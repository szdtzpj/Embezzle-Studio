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
  PanResponder,
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
import { AudioLines, Camera, ChevronDown, Copy, Download, ExternalLink, Image as ImageIcon, Lightbulb, Menu, MessageSquare, MoreHorizontal, Paperclip, PenSquare, Pencil, Plus, RefreshCw, Search, Share2, Settings, Trash2, X } from 'lucide-react-native';
import { Bailian, ChatGLM, Claude, DeepSeek, Doubao, Gemini, Kimi, Minimax, NewAPI, OpenAI, Qwen, Volcengine, Zhipu } from '@lobehub/icons-rn';

import { isArkStaticDoubaoModelId, isVolcengineArkProvider } from './src/data/arkModels';
import { appInfo } from './src/data/appInfo';
import { createDefaultWorkspace } from './src/data/providerCatalog';
import type {
  AppWorkspace,
  ChatTokenUsage,
  ChatConversation,
  GenerationTaskInfo,
  ChatMessage,
  MessageRole,
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
import { checkForAppUpdate, type AppUpdateInfo } from './src/services/updateChecker';
import {
  createModelInfoFromId,
  inferModelTask,
  isVideoInputModel,
  isVisionModel,
  modelMatchesCapabilityFilter,
  modelSearchText,
  type ModelCapabilityFilter,
} from './src/services/modelCapabilities';

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
const webInteractiveStyle =
  Platform.OS === 'web'
    ? ({
        cursor: 'pointer',
        userSelect: 'none',
      } as unknown as ViewStyle)
    : undefined;

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
  const opacity = useRef(new Animated.Value(disabled ? 0.55 : 1)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: disabled ? 0.55 : 1,
      duration: 120,
      easing: Easing.out(Easing.quad),
      useNativeDriver,
    }).start();
  }, [disabled, opacity]);

  const animateTo = (toScale: number, toOpacity: number) => {
    Animated.parallel([
      Animated.spring(scale, {
        toValue: toScale,
        useNativeDriver,
        speed: 60,
        bounciness: 0,
      }),
      Animated.timing(opacity, {
        toValue: toOpacity,
        duration: 90,
        easing: Easing.out(Easing.quad),
        useNativeDriver,
      }),
    ]).start();
  };

  return (
    <PressableAnimated
      {...rest}
      disabled={disabled}
      onPressIn={(event) => {
        if (!disabled) {
          animateTo(0.93, 0.62);
        }
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        animateTo(1, disabled ? 0.55 : 1);
        onPressOut?.(event);
      }}
      style={[
        style,
        webInteractiveStyle,
        {
          opacity,
          transform: [{ scale }],
        },
      ]}
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
  'file-input': '文件',
  'tool-calling': '工具',
  reasoning: '推理',
  'web-search': '联网',
  'image-generation': '生图',
  'video-generation': '生视频',
  embedding: '嵌入',
  rerank: '重排',
  streaming: '流式',
  mcp: 'MCP',
};

const candidateModelFilters: Array<{ key: ModelCapabilityFilter; label: string }> = [
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
  return modelSearchText(model);
}

function matchesCandidateModelFilter(model: ModelInfo, filter: ModelCapabilityFilter) {
  return modelMatchesCapabilityFilter(model, filter);
}

const maxSavedConversations = 100;

function isConversationMessage(message: ChatMessage): boolean {
  return (
    message.id !== 'welcome' &&
    (message.content.trim().length > 0 ||
      Boolean(message.attachments?.length) ||
      Boolean(message.reasoningContent?.trim()) ||
      Boolean(message.generationTask) ||
      Boolean(message.error))
  );
}

function hasConversationHistory(conversation: ChatConversation): boolean {
  return conversation.messages.some(isConversationMessage);
}

function conversationSearchText(conversation: ChatConversation): string {
  return [
    conversation.title,
    ...conversation.messages.flatMap((message) => [
      message.content,
      message.reasoningContent ?? '',
      message.modelId ?? '',
      message.providerName ?? '',
      message.attachments?.map((attachment) => attachment.name).join(' ') ?? '',
    ]),
  ]
    .join(' ')
    .toLowerCase();
}

function conversationTitleFromMessages(messages: ChatMessage[]): string {
  const userMessage = messages.find(
    (message) => message.role === 'user' && (message.content.trim() || message.attachments?.length)
  );

  if (userMessage?.content.trim()) {
    const title = userMessage.content.trim().replace(/\s+/g, ' ');
    return title.length > 28 ? `${title.slice(0, 28)}...` : title;
  }

  if (userMessage?.attachments?.length) {
    return '附件对话';
  }

  return '新对话';
}

