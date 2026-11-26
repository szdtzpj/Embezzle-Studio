import { memo, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { BookOpen, Check, Volume2, X } from 'lucide-react-native';

import type {
  ChatMessage,
  GenerationTaskInfo,
  MediaAttachment,
} from '../../../../domain/types';
import { MessageActivityModules } from '../../../../ui/components/MessageActivityModules';
import { MessageMarkdown } from '../../../../ui/components/MessageMarkdown';
import { useChatPaneTheme } from '../../chatPaneStyles';
import { useStreamingDraftSelector } from '../ChatWorkspaceRuntime';
import { AttachmentPreview } from './ChatAttachmentPresentation';
import {
  AssistantMessageHeader,
  GenerationTaskPanel,
  McpActivityPanel,
  MessageActionMenu,
  MessageActions,
  MessageInlineEditor,
  TokenUsageLine,
  WebCitationList,
} from './ChatMessagePresentation';
import { AnimatedMessage, AnimatedPressable } from './ChatMotion';

/** 虚拟化消息行组件属性；所有非行级全局状态均已收敛为标量与稳定回调。 */
export interface ChatMessageRowProps {
  conversationId: string;
  message: ChatMessage;
  isAnimated: boolean;
  isSearchHighlighted: boolean;
  isEditing: boolean;
  editingDraft: string;
  editDisabled: boolean;
  systemRemoveDisabled: boolean;
  isCopied: boolean;
  isActionMenuOpen: boolean;
  isTaskQuerying: boolean;
  activeVideoId: string | null;
  canSynthesizeSpeech: boolean;
  isSpeaking: boolean;
  speechDisabled: boolean;
  videoFallbackTarget: { providerId: string; modelId: string } | null;
  onCopy: (message: ChatMessage) => void;
  onRetry: (message: ChatMessage) => void;
  onBeginEdit: (message: ChatMessage) => void;
  onChangeEditDraft: (value: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onShare: (message: ChatMessage) => void;
  onToggleActionMenu: (message: ChatMessage) => void;
  onSaveArtifact: (message: ChatMessage) => void;
  onSaveKnowledge: (message: ChatMessage) => void;
  onBranch: (messageId: string) => void;
  onDelete: (message: ChatMessage) => void;
  onRemoveSystemInstruction: (message: ChatMessage) => void;
  onSelectComparisonAnswer: (message: ChatMessage) => void;
  onRefreshGenerationTask: (message: ChatMessage, task: GenerationTaskInfo) => void;
  onToggleVideo: (attachmentId: string) => void;
  onReadAloud: (message: ChatMessage) => void;
  /** M3 预留图片编辑回调插槽（“以此图继续编辑”）。 */
  onEditImageAttachment?: (attachment: MediaAttachment, message: ChatMessage) => void;
  /** M3 预留图片全屏灯箱回调插槽。 */
  onOpenImageLightbox?: (attachment: MediaAttachment, message: ChatMessage) => void;
}

function inferGenerationTaskForMessage(
  message: ChatMessage,
  videoFallbackTarget: { providerId: string; modelId: string } | null
): GenerationTaskInfo | undefined {
  if (message.generationTask) return message.generationTask;
  if (!videoFallbackTarget) return undefined;
  const match = message.content.match(/cgt-[A-Za-z0-9-]+/);
  if (!match) return undefined;
  const statusMatch = message.content.match(/当前状态[:：]\s*([A-Za-z_-]+)/);
  return {
    providerId: videoFallbackTarget.providerId,
    modelId: videoFallbackTarget.modelId,
    taskId: match[0],
    kind: 'video',
    status: statusMatch?.[1],
  };
}

function ChatMessageRowInner({
  conversationId,
  message,
  isAnimated,
  isSearchHighlighted,
  isEditing,
  editingDraft,
  editDisabled,
  systemRemoveDisabled,
  isCopied,
  isActionMenuOpen,
  isTaskQuerying,
  activeVideoId,
  canSynthesizeSpeech,
  isSpeaking,
  speechDisabled,
  videoFallbackTarget,
  onCopy,
  onRetry,
  onBeginEdit,
  onChangeEditDraft,
  onCancelEdit,
  onSaveEdit,
  onShare,
  onToggleActionMenu,
  onSaveArtifact,
  onSaveKnowledge,
  onBranch,
  onDelete,
  onRemoveSystemInstruction,
  onSelectComparisonAnswer,
  onRefreshGenerationTask,
  onToggleVideo,
  onReadAloud,
  onEditImageAttachment,
  onOpenImageLightbox,
}: ChatMessageRowProps) {
  const { palette, styles } = useChatPaneTheme();
  const draft = useStreamingDraftSelector(conversationId, message.id);
  const [focusedCitationIndex, setFocusedCitationIndex] = useState<number | null>(null);

  useEffect(() => {
    setFocusedCitationIndex(null);
  }, [message.id]);

  // 仅在持久化消息仍处于 pending 时合并独立流式草稿，防止终态回闪旧草稿
  const displayMessage = useMemo<ChatMessage>(() => {
    if (!draft || message.status !== 'pending') {
      return message;
    }
    return {
      ...message,
      content: draft.content,
      reasoningContent: draft.reasoningContent,
      thinkingDurationMs: draft.thinkingDurationMs,
      usage: draft.usage,
      citations: draft.citations,
      webSearchTriggered: draft.webSearchTriggered,
      toolActivity: draft.toolActivity,
      activityTimeline: draft.activityTimeline,
      status: draft.status,
    };
  }, [draft, message]);

  const generationTask =
    displayMessage.role === 'assistant'
      ? inferGenerationTaskForMessage(displayMessage, videoFallbackTarget)
      : undefined;
  const messageModelId = displayMessage.modelId ?? '模型未记录';
  const messageProviderName = displayMessage.providerName ?? '未知服务商';

  return (
    <AnimatedMessage
      animate={isAnimated}
      style={[
        styles.messageBubble,
        displayMessage.role === 'user'
          ? styles.userMessageBlock
          : displayMessage.role === 'system'
            ? styles.systemMessageBlock
            : styles.assistantBubble,
        displayMessage.status === 'error' && styles.errorBubble,
        isSearchHighlighted && styles.searchHighlightedMessage,
      ]}
    >
      {displayMessage.role === 'user' ? (
        <>
          <View style={styles.userBubble}>
            {isEditing ? (
              <MessageInlineEditor
                role="user"
                value={editingDraft}
                placeholder="修改这条问题"
                primaryLabel="提交修改"
                disabled={editDisabled}
                onChange={onChangeEditDraft}
                onCancel={onCancelEdit}
                onSave={onSaveEdit}
              />
            ) : (
              <Text style={[styles.messageText, styles.userMessageText]}>
                {displayMessage.content}
              </Text>
            )}
            {displayMessage.attachments?.length ? (
              <View style={styles.attachmentGrid}>
                {displayMessage.attachments.map((attachment) => (
                  <AttachmentPreview
                    key={attachment.id}
                    attachment={attachment}
                    videoActive={activeVideoId === attachment.id}
                    onToggleVideo={() => onToggleVideo(attachment.id)}
                    onOpenLightbox={
                      onOpenImageLightbox
                        ? () => onOpenImageLightbox(attachment, displayMessage)
                        : undefined
                    }
                    onEditWithImage={
                      onEditImageAttachment
                        ? () => onEditImageAttachment(attachment, displayMessage)
                        : undefined
                    }
                  />
                ))}
              </View>
            ) : null}
          </View>
          <MessageActions
            role="user"
            copied={isCopied}
            onCopy={() => onCopy(displayMessage)}
            onRetry={() => onRetry(displayMessage)}
            onEdit={() => onBeginEdit(displayMessage)}
            onShare={() => onShare(displayMessage)}
            onMore={() => onToggleActionMenu(displayMessage)}
          />
          {isActionMenuOpen ? (
            <MessageActionMenu
              role="user"
              canSave={displayMessage.status === 'ready' && Boolean(displayMessage.content.trim())}
              onEdit={() => onBeginEdit(displayMessage)}
              onSaveArtifact={() => onSaveArtifact(displayMessage)}
              onSaveKnowledge={() => onSaveKnowledge(displayMessage)}
              onBranch={() => onBranch(displayMessage.id)}
              onDelete={() => onDelete(displayMessage)}
            />
          ) : null}
        </>
      ) : displayMessage.role === 'system' ? (
        <View style={styles.systemInstructionCard}>
          <View style={styles.systemInstructionHeader}>
            <View style={styles.systemInstructionTitleRow}>
              <BookOpen size={15} color={palette.text} strokeWidth={2} />
              <Text style={styles.systemInstructionTitle}>会话指令</Text>
            </View>
            <AnimatedPressable
              accessibilityRole="button"
              accessibilityLabel="移除会话指令"
              disabled={systemRemoveDisabled}
              onPress={() => onRemoveSystemInstruction(displayMessage)}
              style={styles.iconButton}
            >
              <X size={15} color={palette.textSecondary} strokeWidth={2} />
            </AnimatedPressable>
          </View>
          <Text style={styles.systemInstructionText}>{displayMessage.content}</Text>
        </View>
      ) : (
        <>
          <AssistantMessageHeader
            modelId={messageModelId}
            providerName={messageProviderName}
            createdAt={displayMessage.createdAt}
          />
          {displayMessage.comparisonGroupId ? (
            <AnimatedPressable
              accessibilityRole="button"
              accessibilityState={{
                selected: displayMessage.selectedForContext === true,
                disabled: displayMessage.status !== 'ready',
              }}
              disabled={displayMessage.status !== 'ready'}
              onPress={() => onSelectComparisonAnswer(displayMessage)}
              style={[
                styles.comparisonContextButton,
                displayMessage.selectedForContext && styles.comparisonContextButtonSelected,
                displayMessage.status !== 'ready' && styles.buttonDisabled,
              ]}
            >
              {displayMessage.selectedForContext ? (
                <Check size={12} color={palette.textOnAccent} strokeWidth={2.8} />
              ) : null}
              <Text
                style={[
                  styles.comparisonContextButtonText,
                  displayMessage.selectedForContext && styles.comparisonContextButtonTextSelected,
                ]}
              >
                {displayMessage.selectedForContext ? '用于后续上下文' : '以此回答继续'}
              </Text>
            </AnimatedPressable>
          ) : null}
          <MessageActivityModules message={displayMessage} />
          {isEditing ? (
            <MessageInlineEditor
              role="assistant"
              value={editingDraft}
              placeholder="修改这条回答"
              primaryLabel="保存修改"
              disabled={editDisabled}
              onChange={onChangeEditDraft}
              onCancel={onCancelEdit}
              onSave={onSaveEdit}
            />
          ) : displayMessage.content ? (
            <View accessibilityLiveRegion="polite">
              {displayMessage.status === 'pending' ? (
                <Text selectable style={styles.messageText}>
                  {displayMessage.content}
                </Text>
              ) : (
                <MessageMarkdown
                  content={displayMessage.content}
                  citations={displayMessage.citations}
                  onCitationPress={(index) => setFocusedCitationIndex(index)}
                />
              )}
            </View>
          ) : null}
          {displayMessage.citations?.length ? (
            <WebCitationList
              citations={displayMessage.citations}
              focusedCitationIndex={focusedCitationIndex}
              onFocusCitationChange={setFocusedCitationIndex}
            />
          ) : null}
          {displayMessage.mcpActivity &&
          !displayMessage.toolActivity?.length &&
          !displayMessage.mcpActivity.approvals.length &&
          !displayMessage.mcpActivity.calls.length ? (
            <McpActivityPanel activity={displayMessage.mcpActivity} />
          ) : null}
          {displayMessage.status === 'cancelled' ? (
            <Text style={styles.messageStatusText}>已停止生成</Text>
          ) : displayMessage.error && displayMessage.content !== displayMessage.error ? (
            <Text
              accessibilityLiveRegion="polite"
              style={[styles.messageStatusText, styles.messageErrorText]}
            >
              {displayMessage.error}
            </Text>
          ) : null}
          {generationTask &&
          !displayMessage.attachments?.some((attachment) => attachment.kind === 'video') ? (
            <GenerationTaskPanel
              task={generationTask}
              busy={isTaskQuerying}
              onRefresh={() => onRefreshGenerationTask(displayMessage, generationTask)}
            />
          ) : null}
          {displayMessage.attachments?.length ? (
            <View style={styles.attachmentGrid}>
              {displayMessage.attachments.map((attachment) => (
                <AttachmentPreview
                  key={attachment.id}
                  attachment={attachment}
                  videoActive={activeVideoId === attachment.id}
                  onToggleVideo={() => onToggleVideo(attachment.id)}
                  onOpenLightbox={
                    onOpenImageLightbox
                      ? () => onOpenImageLightbox(attachment, displayMessage)
                      : undefined
                  }
                  onEditWithImage={
                    onEditImageAttachment
                      ? () => onEditImageAttachment(attachment, displayMessage)
                      : undefined
                  }
                />
              ))}
            </View>
          ) : null}
          <View style={styles.assistantFooterRow}>
            <View style={styles.messageActions}>
              <MessageActions
                role="assistant"
                copied={isCopied}
                onCopy={() => onCopy(displayMessage)}
                onRetry={() => onRetry(displayMessage)}
                onEdit={() => onBeginEdit(displayMessage)}
                onShare={() => onShare(displayMessage)}
                onMore={() => onToggleActionMenu(displayMessage)}
              />
              {canSynthesizeSpeech &&
              displayMessage.status === 'ready' &&
              displayMessage.content.trim() ? (
                <AnimatedPressable
                  accessibilityRole="button"
                  disabled={speechDisabled}
                  accessibilityLabel={
                    isSpeaking ? '停止 AI 朗读' : '使用服务商生成 AI 朗读'
                  }
                  onPress={() => onReadAloud(displayMessage)}
                  style={[
                    styles.messageActionButton,
                    speechDisabled && styles.buttonDisabled,
                  ]}
                >
                  <Volume2
                    size={15}
                    color={isSpeaking ? palette.accent : palette.textSecondary}
                    strokeWidth={2}
                  />
                </AnimatedPressable>
              ) : null}
            </View>
            {displayMessage.usage ? <TokenUsageLine usage={displayMessage.usage} /> : null}
            {displayMessage.requestMetrics?.durationMs !== undefined ? (
              <Text style={styles.tokenUsageText}>
                {(displayMessage.requestMetrics.durationMs / 1000).toFixed(1)}s
              </Text>
            ) : null}
          </View>
          {isActionMenuOpen ? (
            <MessageActionMenu
              role="assistant"
              canSave={displayMessage.status === 'ready' && Boolean(displayMessage.content.trim())}
              onEdit={() => onBeginEdit(displayMessage)}
              onSaveArtifact={() => onSaveArtifact(displayMessage)}
              onSaveKnowledge={() => onSaveKnowledge(displayMessage)}
              onBranch={() => onBranch(displayMessage.id)}
              onDelete={() => onDelete(displayMessage)}
            />
          ) : null}
        </>
      )}
    </AnimatedMessage>
  );
}

/** React.memo 包装的虚拟化消息行，配合流式草稿切片隔离无关行重渲染。 */
export const ChatMessageRow = memo(ChatMessageRowInner);
