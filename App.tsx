import { StatusBar } from 'expo-status-bar';
import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { PressableProps, StyleProp, ViewStyle } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Camera, ChevronDown, Image as ImageIcon, Menu, MessageSquare, Paperclip, PenSquare, Plus, Settings, X } from 'lucide-react-native';

import { isArkStaticDoubaoModelId, isVolcengineArkProvider } from './src/data/arkModels';
import { createDefaultWorkspace } from './src/data/providerCatalog';
import type {
  AppWorkspace,
  ChatTokenUsage,
  Capability,
  GenerationTaskInfo,
  ChatMessage,
  MediaAttachment,
  ModelInfo,
  ModelTask,
  ProviderProfile,
  ReasoningEffort,
} from './src/domain/types';
import { pickFiles, pickImages, pickVideos } from './src/services/mediaPicker';
import { queryGenerationTask, sendOpenAiCompatibleChat } from './src/services/openAiCompatible';
import { refreshProviderModels } from './src/services/modelDiscovery';
import { createId } from './src/services/id';
import { loadWorkspace, saveWorkspace } from './src/services/storage';

/**
 * Anthropic / Claude 风格视觉令牌。
 * 暖色纸张底、粘土色强调、柔和圆角。仅影响外观，不改动任何业务逻辑。
 */
const palette = {
  bg: '#F4F4F4',
  surface: '#EAEAEA',
  surfaceAlt: '#E2E2E2',
  surfaceSunken: '#DCDCDC',
  border: '#D9D9D9',
  borderStrong: '#C4C4C4',
  accent: '#0D0D0D',
  accentPressed: '#333333',
  accentSoft: '#EAEAEA',
  accentBorder: '#C4C4C4',
  accentText: '#0D0D0D',
  text: '#0D0D0D',
  textSecondary: '#6E6E6E',
  textMuted: '#9A9A9A55',
  textMutedSolid: '#9A9A9A',
  textOnAccent: '#FFFFFF',
  danger: '#DC2626',
  dangerBg: '#FEF2F2',
  dangerBorder: '#FECACA',
  warning: '#D97706',
  placeholder: '#9CA3AF',
  scrim: 'rgba(0, 0, 0, 0.4)',
} as const;

const radii = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

// 用衬线体呈现品牌标题，呼应 Anthropic 的展示字体气质
const serifFont = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  default: 'Georgia, "Times New Roman", serif',
});

const useNativeDriver = Platform.OS !== 'web';

type AnimatedPressableProps = PressableProps & {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

const PressableAnimated = Animated.createAnimatedComponent(Pressable);

/**
 * 带按压缩放反馈的 Pressable，行为与原生 Pressable 完全一致，只是多了触感动画。
 */
function AnimatedPressable({
  style,
  children,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: AnimatedPressableProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const animateTo = (toValue: number) => {
    Animated.spring(scale, {
      toValue,
      useNativeDriver,
      speed: 50,
      bounciness: 0,
    }).start();
  };

  return (
    <PressableAnimated
      {...rest}
      disabled={disabled}
      onPressIn={(event) => {
        if (!disabled) {
          animateTo(0.96);
        }
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        animateTo(1);
        onPressOut?.(event);
      }}
      style={[style, { transform: [{ scale }] }]}
    >
      {children}
    </PressableAnimated>
  );
}

/**
 * 消息气泡入场动画：淡入 + 轻微上移。仅在首次挂载时播放一次。
 */
function AnimatedMessage({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver,
    }).start();
  }, [anim]);

  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [10, 0],
  });

  return (
    <Animated.View style={[style, { opacity: anim, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}

/**
 * 切换聊天 / 配置时的柔和淡入过渡。
 */
function ScreenFade({ children }: { children?: ReactNode }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver,
    }).start();
  }, [anim]);

  return <Animated.View style={[styles.screenFade, { opacity: anim }]}>{children}</Animated.View>;
}

/**
 * “正在思考”指示器：三个交错脉动的圆点。
 */
function ThinkingDots() {
  const dotA = useRef(new Animated.Value(0)).current;
  const dotB = useRef(new Animated.Value(0)).current;
  const dotC = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const pulse = (value: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(value, {
            toValue: 1,
            duration: 360,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver,
          }),
          Animated.timing(value, {
            toValue: 0,
            duration: 360,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver,
          }),
        ])
      );

    const animation = Animated.parallel([pulse(dotA, 0), pulse(dotB, 160), pulse(dotC, 320)]);
    animation.start();

    return () => animation.stop();
  }, [dotA, dotB, dotC]);

  const dotStyle = (value: Animated.Value) => ({
    opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.32, 1] }),
    transform: [
      {
        translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }),
      },
    ],
  });

  return (
    <View style={styles.thinkingRow} accessibilityRole="text" accessibilityLabel="正在思考">
      <Animated.View style={[styles.thinkingDot, dotStyle(dotA)]} />
      <Animated.View style={[styles.thinkingDot, dotStyle(dotB)]} />
      <Animated.View style={[styles.thinkingDot, dotStyle(dotC)]} />
    </View>
  );
}

const capabilityLabel: Record<string, string> = {
  text: '文本',
  'image-input': '图片',
  'video-input': '视频',
  'tool-calling': '工具',
  streaming: '流式',
  mcp: 'MCP',
};

type CandidateModelFilter = 'all' | 'reasoning' | 'vision' | 'web' | 'free' | 'embedding' | 'rerank' | 'tool';

const candidateModelFilters: Array<{ key: CandidateModelFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'reasoning', label: '推理' },
  { key: 'vision', label: '视觉' },
  { key: 'web', label: '联网' },
  { key: 'free', label: '免费' },
  { key: 'embedding', label: '嵌入' },
  { key: 'rerank', label: '重排' },
  { key: 'tool', label: '工具' },
];

const reasoningEffortOptions: Array<{ key: ReasoningEffort; label: string }> = [
  { key: 'default', label: '默认' },
  { key: 'off', label: '关闭' },
  { key: 'low', label: '低' },
  { key: 'medium', label: '中' },
  { key: 'high', label: '高' },
  { key: 'max', label: '极高' },
];

const modelFilterKeywords = {
  reasoning: ['reason', 'thinking', 'think', 'deepseek-r1', '-r1', 'r1-', 'qwq', 'qvq', 'o1', 'o3', 'o4', 'z1'],
  vision: ['vision', 'visual', 'vl', 'image', 'img', 'omni', '4v', 'multimodal', 'multi-modal', 'qwen-vl', 'glm-4v', 'gpt-4o'],
  web: ['web', 'search', 'browsing', 'browser', 'online', 'internet'],
  free: ['free', 'gratis', 'trial'],
  embedding: ['embedding', 'embeddings', 'embed', 'bge', 'm3e', 'jina-embeddings'],
  rerank: ['rerank', 'reranker', 're-rank', 'bge-reranker'],
  tool: ['functioncall', 'function-call', 'function', 'tool', 'tools', 'mcp'],
};

const modelTaskLabel: Record<ModelTask, string> = {
  chat: '对话',
  'image-generation': '图片生成',
  'video-generation': '视频生成',
  embedding: '嵌入',
  rerank: '重排',
};

const webVideoPreviewStyle: CSSProperties = {
  width: '100%',
  height: 128,
  display: 'block',
  backgroundColor: '#E4E0D3',
};

function getSelectableModels(provider: ProviderProfile) {
  return provider.models.filter(
    (model) =>
      model.source !== 'preset' &&
      !(isVolcengineArkProvider(provider) && model.source !== 'remote' && isArkStaticDoubaoModelId(model.id))
  );
}