function dominantConversationModel(conversation: ChatConversation): { modelId: string; providerName?: string; count: number } | null {
  const counts = new Map<string, { modelId: string; providerName?: string; count: number; latestAt: number }>();

  for (const message of conversation.messages) {
    if (message.role !== 'assistant' || !message.modelId) {
      continue;
    }

    const key = `${message.providerId ?? message.providerName ?? ''}:${message.modelId}`;
    const current = counts.get(key);
    counts.set(key, {
      modelId: message.modelId,
      providerName: message.providerName,
      count: (current?.count ?? 0) + 1,
      latestAt: Math.max(current?.latestAt ?? 0, message.createdAt),
    });
  }

  return (
    [...counts.values()].sort((a, b) => b.count - a.count || b.latestAt - a.latestAt)[0] ?? null
  );
}

function upsertConversation(
  conversations: ChatConversation[],
  conversationId: string,
  messages: ChatMessage[],
  updatedAt = Date.now()
): ChatConversation[] {
  const existing = conversations.find((conversation) => conversation.id === conversationId);
  const firstTimestamp = messages[0]?.createdAt;
  const conversation: ChatConversation = {
    id: conversationId,
    title: conversationTitleFromMessages(messages),
    createdAt: existing?.createdAt ?? firstTimestamp ?? updatedAt,
    updatedAt,
    messages,
  };

  return [conversation, ...conversations.filter((item) => item.id !== conversationId)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxSavedConversations);
}

function formatConversationTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function formatUpdateStatusTitle(updateInfo: AppUpdateInfo | null, updateNotice: string) {
  if (updateInfo) {
    return updateInfo.updateAvailable
      ? `可更新到 v${updateInfo.latestVersion}`
      : `最新版本 v${updateInfo.latestVersion}`;
  }

  if (updateNotice.includes('暂未找到')) {
    return '暂无可用 Release';
  }

  if (updateNotice) {
    return '检查失败';
  }

  return '尚未检查';
}

