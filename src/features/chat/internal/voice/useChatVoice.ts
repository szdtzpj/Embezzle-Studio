import {
  RecordingPresets,
  createAudioPlayer,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { AppState } from 'react-native';

import {
  useWorkspaceSelector,
} from '../../../../app/workspace/WorkspaceSessionProvider';
import { useWorkspaceSession } from '../../../../app/workspace/internal/WorkspaceSessionContext';
import type { ChatMessage } from '../../../../domain/types';
import { createId } from '../../../../services/id';
import { estimateMessageCost } from '../../../../services/usageAnalytics';
import {
  getProviderAudioReadiness,
  resolveConfiguredProviderAudioTarget,
} from '../../../../services/providerAudio';
import { useChatAdapters, useChatOrchestrationController } from '../../ChatProvider';
import type { ChatLease } from '../ChatContext';
import type { ChatUsageLedger } from '../requests/ChatUsageLedger';

export type ChatVoiceOperation = 'idle' | 'recording' | 'transcribing' | 'synthesizing';

interface ActiveVoiceOperation {
  id: number;
  kind: Exclude<ChatVoiceOperation, 'idle'>;
  controller: AbortController;
  lease: ChatLease;
}

export interface ChatVoiceController {
  operation: ChatVoiceOperation;
  busy: boolean;
  isRecording: boolean;
  speakingMessageId: string | null;
  canTranscribe: boolean;
  canSynthesize: boolean;
  toggleInput(): Promise<void>;
  readAloud(message: ChatMessage): Promise<void>;
}

export function useChatVoice(options: {
  usageLedger: ChatUsageLedger;
  setInput: Dispatch<SetStateAction<string>>;
  notify(message: string): void;
}): ChatVoiceController {
  const workspaceSession = useWorkspaceSession();
  const workspace = useWorkspaceSelector((snapshot) => snapshot);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const orchestration = useChatOrchestrationController();
  const audioAdapter = useChatAdapters().audio;
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  const mountedRef = useRef(true);
  const operationSequenceRef = useRef(0);
  const activeOperationRef = useRef<ActiveVoiceOperation | null>(null);
  const playerRef = useRef<ReturnType<typeof createAudioPlayer> | null>(null);
  const cacheUriRef = useRef<string | null>(null);
  const backgroundRecordingStopRef = useRef(false);
  const [operation, setOperation] = useState<ChatVoiceOperation>('idle');
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const notifyRef = useRef(options.notify);
  notifyRef.current = options.notify;

  const configuredTranscriptionTarget = resolveConfiguredProviderAudioTarget(
    workspace,
    'transcription'
  );
  const configuredSpeechTarget = resolveConfiguredProviderAudioTarget(workspace, 'speech');

  const finishOperation = useCallback(
    (active: ActiveVoiceOperation): void => {
      if (activeOperationRef.current !== active) return;
      activeOperationRef.current = null;
      orchestration.finish(active.lease);
      if (mountedRef.current) setOperation('idle');
    },
    [orchestration]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeOperationRef.current?.controller.abort();
      playerRef.current?.release();
      playerRef.current = null;
      void deleteTemporaryAudioFile(cacheUriRef.current);
      cacheUriRef.current = null;
      if (recorderRef.current.isRecording) void recorderRef.current.stop();
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') return;

      const active = activeOperationRef.current;
      active?.controller.abort();
      if (playerRef.current) {
        playerRef.current.pause();
        playerRef.current.release();
        playerRef.current = null;
        void deleteTemporaryAudioFile(cacheUriRef.current);
        cacheUriRef.current = null;
        setSpeakingMessageId(null);
      }

      const currentRecorder = recorderRef.current;
      if (
        active?.kind === 'recording' &&
        currentRecorder.isRecording &&
        !backgroundRecordingStopRef.current
      ) {
        backgroundRecordingStopRef.current = true;
        void (async () => {
          try {
            await currentRecorder.stop();
            await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
            await deleteTemporaryAudioFile(currentRecorder.uri);
            if (mountedRef.current) {
              notifyRef.current('应用进入后台，录音已停止并丢弃，未发送给任何服务商。');
            }
          } catch {
            if (mountedRef.current) {
              notifyRef.current('应用进入后台；录音停止状态无法确认，请返回后重新录制。');
            }
          } finally {
            backgroundRecordingStopRef.current = false;
            finishOperation(active);
          }
        })();
      } else if (active?.kind === 'recording') {
        finishOperation(active);
        notifyRef.current('应用进入后台，录音准备已取消，未发送给任何服务商。');
      } else if (active) {
        notifyRef.current('应用进入后台，进行中的语音请求已停止。');
      }
    });
    return () => subscription.remove();
  }, [finishOperation]);

  function beginOperation(kind: ActiveVoiceOperation['kind']): ActiveVoiceOperation | null {
    if (workspaceSession.isReplacing()) {
      options.notify('正在验证并导入备份，暂时不能开始语音操作。');
      return null;
    }
    if (activeOperationRef.current) return null;
    const lease = orchestration.begin({ phase: 'audio', label: '语音操作' });
    if (!lease) {
      options.notify(`${orchestration.current()?.label ?? '其他操作'}仍在进行中，请稍后再试。`);
      return null;
    }
    const active: ActiveVoiceOperation = {
      id: ++operationSequenceRef.current,
      kind,
      controller: lease.controller,
      lease,
    };
    activeOperationRef.current = active;
    setOperation(kind);
    return active;
  }

  function transitionOperation(
    active: ActiveVoiceOperation,
    kind: ActiveVoiceOperation['kind']
  ): boolean {
    if (activeOperationRef.current !== active || active.controller.signal.aborted) return false;
    active.kind = kind;
    orchestration.transition(active.lease, 'audio');
    setOperation(kind);
    return true;
  }

  function assertOperationCurrent(active: ActiveVoiceOperation): void {
    if (activeOperationRef.current !== active || active.controller.signal.aborted) {
      const error = new Error('语音操作已停止。');
      error.name = 'AbortError';
      throw error;
    }
  }

  async function toggleInput(): Promise<void> {
    const active = activeOperationRef.current;
    if (active?.kind === 'recording') {
      if (!recorder.isRecording && !recorderState.isRecording) {
        active.controller.abort();
        options.notify('正在取消录音准备…');
        return;
      }
      if (!transitionOperation(active, 'transcribing')) return;

      let recordedUri: string | null = null;
      let usageEvent = null as ReturnType<ChatUsageLedger['createStarted']> | null;
      try {
        await recorder.stop();
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        assertOperationCurrent(active);
        const uri = recorder.uri;
        if (!uri) throw new Error('没有生成可转写的录音文件。');
        recordedUri = uri;
        const target = resolveConfiguredProviderAudioTarget(
          workspaceRef.current,
          'transcription'
        );
        if (!target) throw new Error('请先在设置中选择语音转写模型。');
        const readiness = getProviderAudioReadiness(target.provider);
        if (!readiness.canTranscribe) {
          throw new Error(readiness.message ?? '当前服务商语音转写尚未就绪。');
        }
        if (
          !(await options.usageLedger.authorize({
            operations: [
              {
                kind: 'audio-transcription',
                providerId: target.provider.id,
                modelId: target.modelId,
              },
            ],
          }))
        ) {
          return;
        }
        const startedEvent = options.usageLedger.createStarted({
          id: createId('usage'),
          kind: 'audio-transcription',
          providerId: target.provider.id,
          modelId: target.modelId,
          createdAt: Date.now(),
        });
        await options.usageLedger.persist([startedEvent]);
        // Keep the event visible to the catch path only after persistence has
        // succeeded; a failed ledger write must not be marked as a provider
        // failure or completed as though a request had started.
        usageEvent = startedEvent;
        options.notify('正在使用你的服务商账号转写录音…');
        const result = await audioAdapter.transcribe({
          provider: target.provider,
          modelId: target.modelId,
          source: {
            uri,
            name: `voice-input-${Date.now()}.m4a`,
            mimeType: 'audio/mp4',
          },
          signal: active.controller.signal,
        });
        assertOperationCurrent(active);
        options.setInput((current) => (current.trim() ? `${current}\n${result.text}` : result.text));
        const transcriptCost = result.usage
          ? estimateMessageCost(
              {
                id: createId('usage-message'),
                role: 'assistant',
                content: result.text,
                createdAt: Date.now(),
                status: 'ready',
                providerId: target.provider.id,
                modelId: target.modelId,
                usage: result.usage,
              },
              workspaceRef.current.modelPricing
                .filter(
                  (pricing) =>
                    pricing.providerId === target.provider.id &&
                    pricing.modelId === target.modelId
                )
                .sort((left, right) => right.updatedAt - left.updatedAt)[0]
            )
          : undefined;
        await options.usageLedger.finish(usageEvent, 'succeeded', transcriptCost ?? undefined);
        usageEvent = null;
        options.notify('语音已转写到输入框，尚未自动发送。');
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (usageEvent) {
          await options.usageLedger.finish(usageEvent, aborted ? 'cancelled' : 'failed');
        }
        options.notify(
          aborted
            ? '语音转写已停止。'
            : error instanceof Error
              ? error.message
              : '语音转写失败。'
        );
      } finally {
        try {
          if (recorder.isRecording) await recorder.stop();
          await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        } catch {
          // The primary result remains authoritative; cleanup is best effort.
        }
        await deleteTemporaryAudioFile(recordedUri);
        finishOperation(active);
      }
      return;
    }

    if (active) {
      active.controller.abort();
      options.notify(
        active.kind === 'synthesizing'
          ? '正在停止语音合成请求…'
          : '正在停止语音转写请求…'
      );
      return;
    }

    const target = resolveConfiguredProviderAudioTarget(
      workspaceRef.current,
      'transcription'
    );
    if (!target) {
      options.notify('请先在设置中选择语音转写模型。');
      return;
    }
    const readiness = getProviderAudioReadiness(target.provider);
    if (!readiness.canTranscribe) {
      options.notify(readiness.message ?? '当前服务商语音转写尚未就绪。');
      return;
    }
    const next = beginOperation('recording');
    if (!next) return;
    let recordingStarted = false;
    try {
      const permission = await requestRecordingPermissionsAsync();
      assertOperationCurrent(next);
      if (!permission.granted) {
        options.notify('未获得麦克风权限，无法录制语音。');
        return;
      }
      playerRef.current?.release();
      playerRef.current = null;
      void deleteTemporaryAudioFile(cacheUriRef.current);
      cacheUriRef.current = null;
      setSpeakingMessageId(null);
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      assertOperationCurrent(next);
      await recorder.prepareToRecordAsync();
      assertOperationCurrent(next);
      recorder.record();
      recordingStarted = true;
      options.notify('正在录音；再次点击麦克风即可停止并转写。');
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      options.notify(
        aborted ? '录音准备已停止。' : error instanceof Error ? error.message : '无法开始录音。'
      );
    } finally {
      if (!recordingStarted) finishOperation(next);
    }
  }

  async function readAloud(message: ChatMessage): Promise<void> {
    if (speakingMessageId === message.id && playerRef.current) {
      playerRef.current.pause();
      playerRef.current.release();
      playerRef.current = null;
      void deleteTemporaryAudioFile(cacheUriRef.current);
      cacheUriRef.current = null;
      setSpeakingMessageId(null);
      options.notify('已停止朗读。');
      return;
    }
    if (activeOperationRef.current?.kind === 'recording' || recorderState.isRecording) {
      options.notify('正在录音，不能同时生成朗读；请先停止录音并完成或取消转写。');
      return;
    }
    const active = activeOperationRef.current;
    if (active) {
      if (active.kind === 'synthesizing' && speakingMessageId === message.id) {
        active.controller.abort();
        options.notify('正在停止语音合成请求…');
      } else {
        options.notify('另一项语音操作仍在进行中。');
      }
      return;
    }
    const text = message.content.trim();
    if (!text) return;
    const target = resolveConfiguredProviderAudioTarget(workspaceRef.current, 'speech');
    if (!target) {
      options.notify('请先在设置中选择语音合成模型。');
      return;
    }
    const readiness = getProviderAudioReadiness(target.provider);
    if (!readiness.canSynthesize) {
      options.notify(readiness.message ?? '当前服务商语音合成尚未就绪。');
      return;
    }
    if (
      !(await options.usageLedger.authorize({
        operations: [
          {
            kind: 'speech-generation',
            providerId: target.provider.id,
            modelId: target.modelId,
          },
        ],
      }))
    ) {
      return;
    }

    playerRef.current?.release();
    playerRef.current = null;
    await deleteTemporaryAudioFile(cacheUriRef.current);
    cacheUriRef.current = null;
    const next = beginOperation('synthesizing');
    if (!next) {
      options.notify('另一项语音操作仍在进行中。');
      return;
    }
    let usageEvent = null as ReturnType<ChatUsageLedger['createStarted']> | null;
    try {
      const startedEvent = options.usageLedger.createStarted({
        id: createId('usage'),
        kind: 'speech-generation',
        providerId: target.provider.id,
        modelId: target.modelId,
        createdAt: Date.now(),
        messageId: message.id,
      });
      await options.usageLedger.persist([startedEvent]);
      // Do not expose an unpersisted attempt to the provider-error catch path.
      usageEvent = startedEvent;
    } catch (error) {
      finishOperation(next);
      options.notify(
        error instanceof Error ? error.message : '费用保险丝台账写入失败，语音请求未发出。'
      );
      return;
    }

    setSpeakingMessageId(message.id);
    options.notify('正在使用你的服务商账号生成 AI 合成语音…');
    let generatedUri: string | null = null;
    try {
      const result = await audioAdapter.synthesize({
        provider: target.provider,
        modelId: target.modelId,
        text,
        voice: workspaceRef.current.voice.speechVoice,
        responseFormat: workspaceRef.current.voice.speechFormat,
        signal: next.controller.signal,
      });
      generatedUri = result.uri;
      assertOperationCurrent(next);
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      assertOperationCurrent(next);
      const player = createAudioPlayer(result.uri);
      playerRef.current = player;
      cacheUriRef.current = result.uri;
      setSpeakingMessageId(message.id);
      const subscription = player.addListener('playbackStatusUpdate', (status) => {
        if (!status.didJustFinish || playerRef.current !== player) return;
        subscription.remove();
        player.release();
        playerRef.current = null;
        void deleteTemporaryAudioFile(cacheUriRef.current);
        cacheUriRef.current = null;
        setSpeakingMessageId(null);
      });
      player.play();
      await options.usageLedger.finish(usageEvent, 'succeeded');
      usageEvent = null;
      options.notify('正在播放 AI 合成语音。');
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      if (usageEvent) {
        await options.usageLedger.finish(usageEvent, aborted ? 'cancelled' : 'failed');
      }
      if (cacheUriRef.current === generatedUri) {
        playerRef.current?.release();
        playerRef.current = null;
      }
      await deleteTemporaryAudioFile(generatedUri);
      if (cacheUriRef.current === generatedUri) cacheUriRef.current = null;
      setSpeakingMessageId(null);
      options.notify(
        aborted
          ? '语音生成已停止。'
          : error instanceof Error
            ? error.message
            : '语音生成失败。'
      );
    } finally {
      finishOperation(next);
    }
  }

  return {
    operation,
    busy: operation !== 'idle',
    isRecording: recorderState.isRecording,
    speakingMessageId,
    canTranscribe: Boolean(configuredTranscriptionTarget),
    canSynthesize: Boolean(configuredSpeechTarget),
    toggleInput,
    readAloud,
  };
}

async function deleteTemporaryAudioFile(uri?: string | null): Promise<void> {
  if (!uri?.startsWith('file:')) return;
  try {
    const { File } = await import('expo-file-system');
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Temporary cache cleanup is best effort and must not mask the primary result.
  }
}