function modelIndexText(model: ModelInfo) {
  return `${model.name ?? ''} ${model.id}`.toLowerCase();
}

function inferModelTask(model: ModelInfo): ModelTask {
  if (model.task) {
    return model.task;
  }

  const text = modelIndexText(model);

  if (text.includes('seedream') || text.includes('image-generation') || text.includes('text-to-image')) {
    return 'image-generation';
  }

  if (text.includes('seedance') || text.includes('video-generation') || text.includes('text-to-video')) {
    return 'video-generation';
  }

  if (text.includes('embedding') || text.includes('embed')) {
    return 'embedding';
  }

  if (text.includes('rerank') || text.includes('reranker')) {
    return 'rerank';
  }

  return 'chat';
}

function includesAny(value: string, keywords: string[]) {
  return keywords.some((keyword) => value.includes(keyword));
}

function hasExplicitCapability(model: ModelInfo, capability: Capability) {
  return model.source !== 'remote' && model.capabilities.includes(capability);
}

function matchesCandidateModelFilter(model: ModelInfo, filter: CandidateModelFilter) {
  if (filter === 'all') {
    return true;
  }

  const text = modelIndexText(model);

  if (filter === 'reasoning') {
    return includesAny(text, modelFilterKeywords.reasoning);
  }

  if (filter === 'vision') {
    return hasExplicitCapability(model, 'image-input') || includesAny(text, modelFilterKeywords.vision);
  }

  if (filter === 'web') {
    return includesAny(text, modelFilterKeywords.web);
  }

  if (filter === 'free') {
    return includesAny(text, modelFilterKeywords.free);
  }

  if (filter === 'embedding') {
    return includesAny(text, modelFilterKeywords.embedding);
  }

  if (filter === 'rerank') {
    return includesAny(text, modelFilterKeywords.rerank);
  }

  return hasExplicitCapability(model, 'tool-calling') || includesAny(text, modelFilterKeywords.tool);
}