export default function App() {
  const [workspace, setWorkspace] = useState<AppWorkspace>(() => createDefaultWorkspace());
  const [booting, setBooting] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [input, setInput] = useState('');
  const [manualModelId, setManualModelId] = useState('');
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [modelCapabilityFilter, setModelCapabilityFilter] = useState<ModelCapabilityFilter>('all');
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [notice, setNotice] = useState('');
  const [updateNotice, setUpdateNotice] = useState('');
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
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
  const recentConversations = useMemo(
    () =>
      workspace.conversations
        .filter(hasConversationHistory)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [workspace.conversations]
  );
  const filteredConversations = useMemo(() => {
    const query = historySearchQuery.trim().toLowerCase();

    if (!query) {
      return recentConversations;
    }

    return recentConversations.filter((conversation) => conversationSearchText(conversation).includes(query));
  }, [historySearchQuery, recentConversations]);

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

    const model = createModelInfoFromId(activeProvider, modelId, 'manual');

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
                  task: inferModelTask(model),
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

  function startNewConversation() {
    const conversationId = createId('conversation');
    const now = Date.now();

    setWorkspace((current) => ({
      ...current,
      activeConversationId: conversationId,
      conversations: upsertConversation(current.conversations, conversationId, [], now),
      messages: [],
    }));
    setExpandedReasoningByMessageId({});
    setQueryingTaskByMessageId({});
    setNotice('');
  }

  function selectConversation(conversationId: string) {
    setWorkspace((current) => {
      const conversation = current.conversations.find((item) => item.id === conversationId);
      if (!conversation) {
        return current;
      }

      return {
        ...current,
        activeConversationId: conversation.id,
        messages: conversation.messages,
      };
    });
    setExpandedReasoningByMessageId({});
    setQueryingTaskByMessageId({});
    setSidebarOpen(false);
    setNotice('');
  }

  async function addAttachments(kind: 'image' | 'video' | 'file') {
    setNotice('');

    if (!activeModel) {
      setNotice('请先添加并选择模型。');
      return;
    }

    if (kind === 'image' && !isVisionModel(activeModel)) {
      setNotice('当前模型未标记为支持图片输入，请先切换视觉模型。');
      return;
    }

    if (kind === 'video' && !isVideoInputModel(activeModel)) {
      setNotice('当前模型未标记为支持视频输入，请先切换视频模型。');
      return;
    }

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
    setWorkspace((current) => {
      const now = Date.now();
      const updateMessages = (messages: ChatMessage[]) =>
        messages.map((message) =>
          message.id === messageId ? { ...message, ...patch } : message
        );
      const messages = updateMessages(current.messages);
      const conversations = current.conversations.map((conversation) => {
        if (!conversation.messages.some((message) => message.id === messageId)) {
          return conversation;
        }

        const updatedMessages = updateMessages(conversation.messages);

        return {
          ...conversation,
          title: conversationTitleFromMessages(updatedMessages),
          updatedAt: now,
          messages: updatedMessages,
        };
      });

      return {
        ...current,
        messages,
        conversations,
      };
    });
  }

  function toggleReasoning(messageId: string) {
    setExpandedReasoningByMessageId((current) => ({
      ...current,
      [messageId]: !current[messageId],
    }));
  }

  async function copyMessage(message: ChatMessage) {
    const text = message.content.trim();
    if (!text) {
      return;
    }

    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setNotice('已复制消息内容。');
        return;
      }
      setNotice('当前环境暂未接入剪贴板。');
    } catch {
      setNotice('复制失败，请稍后再试。');
    }
  }

  function editMessage(message: ChatMessage) {
    if (!message.content.trim()) {
      return;
    }
    setInput(message.content);
    setNotice('已放入输入框，可继续编辑。');
  }

  function showPendingActionNotice() {
    setNotice('这个操作入口已保留，后续接入完整行为。');
  }

  async function checkUpdates() {
    setCheckingUpdate(true);
    setUpdateNotice('');

    try {
      const result = await checkForAppUpdate();
      setUpdateInfo(result);
      setUpdateNotice(result.updateAvailable ? `发现新版本 v${result.latestVersion}` : '当前已是最新版本。');
    } catch (error) {
      setUpdateInfo(null);
      setUpdateNotice(error instanceof Error ? error.message : '更新检查失败。');
    } finally {
      setCheckingUpdate(false);
    }
  }

  function openUpdateTarget(kind: 'release' | 'install') {
    const target =
      kind === 'install'
        ? updateInfo?.installAsset?.downloadUrl ?? updateInfo?.releaseUrl ?? appInfo.releasesUrl
        : updateInfo?.releaseUrl ?? appInfo.releasesUrl;

    void Linking.openURL(target);
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

    const conversationId = workspace.activeConversationId || createId('conversation');
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
      modelId: activeModelId,
      providerId: activeProvider.id,
      providerName: activeProvider.name,
    };
    const transcript = [...workspace.messages.filter((message) => message.id !== 'welcome'), userMessage].slice(-12);

    setInput('');
    setAttachments([]);
    setBusy(true);
    setNotice('');
    setWorkspace((current) => {
      const messages = [
        ...current.messages.filter((message) => message.id !== 'welcome'),
        userMessage,
        assistantMessage,
      ];

      return {
        ...current,
        activeConversationId: conversationId,
        messages,
        conversations: upsertConversation(current.conversations, conversationId, messages, userMessage.createdAt),
      };
    });

    try {
      const result = await sendOpenAiCompatibleChat({
        provider: activeProvider,
        modelId: activeModelId,
        model: activeModel,
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
                    {activeReasoningEffort !== 'default' && activeModelTask === 'chat'
                      ? ` ${reasoningEffortOptions.find((o) => o.key === activeReasoningEffort)?.label ?? ''}`
                      : ''}
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
          </View>

          <ModelPickerModal
            visible={modelPickerOpen}
            groups={providerModelGroups}
            activeProviderId={activeProvider.id}
            activeModelId={activeModelId}
            activeModelTask={activeModelTask}
            activeReasoningEffort={activeReasoningEffort}
            onClose={() => setModelPickerOpen(false)}
            onSelect={selectProviderModel}
            onReasoningEffortChange={setActiveReasoningEffort}
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
                <View style={styles.settingsCardHeader}>
                  <Text style={styles.settingsCardTitle}>可添加模型</Text>
                  {modelCandidates.length ? (
                    <AnimatedPressable
                      accessibilityRole="button"
                      onPress={() => {
                        setWorkspace((current) => ({
                          ...current,
                          modelCandidatesByProvider: {
                            ...current.modelCandidatesByProvider,
                            [activeProvider.id]: [],
                          },
                        }));
                        setModelSearchQuery('');
                        setModelCapabilityFilter('all');
                      }}
                      style={styles.settingsCardHeaderAction}
                    >
                      <Trash2 size={16} color={palette.textSecondary} strokeWidth={2} />
                    </AnimatedPressable>
                  ) : null}
                </View>
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
                          <AnimatedPressable
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
                          </AnimatedPressable>
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

              <View style={styles.settingsCard}>
                <View style={styles.updateHeaderRow}>
                  <View style={styles.updateTitleBlock}>
                    <Text style={styles.settingsCardTitle}>版本更新</Text>
                    <Text style={styles.updateVersionText}>当前 v{appInfo.version}</Text>
                  </View>
                  <Text style={styles.updateSourceBadge}>GitHub Releases</Text>
                </View>

                <View style={styles.updateStatusPanel}>
                  <Text style={styles.updateStatusTitle}>
                    {formatUpdateStatusTitle(updateInfo, updateNotice)}
                  </Text>
                  {updateInfo?.publishedAt ? (
                    <Text style={styles.updateStatusMeta}>
                      发布于 {new Date(updateInfo.publishedAt).toLocaleDateString('zh-CN')}
                    </Text>
                  ) : null}
                  {updateInfo?.installAsset ? (
                    <Text numberOfLines={1} style={styles.updateStatusMeta}>
                      安装包 {updateInfo.installAsset.name}
                    </Text>
                  ) : null}
                  {updateNotice ? <Text style={styles.updateNotice}>{updateNotice}</Text> : null}
                </View>

                <View style={styles.updateActionRow}>
                  <AnimatedPressable
                    accessibilityRole="button"
                    disabled={checkingUpdate}
                    onPress={checkUpdates}
                    style={[styles.secondaryButton, styles.updateActionButton, checkingUpdate && styles.buttonDisabled]}
                  >
                    <RefreshCw size={16} color={palette.text} strokeWidth={2} />
                    <Text style={styles.secondaryButtonText}>{checkingUpdate ? '检查中' : '检查更新'}</Text>
                  </AnimatedPressable>
                  <AnimatedPressable
                    accessibilityRole="button"
                    onPress={() => openUpdateTarget(updateInfo?.updateAvailable ? 'install' : 'release')}
                    style={[styles.primaryButton, styles.updateActionButton]}
                  >
                    {updateInfo?.updateAvailable ? (
                      <Download size={16} color={palette.textOnAccent} strokeWidth={2} />
                    ) : (
                      <ExternalLink size={16} color={palette.textOnAccent} strokeWidth={2} />
                    )}
                    <Text style={styles.primaryButtonText}>
                      {updateInfo?.updateAvailable ? '打开更新' : 'Release'}
                    </Text>
                  </AnimatedPressable>
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
                  const messageModelId = message.modelId ?? '模型未记录';
                  const messageProviderName = message.providerName ?? '未知服务商';
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
                      message.role === 'user' ? styles.userMessageBlock : styles.assistantBubble,
                      message.status === 'error' && styles.errorBubble,
                    ]}
                  >
                    {message.role === 'user' ? (
                      <>
                        <View style={styles.userBubble}>
                          <Text style={[styles.messageText, styles.userMessageText]}>{message.content}</Text>
                          {message.attachments?.length ? (
                            <View style={styles.attachmentGrid}>
                              {message.attachments.map((attachment) => (
                                <AttachmentPreview key={attachment.id} attachment={attachment} />
                              ))}
                            </View>
                          ) : null}
                        </View>
                        <MessageActions
                          role="user"
                          onCopy={() => void copyMessage(message)}
                          onRetry={showPendingActionNotice}
                          onEdit={() => editMessage(message)}
                          onMore={showPendingActionNotice}
                        />
                      </>
                    ) : (
                      <>
                        <AssistantMessageHeader
                          modelId={messageModelId}
                          providerName={messageProviderName}
                          createdAt={message.createdAt}
                        />
                        {message.reasoningContent ? (
                          <View style={styles.reasoningPanel}>
                            <AnimatedPressable
                              accessibilityRole="button"
                              onPress={() => toggleReasoning(message.id)}
                              style={styles.reasoningPanelHeader}
                            >
                              <Text style={styles.reasoningPanelTitle}>思考过程</Text>
                              <Text style={styles.reasoningPanelAction}>
                                {expandedReasoningByMessageId[message.id] ? '收起' : '展开'}
                              </Text>
                            </AnimatedPressable>
                            {expandedReasoningByMessageId[message.id] ? (
                              <Text style={styles.reasoningPanelText}>{message.reasoningContent}</Text>
                            ) : null}
                          </View>
                        ) : null}
                        {showThinking ? (
                          <ThinkingDots />
                        ) : (
                          <Text style={styles.messageText}>{message.content}</Text>
                        )}
                        {generationTask ? (
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
                        <View style={styles.assistantFooterRow}>
                          <MessageActions
                            role="assistant"
                            onCopy={() => void copyMessage(message)}
                            onRetry={showPendingActionNotice}
                            onEdit={() => editMessage(message)}
                            onMore={showPendingActionNotice}
                          />
                          {message.usage ? <TokenUsageLine usage={message.usage} /> : null}
                        </View>
                      </>
                    )}
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

              {attachMenuOpen || reasoningMenuOpen ? (
                <Pressable
                  style={styles.attachMenuBackdrop}
                  onPress={() => {
                    setAttachMenuOpen(false);
                    setReasoningMenuOpen(false);
                  }}
                />
              ) : null}
              <View style={styles.composerWrapper}>
                {reasoningMenuOpen && activeModelId && activeModelTask === 'chat' ? (
                  <View style={styles.reasoningMenu}>
                    {reasoningEffortOptions.map((option) => {
                      const active = option.key === activeReasoningEffort;

                      return (
                        <AnimatedPressable
                          key={option.key}
                          accessibilityRole="button"
                          testID={`reasoning-effort-${option.key}`}
                          onPress={() => {
                            setActiveReasoningEffort(option.key);
                            setReasoningMenuOpen(false);
                          }}
                          style={[styles.reasoningMenuItem, active && styles.reasoningMenuItemActive]}
                        >
                          <Text style={[styles.reasoningMenuText, active && styles.reasoningMenuTextActive]}>
                            {option.label}
                          </Text>
                        </AnimatedPressable>
                      );
                    })}
                  </View>
                ) : null}
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
                  <TextInput
                    multiline
                    placeholder="今天如何？"
                    placeholderTextColor={palette.placeholder}
                    value={input}
                    onChangeText={setInput}
                    style={styles.composerInput}
                  />
                  <View style={styles.composerFooter}>
                    <View style={styles.composerLeftTools}>
                      {activeModelId && activeModelTask === 'chat' ? (
                        <AnimatedPressable
                          accessibilityRole="button"
                          onPress={() => {
                            setAttachMenuOpen(false);
                            setReasoningMenuOpen((current) => !current);
                          }}
                          style={[
                            styles.composerToolButton,
                            activeReasoningEffort !== 'default' && styles.composerToolButtonActive,
                          ]}
                        >
                          <Lightbulb
                            size={15}
                            color={activeReasoningEffort !== 'default' ? palette.accentText : palette.textSecondary}
                            strokeWidth={2.2}
                          />
                        </AnimatedPressable>
                      ) : null}
                      <AnimatedPressable
                        accessibilityRole="button"
                        onPress={() => {
                          setReasoningMenuOpen(false);
                          setAttachMenuOpen((v) => !v);
                        }}
                        style={styles.composerToolButton}
                      >
                        <Plus size={15} color={palette.textSecondary} strokeWidth={2.4} />
                      </AnimatedPressable>
                    </View>
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
                onPress={() => { startNewConversation(); setSidebarOpen(false); }}
                style={styles.sidebarNewChat}
              >
                <PenSquare size={18} color={palette.textOnAccent} strokeWidth={2} />
                <Text style={styles.sidebarNewChatText}>新对话</Text>
              </AnimatedPressable>

              <View style={styles.sidebarSearchBox}>
                <Search size={16} color={palette.textSecondary} strokeWidth={2} />
                <TextInput
                  value={historySearchQuery}
                  onChangeText={setHistorySearchQuery}
                  placeholder="搜索聊天记录"
                  placeholderTextColor={palette.placeholder}
                  style={styles.sidebarSearchInput}
                />
                {historySearchQuery ? (
                  <AnimatedPressable
                    accessibilityRole="button"
                    onPress={() => setHistorySearchQuery('')}
                    style={styles.sidebarSearchClear}
                  >
                    <X size={14} color={palette.textSecondary} strokeWidth={2} />
                  </AnimatedPressable>
                ) : null}
              </View>

              <View style={styles.sidebarSection}>
                <Text style={styles.sidebarSectionTitle}>最近</Text>
                {filteredConversations.length ? (
                  <ScrollView
                    style={styles.sidebarConversationList}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.sidebarConversationListContent}
                  >
                    {filteredConversations.map((conversation) => {
                      const active = conversation.id === workspace.activeConversationId;
                      const dominantModel = dominantConversationModel(conversation);

                      return (
                        <AnimatedPressable
                          key={conversation.id}
                          accessibilityRole="button"
                          onPress={() => selectConversation(conversation.id)}
                          style={[styles.sidebarConversationItem, active && styles.sidebarConversationItemActive]}
                        >
                          <Text numberOfLines={1} style={[styles.sidebarConversationTitle, active && styles.sidebarConversationTitleActive]}>
                            {conversation.title}
                          </Text>
                          <View style={styles.sidebarConversationMetaRow}>
                            {dominantModel ? (
                              <ModelAvatar
                                modelId={dominantModel.modelId}
                                providerName={dominantModel.providerName}
                                size={18}
                                containerSize={22}
                              />
                            ) : null}
                            <Text numberOfLines={1} style={styles.sidebarConversationMeta}>
                              {dominantModel
                                ? `${dominantModel.modelId}${dominantModel.count > 1 ? ` x${dominantModel.count}` : ''} · `
                                : ''}
                              {formatConversationTime(conversation.updatedAt)}
                            </Text>
                          </View>
                        </AnimatedPressable>
                      );
                    })}
                  </ScrollView>
                ) : (
                  <Text style={styles.sidebarEmpty}>
                    {recentConversations.length ? '没有匹配的聊天记录' : '暂无历史对话'}
                  </Text>
                )}
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

function formatMessageTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp));
}

function displayProviderName(providerName?: string) {
  const name = providerName?.trim();
  if (!name) {
    return 'Provider';
  }

  const text = name.toLowerCase();
  if (text.includes('new api')) {
    return 'New API';
  }
  if (text.includes('volc') || text.includes('ark')) {
    return 'Volcengine Ark';
  }
  if (text.includes('bailian') || text.includes('dashscope')) {
    return 'Bailian';
  }

  return name;
}

type ModelIconKey =
  | 'openai'
  | 'claude'
  | 'gemini'
  | 'qwen'
  | 'deepseek'
  | 'doubao'
  | 'chatglm'
  | 'zhipu'
  | 'kimi'
  | 'minimax'
  | 'bailian'
  | 'volcengine'
  | 'newapi'
  | 'unknown';

function modelIconKey(modelId?: string, providerName?: string): ModelIconKey {
  const modelText = (modelId ?? '').toLowerCase();
  const providerText = (providerName ?? '').toLowerCase();
  const text = `${modelText} ${providerText}`;

  if (text.includes('模型未记录') || text.includes('未知服务商')) {
    return 'unknown';
  }
  if (text.includes('gpt') || text.includes('openai') || text.includes('codex')) {
    return 'openai';
  }
  if (text.includes('claude') || text.includes('anthropic')) {
    return 'claude';
  }
  if (text.includes('gemini') || text.includes('google')) {
    return 'gemini';
  }
  if (modelText.includes('qwen') || modelText.includes('qwq') || modelText.includes('qvq') || modelText.includes('tongyi')) {
    return 'qwen';
  }
  if (text.includes('deepseek')) {
    return 'deepseek';
  }
  if (modelText.includes('doubao') || modelText.includes('seed')) {
    return 'doubao';
  }
  if (modelText.includes('chatglm')) {
    return 'chatglm';
  }
  if (/^glm(?:[-_.]|$)/.test(modelText) || text.includes('zhipu') || text.includes('bigmodel') || text.includes('智谱')) {
    return 'zhipu';
  }
  if (text.includes('kimi') || text.includes('moonshot')) {
    return 'kimi';
  }
  if (text.includes('minimax')) {
    return 'minimax';
  }
  if (providerText.includes('bailian') || providerText.includes('dashscope') || providerText.includes('aliyun')) {
    return 'bailian';
  }
  if (providerText.includes('volc') || providerText.includes('ark') || providerText.includes('huoshan')) {
    return 'volcengine';
  }
  if (providerText.includes('new api') || providerText.includes('new-api') || providerText.includes('newapi')) {
    return 'newapi';
  }

  return 'unknown';
}