export default function App() {
  const [workspace, setWorkspace] = useState<AppWorkspace>(() => createDefaultWorkspace());
  const [booting, setBooting] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [input, setInput] = useState('');
  const [manualModelId, setManualModelId] = useState('');
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [modelCapabilityFilter, setModelCapabilityFilter] = useState<CandidateModelFilter>('all');
  const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [expandedReasoningByMessageId, setExpandedReasoningByMessageId] = useState<Record<string, boolean>>({});
  const [queryingTaskByMessageId, setQueryingTaskByMessageId] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let mounted = true;

    loadWorkspace()
      .then((snapshot) => {
        if (snapshot && mounted) {
          setWorkspace(snapshot);
        }
      })
      .catch((error) => {
        setNotice(error instanceof Error ? error.message : '工作区加载失败。');
      })
      .finally(() => {
        if (mounted) {
          setBooting(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (booting) {
      return;
    }

    saveWorkspace(workspace).catch((error) => {
      setNotice(error instanceof Error ? error.message : '工作区保存失败。');
    });
  }, [booting, workspace]);

  const activeProvider = useMemo(
    () => workspace.providers.find((provider) => provider.id === workspace.activeProviderId) ?? workspace.providers[0],
    [workspace.activeProviderId, workspace.providers]
  );

  const addedModels = useMemo(() => {
    if (!activeProvider) {
      return [];
    }

    return getSelectableModels(activeProvider);
  }, [activeProvider]);
  const savedActiveModelId = activeProvider ? workspace.activeModelIdByProvider[activeProvider.id] : '';
  const activeModelId = activeProvider
    ? addedModels.some((model) => model.id === savedActiveModelId)
      ? savedActiveModelId
      : addedModels[0]?.id ?? ''
    : '';

  const activeModel = addedModels.find((model) => model.id === activeModelId);
  const activeModelTask = activeModel ? inferModelTask(activeModel) : 'chat';
  const activeModelKey = activeProvider && activeModelId ? `${activeProvider.id}:${activeModelId}` : '';
  const activeReasoningEffort: ReasoningEffort = activeModelKey
    ? workspace.reasoningEffortByModel[activeModelKey] ?? 'default'
    : 'default';
  const modelCandidates = activeProvider
    ? (workspace.modelCandidatesByProvider[activeProvider.id] ?? []).filter(
        (model) =>
          model.source !== 'preset' &&
          !(isVolcengineArkProvider(activeProvider) && model.source !== 'remote' && isArkStaticDoubaoModelId(model.id))
      )
    : [];
  const addedModelIds = useMemo(
    () => new Set(addedModels.map((model) => model.id)),
    [addedModels]
  );
  const filteredModelCandidates = useMemo(() => {
    const query = modelSearchQuery.trim().toLowerCase();

    return modelCandidates.filter((model) => {
      const text = modelIndexText(model);
      const matchesQuery = !query || text.includes(query);

      return matchesQuery && matchesCandidateModelFilter(model, modelCapabilityFilter);
    });
  }, [modelCandidates, modelCapabilityFilter, modelSearchQuery]);
  const providerModelGroups = useMemo(
    () =>
      workspace.providers
        .map((provider) => ({
          provider,
          models: getSelectableModels(provider),
        }))
        .filter((group) => group.models.length > 0),
    [workspace.providers]
  );

  function updateActiveProvider(patch: Partial<ProviderProfile>) {
    if (!activeProvider) {
      return;
    }

    setWorkspace((current) => ({
      ...current,
      providers: current.providers.map((provider) =>
        provider.id === activeProvider.id ? { ...provider, ...patch } : provider
      ),
    }));
  }

  function selectProvider(providerId: string) {
    setWorkspace((current) => ({
      ...current,
      activeProviderId: providerId,
    }));
    setModelSearchQuery('');
    setModelCapabilityFilter('all');
  }

  function selectModel(modelId: string) {
    if (!activeProvider) {
      return;
    }

    setWorkspace((current) => ({
      ...current,
      activeModelIdByProvider: {
        ...current.activeModelIdByProvider,
        [activeProvider.id]: modelId,
      },
    }));
  }

  function selectProviderModel(providerId: string, modelId: string) {
    setWorkspace((current) => ({
      ...current,
      activeProviderId: providerId,
      activeModelIdByProvider: {
        ...current.activeModelIdByProvider,
        [providerId]: modelId,
      },
    }));
    setModelPickerOpen(false);
  }

  function setActiveReasoningEffort(effort: ReasoningEffort) {
    if (!activeModelKey) {
      return;
    }

    setWorkspace((current) => {
      const next = { ...current.reasoningEffortByModel };
      if (effort === 'default') {
        delete next[activeModelKey];
      } else {
        next[activeModelKey] = effort;
      }

      return {
        ...current,
        reasoningEffortByModel: next,
      };
    });
  }

  function addCustomProvider() {
    const providerId = createId('provider');
    const provider: ProviderProfile = {
      id: providerId,
      name: 'Custom Provider',
      kind: 'custom',
      baseUrl: 'https://your-provider.example.com/v1',
      capabilities: ['text', 'image-input', 'streaming'],
      models: [],
    };

    setWorkspace((current) => ({
      ...current,
      providers: [...current.providers, provider],
      activeProviderId: providerId,
      activeModelIdByProvider: {
        ...current.activeModelIdByProvider,
        [providerId]: '',
      },
      modelCandidatesByProvider: {
        ...current.modelCandidatesByProvider,
        [providerId]: [],
      },
    }));
    setManualModelId('');
    setModelSearchQuery('');
    setModelCapabilityFilter('all');
  }

  function addManualModel() {
    if (!activeProvider) {
      return;
    }

    const modelId = manualModelId.trim();
    if (!modelId) {
      setNotice('请输入模型 ID。');
      return;
    }

    const model: ModelInfo = {
      id: modelId,
      name: modelId,
      capabilities: activeProvider.capabilities,
      source: 'manual',
    };

    setWorkspace((current) => ({
      ...current,
      providers: current.providers.map((provider) =>
        provider.id === activeProvider.id
          ? {
              ...provider,
              models: [
                ...provider.models.filter((existing) => existing.id !== modelId),
                model,
              ],
            }
          : provider
      ),
      activeModelIdByProvider: {
        ...current.activeModelIdByProvider,
        [activeProvider.id]: modelId,
      },
    }));
    setManualModelId('');
  }

  function addCandidateModel(model: ModelInfo) {
    if (!activeProvider) {
      return;
    }

    setWorkspace((current) => ({
      ...current,
      providers: current.providers.map((provider) =>
        provider.id === activeProvider.id
          ? {
              ...provider,
              models: [
                ...provider.models.filter((existing) => existing.id !== model.id),
                {
                  ...model,
                  capabilities: model.capabilities.length ? model.capabilities : activeProvider.capabilities,
                  source: model.source === 'preset' ? 'manual' : model.source,
                },
              ],
            }
          : provider
      ),
      activeModelIdByProvider: {
        ...current.activeModelIdByProvider,
        [activeProvider.id]: model.id,
      },
    }));
    setNotice(`已添加并启用 ${model.name ?? model.id}。`);
  }

  function removeModel(modelId: string) {
    if (!activeProvider) {
      return;
    }

    setWorkspace((current) => {
      const provider = current.providers.find((item) => item.id === activeProvider.id);
      const nextModels = provider?.models.filter((model) => model.id !== modelId) ?? [];
      const currentActiveModelId = current.activeModelIdByProvider[activeProvider.id];

      return {
        ...current,
        providers: current.providers.map((item) =>
          item.id === activeProvider.id ? { ...item, models: nextModels } : item
        ),
        activeModelIdByProvider: {
          ...current.activeModelIdByProvider,
          [activeProvider.id]:
            currentActiveModelId === modelId ? nextModels[0]?.id ?? '' : currentActiveModelId,
        },
      };
    });
    setNotice('已移除模型。');
  }

  async function refreshModels() {
    if (!activeProvider) {
      return;
    }

    setBusy(true);
    setNotice('');

    try {
      const result = await refreshProviderModels(activeProvider);
      setWorkspace((current) => ({
        ...current,
        modelCandidatesByProvider: {
          ...current.modelCandidatesByProvider,
          [activeProvider.id]: result.models,
        },
      }));
      setModelSearchQuery('');
      setModelCapabilityFilter('all');
      setNotice(result.notice);
    } catch (error) {
      setWorkspace((current) => ({
        ...current,
        modelCandidatesByProvider: {
          ...current.modelCandidatesByProvider,
          [activeProvider.id]: [],
        },
      }));
      setNotice(error instanceof Error ? error.message : '模型列表获取失败。');
    } finally {
      setBusy(false);
    }
  }

  function clearMessages() {
    setWorkspace((current) => ({
      ...current,
      messages: [],
    }));
    setExpandedReasoningByMessageId({});
    setQueryingTaskByMessageId({});
    setNotice('');
  }

  async function addAttachments(kind: 'image' | 'video' | 'file') {
    setNotice('');

    try {
      const picked =
        kind === 'image' ? await pickImages() : kind === 'video' ? await pickVideos() : await pickFiles();
      setAttachments((current) => [...current, ...picked]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '附件选择失败。');
    }
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  }

  function updateAssistantMessage(messageId: string, patch: Partial<ChatMessage>) {
    setWorkspace((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === messageId ? { ...message, ...patch } : message
      ),
    }));
  }

  function toggleReasoning(messageId: string) {
    setExpandedReasoningByMessageId((current) => ({
      ...current,
      [messageId]: !current[messageId],
    }));
  }

  function inferMessageGenerationTask(message: ChatMessage): GenerationTaskInfo | undefined {
    const match = message.content.match(/cgt-[A-Za-z0-9-]+/);
    if (!match || !activeProvider || !activeModelId || activeModelTask !== 'video-generation') {
      return undefined;
    }

    const statusMatch = message.content.match(/当前状态[:：]\s*([A-Za-z_-]+)/);

    return {
      providerId: activeProvider.id,
      modelId: activeModelId,
      taskId: match[0],
      kind: 'video',
      status: statusMatch?.[1],
    };
  }

  async function refreshGenerationTask(message: ChatMessage, task: GenerationTaskInfo) {
    const provider = workspace.providers.find((item) => item.id === task.providerId);
    if (!provider) {
      setNotice('找不到这个生成任务对应的服务商。');
      return;
    }

    setQueryingTaskByMessageId((current) => ({
      ...current,
      [message.id]: true,
    }));
    setNotice('');

    try {
      const result = await queryGenerationTask(provider, task);
      updateAssistantMessage(message.id, {
        content: result.content,
        attachments: result.attachments ?? message.attachments,
        generationTask: result.generationTask,
        usage: result.usage ?? message.usage,
        status: 'ready',
        error: undefined,
      });
    } catch (error) {
      const content = error instanceof Error ? error.message : '生成任务查询失败。';
      updateAssistantMessage(message.id, {
        content,
        status: 'error',
        error: content,
      });
    } finally {
      setQueryingTaskByMessageId((current) => ({
        ...current,
        [message.id]: false,
      }));
    }
  }

  async function sendMessage() {
    const content = input.trim();
    if (!content && attachments.length === 0) {
      return;
    }

    if (!activeProvider) {
      setNotice('请先选择服务商。');
      return;
    }

    if (!activeModel) {
      setNotice('请先添加并选择模型。');
      return;
    }

    const userMessage: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content,
      attachments,
      createdAt: Date.now(),
      status: 'ready',
    };
    const assistantMessage: ChatMessage = {
      id: createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'pending',
    };
    const transcript = [...workspace.messages.filter((message) => message.id !== 'welcome'), userMessage].slice(-12);

    setInput('');
    setAttachments([]);
    setBusy(true);
    setNotice('');
    setWorkspace((current) => ({
      ...current,
      messages: [...current.messages.filter((message) => message.id !== 'welcome'), userMessage, assistantMessage],
    }));

    try {
      const result = await sendOpenAiCompatibleChat({
        provider: activeProvider,
        modelId: activeModelId,
        messages: transcript,
        reasoningEffort: activeReasoningEffort,
        onStreamUpdate: (update) => {
          updateAssistantMessage(assistantMessage.id, {
            content: update.content,
            reasoningContent: update.reasoningContent,
            usage: update.usage,
            status: 'pending',
          });
        },
      });

      updateAssistantMessage(assistantMessage.id, {
        content: result.content,
        reasoningContent: result.reasoningContent,
        usage: result.usage,
        attachments: result.attachments,
        generationTask: result.generationTask,
        status: 'ready',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '对话请求失败。';
      updateAssistantMessage(assistantMessage.id, {
        content: message,
        status: 'error',
        error: message,
      });
    } finally {
      setBusy(false);
    }
  }

  if (booting || !activeProvider) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.loadingShell}>
          <ActivityIndicator color={palette.accent} />
          <Text style={styles.loadingText}>正在加载工作区</Text>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.shell}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboard}
        >
          <View style={styles.topBar}>
            <View style={styles.topHeaderRow}>
              <View style={styles.topLeft}>
                <AnimatedPressable accessibilityRole="button" onPress={() => setSidebarOpen(true)} style={styles.iconButton}>
                  <Menu size={20} color={palette.text} strokeWidth={2} />
                </AnimatedPressable>
                <AnimatedPressable
                  accessibilityRole="button"
                  testID="model-picker-trigger"
                  onPress={() => setModelPickerOpen(true)}
                  style={styles.modelPickerPill}
                >
                  <Text numberOfLines={1} style={styles.modelPickerPillText}>
                    {(activeModel?.name ?? activeModelId) || '选择模型'}
                  </Text>
                  <ChevronDown size={16} color={palette.textSecondary} strokeWidth={2} />
                </AnimatedPressable>
              </View>
              <AnimatedPressable
                accessibilityRole="button"
                onPress={() => setSettingsOpen((current) => !current)}
                style={styles.iconButton}
              >
                {settingsOpen ? <MessageSquare size={20} color={palette.text} strokeWidth={2} /> : <Settings size={20} color={palette.text} strokeWidth={2} />}
              </AnimatedPressable>
            </View>
            {activeModelId && activeModelTask === 'chat' ? (
              <View style={styles.reasoningControl}>
                <Text style={styles.reasoningLabel}>思考</Text>
                <ScrollView
                  horizontal
                  style={styles.reasoningScroller}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.reasoningOptions}
                >
                  {reasoningEffortOptions.map((option) => {
                    const active = option.key === activeReasoningEffort;

                    return (
                      <AnimatedPressable
                        key={option.key}
                        accessibilityRole="button"
                        testID={`reasoning-effort-${option.key}`}
                        onPress={() => setActiveReasoningEffort(option.key)}
                        style={[
                          styles.reasoningOption,
                          active && styles.reasoningOptionActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.reasoningOptionText,
                            active && styles.reasoningOptionTextActive,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </AnimatedPressable>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}
          </View>

          <ModelPickerModal
            visible={modelPickerOpen}
            groups={providerModelGroups}
            activeProviderId={activeProvider.id}
            activeModelId={activeModelId}
            onClose={() => setModelPickerOpen(false)}
            onSelect={selectProviderModel}
          />

          {settingsOpen ? (
            <ScreenFade>
              <ScrollView style={styles.content} contentContainerStyle={styles.settingsContent}>

              <View style={styles.settingsCard}>
                <Text style={styles.settingsCardTitle}>服务商</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.providerRow}>
                  {workspace.providers.map((provider) => (
                    <AnimatedPressable
                      key={provider.id}
                      accessibilityRole="button"
                      onPress={() => selectProvider(provider.id)}
                      style={[
                        styles.providerChip,
                        provider.id === activeProvider.id && styles.providerChipActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.providerChipText,
                          provider.id === activeProvider.id && styles.providerChipTextActive,
                        ]}
                      >
                        {provider.name}
                      </Text>
                    </AnimatedPressable>
                  ))}
                  <AnimatedPressable
                    accessibilityRole="button"
                    onPress={addCustomProvider}
                    style={styles.providerChip}
                  >
                    <Text style={styles.providerChipText}>+ 新增</Text>
                  </AnimatedPressable>
                </ScrollView>
              </View>

              <View style={styles.settingsCard}>
                <Text style={styles.settingsCardTitle}>连接配置</Text>
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>名称</Text>
                  <TextInput
                    value={activeProvider.name}
                    onChangeText={(name) => updateActiveProvider({ name })}
                    style={styles.input}
                  />
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>Base URL</Text>
                  <TextInput
                    autoCapitalize="none"
                    value={activeProvider.baseUrl}
                    onChangeText={(baseUrl) => updateActiveProvider({ baseUrl })}
                    style={styles.input}
                  />
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>API Key</Text>
                  <TextInput
                    autoCapitalize="none"
                    secureTextEntry
                    value={activeProvider.apiKey ?? ''}
                    onChangeText={(apiKey) => updateActiveProvider({ apiKey })}
                    style={styles.input}
                  />
                </View>

                <View style={styles.capabilityRow}>
                  {activeProvider.capabilities.map((capability) => (
                    <View key={capability} style={styles.capabilityChip}>
                      <Text style={styles.capabilityText}>{capabilityLabel[capability] ?? capability}</Text>
                    </View>
                  ))}
                </View>

                <AnimatedPressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={refreshModels}
                  style={[styles.primaryButton, busy && styles.buttonDisabled]}
                >
                  <Text style={styles.primaryButtonText}>{busy ? '请求中...' : '获取模型'}</Text>
                </AnimatedPressable>
              </View>

              {notice ? <Text style={styles.settingsNotice}>{notice}</Text> : null}

              <View style={styles.settingsCard}>
                <Text style={styles.settingsCardTitle}>可添加模型</Text>
                {modelCandidates.length ? (
                  <>
                    <View style={styles.modelSearchRow}>
                      <TextInput
                        testID="candidate-model-search"
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder="搜索模型名称或 ID"
                        placeholderTextColor={palette.placeholder}
                        value={modelSearchQuery}
                        onChangeText={setModelSearchQuery}
                        style={[styles.input, styles.modelSearchInput]}
                      />
                      {modelSearchQuery ? (
                        <AnimatedPressable
                          accessibilityRole="button"
                          onPress={() => setModelSearchQuery('')}
                          style={styles.secondaryButton}
                        >
                          <Text style={styles.secondaryButtonText}>清除</Text>
                        </AnimatedPressable>
                      ) : null}
                    </View>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.modelFilterTabs}
                    >
                      {candidateModelFilters.map((filter) => {
                        const active = filter.key === modelCapabilityFilter;

                        return (
                          <Pressable
                            key={filter.key}
                            accessibilityRole="button"
                            testID={`candidate-model-filter-${filter.key}`}
                            onPress={() => setModelCapabilityFilter(filter.key)}
                            style={styles.modelFilterTab}
                          >
                            <Text
                              style={[
                                styles.modelFilterTabText,
                                active && styles.modelFilterTabTextActive,
                              ]}
                            >
                              {filter.label}
                            </Text>
                            <View style={[styles.modelFilterTabLine, active && styles.modelFilterTabLineActive]} />
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                    <Text testID="candidate-model-search-count" style={styles.modelSearchMeta}>
                      显示 {filteredModelCandidates.length} / {modelCandidates.length}
                    </Text>
                  </>
                ) : null}
                <View style={styles.modelList}>
                  {filteredModelCandidates.map((model) => (
                    <CandidateModelRow
                      key={model.id}
                      model={model}
                      added={addedModelIds.has(model.id)}
                      onAdd={() => addCandidateModel(model)}
                    />
                  ))}
                  {modelCandidates.length && !filteredModelCandidates.length ? (
                    <View style={styles.modelSearchEmpty}>
                      <Text style={styles.modelSearchEmptyText}>没有匹配的模型</Text>
                    </View>
                  ) : null}
                </View>
              </View>

              <View style={styles.settingsCard}>
                <Text style={styles.settingsCardTitle}>已添加模型</Text>
                <View style={styles.inlineField}>
                  <TextInput
                    autoCapitalize="none"
                    placeholder="手动模型 ID"
                    placeholderTextColor={palette.placeholder}
                    value={manualModelId}
                    onChangeText={setManualModelId}
                    style={[styles.input, styles.inlineInput]}
                  />
                  <AnimatedPressable
                    accessibilityRole="button"
                    onPress={addManualModel}
                    style={styles.secondaryButton}
                  >
                    <Text style={styles.secondaryButtonText}>添加</Text>
                  </AnimatedPressable>
                </View>
                <View style={styles.modelList}>
                  {addedModels.map((model) => (
                    <ModelButton
                      key={model.id}
                      model={model}
                      active={model.id === activeModelId}
                      onPress={() => selectModel(model.id)}
                      onRemove={() => removeModel(model.id)}
                    />
                  ))}
                </View>
              </View>

              </ScrollView>
            </ScreenFade>
          ) : (
            <ScreenFade>
              <ScrollView style={styles.content} contentContainerStyle={styles.chatContent}>
                {workspace.messages.map((message) => {
                  const generationTask =
                    message.role === 'assistant'
                      ? message.generationTask ?? inferMessageGenerationTask(message)
                      : undefined;
                  const showThinking =
                    message.role === 'assistant' &&
                    message.status === 'pending' &&
                    !message.content &&
                    !message.reasoningContent;

                  return (
                  <AnimatedMessage
                    key={message.id}
                    style={[
                      styles.messageBubble,
                      message.role === 'user' ? styles.userBubble : styles.assistantBubble,
                      message.status === 'error' && styles.errorBubble,
                    ]}
                  >
                    <Text
                      style={[
                        styles.messageRole,
                        message.role === 'user' ? styles.userRole : styles.assistantRole,
                      ]}
                    >
                      {message.role === 'user' ? '你' : 'Claude'}
                    </Text>
                    {showThinking ? (
                      <ThinkingDots />
                    ) : (
                      <Text
                        style={[
                          styles.messageText,
                          message.role === 'user' && styles.userMessageText,
                        ]}
                      >
                        {message.content}
                      </Text>
                    )}
                    {message.role === 'assistant' && message.reasoningContent ? (
                      <View style={styles.reasoningPanel}>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => toggleReasoning(message.id)}
                          style={styles.reasoningPanelHeader}
                        >
                          <Text style={styles.reasoningPanelTitle}>思考过程</Text>
                          <Text style={styles.reasoningPanelAction}>
                            {expandedReasoningByMessageId[message.id] ? '收起' : '展开'}
                          </Text>
                        </Pressable>
                        {expandedReasoningByMessageId[message.id] ? (
                          <Text style={styles.reasoningPanelText}>{message.reasoningContent}</Text>
                        ) : null}
                      </View>
                    ) : null}
                    {message.role === 'assistant' && message.usage ? (
                      <TokenUsageLine usage={message.usage} />
                    ) : null}
                    {message.role === 'assistant' && generationTask ? (
                      <GenerationTaskPanel
                        task={generationTask}
                        busy={Boolean(queryingTaskByMessageId[message.id])}
                        onRefresh={() => refreshGenerationTask(message, generationTask)}
                      />
                    ) : null}
                    {message.attachments?.length ? (
                      <View style={styles.attachmentGrid}>
                        {message.attachments.map((attachment) => (
                          <AttachmentPreview key={attachment.id} attachment={attachment} />
                        ))}
                      </View>
                    ) : null}
                  </AnimatedMessage>
                  );
                })}
              </ScrollView>

              {notice ? <Text style={styles.notice}>{notice}</Text> : null}

              {attachments.length ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.pendingAttachments}
                >
                  {attachments.map((attachment) => (
                    <AnimatedPressable
                      key={attachment.id}
                      accessibilityRole="button"
                      onPress={() => removeAttachment(attachment.id)}
                      style={styles.pendingAttachment}
                    >
                      <Text style={styles.pendingAttachmentText}>{attachment.kind}</Text>
                      <Text numberOfLines={1} style={styles.pendingAttachmentName}>
                        {attachment.name}
                      </Text>
                    </AnimatedPressable>
                  ))}
                </ScrollView>
              ) : null}

              {attachMenuOpen ? (
                <Pressable style={styles.attachMenuBackdrop} onPress={() => setAttachMenuOpen(false)} />
              ) : null}
              <View style={styles.composerWrapper}>
                {attachMenuOpen ? (
                  <View style={styles.attachMenu}>
                    <AnimatedPressable accessibilityRole="button" onPress={() => { addAttachments('image'); setAttachMenuOpen(false); }} style={styles.attachMenuItem}>
                      <View style={styles.attachMenuIcon}><ImageIcon size={18} color={palette.text} strokeWidth={2} /></View>
                      <Text style={styles.attachMenuText}>照片</Text>
                    </AnimatedPressable>
                    <AnimatedPressable accessibilityRole="button" onPress={() => { addAttachments('video'); setAttachMenuOpen(false); }} style={styles.attachMenuItem}>
                      <View style={styles.attachMenuIcon}><Camera size={18} color={palette.text} strokeWidth={2} /></View>
                      <Text style={styles.attachMenuText}>视频</Text>
                    </AnimatedPressable>
                    <AnimatedPressable accessibilityRole="button" onPress={() => { addAttachments('file'); setAttachMenuOpen(false); }} style={styles.attachMenuItem}>
                      <View style={styles.attachMenuIcon}><Paperclip size={18} color={palette.text} strokeWidth={2} /></View>
                      <Text style={styles.attachMenuText}>文件</Text>
                    </AnimatedPressable>
                  </View>
                ) : null}
                <View style={styles.composer}>
                  <AnimatedPressable
                    accessibilityRole="button"
                    onPress={() => setAttachMenuOpen((v) => !v)}
                    style={styles.attachButton}
                  >
                    <Plus size={16} color={palette.textSecondary} strokeWidth={2.5} />
                  </AnimatedPressable>
                  <TextInput
                    multiline
                    placeholder="今天如何？"
                    placeholderTextColor={palette.placeholder}
                    value={input}
                    onChangeText={setInput}
                    style={styles.composerInput}
                  />
                  <AnimatedPressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={sendMessage}
                    style={[styles.sendButton, busy && styles.buttonDisabled]}
                  >
                    <Text style={styles.sendButtonText}>{busy ? '···' : '↑'}</Text>
                  </AnimatedPressable>
                </View>
              </View>
            </ScreenFade>
          )}
        </KeyboardAvoidingView>

        {/* Sidebar drawer */}
        <Modal visible={sidebarOpen} transparent animationType="none" onRequestClose={() => setSidebarOpen(false)}>
          <Pressable style={styles.sidebarScrim} onPress={() => setSidebarOpen(false)}>
            <Pressable style={styles.sidebarPanel} onPress={(e) => e.stopPropagation()}>
              <View style={styles.sidebarHeader}>
                <Text style={styles.sidebarBrand}>Embezzle Studio</Text>
                <AnimatedPressable accessibilityRole="button" onPress={() => setSidebarOpen(false)} style={styles.sidebarClose}>
                  <X size={20} color={palette.text} strokeWidth={2} />
                </AnimatedPressable>
              </View>

              <AnimatedPressable
                accessibilityRole="button"
                onPress={() => { clearMessages(); setSidebarOpen(false); }}
                style={styles.sidebarNewChat}
              >
                <PenSquare size={18} color={palette.textOnAccent} strokeWidth={2} />
                <Text style={styles.sidebarNewChatText}>新对话</Text>
              </AnimatedPressable>

              <View style={styles.sidebarSection}>
                <Text style={styles.sidebarSectionTitle}>最近</Text>
                <Text style={styles.sidebarEmpty}>暂无历史对话</Text>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function formatTokenCount(value?: number) {
  return typeof value === 'number' ? value.toLocaleString() : '-';
}

function TokenUsageLine({ usage }: { usage: ChatTokenUsage }) {
  return (
    <View style={styles.tokenUsageRow}>
      <View style={styles.tokenUsageChip}>
        <Text style={styles.tokenUsageLabel}>上传</Text>
        <Text style={styles.tokenUsageValue}>{formatTokenCount(usage.inputTokens)}</Text>
      </View>
      <View style={styles.tokenUsageChip}>
        <Text style={styles.tokenUsageLabel}>下载</Text>
        <Text style={styles.tokenUsageValue}>{formatTokenCount(usage.outputTokens)}</Text>
      </View>
      {typeof usage.reasoningTokens === 'number' ? (
        <View style={styles.tokenUsageChip}>
          <Text style={styles.tokenUsageLabel}>推理</Text>
          <Text style={styles.tokenUsageValue}>{formatTokenCount(usage.reasoningTokens)}</Text>
        </View>
      ) : null}
      {typeof usage.cachedInputTokens === 'number' ? (
        <View style={styles.tokenUsageChip}>
          <Text style={styles.tokenUsageLabel}>缓存</Text>
          <Text style={styles.tokenUsageValue}>{formatTokenCount(usage.cachedInputTokens)}</Text>
        </View>
      ) : null}
      <View style={styles.tokenUsageChip}>
        <Text style={styles.tokenUsageLabel}>合计</Text>
        <Text style={styles.tokenUsageValue}>{formatTokenCount(usage.totalTokens)}</Text>
      </View>
    </View>
  );
}

function GenerationTaskPanel({
  task,
  busy,
  onRefresh,
}: {
  task: GenerationTaskInfo;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <View style={styles.generationTaskPanel}>
      <View style={styles.generationTaskInfo}>
        <Text style={styles.generationTaskTitle}>视频生成任务</Text>
        <Text numberOfLines={1} style={styles.generationTaskMeta}>
          {task.taskId}
        </Text>
        <Text style={styles.generationTaskStatus}>状态：{task.status ?? 'submitted'}</Text>
      </View>
      <AnimatedPressable
        accessibilityRole="button"
        disabled={busy}
        onPress={onRefresh}
        style={[styles.generationTaskButton, busy && styles.buttonDisabled]}
      >
        <Text style={styles.generationTaskButtonText}>{busy ? '查询中' : '查询结果'}</Text>
      </AnimatedPressable>
    </View>
  );
}

interface ModelPickerModalProps {
  visible: boolean;
  groups: Array<{
    provider: ProviderProfile;
    models: ModelInfo[];
  }>;
  activeProviderId: string;
  activeModelId: string;
  onClose: () => void;
  onSelect: (providerId: string, modelId: string) => void;
}

function ModelPickerModal({
  visible,
  groups,
  activeProviderId,
  activeModelId,
  onClose,
  onSelect,
}: ModelPickerModalProps) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.timing(anim, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver,
      }).start();
    } else {
      anim.setValue(0);
    }
  }, [anim, visible]);

  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [40, 0],
  });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modelPickerModalRoot}>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.modelPickerBackdrop} />
        <Animated.View
          testID="model-picker-sheet"
          style={[styles.modelPickerSheet, { opacity: anim, transform: [{ translateY }] }]}
        >
          <View style={styles.modelPickerHandle} />
          <View style={styles.modelPickerSheetHeader}>
            <View style={styles.modelPickerTitleBlock}>
              <Text style={styles.modelPickerTitle}>选择模型</Text>
              <Text style={styles.modelPickerSubtitle}>已添加模型</Text>
            </View>
            <AnimatedPressable accessibilityRole="button" onPress={onClose} style={styles.modelPickerCloseButton}>
              <Text style={styles.modelPickerCloseText}>×</Text>
            </AnimatedPressable>
          </View>

          <ScrollView contentContainerStyle={styles.modelPickerList}>
            {groups.length ? (
              groups.map((group) => (
                <View key={group.provider.id} style={styles.modelPickerGroup}>
                  <View style={styles.modelPickerGroupHeader}>
                    <Text numberOfLines={1} style={styles.modelPickerGroupName}>
                      {group.provider.name}
                    </Text>
                    <Text style={styles.modelPickerGroupCount}>{group.models.length}</Text>
                  </View>
                  {group.models.map((model) => {
                    const selected = group.provider.id === activeProviderId && model.id === activeModelId;

                    return (
                      <AnimatedPressable
                        key={`${group.provider.id}:${model.id}`}
                        accessibilityRole="button"
                        onPress={() => onSelect(group.provider.id, model.id)}
                        style={[
                          styles.modelPickerRow,
                          selected && styles.modelPickerRowActive,
                        ]}
                      >
                        <View style={styles.modelPickerRowTextBlock}>
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.modelPickerRowName,
                              selected && styles.modelPickerRowNameActive,
                            ]}
                          >
                            {model.name ?? model.id}
                          </Text>
                          <Text numberOfLines={1} style={styles.modelPickerRowMeta}>
                            {model.id}
                          </Text>
                        </View>
                        <ModelTaskBadge model={model} />
                        {selected ? <Text style={styles.modelPickerSelectedText}>当前</Text> : null}
                      </AnimatedPressable>
                    );
                  })}
                </View>
              ))
            ) : (
              <View style={styles.modelPickerEmpty}>
                <Text style={styles.modelPickerEmptyText}>暂无已添加模型</Text>
              </View>
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

interface ModelButtonProps {
  model: ModelInfo;
  active: boolean;
  onPress: () => void;
  onRemove: () => void;
}

function ModelTaskBadge({ model }: { model: ModelInfo }) {
  const task = inferModelTask(model);

  return (
    <View style={styles.modelTaskBadge}>
      <Text style={styles.modelTaskBadgeText}>{modelTaskLabel[task]}</Text>
    </View>
  );
}

function ModelButton({ model, active, onPress, onRemove }: ModelButtonProps) {
  return (
    <View style={[styles.modelButton, active && styles.modelButtonActive]}>
      <AnimatedPressable accessibilityRole="button" onPress={onPress} style={styles.modelSelectArea}>
        <Text numberOfLines={1} style={[styles.modelName, active && styles.modelNameActive]}>
          {model.name ?? model.id}
        </Text>
        <Text numberOfLines={1} style={styles.modelMeta}>
          {model.id}
        </Text>
        <ModelTaskBadge model={model} />
      </AnimatedPressable>
      <AnimatedPressable accessibilityRole="button" onPress={onRemove} style={styles.compactButton}>
        <Text style={styles.compactButtonText}>删除</Text>
      </AnimatedPressable>
    </View>
  );
}

interface CandidateModelRowProps {
  model: ModelInfo;
  added: boolean;
  onAdd: () => void;
}

function CandidateModelRow({ model, added, onAdd }: CandidateModelRowProps) {
  return (
    <View style={styles.candidateRow}>
      <View style={styles.modelTextBlock}>
        <Text numberOfLines={1} style={styles.modelName}>
          {model.name ?? model.id}
        </Text>
        <Text numberOfLines={1} style={styles.modelMeta}>
          {model.id}
        </Text>
        <ModelTaskBadge model={model} />
      </View>
      <AnimatedPressable
        accessibilityRole="button"
        disabled={added}
        onPress={onAdd}
        style={[styles.addModelButton, added && styles.addModelButtonAdded]}
      >
        <Text style={[styles.addModelButtonText, added && styles.addModelButtonTextAdded]}>
          {added ? '已添加' : '+'}
        </Text>
      </AnimatedPressable>
    </View>
  );
}

function AttachmentPreview({ attachment }: { attachment: MediaAttachment }) {
  if (attachment.kind === 'image') {
    return <Image source={{ uri: attachment.uri }} style={styles.attachmentImage} />;
  }

  if (attachment.kind === 'video') {
    return (
      <View style={styles.attachmentVideoCard}>
        {Platform.OS === 'web' ? (
          createElement('video', {
            controls: true,
            src: attachment.uri,
            style: webVideoPreviewStyle,
          })
        ) : (
          <View style={styles.attachmentVideoPlaceholder}>
            <Text style={styles.attachmentKind}>VIDEO</Text>
          </View>
        )}
        <View style={styles.attachmentVideoFooter}>
          <Text numberOfLines={1} style={styles.attachmentFileName}>
            {attachment.name}
          </Text>
          <AnimatedPressable
            accessibilityRole="button"
            onPress={() => {
              void Linking.openURL(attachment.uri);
            }}
            style={styles.attachmentOpenButton}
          >
            <Text style={styles.attachmentOpenButtonText}>打开</Text>
          </AnimatedPressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.attachmentFile}>
      <Text style={styles.attachmentKind}>{attachment.kind.toUpperCase()}</Text>
      <Text numberOfLines={1} style={styles.attachmentFileName}>
        {attachment.name}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  keyboard: {
    flex: 1,
  },
  screenFade: {
    flex: 1,
  },
  loadingShell: {
    flex: 1,
    backgroundColor: palette.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 12,
    color: palette.textSecondary,
    fontSize: 14,
  },
  topBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: palette.bg,
  },
  topHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  modelPickerPill: {
    height: 40,
    borderRadius: radii.pill,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 6,
  },
  modelPickerPillText: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '600',
    maxWidth: 160,
  },
  modelPickerLabelBadge: {
    height: 27,
    borderRadius: radii.sm,
    backgroundColor: palette.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  modelPickerLabelText: {
    color: palette.accentText,
    fontSize: 12,
    fontWeight: '700',
  },
  modelPickerCurrent: {
    flex: 1,
    minWidth: 0,
  },
  modelPickerProviderText: {
    color: palette.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  modelPickerModelText: {
    marginTop: 2,
    color: palette.text,
    fontSize: 15,
    fontWeight: '600',
  },
  modelPickerChevron: {
    color: palette.textSecondary,
    fontSize: 16,
    fontWeight: '700',
  },
  reasoningControl: {
    minHeight: 40,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
  },
  reasoningLabel: {
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  reasoningScroller: {
    flex: 1,
  },
  reasoningOptions: {
    gap: 7,
    paddingRight: 8,
    paddingVertical: 6,
  },
  reasoningOption: {
    height: 28,
    minWidth: 42,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    backgroundColor: palette.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  reasoningOptionActive: {
    borderColor: palette.accentBorder,
    backgroundColor: palette.accentSoft,
  },
  reasoningOptionText: {
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  reasoningOptionTextActive: {
    color: palette.accentText,
    fontWeight: '700',
  },
  secondaryButton: {
    height: 40,
    minWidth: 60,
    paddingHorizontal: 16,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
  },
  secondaryButtonText: {
    color: palette.text,
    fontWeight: '600',
    fontSize: 14,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
  },
  content: {
    flex: 1,
  },
  settingsContent: {
    padding: 16,
    gap: 16,
  },
  chatContent: {
    padding: 16,
    gap: 18,
  },
  sectionTitle: {
    color: palette.text,
    fontSize: 17,
    fontWeight: '600',
    fontFamily: serifFont,
  },
  settingsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: radii.lg,
    padding: 16,
    gap: 14,
  },
  settingsCardTitle: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  providerRow: {
    gap: 10,
    paddingRight: 18,
    paddingVertical: 2,
  },
  providerChip: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.bg,
  },
  providerChipActive: {
    backgroundColor: palette.accent,
    borderColor: palette.accent,
  },
  providerChipText: {
    color: palette.text,
    fontWeight: '500',
    fontSize: 14,
  },
  providerChipTextActive: {
    color: palette.textOnAccent,
  },
  fieldGroup: {
    gap: 8,
  },
  fieldLabel: {
    color: palette.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  input: {
    minHeight: 44,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.bg,
    paddingHorizontal: 14,
    color: palette.text,
    fontSize: 15,
  },
  capabilityRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  capabilityChip: {
    borderRadius: radii.pill,
    backgroundColor: palette.surfaceAlt,
    borderWidth: 1,
    borderColor: palette.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  capabilityText: {
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
  },
  inlineField: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  inlineInput: {
    flex: 1,
  },
  primaryButton: {
    height: 48,
    paddingHorizontal: 20,
    borderRadius: radii.pill,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: palette.textOnAccent,
    fontWeight: '600',
    fontSize: 15,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  modelList: {
    gap: 10,
  },
  modelSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  modelSearchInput: {
    flex: 1,
  },
  modelFilterTabs: {
    paddingRight: 18,
    gap: 22,
  },
  modelFilterTab: {
    height: 34,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modelFilterTabText: {
    color: palette.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  modelFilterTabTextActive: {
    color: palette.accentText,
    fontWeight: '700',
  },
  modelFilterTabLine: {
    width: '100%',
    height: 2,
    borderRadius: 2,
    backgroundColor: 'transparent',
  },
  modelFilterTabLineActive: {
    backgroundColor: palette.accent,
  },
  modelSearchMeta: {
    marginTop: -8,
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  modelSearchEmpty: {
    minHeight: 70,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelSearchEmptyText: {
    color: palette.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  modelButton: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  modelButtonActive: {
    borderColor: palette.accentBorder,
    backgroundColor: palette.accentSoft,
  },
  modelSelectArea: {
    flex: 1,
    minWidth: 0,
  },
  modelTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  modelName: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '600',
  },
  modelNameActive: {
    color: palette.accentText,
  },
  modelMeta: {
    marginTop: 4,
    color: palette.textSecondary,
    fontSize: 12,
  },
  modelTaskBadge: {
    alignSelf: 'flex-start',
    marginTop: 6,
    borderRadius: radii.pill,
    backgroundColor: palette.surfaceAlt,
    borderWidth: 1,
    borderColor: palette.border,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  modelTaskBadgeText: {
    color: palette.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  candidateRow: {
    minHeight: 60,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  addModelButton: {
    minWidth: 48,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  addModelButtonAdded: {
    backgroundColor: palette.surfaceAlt,
    borderWidth: 1,
    borderColor: palette.border,
  },
  addModelButtonText: {
    color: palette.textOnAccent,
    fontSize: 14,
    fontWeight: '700',
  },
  addModelButtonTextAdded: {
    color: palette.textSecondary,
  },
  compactButton: {
    height: 36,
    minWidth: 52,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    backgroundColor: palette.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  compactButtonText: {
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  modelPickerModalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: palette.scrim,
  },
  modelPickerBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  modelPickerSheet: {
    maxHeight: '82%',
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    backgroundColor: palette.surface,
    paddingTop: 8,
    shadowColor: '#2A2018',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.16,
    shadowRadius: 24,
    elevation: 16,
    overflow: 'hidden',
  },
  modelPickerHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: palette.borderStrong,
    marginBottom: 6,
  },
  modelPickerSheetHeader: {
    minHeight: 58,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  modelPickerTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  modelPickerTitle: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '600',
    fontFamily: serifFont,
  },
  modelPickerSubtitle: {
    marginTop: 3,
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  modelPickerCloseButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
  },
  modelPickerCloseText: {
    color: palette.textSecondary,
    fontSize: 20,
    lineHeight: 22,
    fontWeight: '600',
  },
  modelPickerList: {
    padding: 14,
    gap: 14,
  },
  modelPickerGroup: {
    gap: 8,
  },
  modelPickerGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  modelPickerGroupName: {
    flex: 1,
    color: palette.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
  modelPickerGroupCount: {
    minWidth: 24,
    height: 22,
    borderRadius: radii.pill,
    backgroundColor: palette.surfaceAlt,
    color: palette.textSecondary,
    overflow: 'hidden',
    textAlign: 'center',
    textAlignVertical: 'center',
    fontSize: 11,
    fontWeight: '700',
  },
  modelPickerRow: {
    minHeight: 56,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  modelPickerRowActive: {
    borderColor: palette.accentBorder,
    backgroundColor: palette.accentSoft,
  },
  modelPickerRowTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  modelPickerRowName: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '600',
  },
  modelPickerRowNameActive: {
    color: palette.accentText,
  },
  modelPickerRowMeta: {
    marginTop: 4,
    color: palette.textSecondary,
    fontSize: 12,
  },
  modelPickerSelectedText: {
    borderRadius: radii.pill,
    backgroundColor: palette.accent,
    color: palette.textOnAccent,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 5,
    fontSize: 12,
    fontWeight: '700',
  },
  modelPickerEmpty: {
    minHeight: 84,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelPickerEmptyText: {
    color: palette.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  messageBubble: {
    maxWidth: '100%',
  },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '86%',
    backgroundColor: palette.surfaceAlt,
    borderRadius: radii.lg,
    borderTopRightRadius: radii.sm,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  assistantBubble: {
    alignSelf: 'stretch',
    paddingHorizontal: 2,
  },
  errorBubble: {
    alignSelf: 'stretch',
    backgroundColor: palette.dangerBg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dangerBorder,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  messageRole: {
    marginBottom: 6,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  userRole: {
    color: palette.textSecondary,
  },
  assistantRole: {
    color: palette.accentText,
  },
  messageText: {
    color: palette.text,
    fontSize: 16,
    lineHeight: 25,
  },
  userMessageText: {
    color: palette.text,
  },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
  },
  thinkingDot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill,
    backgroundColor: palette.accent,
  },
  reasoningPanel: {
    marginTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
    paddingTop: 10,
    gap: 8,
  },
  reasoningPanelHeader: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  reasoningPanelTitle: {
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  reasoningPanelAction: {
    color: palette.accentText,
    fontSize: 12,
    fontWeight: '700',
  },
  reasoningPanelText: {
    color: palette.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  tokenUsageRow: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tokenUsageChip: {
    minHeight: 26,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surfaceAlt,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
  },
  tokenUsageLabel: {
    color: palette.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  tokenUsageValue: {
    color: palette.text,
    fontSize: 11,
    fontWeight: '700',
  },
  generationTaskPanel: {
    marginTop: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surfaceAlt,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  generationTaskInfo: {
    flex: 1,
    minWidth: 0,
  },
  generationTaskTitle: {
    color: palette.text,
    fontSize: 12,
    fontWeight: '700',
  },
  generationTaskMeta: {
    marginTop: 4,
    color: palette.textSecondary,
    fontSize: 12,
  },
  generationTaskStatus: {
    marginTop: 4,
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  generationTaskButton: {
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  generationTaskButtonText: {
    color: palette.textOnAccent,
    fontSize: 12,
    fontWeight: '700',
  },
  attachmentGrid: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  attachmentImage: {
    width: 96,
    height: 96,
    borderRadius: radii.md,
    backgroundColor: palette.surfaceAlt,
  },
  attachmentFile: {
    width: 120,
    minHeight: 74,
    borderRadius: radii.md,
    backgroundColor: palette.surfaceAlt,
    borderWidth: 1,
    borderColor: palette.border,
    padding: 12,
    justifyContent: 'space-between',
  },
  attachmentKind: {
    color: palette.accentText,
    fontSize: 11,
    fontWeight: '700',
  },
  attachmentFileName: {
    color: palette.text,
    fontSize: 12,
  },
  attachmentVideoCard: {
    width: 220,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surfaceAlt,
    overflow: 'hidden',
  },
  attachmentVideoPlaceholder: {
    height: 128,
    backgroundColor: palette.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentVideoFooter: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  attachmentOpenButton: {
    height: 30,
    borderRadius: radii.pill,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  attachmentOpenButtonText: {
    color: palette.textOnAccent,
    fontSize: 12,
    fontWeight: '700',
  },
  notice: {
    marginHorizontal: 16,
    marginBottom: 8,
    color: palette.warning,
    fontSize: 12,
  },
  settingsNotice: {
    color: palette.warning,
    fontSize: 12,
    lineHeight: 18,
  },
  pendingAttachments: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 8,
  },
  pendingAttachment: {
    width: 132,
    minHeight: 54,
    borderRadius: radii.md,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
    padding: 10,
  },
  pendingAttachmentText: {
    color: palette.accentText,
    fontSize: 11,
    fontWeight: '700',
  },
  pendingAttachmentName: {
    marginTop: 4,
    color: palette.textSecondary,
    fontSize: 12,
  },
  attachButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: palette.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachMenuBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
  },
  attachMenu: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    marginBottom: 8,
    backgroundColor: palette.bg,
    borderRadius: radii.lg,
    paddingVertical: 8,
    paddingHorizontal: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
    minWidth: 180,
  },
  attachMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: 44,
    borderRadius: radii.sm,
    paddingHorizontal: 12,
  },
  attachMenuIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: palette.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachMenuText: {
    color: palette.text,
    fontWeight: '500',
    fontSize: 15,
  },
  composerWrapper: {
    marginHorizontal: 8,
    marginBottom: 12,
    borderRadius: radii.xl,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
    overflow: 'visible',
    zIndex: 20,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 8,
  },
  composerInput: {
    flex: 1,
    minHeight: 28,
    maxHeight: 120,
    paddingVertical: 0,
    color: palette.text,
    fontSize: 15,
    lineHeight: 28,
  },
  sendButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonText: {
    color: palette.textOnAccent,
    fontWeight: '700',
    fontSize: 16,
    lineHeight: 18,
  },
  sidebarScrim: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: palette.scrim,
  },
  sidebarPanel: {
    width: '80%',
    maxWidth: 320,
    backgroundColor: palette.bg,
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  sidebarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  sidebarBrand: {
    color: palette.text,
    fontSize: 22,
    fontWeight: '700',
    fontFamily: serifFont,
  },
  sidebarClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sidebarNewChat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: palette.accent,
    paddingHorizontal: 18,
    alignSelf: 'flex-start',
    marginBottom: 28,
  },
  sidebarNewChatText: {
    color: palette.textOnAccent,
    fontSize: 15,
    fontWeight: '600',
  },
  sidebarSection: {
    flex: 1,
  },
  sidebarSectionTitle: {
    color: palette.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sidebarEmpty: {
    color: palette.placeholder,
    fontSize: 14,
  },
});