function ModelAvatar({
  modelId,
  providerName,
  size = 30,
  containerSize = 34,
}: {
  modelId?: string;
  providerName?: string;
  size?: number;
  containerSize?: number;
}) {
  const iconKey = modelIconKey(modelId, providerName);

  return (
    <View style={[styles.modelAvatar, { width: containerSize, height: containerSize, borderRadius: containerSize / 2 }]}>
      {iconKey === 'claude' ? <Claude.Color size={size} /> : null}
      {iconKey === 'gemini' ? <Gemini.Color size={size} /> : null}
      {iconKey === 'qwen' ? <Qwen.Color size={size} /> : null}
      {iconKey === 'deepseek' ? <DeepSeek.Color size={size} /> : null}
      {iconKey === 'doubao' ? <Doubao.Color size={size} /> : null}
      {iconKey === 'chatglm' ? <ChatGLM.Color size={size} /> : null}
      {iconKey === 'zhipu' ? <Zhipu.Color size={size} /> : null}
      {iconKey === 'kimi' ? <Kimi.Color size={size} /> : null}
      {iconKey === 'minimax' ? <Minimax.Color size={size} /> : null}
      {iconKey === 'bailian' ? <Bailian.Color size={size} /> : null}
      {iconKey === 'volcengine' ? <Volcengine.Color size={size} /> : null}
      {iconKey === 'newapi' ? <NewAPI.Color size={size} /> : null}
      {iconKey === 'openai' ? <OpenAI size={size} color={palette.text} /> : null}
      {iconKey === 'unknown' ? <MessageSquare size={Math.max(14, size - 8)} color={palette.textSecondary} strokeWidth={2} /> : null}
    </View>
  );
}

function AssistantMessageHeader({
  modelId,
  providerName,
  createdAt,
}: {
  modelId: string;
  providerName: string;
  createdAt: number;
}) {
  return (
    <View style={styles.assistantMetaRow}>
      <ModelAvatar modelId={modelId} providerName={providerName} />
      <Text numberOfLines={1} style={styles.assistantModelName}>
        {modelId || '模型'}
      </Text>
      <Text style={styles.assistantMetaDivider}>|</Text>
      <Text numberOfLines={1} style={styles.assistantProviderName}>
        {displayProviderName(providerName)}
      </Text>
      <Text style={styles.assistantTime}>{formatMessageTime(createdAt)}</Text>
    </View>
  );
}

function MessageActions({
  role,
  onCopy,
  onRetry,
  onEdit,
  onMore,
}: {
  role: MessageRole;
  onCopy: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onMore: () => void;
}) {
  return (
    <View style={[styles.messageActions, role === 'user' && styles.userMessageActions]}>
      <AnimatedPressable accessibilityRole="button" onPress={onCopy} style={styles.messageActionButton}>
        <Copy size={21} color={palette.textSecondary} strokeWidth={2} />
      </AnimatedPressable>
      <AnimatedPressable accessibilityRole="button" onPress={onRetry} style={styles.messageActionButton}>
        <RefreshCw size={22} color={palette.textSecondary} strokeWidth={2} />
      </AnimatedPressable>
      {role === 'assistant' ? (
        <>
          <AnimatedPressable accessibilityRole="button" onPress={onMore} style={styles.messageActionButton}>
            <AudioLines size={22} color={palette.textSecondary} strokeWidth={2} />
          </AnimatedPressable>
          <AnimatedPressable accessibilityRole="button" onPress={onMore} style={styles.messageActionButton}>
            <Share2 size={22} color={palette.textSecondary} strokeWidth={2} />
          </AnimatedPressable>
        </>
      ) : (
        <AnimatedPressable accessibilityRole="button" onPress={onEdit} style={styles.messageActionButton}>
          <Pencil size={22} color={palette.textSecondary} strokeWidth={2} />
        </AnimatedPressable>
      )}
      <AnimatedPressable accessibilityRole="button" onPress={onMore} style={styles.messageActionButton}>
        <MoreHorizontal size={23} color={palette.textSecondary} strokeWidth={2} />
      </AnimatedPressable>
    </View>
  );
}

function TokenUsageLine({ usage }: { usage: ChatTokenUsage }) {
  const total =
    usage.totalTokens ??
    [usage.inputTokens, usage.outputTokens, usage.reasoningTokens]
      .filter((value): value is number => typeof value === 'number')
      .reduce((sum, value) => sum + value, 0);

  return (
    <View style={styles.tokenUsageRow}>
      <Text style={styles.tokenUsageText}>↑ {formatTokenCount(usage.inputTokens)}</Text>
      <Text style={styles.tokenUsageText}>↓ {formatTokenCount(usage.outputTokens)}</Text>
      {typeof usage.reasoningTokens === 'number' ? (
        <Text style={styles.tokenUsageText}>思 {formatTokenCount(usage.reasoningTokens)}</Text>
      ) : null}
      <Text style={styles.tokenUsageText}>Σ{formatTokenCount(total || undefined)}</Text>
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

const reasoningSliderStops: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max'];
const reasoningSliderLabels: Record<string, string> = {
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  max: '极高',
};

function ReasoningSlider({
  value,
  onChange,
}: {
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
}) {
  const activeIndex = reasoningSliderStops.indexOf(value === 'default' ? 'medium' : value);
  const trackWidth = useRef(0);
  const currentIndex = useRef(activeIndex);
  currentIndex.current = activeIndex;

  const snapToIndex = (locationX: number) => {
    const width = trackWidth.current;
    if (!width) return;
    const ratio = Math.max(0, Math.min(1, locationX / width));
    const index = Math.round(ratio * (reasoningSliderStops.length - 1));
    if (index !== currentIndex.current) {
      onChange(reasoningSliderStops[index]);
    }
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        snapToIndex(event.nativeEvent.locationX);
      },
      onPanResponderMove: (event) => {
        snapToIndex(event.nativeEvent.locationX);
      },
    })
  ).current;

  const thumbPosition = reasoningSliderStops.length > 1
    ? (activeIndex / (reasoningSliderStops.length - 1)) * 100
    : 50;

  return (
    <View style={styles.reasoningSlider}>
      <View
        style={styles.reasoningSliderTrackArea}
        onLayout={(e) => { trackWidth.current = e.nativeEvent.layout.width; }}
        {...panResponder.panHandlers}
      >
        <View style={styles.reasoningSliderTrack} />
        <View style={[styles.reasoningSliderThumb, { left: `${thumbPosition}%` as any }]} />
      </View>
      <View style={styles.reasoningSliderLabels}>
        {reasoningSliderStops.map((stop, index) => (
          <Pressable key={stop} onPress={() => onChange(stop)}>
            <Text
              style={[
                styles.reasoningSliderLabel,
                index === activeIndex && styles.reasoningSliderLabelActive,
              ]}
            >
              {reasoningSliderLabels[stop]}
            </Text>
          </Pressable>
        ))}
      </View>
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
  activeModelTask: ModelTask;
  activeReasoningEffort: ReasoningEffort;
  onClose: () => void;
  onSelect: (providerId: string, modelId: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
}

function ModelPickerModal({
  visible,
  groups,
  activeProviderId,
  activeModelId,
  activeModelTask,
  activeReasoningEffort,
  onClose,
  onSelect,
  onReasoningEffortChange,
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
            {activeModelTask === 'chat' ? (
              <View style={styles.modelPickerReasoningSection}>
                <View style={styles.reasoningSliderEndpoints}>
                  <Text style={styles.reasoningSliderEndpointText}>快速</Text>
                  <Text style={styles.reasoningSliderEndpointText}>深思</Text>
                </View>
                <ReasoningSlider value={activeReasoningEffort} onChange={onReasoningEffortChange} />
              </View>
            ) : null}
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
  secondaryButton: {
    height: 40,
    minWidth: 60,
    paddingHorizontal: 16,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
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
  settingsCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  settingsCardHeaderAction: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
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
  updateHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  updateTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  updateVersionText: {
    color: palette.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  updateSourceBadge: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    color: palette.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  updateStatusPanel: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.bg,
    padding: 12,
    gap: 5,
  },
  updateStatusTitle: {
    color: palette.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  updateStatusMeta: {
    color: palette.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  updateNotice: {
    color: palette.warning,
    fontSize: 12,
    lineHeight: 17,
  },
  updateActionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  updateActionButton: {
    flex: 1,
    minWidth: 0,
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
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
  modelPickerReasoningSection: {
    gap: 8,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  reasoningSliderEndpoints: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  reasoningSliderEndpointText: {
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  reasoningSlider: {
    gap: 6,
  },
  reasoningSliderTrackArea: {
    height: 28,
    justifyContent: 'center',
    position: 'relative',
  },
  reasoningSliderTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: palette.borderStrong,
  },
  reasoningSliderThumb: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: palette.accent,
    marginLeft: -9,
    top: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  reasoningSliderLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  reasoningSliderLabel: {
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '500',
    paddingHorizontal: 2,
  },
  reasoningSliderLabelActive: {
    color: palette.accent,
    fontWeight: '700',
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
  userMessageBlock: {
    alignSelf: 'stretch',
    alignItems: 'flex-end',
  },
  userBubble: {
    maxWidth: '86%',
    backgroundColor: '#E8F8EF',
    borderWidth: 1,
    borderColor: '#BEEBD1',
    borderRadius: radii.lg,
    borderTopRightRadius: radii.sm,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  assistantBubble: {
    alignSelf: 'stretch',
    paddingHorizontal: 6,
    gap: 12,
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
  assistantMetaRow: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  modelAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  assistantModelName: {
    maxWidth: 180,
    color: palette.text,
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '500',
  },
  assistantMetaDivider: {
    color: palette.textSecondary,
    fontSize: 18,
    lineHeight: 22,
  },
  assistantProviderName: {
    maxWidth: 140,
    color: palette.textSecondary,
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '400',
  },
  assistantTime: {
    color: palette.textSecondary,
    fontSize: 16,
    lineHeight: 20,
  },
  messageText: {
    color: palette.text,
    fontSize: 18,
    lineHeight: 29,
  },
  userMessageText: {
    color: palette.text,
    fontSize: 20,
    lineHeight: 30,
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
    borderLeftWidth: 2,
    borderLeftColor: palette.borderStrong,
    paddingLeft: 10,
    paddingVertical: 2,
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
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  tokenUsageText: {
    color: palette.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  assistantFooterRow: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  messageActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  userMessageActions: {
    marginTop: 12,
    marginRight: 8,
  },
  messageActionButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
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
  reasoningMenu: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    marginBottom: 8,
    backgroundColor: palette.bg,
    borderRadius: radii.md,
    padding: 6,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
  },
  reasoningMenuItem: {
    height: 30,
    minWidth: 48,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  reasoningMenuItemActive: {
    borderColor: palette.accentBorder,
    backgroundColor: palette.accentSoft,
  },
  reasoningMenuText: {
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  reasoningMenuTextActive: {
    color: palette.accentText,
    fontWeight: '700',
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
    borderRadius: radii.md,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
    overflow: 'visible',
    zIndex: 20,
  },
  composer: {
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 7,
    gap: 6,
  },
  composerInput: {
    alignSelf: 'stretch',
    minHeight: 34,
    maxHeight: 120,
    paddingVertical: 0,
    paddingHorizontal: 2,
    color: palette.text,
    fontSize: 15,
    lineHeight: 30,
    textAlignVertical: 'center',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as any : {}),
  },
  composerFooter: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  composerLeftTools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  composerToolButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  composerToolButtonActive: {
    backgroundColor: palette.surfaceAlt,
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
  sidebarSearchBox: {
    height: 40,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    marginBottom: 22,
  },
  sidebarSearchInput: {
    flex: 1,
    minWidth: 0,
    color: palette.text,
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 0,
    outlineStyle: 'none' as never,
  },
  sidebarSearchClear: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
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
  sidebarConversationList: {
    flex: 1,
  },
  sidebarConversationListContent: {
    gap: 6,
    paddingBottom: 20,
  },
  sidebarConversationItem: {
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  sidebarConversationItemActive: {
    backgroundColor: palette.surfaceAlt,
  },
  sidebarConversationTitle: {
    color: palette.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '600',
  },
  sidebarConversationTitleActive: {
    color: palette.accentText,
  },
  sidebarConversationMetaRow: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  sidebarConversationMeta: {
    flex: 1,
    minWidth: 0,
    color: palette.textSecondary,
    fontSize: 12,
    lineHeight: 16,
  },
  sidebarEmpty: {
    color: palette.placeholder,
    fontSize: 14,
  },
});
