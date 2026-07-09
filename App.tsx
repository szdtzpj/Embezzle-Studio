import { StatusBar } from 'expo-status-bar';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Share as NativeShare,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import type { PressableProps, StyleProp, ViewStyle } from 'react-native';
import Reanimated, {
  Easing as ReanimatedEasing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { AnimatePresence, MotiView } from 'moti';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Brain, Camera, Check, ChevronDown, Copy, Download, ExternalLink, Image as ImageIcon, Lightbulb, Menu, MessageSquare, MoreHorizontal, Paperclip, PenSquare, Pencil, Pin, Plus, RefreshCw, Search, Share2, Settings, SlidersHorizontal, Trash2, X } from 'lucide-react-native';
import { Bailian, ChatGLM, Claude, DeepSeek, Doubao, Gemini, Kimi, Minimax, NewAPI, OpenAI, Qwen, Volcengine, Zhipu } from '@lobehub/icons-rn';

import { isArkStaticDoubaoModelId, isVolcengineArkProvider } from './src/data/arkModels';
import { appInfo } from './src/data/appInfo';
import { createDefaultWorkspace, defaultParameterSettings } from './src/data/providerCatalog';
import type {
  AppWorkspace,
  ChatCompletionResult,
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
  ModelParameterSettings,
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
import {
  getReasoningEffortOptions,
  normalizeReasoningEffort,
  reasoningEffortLabels,
  type ReasoningEffortOption,
} from './src/services/reasoningEfforts';

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

type HapticStyle = 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'none';

/**
 * 轻量触觉反馈：模仿 ChatGPT / Claude / 豆包点击控件时的细微震动。
 * 采用即发即忘方式，绝不阻塞点击；Web 端及不支持的平台自动降级为空操作。
 */
function triggerHaptic(style: HapticStyle = 'light') {
  if (style === 'none' || Platform.OS === 'web') {
    return;
  }
  try {
    switch (style) {
      case 'selection':
        void Haptics.selectionAsync();
        break;
      case 'success':
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        break;
      case 'warning':
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        break;
      case 'medium':
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        break;
      case 'heavy':
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        break;
      case 'light':
      default:
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        break;
    }
  } catch {
    // 部分设备 / 环境不支持触觉，静默忽略即可。
  }
}

type AnimatedPressableProps = PressableProps & {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  /** 按下时缩放到的比例，默认 0.96（大按钮更轻微、图标按钮更明显）。 */
  pressScale?: number;
  /** 按下时的不透明度，默认 0.92（仅轻微压暗，避免廉价的重度变灰）。 */
  pressOpacity?: number;
  /** 按下瞬间的触觉反馈类型，默认 'light'；传 'none' 可关闭。 */
  haptic?: HapticStyle;
};

const AnimatedPressableView = Reanimated.createAnimatedComponent(Pressable);
const webInteractiveStyle =
  Platform.OS === 'web'
    ? ({
        cursor: 'pointer',
        userSelect: 'none',
      } as unknown as ViewStyle)
    : undefined;

// 按下 / 回弹的弹簧参数——回弹带一点点过冲，让控件“有生命感”而不僵硬。
const PRESS_IN_CONFIG = { duration: 70, easing: ReanimatedEasing.out(ReanimatedEasing.quad) } as const;
const PRESS_OUT_SPRING = { damping: 17, stiffness: 340, mass: 0.5 } as const;
const DISABLED_FADE = { duration: 160, easing: ReanimatedEasing.out(ReanimatedEasing.quad) } as const;

/**
 * 全局统一的可点击控件：
 * - 运行在 Reanimated UI 线程上，即使正在请求模型、列表滚动也不掉帧；
 * - 按下时轻微缩放 + 轻微压暗 + 触觉反馈，松开时用弹簧自然回弹（带细微过冲）；
 * - 行为与原生 Pressable 完全一致，只是多了触感动画，不改动任何业务逻辑。
 */
function AnimatedPressable({
  style,
  children,
  onPressIn,
  onPressOut,
  disabled,
  pressScale = 0.96,
  pressOpacity = 0.92,
  haptic = 'light',
  ...rest
}: AnimatedPressableProps) {
  const pressed = useSharedValue(0);
  const disabledValue = useSharedValue(disabled ? 1 : 0);

  useEffect(() => {
    disabledValue.value = withTiming(disabled ? 1 : 0, DISABLED_FADE);
  }, [disabled, disabledValue]);

  const animatedStyle = useAnimatedStyle(() => {
    const scale = interpolate(pressed.value, [0, 1], [1, pressScale], Extrapolation.CLAMP);
    const pressDim = interpolate(pressed.value, [0, 1], [1, pressOpacity], Extrapolation.CLAMP);
    const disabledDim = interpolate(disabledValue.value, [0, 1], [1, 0.5], Extrapolation.CLAMP);

    return {
      transform: [{ scale }],
      opacity: pressDim * disabledDim,
    };
  });

  return (
    <AnimatedPressableView
      {...rest}
      disabled={disabled}
      onPressIn={(event) => {
        if (!disabled) {
          pressed.value = withTiming(1, PRESS_IN_CONFIG);
          triggerHaptic(haptic);
        }
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        pressed.value = withSpring(0, PRESS_OUT_SPRING);
        onPressOut?.(event);
      }}
      style={[style, webInteractiveStyle, animatedStyle]}
    >
      {children}
    </AnimatedPressableView>
  );
}

/**
 * 消息气泡入场动画：淡入 + 轻微上移。仅在首次挂载时播放一次。
 * 用 Reanimated 在 UI 线程执行——即使收到回复瞬间 JS 线程繁忙也不会卡顿。
 */
function AnimatedMessage({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(1, {
      duration: 340,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
  }, [progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [
      { translateY: interpolate(progress.value, [0, 1], [12, 0], Extrapolation.CLAMP) },
    ],
  }));

  return <Reanimated.View style={[style, animatedStyle]}>{children}</Reanimated.View>;
}

/**
 * 切换聊天 / 配置时的柔和淡入 + 轻微缩放过渡。
 */
function ScreenFade({ children }: { children?: ReactNode }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(1, {
      duration: 260,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
  }, [progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.99, 1], Extrapolation.CLAMP) }],
  }));

  return <Reanimated.View style={[styles.screenFade, animatedStyle]}>{children}</Reanimated.View>;
}

/**
 * 图标 / 内容切换时的交叉淡入淡出：旧内容旋转淡出、新内容旋转淡入。
 * 用 moti 的 AnimatePresence 编排挂载 / 卸载，避免图标瞬间硬切。
 */
function IconCrossfade({ swapKey, children }: { swapKey: string; children: ReactNode }) {
  return (
    <View style={styles.iconCrossfade}>
      <AnimatePresence exitBeforeEnter>
        <MotiView
          key={swapKey}
          from={{ opacity: 0, scale: 0.6, rotate: '-30deg' }}
          animate={{ opacity: 1, scale: 1, rotate: '0deg' }}
          exit={{ opacity: 0, scale: 0.6, rotate: '30deg' }}
          transition={{ type: 'timing', duration: 180 }}
          style={styles.iconCrossfadeLayer}
        >
          {children}
        </MotiView>
      </AnimatePresence>
    </View>
  );
}

/**
 * 豆包 / ChatGPT 风格的浮层轻提示：屏幕中央浮出一个圆角白框，
 * 内含对勾 + 文案（如“已复制”），短暂停留后自动淡出。
 * 用 pointerEvents="none" 让它不拦截任何点击，纯视觉反馈。
 */
function Toast({ message }: { message: string | null }) {
  return (
    <View pointerEvents="none" style={styles.toastRoot}>
      <AnimatePresence>
        {message ? (
          <MotiView
            key="toast"
            from={{ opacity: 0, translateY: 14, scale: 0.9 }}
            animate={{ opacity: 1, translateY: 0, scale: 1 }}
            exit={{ opacity: 0, translateY: 8, scale: 0.94 }}
            transition={{ type: 'timing', duration: 200 }}
            style={styles.toastCard}
          >
            <View style={styles.toastIconBadge}>
              <Check size={13} color={palette.textOnAccent} strokeWidth={3.2} />
            </View>
            <Text style={styles.toastText}>{message}</Text>
          </MotiView>
        ) : null}
      </AnimatePresence>
    </View>
  );
}

/** 单个脉动圆点，交错的相位由 delay 控制。 */
function ThinkingDot({ delay }: { delay: number }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 380, easing: ReanimatedEasing.inOut(ReanimatedEasing.quad) }),
          withTiming(0, { duration: 380, easing: ReanimatedEasing.inOut(ReanimatedEasing.quad) })
        ),
        -1,
        false
      )
    );
  }, [delay, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0.3, 1], Extrapolation.CLAMP),
    transform: [
      { translateY: interpolate(progress.value, [0, 1], [0, -5], Extrapolation.CLAMP) },
      { scale: interpolate(progress.value, [0, 1], [0.85, 1], Extrapolation.CLAMP) },
    ],
  }));

  return <Reanimated.View style={[styles.thinkingDot, animatedStyle]} />;
}

/**
 * “正在思考”指示器：三个交错脉动的圆点，运行在 UI 线程。
 */
function ThinkingDots() {
  return (
    <View style={styles.thinkingRow} accessibilityRole="text" accessibilityLabel="正在思考">
      <ThinkingDot delay={0} />
      <ThinkingDot delay={160} />
      <ThinkingDot delay={320} />
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

type ParameterKey = Exclude<keyof ModelParameterSettings, 'enabled'>;

const parameterControls: Array<{
  key: ParameterKey;
  label: string;
  min: number;
  max: number;
  step: number;
  description: string;
}> = [
  {
    key: 'temperature',
    label: '温度',
    min: 0,
    max: 2,
    step: 0.01,
    description: '越低越稳定，越高越发散。',
  },
  {
    key: 'topP',
    label: 'Top P',
    min: 0,
    max: 1,
    step: 0.01,
    description: '控制采样候选范围，一般保持 1。',
  },
  {
    key: 'presencePenalty',
    label: '存在惩罚',
    min: -2,
    max: 2,
    step: 0.01,
    description: '正值会鼓励引入新话题。',
  },
  {
    key: 'frequencyPenalty',
    label: '频率惩罚',
    min: -2,
    max: 2,
    step: 0.01,
    description: '正值会减少重复表达。',
  },
];
const modelTaskLabel: Record<ModelTask, string> = {
  chat: '对话',
  'image-generation': '图片生成',
  'video-generation': '视频生成',
  embedding: '嵌入',
  rerank: '重排',
};

function parameterRuntimeSummary(settings: ModelParameterSettings): string {
  if (!settings.enabled) {
    return '参数默认';
  }

  return `温度 ${settings.temperature.toFixed(2)} · Top P ${settings.topP.toFixed(2)}`;
}

function clampParameterValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function snapParameterValue(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function formatParameterValue(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '');
}

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
const conversationActionMenuHeight = 154;

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

function sortConversations(conversations: ChatConversation[]): ChatConversation[] {
  return [...conversations].sort(
    (a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt
  );
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
    title: existing?.customTitle ? existing.title : conversationTitleFromMessages(messages),
    customTitle: existing?.customTitle,
    pinnedAt: existing?.pinnedAt,
    createdAt: existing?.createdAt ?? firstTimestamp ?? updatedAt,
    updatedAt,
    messages,
  };

  return sortConversations([conversation, ...conversations.filter((item) => item.id !== conversationId)])
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

function conversationShareText(conversation: ChatConversation): string {
  const lines = [`# ${conversation.title}`, ''];

  for (const message of conversation.messages.filter(isConversationMessage)) {
    const role = message.role === 'user' ? '我' : '模型';
    const model = message.role === 'assistant' && message.modelId ? `（${message.modelId}）` : '';
    const content = message.content.trim() || '[附件/空内容]';
    lines.push(`${role}${model}: ${content}`);
    if (message.reasoningContent?.trim()) {
      lines.push(`思考过程: ${message.reasoningContent.trim()}`);
    }
    if (message.attachments?.length) {
      lines.push(`附件: ${message.attachments.map((attachment) => attachment.name).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
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
  const [parameterMenuOpen, setParameterMenuOpen] = useState(false);
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
  const [conversationActionId, setConversationActionId] = useState<string | null>(null);
  const [conversationActionMenuTop, setConversationActionMenuTop] = useState(16);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [deleteConfirmConversationId, setDeleteConfirmConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [sidebarPanelHeight, setSidebarPanelHeight] = useState(0);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageDraft, setEditingMessageDraft] = useState('');
  const [messageActionMenuId, setMessageActionMenuId] = useState<string | null>(null);
  const [expandedReasoningByMessageId, setExpandedReasoningByMessageId] = useState<Record<string, boolean>>({});
  const [queryingTaskByMessageId, setQueryingTaskByMessageId] = useState<Record<string, boolean>>({});
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 卸载时清理提示定时器，避免在已卸载组件上 setState。
    return () => {
      if (toastTimer.current) {
        clearTimeout(toastTimer.current);
      }
      if (copiedTimer.current) {
        clearTimeout(copiedTimer.current);
      }
    };
  }, []);

  /** 豆包风格轻提示：浮出一个圆角框，1.6s 后自动淡出。 */
  function showToast(message: string) {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
    }
    setToastMessage(message);
    toastTimer.current = setTimeout(() => {
      setToastMessage(null);
      toastTimer.current = null;
    }, 1600);
  }

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

  useEffect(() => {
    if (!sidebarOpen) {
      setConversationActionId(null);
    }
  }, [sidebarOpen]);

  useEffect(() => {
    if (deleteConfirmConversationId && renamingConversationId) {
      setRenamingConversationId(null);
      setRenameDraft('');
    }
  }, [deleteConfirmConversationId, renamingConversationId]);

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
  const activeReasoningOptions = useMemo(
    () => getReasoningEffortOptions(activeProvider, activeModel),
    [activeProvider, activeModel]
  );
  const savedActiveReasoningEffort: ReasoningEffort = activeModelKey
    ? workspace.reasoningEffortByModel[activeModelKey] ?? 'default'
    : 'default';
  const activeReasoningEffort = normalizeReasoningEffort(activeProvider, activeModel, savedActiveReasoningEffort);
  const canConfigureReasoning = activeReasoningOptions.length > 1;
  const parameterSettings = {
    ...defaultParameterSettings,
    ...(workspace.parameterSettings ?? {}),
  };
  const parametersActive = parameterSettings.enabled;
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
      sortConversations(workspace.conversations.filter(hasConversationHistory)),
    [workspace.conversations]
  );
  const renamingConversation = renamingConversationId
    ? workspace.conversations.find((conversation) => conversation.id === renamingConversationId) ?? null
    : null;
  const deleteConfirmConversation = deleteConfirmConversationId
    ? workspace.conversations.find((conversation) => conversation.id === deleteConfirmConversationId) ?? null
    : null;
  const conversationActionConversation = conversationActionId
    ? workspace.conversations.find((conversation) => conversation.id === conversationActionId) ?? null
    : null;
  const editingMessage = editingMessageId
    ? workspace.messages.find((message) => message.id === editingMessageId) ?? null
    : null;
  const filteredConversations = useMemo(() => {
    const query = historySearchQuery.trim().toLowerCase();

    if (!query) {
      return recentConversations;
    }

    return recentConversations.filter((conversation) => conversationSearchText(conversation).includes(query));
  }, [historySearchQuery, recentConversations]);

  useEffect(() => {
    if (!canConfigureReasoning && reasoningMenuOpen) {
      setReasoningMenuOpen(false);
    }
  }, [canConfigureReasoning, reasoningMenuOpen]);

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

    const supportedEffort = normalizeReasoningEffort(activeProvider, activeModel, effort);

    setWorkspace((current) => {
      const next = { ...current.reasoningEffortByModel };
      if (supportedEffort === 'default') {
        delete next[activeModelKey];
      } else {
        next[activeModelKey] = supportedEffort;
      }

      return {
        ...current,
        reasoningEffortByModel: next,
      };
    });
  }

  function updateParameterSettings(patch: Partial<ModelParameterSettings>) {
    setWorkspace((current) => ({
      ...current,
      parameterSettings: {
        ...defaultParameterSettings,
        ...(current.parameterSettings ?? {}),
        ...patch,
      },
    }));
  }

  function updateParameterValue(key: ParameterKey, value: number) {
    const control = parameterControls.find((item) => item.key === key);
    if (!control) {
      return;
    }

    updateParameterSettings({
      [key]: snapParameterValue(
        clampParameterValue(value, control.min, control.max),
        control.step
      ),
    } as Partial<ModelParameterSettings>);
  }

  function resetParameterSettings() {
    setWorkspace((current) => ({
      ...current,
      parameterSettings: {
        ...defaultParameterSettings,
        enabled: true,
      },
    }));
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

  function openConversationActionMenu(conversationId: string, pageY: number) {
    if (conversationActionId === conversationId) {
      setConversationActionId(null);
      return;
    }

    const maxTop = sidebarPanelHeight
      ? Math.max(12, sidebarPanelHeight - conversationActionMenuHeight - 16)
      : pageY + 16;

    setConversationActionMenuTop(Math.min(Math.max(12, pageY + 16), maxTop));
    setConversationActionId(conversationId);
  }

  function requestDeleteConversation(conversationId: string) {
    setConversationActionId(null);
    setRenamingConversationId(null);
    setRenameDraft('');
    setSidebarOpen(false);
    setDeleteConfirmConversationId(conversationId);
  }

  function deleteConversation(conversationId: string) {
    setWorkspace((current) => {
      const conversations = current.conversations.filter((conversation) => conversation.id !== conversationId);
      const deletedActive = current.activeConversationId === conversationId;
      const nextActive = deletedActive ? conversations[0] : current.conversations.find((item) => item.id === current.activeConversationId);

      return {
        ...current,
        conversations,
        activeConversationId: nextActive?.id ?? 'conversation-default',
        messages: deletedActive ? nextActive?.messages ?? [] : current.messages,
      };
    });
    setExpandedReasoningByMessageId({});
    setQueryingTaskByMessageId({});
    setConversationActionId(null);
    setDeleteConfirmConversationId(null);
    setNotice('已从本地移除该聊天记录。');
  }

  function togglePinConversation(conversationId: string) {
    setWorkspace((current) => ({
      ...current,
      conversations: sortConversations(
        current.conversations.map((conversation) => {
          if (conversation.id !== conversationId) {
            return conversation;
          }

          if (conversation.pinnedAt) {
            const { pinnedAt: _pinnedAt, ...rest } = conversation;
            return rest;
          }

          return {
            ...conversation,
            pinnedAt: Date.now(),
          };
        })
      ),
    }));
    setConversationActionId(null);
  }

  function beginRenameConversation(conversation: ChatConversation) {
    setDeleteConfirmConversationId(null);
    setRenamingConversationId(conversation.id);
    setRenameDraft(conversation.title);
    setConversationActionId(null);
    setSidebarOpen(false);
  }

  function saveConversationTitle() {
    if (!renamingConversationId) {
      return;
    }

    const title = renameDraft.trim().replace(/\s+/g, ' ');
    if (!title) {
      setNotice('对话名称不能为空。');
      return;
    }

    setWorkspace((current) => ({
      ...current,
      conversations: sortConversations(
        current.conversations.map((conversation) =>
          conversation.id === renamingConversationId
            ? {
                ...conversation,
                title,
                customTitle: true,
              }
            : conversation
        )
      ),
    }));
    setRenamingConversationId(null);
    setRenameDraft('');
    setNotice('已更新对话名称。');
  }

  async function shareConversation(conversation: ChatConversation) {
    const text = conversationShareText(conversation);
    setConversationActionId(null);

    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) {
          await navigator.share({ title: conversation.title, text });
          return;
        }

        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          triggerHaptic('success');
          showToast('已复制对话内容');
          return;
        }
      }

      await NativeShare.share({
        title: conversation.title,
        message: text,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      showToast('分享对话失败，请稍后再试');
    }
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
          title: conversation.customTitle ? conversation.title : conversationTitleFromMessages(updatedMessages),
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

  function resolveMessageRuntime(message?: ChatMessage | null) {
    const provider =
      workspace.providers.find((item) => item.id === message?.providerId) ??
      activeProvider;
    const modelId =
      message?.modelId ??
      (provider ? workspace.activeModelIdByProvider[provider.id] : '') ??
      activeModelId;

    if (!provider || !modelId) {
      return null;
    }

    const model =
      getSelectableModels(provider).find((item) => item.id === modelId) ??
      createModelInfoFromId(provider, modelId, 'manual');
    const effortKey = `${provider.id}:${modelId}`;
    const effort = normalizeReasoningEffort(
      provider,
      model,
      workspace.reasoningEffortByModel[effortKey] ?? 'default'
    );

    return {
      provider,
      model,
      modelId,
      reasoningEffort: effort,
    };
  }

  function applyAssistantResult(messageId: string, result: ChatCompletionResult) {
    updateAssistantMessage(messageId, {
      content: result.content,
      reasoningContent: result.reasoningContent,
      usage: result.usage,
      attachments: result.attachments,
      generationTask: result.generationTask,
      status: 'ready',
      error: undefined,
    });
  }

  async function runAssistantRequest({
    assistantMessage,
    transcript,
    runtime,
  }: {
    assistantMessage: ChatMessage;
    transcript: ChatMessage[];
    runtime: NonNullable<ReturnType<typeof resolveMessageRuntime>>;
  }) {
    try {
      const result = await sendOpenAiCompatibleChat({
        provider: runtime.provider,
        modelId: runtime.modelId,
        model: runtime.model,
        messages: transcript,
        reasoningEffort: runtime.reasoningEffort,
        parameterSettings,
        onStreamUpdate: (update) => {
          updateAssistantMessage(assistantMessage.id, {
            content: update.content,
            reasoningContent: update.reasoningContent,
            usage: update.usage,
            status: 'pending',
          });
        },
      });

      applyAssistantResult(assistantMessage.id, result);
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

    setMessageActionMenuId(null);

    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        markCopied(message.id);
        showToast('已复制');
        return;
      }
      showToast('当前环境暂未接入剪贴板');
    } catch {
      showToast('复制失败，请稍后再试');
    }
  }

  /** 标记某条消息刚被复制：其复制按钮的图标会临时变成对勾，1.6s 后恢复。 */
  function markCopied(messageId: string) {
    if (copiedTimer.current) {
      clearTimeout(copiedTimer.current);
    }
    triggerHaptic('success');
    setCopiedMessageId(messageId);
    copiedTimer.current = setTimeout(() => {
      setCopiedMessageId(null);
      copiedTimer.current = null;
    }, 1600);
  }

  function beginEditUserMessage(message: ChatMessage) {
    if (message.role === 'system') {
      setNotice('系统消息暂不支持编辑。');
      return;
    }

    if (busy) {
      setNotice('当前仍有请求进行中，稍后再编辑。');
      return;
    }

    setEditingMessageId(message.id);
    setEditingMessageDraft(message.content);
    setMessageActionMenuId(null);
    setNotice('');
  }

  function cancelEditUserMessage() {
    setEditingMessageId(null);
    setEditingMessageDraft('');
  }

  async function shareMessage(message: ChatMessage) {
    const text = [
      message.role === 'user' ? '我：' : '模型：',
      message.content.trim() || '[空内容]',
      message.reasoningContent?.trim() ? `\n\n思考过程：\n${message.reasoningContent.trim()}` : '',
    ].join('');

    setMessageActionMenuId(null);

    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) {
          await navigator.share({ text });
          return;
        }

        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          markCopied(message.id);
          showToast('已复制，可直接粘贴分享');
          return;
        }
      }

      await NativeShare.share({ message: text });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      showToast('分享失败，请稍后再试');
    }
  }

  function openMessageActionMenu(message: ChatMessage) {
    setMessageActionMenuId((current) => current === message.id ? null : message.id);
  }

  function createAssistantPlaceholder(runtime: NonNullable<ReturnType<typeof resolveMessageRuntime>>): ChatMessage {
    return {
      id: createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'pending',
      modelId: runtime.modelId,
      providerId: runtime.provider.id,
      providerName: runtime.provider.name,
    };
  }

  async function regenerateAssistantMessage(message: ChatMessage) {
    if (message.role !== 'assistant') {
      return;
    }

    if (busy) {
      setNotice('当前仍有请求进行中，稍后再重新生成。');
      return;
    }

    const runtime = resolveMessageRuntime(message);
    if (!runtime) {
      setNotice('找不到这条回答对应的模型配置。');
      return;
    }

    const messages = workspace.messages.filter((item) => item.id !== 'welcome');
    const messageIndex = messages.findIndex((item) => item.id === message.id);
    if (messageIndex <= 0) {
      setNotice('找不到可用于重新生成的上文。');
      return;
    }

    const transcript = messages.slice(0, messageIndex).slice(-12);
    setBusy(true);
    setNotice('');
    setMessageActionMenuId(null);
    updateAssistantMessage(message.id, {
      content: '',
      reasoningContent: undefined,
      usage: undefined,
      attachments: undefined,
      generationTask: undefined,
      status: 'pending',
      error: undefined,
      modelId: runtime.modelId,
      providerId: runtime.provider.id,
      providerName: runtime.provider.name,
    });

    await runAssistantRequest({
      assistantMessage: {
        ...message,
        modelId: runtime.modelId,
        providerId: runtime.provider.id,
        providerName: runtime.provider.name,
      },
      transcript,
      runtime,
    });
  }

  async function rerunFromUserMessage(message: ChatMessage, nextContent?: string) {
    if (message.role !== 'user') {
      return;
    }

    if (busy) {
      setNotice('当前仍有请求进行中，稍后再重新生成。');
      return;
    }

    const messages = workspace.messages.filter((item) => item.id !== 'welcome');
    const messageIndex = messages.findIndex((item) => item.id === message.id);
    if (messageIndex < 0) {
      setNotice('找不到要重新运行的用户消息。');
      return;
    }

    const followingAssistant = messages
      .slice(messageIndex + 1)
      .find((item) => item.role === 'assistant');
    const runtime = resolveMessageRuntime(followingAssistant ?? null);
    if (!runtime) {
      setNotice('请先选择可用模型。');
      return;
    }

    const content = typeof nextContent === 'string' ? nextContent.trim() : message.content.trim();
    if (!content && !message.attachments?.length) {
      setNotice('消息内容不能为空。');
      return;
    }

    const conversationId = workspace.activeConversationId || createId('conversation');
    const editedMessage: ChatMessage = {
      ...message,
      content,
      status: 'ready',
    };
    const assistantMessage = createAssistantPlaceholder(runtime);
    const baseMessages = [
      ...messages.slice(0, messageIndex),
      editedMessage,
    ];
    const nextMessages = [...baseMessages, assistantMessage];
    const transcript = baseMessages.slice(-12);

    setBusy(true);
    setNotice('');
    setMessageActionMenuId(null);
    cancelEditUserMessage();
    setWorkspace((current) => ({
      ...current,
      activeConversationId: conversationId,
      messages: nextMessages,
      conversations: upsertConversation(current.conversations, conversationId, nextMessages, Date.now()),
    }));

    await runAssistantRequest({
      assistantMessage,
      transcript,
      runtime,
    });
  }

  async function saveEditedUserMessage() {
    if (!editingMessage) {
      cancelEditUserMessage();
      return;
    }

    if (editingMessage.role === 'user') {
      await rerunFromUserMessage(editingMessage, editingMessageDraft);
      return;
    }

    const content = editingMessageDraft.trim();
    if (!content) {
      setNotice('消息内容不能为空。');
      return;
    }

    setWorkspace((current) => {
      const now = Date.now();
      const updateMessages = (messages: ChatMessage[]) =>
        messages.map((item) =>
          item.id === editingMessage.id
            ? {
                ...item,
                content,
                status: 'ready' as const,
                error: undefined,
              }
            : item,
        );
      const messages = updateMessages(current.messages);
      const conversations = current.conversations.map((conversation) => {
        if (!conversation.messages.some((item) => item.id === editingMessage.id)) {
          return conversation;
        }

        const updatedMessages = updateMessages(conversation.messages);
        return {
          ...conversation,
          title: conversation.customTitle ? conversation.title : conversationTitleFromMessages(updatedMessages),
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
    cancelEditUserMessage();
    setMessageActionMenuId(null);
    setNotice('已更新消息。');
  }

  function retryMessage(message: ChatMessage) {
    if (message.role === 'assistant') {
      void regenerateAssistantMessage(message);
      return;
    }

    void rerunFromUserMessage(message);
  }

  function removeMessage(message: ChatMessage) {
    setMessageActionMenuId(null);
    setWorkspace((current) => {
      const messages = current.messages.filter((item) => item.id !== message.id);
      const conversationId = current.activeConversationId || 'conversation-default';

      return {
        ...current,
        messages,
        conversations: upsertConversation(current.conversations, conversationId, messages, Date.now()),
      };
    });
    setNotice('已删除该条消息。');
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
        parameterSettings,
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
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider>
          <SafeAreaView style={styles.loadingShell}>
            <ActivityIndicator color={palette.accent} />
            <Text style={styles.loadingText}>正在加载工作区</Text>
          </SafeAreaView>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={styles.root}>
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
                  <ModelAvatar
                    modelId={activeModelId}
                    providerName={activeProvider.name}
                    size={16}
                    containerSize={24}
                  />
                  <Text numberOfLines={1} style={styles.modelPickerPillText}>
                    {activeModelId ? formatCompactModelName(activeModelId, activeProvider.name) : '选择模型'}
                    {activeReasoningEffort !== 'default' && activeModelTask === 'chat'
                      ? ` ${activeReasoningOptions.find((o) => o.key === activeReasoningEffort)?.label ?? reasoningEffortLabels[activeReasoningEffort]}`
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
                <IconCrossfade swapKey={settingsOpen ? 'chat' : 'settings'}>
                  {settingsOpen ? <MessageSquare size={20} color={palette.text} strokeWidth={2} /> : <Settings size={20} color={palette.text} strokeWidth={2} />}
                </IconCrossfade>
              </AnimatedPressable>
            </View>
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
                      haptic="selection"
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
                {modelCandidates.length ? (
                  <ScrollView
                    nestedScrollEnabled
                    style={styles.candidateModelListFrame}
                    contentContainerStyle={styles.modelList}
                    showsVerticalScrollIndicator={filteredModelCandidates.length > 4}
                  >
                    {filteredModelCandidates.map((model) => (
                      <CandidateModelRow
                        key={model.id}
                        model={model}
                        providerName={activeProvider.name}
                        added={addedModelIds.has(model.id)}
                        onAdd={() => addCandidateModel(model)}
                      />
                    ))}
                    {!filteredModelCandidates.length ? (
                      <View style={styles.modelSearchEmpty}>
                        <Text style={styles.modelSearchEmptyText}>没有匹配的模型</Text>
                      </View>
                    ) : null}
                  </ScrollView>
                ) : null}
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
                      providerName={activeProvider.name}
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
                          {editingMessageId === message.id ? (
                            <MessageInlineEditor
                              role="user"
                              value={editingMessageDraft}
                              placeholder="修改这条问题"
                              primaryLabel="提交修改"
                              disabled={busy}
                              onChange={setEditingMessageDraft}
                              onCancel={cancelEditUserMessage}
                              onSave={() => { void saveEditedUserMessage(); }}
                            />
                          ) : (
                            <Text style={[styles.messageText, styles.userMessageText]}>{message.content}</Text>
                          )}
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
                          copied={copiedMessageId === message.id}
                          onCopy={() => void copyMessage(message)}
                          onRetry={() => retryMessage(message)}
                          onEdit={() => beginEditUserMessage(message)}
                          onShare={() => void shareMessage(message)}
                          onMore={() => openMessageActionMenu(message)}
                        />
                        {messageActionMenuId === message.id ? (
                          <MessageActionMenu
                            role="user"
                            onEdit={() => beginEditUserMessage(message)}
                            onDelete={() => removeMessage(message)}
                          />
                        ) : null}
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
                        ) : editingMessageId === message.id ? (
                          <MessageInlineEditor
                            role="assistant"
                            value={editingMessageDraft}
                            placeholder="修改这条回答"
                            primaryLabel="保存修改"
                            disabled={busy}
                            onChange={setEditingMessageDraft}
                            onCancel={cancelEditUserMessage}
                            onSave={() => { void saveEditedUserMessage(); }}
                          />
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
                            copied={copiedMessageId === message.id}
                            onCopy={() => void copyMessage(message)}
                            onRetry={() => retryMessage(message)}
                            onEdit={() => beginEditUserMessage(message)}
                            onShare={() => void shareMessage(message)}
                            onMore={() => openMessageActionMenu(message)}
                          />
                          {message.usage ? <TokenUsageLine usage={message.usage} /> : null}
                        </View>
                        {messageActionMenuId === message.id ? (
                          <MessageActionMenu
                            role="assistant"
                            onEdit={() => beginEditUserMessage(message)}
                            onDelete={() => removeMessage(message)}
                          />
                        ) : null}
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

              {attachMenuOpen || reasoningMenuOpen || parameterMenuOpen ? (
                <Pressable
                  style={styles.attachMenuBackdrop}
                  onPress={() => {
                    setAttachMenuOpen(false);
                    setReasoningMenuOpen(false);
                    setParameterMenuOpen(false);
                  }}
                />
              ) : null}
              <View style={styles.composerWrapper}>
                <AnimatePresence>
                  {reasoningMenuOpen && canConfigureReasoning ? (
                    <MotiView
                      key="reasoning-menu"
                      from={{ opacity: 0, translateY: 8, scale: 0.96 }}
                      animate={{ opacity: 1, translateY: 0, scale: 1 }}
                      exit={{ opacity: 0, translateY: 8, scale: 0.96 }}
                      transition={{ type: 'timing', duration: 160 }}
                      style={styles.reasoningMenu}
                    >
                      {activeReasoningOptions.map((option) => {
                        const active = option.key === activeReasoningEffort;

                        return (
                          <AnimatedPressable
                            key={option.key}
                            accessibilityRole="button"
                            accessibilityLabel={`思考强度：${option.label}`}
                            testID={`reasoning-effort-${option.key}`}
                            onPress={() => {
                              setActiveReasoningEffort(option.key);
                              setReasoningMenuOpen(false);
                            }}
                            haptic="selection"
                            style={[styles.reasoningMenuItem, active && styles.reasoningMenuItemActive]}
                          >
                            {active ? <Check size={12} color={palette.textOnAccent} strokeWidth={3} /> : null}
                            <Text style={[styles.reasoningMenuText, active && styles.reasoningMenuTextActive]}>
                              {option.label}
                            </Text>
                          </AnimatedPressable>
                        );
                      })}
                    </MotiView>
                  ) : null}
                </AnimatePresence>
                <AnimatePresence>
                  {attachMenuOpen ? (
                    <MotiView
                      key="attach-menu"
                      from={{ opacity: 0, translateY: 8, scale: 0.96 }}
                      animate={{ opacity: 1, translateY: 0, scale: 1 }}
                      exit={{ opacity: 0, translateY: 8, scale: 0.96 }}
                      transition={{ type: 'timing', duration: 160 }}
                      style={styles.attachMenu}
                    >
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
                    </MotiView>
                  ) : null}
                </AnimatePresence>
                <AnimatePresence>
                  {parameterMenuOpen ? (
                    <MotiView
                      key="parameter-menu"
                      from={{ opacity: 0, translateY: 8, scale: 0.96 }}
                      animate={{ opacity: 1, translateY: 0, scale: 1 }}
                      exit={{ opacity: 0, translateY: 8, scale: 0.96 }}
                      transition={{ type: 'timing', duration: 160 }}
                      style={styles.parameterMenu}
                    >
                      <View style={styles.toolMenuHeader}>
                        <SlidersHorizontal size={18} color={palette.text} strokeWidth={2.2} />
                        <View style={styles.toolMenuTitleBlock}>
                          <Text style={styles.toolMenuTitle}>参数调整</Text>
                          <Text numberOfLines={1} style={styles.toolMenuSubtitle}>
                            {parameterRuntimeSummary(parameterSettings)}
                          </Text>
                        </View>
                      </View>

                      <View style={styles.toolMenuSection}>
                        <Text style={styles.toolMenuSectionTitle}>模式</Text>
                        <View style={styles.toolSegmentRow}>
                          <AnimatedPressable
                            accessibilityRole="button"
                            onPress={() => updateParameterSettings({ enabled: false })}
                            style={[styles.toolSegment, !parametersActive && styles.toolSegmentActive]}
                          >
                            <Text style={[styles.toolSegmentText, !parametersActive && styles.toolSegmentTextActive]}>
                              关闭
                            </Text>
                          </AnimatedPressable>
                          <AnimatedPressable
                            accessibilityRole="button"
                            onPress={() => updateParameterSettings({ enabled: true })}
                            style={[styles.toolSegment, parametersActive && styles.toolSegmentActive]}
                          >
                            <Text style={[styles.toolSegmentText, parametersActive && styles.toolSegmentTextActive]}>
                              启用
                            </Text>
                          </AnimatedPressable>
                        </View>
                        <Text style={styles.toolMenuHint}>
                          关闭时不发送采样参数，交给服务商默认值处理。
                        </Text>
                      </View>

                      {parametersActive ? (
                        <>
                          {parameterControls.map((control) => (
                            <ParameterControl
                              key={control.key}
                              control={control}
                              value={parameterSettings[control.key]}
                              onChange={(value) => updateParameterValue(control.key, value)}
                            />
                          ))}
                          <AnimatedPressable
                            accessibilityRole="button"
                            onPress={resetParameterSettings}
                            style={styles.parameterResetButton}
                          >
                            <RefreshCw size={15} color={palette.text} strokeWidth={2.2} />
                            <Text style={styles.parameterResetButtonText}>还原默认设置</Text>
                          </AnimatedPressable>
                        </>
                      ) : null}
                    </MotiView>
                  ) : null}
                </AnimatePresence>
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
                      {canConfigureReasoning ? (
                        <AnimatedPressable
                          accessibilityRole="button"
                          onPress={() => {
                            setAttachMenuOpen(false);
                            setParameterMenuOpen(false);
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
                          setParameterMenuOpen(false);
                          setAttachMenuOpen((v) => !v);
                        }}
                        style={styles.composerToolButton}
                      >
                        <Plus size={15} color={palette.textSecondary} strokeWidth={2.4} />
                      </AnimatedPressable>
                      <AnimatedPressable
                        accessibilityRole="button"
                        onPress={() => {
                          setReasoningMenuOpen(false);
                          setAttachMenuOpen(false);
                          setParameterMenuOpen((current) => !current);
                        }}
                        style={[
                          styles.composerToolButton,
                          parametersActive && styles.composerToolButtonActive,
                        ]}
                      >
                        <SlidersHorizontal
                          size={15}
                          color={parametersActive ? palette.accentText : palette.textSecondary}
                          strokeWidth={2.3}
                        />
                      </AnimatedPressable>
                    </View>
                    <AnimatedPressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={sendMessage}
                      haptic="medium"
                      pressScale={0.9}
                      style={[styles.sendButton, busy && styles.buttonDisabled]}
                    >
                      <IconCrossfade swapKey={busy ? 'busy' : 'idle'}>
                        <Text style={styles.sendButtonText}>{busy ? '···' : '↑'}</Text>
                      </IconCrossfade>
                    </AnimatedPressable>
                  </View>
                </View>
              </View>
            </ScreenFade>
          )}
        </KeyboardAvoidingView>

        {/* Sidebar drawer */}
        <SidebarDrawer
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onPanelLayout={(height) => setSidebarPanelHeight(height)}
        >
          <View style={styles.sidebarHeader}>
            <Text style={styles.sidebarBrand}>Embezzle Studio</Text>
            <AnimatedPressable accessibilityRole="button" onPress={() => setSidebarOpen(false)} style={styles.sidebarClose}>
              <X size={20} color={palette.text} strokeWidth={2} />
            </AnimatedPressable>
          </View>

          <AnimatedPressable
            accessibilityRole="button"
            onPress={() => { startNewConversation(); setSidebarOpen(false); }}
            haptic="medium"
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
                    <View
                      key={conversation.id}
                      style={[styles.sidebarConversationItem, active && styles.sidebarConversationItemActive]}
                    >
                      <View style={styles.sidebarConversationRow}>
                        <AnimatedPressable
                          accessibilityRole="button"
                          onPress={() => selectConversation(conversation.id)}
                          haptic="selection"
                          style={styles.sidebarConversationContent}
                        >
                          <View style={styles.sidebarConversationTitleRow}>
                            {conversation.pinnedAt ? (
                              <Pin size={12} color={palette.accentText} strokeWidth={2.4} />
                            ) : null}
                            <Text numberOfLines={1} style={[styles.sidebarConversationTitle, active && styles.sidebarConversationTitleActive]}>
                              {conversation.title}
                            </Text>
                          </View>
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
                        <AnimatedPressable
                          accessibilityRole="button"
                          onPress={(event) => {
                            event.stopPropagation?.();
                            openConversationActionMenu(conversation.id, event.nativeEvent.pageY);
                          }}
                          style={[
                            styles.sidebarConversationMore,
                            conversationActionId === conversation.id && styles.sidebarConversationMoreActive,
                          ]}
                        >
                          <MoreHorizontal size={18} color={palette.textSecondary} strokeWidth={2.4} />
                        </AnimatedPressable>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            ) : (
              <Text style={styles.sidebarEmpty}>
                {recentConversations.length ? '没有匹配的聊天记录' : '暂无历史对话'}
              </Text>
            )}
          </View>
          {conversationActionConversation ? (
            <>
              <BlurView
                intensity={38}
                tint="light"
                blurMethod="dimezisBlurView"
                style={styles.sidebarConversationFrost}
              >
                <Pressable
                  style={styles.sidebarConversationFrostTapTarget}
                  onPress={() => setConversationActionId(null)}
                />
              </BlurView>
              <View
                style={[
                  styles.sidebarConversationActionMenu,
                  { top: conversationActionMenuTop },
                ]}
              >
                <AnimatedPressable
                  accessibilityRole="button"
                  onPress={() => togglePinConversation(conversationActionConversation.id)}
                  style={styles.sidebarConversationActionRow}
                >
                  <Text style={styles.sidebarConversationActionText}>
                    {conversationActionConversation.pinnedAt ? '取消置顶' : '置顶'}
                  </Text>
                  <Pin size={16} color="#111827" strokeWidth={2.4} />
                </AnimatedPressable>
                <AnimatedPressable
                  accessibilityRole="button"
                  onPress={() => beginRenameConversation(conversationActionConversation)}
                  style={styles.sidebarConversationActionRow}
                >
                  <Text style={styles.sidebarConversationActionText}>编辑名称</Text>
                  <Pencil size={16} color="#2563EB" strokeWidth={2.4} />
                </AnimatedPressable>
                <AnimatedPressable
                  accessibilityRole="button"
                  onPress={() => { void shareConversation(conversationActionConversation); }}
                  style={styles.sidebarConversationActionRow}
                >
                  <Text style={styles.sidebarConversationActionText}>分享对话</Text>
                  <Share2 size={16} color="#16A34A" strokeWidth={2.3} />
                </AnimatedPressable>
                <AnimatedPressable
                  accessibilityRole="button"
                  onPress={() => requestDeleteConversation(conversationActionConversation.id)}
                  style={[styles.sidebarConversationActionRow, styles.sidebarConversationActionDangerRow]}
                >
                  <Text style={[styles.sidebarConversationActionText, styles.sidebarConversationActionDangerText]}>
                    删除
                  </Text>
                  <Trash2 size={16} color={palette.danger} strokeWidth={2.4} />
                </AnimatedPressable>
              </View>
            </>
          ) : null}
        </SidebarDrawer>

        <Modal
          visible={Boolean(renamingConversation)}
          transparent
          animationType="fade"
          onRequestClose={() => {
            setRenamingConversationId(null);
            setRenameDraft('');
          }}
        >
          <Pressable
            style={styles.renameDialogScrim}
            onPress={() => {
              setRenamingConversationId(null);
              setRenameDraft('');
            }}
          >
            <Pressable style={styles.renameDialog} onPress={(event) => event.stopPropagation()}>
              <Text style={styles.renameDialogTitle}>编辑对话名称</Text>
              <TextInput
                value={renameDraft}
                onChangeText={setRenameDraft}
                autoFocus
                maxLength={60}
                placeholder="输入对话名称"
                placeholderTextColor={palette.placeholder}
                style={styles.renameDialogInput}
              />
              <View style={styles.renameDialogActions}>
                <AnimatedPressable
                  accessibilityRole="button"
                  onPress={() => {
                    setRenamingConversationId(null);
                    setRenameDraft('');
                  }}
                  style={styles.renameDialogSecondaryButton}
                >
                  <Text style={styles.renameDialogSecondaryText}>取消</Text>
                </AnimatedPressable>
                <AnimatedPressable
                  accessibilityRole="button"
                  onPress={saveConversationTitle}
                  style={styles.renameDialogPrimaryButton}
                >
                  <Text style={styles.renameDialogPrimaryText}>保存</Text>
                </AnimatedPressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          visible={Boolean(deleteConfirmConversation)}
          transparent
          animationType="fade"
          onRequestClose={() => setDeleteConfirmConversationId(null)}
        >
          <Pressable
            style={styles.deleteConfirmScrim}
            onPress={() => setDeleteConfirmConversationId(null)}
          >
            <Pressable style={styles.deleteConfirmDialog} onPress={(event) => event.stopPropagation()}>
              <View style={styles.deleteConfirmIconWrap}>
                <Trash2 size={22} color={palette.danger} strokeWidth={2.4} />
              </View>
              <Text style={styles.deleteConfirmTitle}>删除聊天记录</Text>
              <Text style={styles.deleteConfirmText}>
                这会从本地移除「{deleteConfirmConversation?.title ?? '该对话'}」，并释放这条记录占用的本地存储。
              </Text>
              <View style={styles.renameDialogActions}>
                <AnimatedPressable
                  accessibilityRole="button"
                  onPress={() => setDeleteConfirmConversationId(null)}
                  style={styles.renameDialogSecondaryButton}
                >
                  <Text style={styles.renameDialogSecondaryText}>取消</Text>
                </AnimatedPressable>
                <AnimatedPressable
                  accessibilityRole="button"
                  onPress={() => {
                    if (deleteConfirmConversation) {
                      deleteConversation(deleteConfirmConversation.id);
                    }
                  }}
                  haptic="warning"
                  style={styles.deleteConfirmButton}
                >
                  <Text style={styles.deleteConfirmButtonText}>删除</Text>
                </AnimatedPressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        <Toast message={toastMessage} />
      </SafeAreaView>
    </SafeAreaProvider>
    </GestureHandlerRootView>
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

function capitalizeFirstSegment(value: string) {
  return value.replace(/^[a-z]/, (char) => char.toUpperCase());
}

function truncateModelLabel(value: string, maxLength = 18) {
  return value.length > maxLength ? `${value.slice(0, Math.max(1, maxLength - 3))}...` : value;
}

function formatCompactModelName(modelId?: string, _providerName?: string, maxLength = 18) {
  const raw = (modelId ?? '').trim();
  if (!raw) {
    return 'Model';
  }

  const lower = raw.toLowerCase();
  let compact = raw;

  if (lower.length > maxLength && lower.startsWith('doubao-')) {
    compact = raw.slice('doubao-'.length);
  }

  compact = compact.replace(/[-_.]\d{6,8}$/u, '');

  return truncateModelLabel(capitalizeFirstSegment(compact), maxLength);
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
  size = 18,
  containerSize = 24,
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
        {modelId ? formatCompactModelName(modelId, providerName) : '模型'}
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
  copied,
  onCopy,
  onRetry,
  onEdit,
  onShare,
  onMore,
}: {
  role: MessageRole;
  copied?: boolean;
  onCopy: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onShare: () => void;
  onMore: () => void;
}) {
  return (
    <View style={[styles.messageActions, role === 'user' && styles.userMessageActions]}>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={copied ? '已复制' : '复制'}
        onPress={onCopy}
        haptic="none"
        style={styles.messageActionButton}
      >
        <IconCrossfade swapKey={copied ? 'copied' : 'copy'}>
          {copied ? (
            <Check size={16} color={palette.accentText} strokeWidth={2.6} />
          ) : (
            <Copy size={16} color={palette.textSecondary} strokeWidth={2} />
          )}
        </IconCrossfade>
      </AnimatedPressable>
      <AnimatedPressable accessibilityRole="button" onPress={onRetry} style={styles.messageActionButton}>
        <RefreshCw size={16} color={palette.textSecondary} strokeWidth={2} />
      </AnimatedPressable>
      {role === 'assistant' ? (
        <AnimatedPressable accessibilityRole="button" onPress={onShare} style={styles.messageActionButton}>
          <Share2 size={16} color={palette.textSecondary} strokeWidth={2} />
        </AnimatedPressable>
      ) : (
        <AnimatedPressable accessibilityRole="button" onPress={onEdit} style={styles.messageActionButton}>
          <Pencil size={16} color={palette.textSecondary} strokeWidth={2} />
        </AnimatedPressable>
      )}
      <AnimatedPressable accessibilityRole="button" onPress={onMore} style={styles.messageActionButton}>
        <MoreHorizontal size={16} color={palette.textSecondary} strokeWidth={2} />
      </AnimatedPressable>
    </View>
  );
}

function MessageInlineEditor({
  role,
  value,
  placeholder,
  primaryLabel,
  disabled,
  onChange,
  onCancel,
  onSave,
}: {
  role: MessageRole;
  value: string;
  placeholder: string;
  primaryLabel: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <View style={styles.messageInlineEditor}>
      <TextInput
        value={value}
        onChangeText={onChange}
        multiline
        autoFocus
        placeholder={placeholder}
        placeholderTextColor={palette.placeholder}
        style={[
          styles.messageInlineEditInput,
          role === 'user' ? styles.userInlineEditInput : styles.assistantInlineEditInput,
        ]}
      />
      <View style={styles.inlineEditActions}>
        <AnimatedPressable
          accessibilityRole="button"
          onPress={onCancel}
          style={styles.inlineEditSecondaryButton}
        >
          <Text style={styles.inlineEditSecondaryText}>取消</Text>
        </AnimatedPressable>
        <AnimatedPressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={onSave}
          style={[styles.inlineEditPrimaryButton, disabled && styles.buttonDisabled]}
        >
          <Text style={styles.inlineEditPrimaryText}>{primaryLabel}</Text>
        </AnimatedPressable>
      </View>
    </View>
  );
}

function MessageActionMenu({
  role,
  onEdit,
  onDelete,
}: {
  role: MessageRole;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <View style={[styles.messageActionMenu, role === 'user' && styles.userMessageActionMenu]}>
      <AnimatedPressable accessibilityRole="button" onPress={onEdit} style={styles.messageActionMenuRow}>
        <Text style={styles.messageActionMenuText}>编辑消息</Text>
        <Pencil size={15} color={palette.textSecondary} strokeWidth={2.2} />
      </AnimatedPressable>
      <AnimatedPressable
        accessibilityRole="button"
        onPress={onDelete}
        haptic="warning"
        style={[styles.messageActionMenuRow, styles.messageActionMenuDangerRow]}
      >
        <Text style={[styles.messageActionMenuText, styles.messageActionMenuDangerText]}>删除消息</Text>
        <Trash2 size={15} color={palette.danger} strokeWidth={2.2} />
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
        <View style={styles.tokenUsageItem}>
          <Brain size={12} color={palette.textSecondary} strokeWidth={2} />
          <Text style={styles.tokenUsageText}>{formatTokenCount(usage.reasoningTokens)}</Text>
        </View>
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

function ReasoningSlider({
  value,
  options,
  onChange,
}: {
  value: ReasoningEffort;
  options: ReasoningEffortOption[];
  onChange: (effort: ReasoningEffort) => void;
}) {
  const sliderOptions = options.filter((option) => option.key !== 'default');
  if (!sliderOptions.length) {
    return null;
  }

  const fallbackIndex = Math.max(0, sliderOptions.findIndex((option) => option.key === 'medium'));
  const activeIndex = Math.max(
    0,
    sliderOptions.findIndex((option) => option.key === value) >= 0
      ? sliderOptions.findIndex((option) => option.key === value)
      : fallbackIndex
  );
  const trackWidth = useRef(0);
  const currentIndex = useRef(activeIndex);
  currentIndex.current = activeIndex;

  const snapToIndex = (locationX: number) => {
    const width = trackWidth.current;
    if (!width || !sliderOptions.length) return;
    const ratio = Math.max(0, Math.min(1, locationX / width));
    const index = Math.round(ratio * (sliderOptions.length - 1));
    if (index !== currentIndex.current) {
      onChange(sliderOptions[index].key);
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

  const thumbPosition = sliderOptions.length > 1
    ? (activeIndex / (sliderOptions.length - 1)) * 100
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
        {sliderOptions.map((option, index) => (
          <Pressable key={option.key} onPress={() => onChange(option.key)}>
            <Text
              style={[
                styles.reasoningSliderLabel,
                index === activeIndex && styles.reasoningSliderLabelActive,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function ParameterSlider({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const trackWidth = useRef(0);
  const currentValue = useRef(value);
  currentValue.current = value;

  const setByLocation = (locationX: number) => {
    const width = trackWidth.current;
    if (!width) return;
    const ratio = Math.max(0, Math.min(1, locationX / width));
    const raw = min + ratio * (max - min);
    const next = snapParameterValue(clampParameterValue(raw, min, max), step);
    if (next !== currentValue.current) {
      onChange(next);
    }
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        setByLocation(event.nativeEvent.locationX);
      },
      onPanResponderMove: (event) => {
        setByLocation(event.nativeEvent.locationX);
      },
    })
  ).current;

  const thumbPosition = ((value - min) / (max - min)) * 100;

  return (
    <View
      style={styles.parameterSliderTrackArea}
      onLayout={(event) => {
        trackWidth.current = event.nativeEvent.layout.width;
      }}
      {...panResponder.panHandlers}
    >
      <View style={styles.parameterSliderTrack} />
      <View
        style={[
          styles.parameterSliderFill,
          { width: `${Math.max(0, Math.min(100, thumbPosition))}%` as any },
        ]}
      />
      <View
        style={[
          styles.parameterSliderThumb,
          { left: `${Math.max(0, Math.min(100, thumbPosition))}%` as any },
        ]}
      />
    </View>
  );
}

function ParameterControl({
  control,
  value,
  onChange,
}: {
  control: (typeof parameterControls)[number];
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(formatParameterValue(value));

  useEffect(() => {
    setDraft(formatParameterValue(value));
  }, [value]);

  return (
    <View style={styles.parameterControl}>
      <View style={styles.parameterControlHeader}>
        <View style={styles.parameterControlTitleBlock}>
          <Text style={styles.parameterControlLabel}>{control.label}</Text>
          <Text style={styles.parameterControlHint}>{control.description}</Text>
        </View>
        <TextInput
          value={draft}
          onChangeText={(text) => {
            setDraft(text);
            const parsed = Number.parseFloat(text.replace(',', '.'));
            if (Number.isFinite(parsed)) {
              onChange(parsed);
            }
          }}
          onBlur={() => setDraft(formatParameterValue(value))}
          keyboardType="default"
          selectTextOnFocus
          style={styles.parameterValueInput}
        />
      </View>
      <ParameterSlider
        value={value}
        min={control.min}
        max={control.max}
        step={control.step}
        onChange={onChange}
      />
      <View style={styles.parameterRangeRow}>
        <Text style={styles.parameterRangeText}>{formatParameterValue(control.min)}</Text>
        <Text style={styles.parameterRangeText}>{formatParameterValue(control.max)}</Text>
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
  const [mounted, setMounted] = useState(visible);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (unmountTimer.current) {
      clearTimeout(unmountTimer.current);
      unmountTimer.current = null;
    }

    if (visible) {
      setMounted(true);
      return undefined;
    }

    unmountTimer.current = setTimeout(() => {
      setMounted(false);
      unmountTimer.current = null;
    }, 240);

    return () => {
      if (unmountTimer.current) {
        clearTimeout(unmountTimer.current);
        unmountTimer.current = null;
      }
    };
  }, [visible]);

  if (!mounted) {
    return null;
  }

  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.modelPickerModalRoot}>
        <AnimatePresence>
          {visible ? (
            <MotiView
              key="model-picker-backdrop"
              from={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: 'timing', duration: 180 }}
              style={styles.modelPickerBackdrop}
            >
              <Pressable accessibilityRole="button" onPress={onClose} style={styles.modelPickerBackdropPressable} />
            </MotiView>
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {visible ? (
            <MotiView
              key="model-picker-sheet"
              testID="model-picker-sheet"
              from={{ opacity: 0, translateY: 48, scale: 0.98 }}
              animate={{ opacity: 1, translateY: 0, scale: 1 }}
              exit={{ opacity: 0, translateY: 48, scale: 0.98 }}
              transition={{ type: 'timing', duration: 220 }}
              style={styles.modelPickerSheet}
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
                            haptic="selection"
                            style={[
                              styles.modelPickerRow,
                              selected && styles.modelPickerRowActive,
                            ]}
                          >
                            <ModelAvatar
                              modelId={model.id}
                              providerName={group.provider.name}
                              size={17}
                              containerSize={26}
                            />
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
            </MotiView>
          ) : null}
        </AnimatePresence>
      </View>
    </Modal>
  );
}

const ReanimatedPressable = Reanimated.createAnimatedComponent(Pressable);

/**
 * 抽屉侧边栏：
 * - 用 Reanimated 驱动面板滑入 / 遮罩淡入，避免生硬的瞬间弹出；
 * - 用 gesture-handler 支持向左滑动关闭，手势与动画共享同一个进度值；
 * - 关闭时先播放退场动画再卸载 Modal（progress 归零后回调卸载）。
 */
function SidebarDrawer({
  open,
  onClose,
  onPanelLayout,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onPanelLayout?: (height: number) => void;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(320, Math.round(width * 0.8));
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    if (open) {
      setMounted(true);
      progress.value = withSpring(1, { damping: 22, stiffness: 220, mass: 0.9 });
    } else {
      progress.value = withTiming(0, { duration: 200 }, (finished) => {
        if (finished) {
          runOnJS(setMounted)(false);
        }
      });
    }
    // 仅依赖 open：手势与内部状态不应重新触发入场/退场。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const panGesture = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .onUpdate((event) => {
      const next = 1 + event.translationX / panelWidth;
      progress.value = Math.min(1, Math.max(0, next));
    })
    .onEnd((event) => {
      const shouldClose = event.translationX < -panelWidth * 0.35 || event.velocityX < -650;
      if (shouldClose) {
        runOnJS(onClose)();
      } else {
        progress.value = withSpring(1, { damping: 22, stiffness: 220, mass: 0.9 });
      }
    });

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }), [progress]);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(progress.value, [0, 1], [-panelWidth, 0], Extrapolation.CLAMP),
      },
    ],
  }), [panelWidth, progress]);

  if (!mounted) {
    return null;
  }

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      {/* Modal 在原生端是独立的视图层级，手势需要在其中单独挂一个 root 才能生效 */}
      <GestureHandlerRootView style={styles.sidebarRoot}>
        <ReanimatedPressable
          accessibilityRole="button"
          onPress={onClose}
          style={[styles.sidebarScrimBase, scrimStyle]}
        />
        <GestureDetector gesture={panGesture}>
          <Reanimated.View
            style={[styles.sidebarPanel, { width: panelWidth }, panelStyle]}
            onLayout={(event) => onPanelLayout?.(event.nativeEvent.layout.height)}
          >
            {children}
          </Reanimated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

interface ModelButtonProps {
  model: ModelInfo;
  providerName?: string;
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

function ModelButton({ model, providerName, active, onPress, onRemove }: ModelButtonProps) {
  return (
    <View style={[styles.modelButton, active && styles.modelButtonActive]}>
      <AnimatedPressable accessibilityRole="button" onPress={onPress} style={styles.modelSelectArea}>
        <ModelAvatar modelId={model.id} providerName={providerName} size={17} containerSize={26} />
        <View style={styles.modelTextBlock}>
          <Text numberOfLines={1} style={[styles.modelName, active && styles.modelNameActive]}>
            {model.name ?? model.id}
          </Text>
          <Text numberOfLines={1} style={styles.modelMeta}>
            {model.id}
          </Text>
          <ModelTaskBadge model={model} />
        </View>
      </AnimatedPressable>
      <AnimatedPressable accessibilityRole="button" onPress={onRemove} style={styles.compactButton}>
        <Text style={styles.compactButtonText}>删除</Text>
      </AnimatedPressable>
    </View>
  );
}

interface CandidateModelRowProps {
  model: ModelInfo;
  providerName?: string;
  added: boolean;
  onAdd: () => void;
}

function CandidateModelRow({ model, providerName, added, onAdd }: CandidateModelRowProps) {
  return (
    <View style={styles.candidateRow}>
      <ModelAvatar modelId={model.id} providerName={providerName} size={17} containerSize={26} />
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
  root: {
    flex: 1,
  },
  iconCrossfade: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCrossfadeLayer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastRoot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 16,
    paddingVertical: 11,
    borderRadius: radii.pill,
    backgroundColor: palette.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 16,
    elevation: 8,
  },
  toastIconBadge: {
    width: 20,
    height: 20,
    borderRadius: radii.pill,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastText: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '600',
  },
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
    flex: 1,
    minWidth: 0,
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
    flexShrink: 1,
    maxWidth: 252,
    minWidth: 0,
    paddingHorizontal: 14,
    gap: 6,
  },
  modelPickerPillText: {
    flexShrink: 1,
    minWidth: 0,
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
    height: 40,
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
  candidateModelListFrame: {
    height: 340,
    maxHeight: 340,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? { overflowY: 'auto' } as any : {}),
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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
  },
  modelPickerBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: palette.scrim,
  },
  modelPickerBackdropPressable: {
    flex: 1,
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
    paddingHorizontal: 12,
    paddingVertical: 8,
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
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    gap: 7,
  },
  modelAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  assistantModelName: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: 140,
    color: palette.text,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '600',
  },
  assistantMetaDivider: {
    color: palette.textSecondary,
    fontSize: 12,
    lineHeight: 16,
  },
  assistantProviderName: {
    maxWidth: 100,
    color: palette.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '400',
  },
  assistantTime: {
    color: palette.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  messageText: {
    color: palette.text,
    fontSize: 15,
    lineHeight: 24,
  },
  userMessageText: {
    color: palette.text,
    fontSize: 15,
    lineHeight: 24,
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
    fontSize: 13,
    lineHeight: 20,
  },
  tokenUsageRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  tokenUsageItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  tokenUsageText: {
    color: palette.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  assistantFooterRow: {
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  messageActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  userMessageActions: {
    marginTop: 8,
    marginRight: 8,
  },
  messageActionButton: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageInlineEditor: {
    width: '100%',
    minWidth: 0,
    gap: 10,
  },
  messageInlineEditInput: {
    width: '100%',
    minHeight: 76,
    maxHeight: 150,
    borderRadius: radii.sm,
    borderWidth: 1,
    color: palette.text,
    fontSize: 15,
    lineHeight: 22,
    paddingHorizontal: 10,
    paddingVertical: 8,
    textAlignVertical: 'top',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as any : {}),
  },
  userInlineEditInput: {
    borderColor: '#9FDBB8',
    backgroundColor: '#F4FFF8',
  },
  assistantInlineEditInput: {
    borderColor: palette.border,
    backgroundColor: palette.surfaceAlt,
  },
  inlineEditActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  inlineEditSecondaryButton: {
    minWidth: 66,
    height: 34,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  inlineEditSecondaryText: {
    color: palette.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
  inlineEditPrimaryButton: {
    minWidth: 88,
    height: 34,
    borderRadius: radii.sm,
    backgroundColor: palette.text,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  inlineEditPrimaryText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  messageActionMenu: {
    alignSelf: 'flex-start',
    minWidth: 150,
    maxWidth: 190,
    marginTop: 6,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 18,
    elevation: 10,
  },
  userMessageActionMenu: {
    alignSelf: 'flex-end',
    marginRight: 6,
  },
  messageActionMenuRow: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#EFEFEF',
  },
  messageActionMenuDangerRow: {
    borderBottomWidth: 0,
  },
  messageActionMenuText: {
    flex: 1,
    minWidth: 0,
    color: palette.text,
    fontSize: 13,
    fontWeight: '700',
  },
  messageActionMenuDangerText: {
    color: palette.danger,
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 10,
  },
  reasoningMenuItemActive: {
    borderColor: palette.accent,
    backgroundColor: palette.accent,
  },
  reasoningMenuText: {
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  reasoningMenuTextActive: {
    color: palette.textOnAccent,
    fontWeight: '700',
  },
  parameterMenu: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    marginBottom: 8,
    backgroundColor: palette.bg,
    borderRadius: radii.md,
    padding: 12,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
  },
  toolMenuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  toolMenuTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  toolMenuTitle: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '700',
  },
  toolMenuSubtitle: {
    marginTop: 2,
    color: palette.textSecondary,
    fontSize: 12,
  },
  toolMenuSection: {
    gap: 8,
  },
  toolMenuSectionTitle: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '700',
  },
  toolSegmentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  toolSegment: {
    minHeight: 30,
    minWidth: 58,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  toolSegmentActive: {
    borderColor: palette.accentBorder,
    backgroundColor: palette.accentSoft,
  },
  toolSegmentText: {
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  toolSegmentTextActive: {
    color: palette.accentText,
    fontWeight: '700',
  },
  toolMenuHint: {
    color: palette.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  parameterControl: {
    gap: 8,
  },
  parameterControlHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  parameterControlTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  parameterControlLabel: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '700',
  },
  parameterControlHint: {
    marginTop: 2,
    color: palette.textSecondary,
    fontSize: 11,
    lineHeight: 15,
  },
  parameterValueInput: {
    width: 58,
    height: 32,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    color: palette.text,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as any : {}),
  },
  parameterSliderTrackArea: {
    height: 24,
    justifyContent: 'center',
  },
  parameterSliderTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.surfaceAlt,
  },
  parameterSliderFill: {
    position: 'absolute',
    left: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.accent,
  },
  parameterSliderThumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    marginLeft: -8,
    borderRadius: 8,
    backgroundColor: palette.bg,
    borderWidth: 2,
    borderColor: palette.accent,
  },
  parameterRangeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -4,
  },
  parameterRangeText: {
    color: palette.textMutedSolid,
    fontSize: 10,
    fontWeight: '600',
  },
  parameterResetButton: {
    height: 36,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  parameterResetButtonText: {
    color: palette.text,
    fontSize: 13,
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
    paddingBottom: 6,
    gap: 4,
  },
  composerInput: {
    alignSelf: 'stretch',
    height: 32,
    maxHeight: 120,
    paddingVertical: 6,
    paddingHorizontal: 2,
    color: palette.text,
    fontSize: 14,
    lineHeight: 20,
    textAlignVertical: 'center',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as any : {}),
  },
  composerFooter: {
    minHeight: 24,
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
  sidebarRoot: {
    flex: 1,
    flexDirection: 'row',
  },
  sidebarScrimBase: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: palette.scrim,
  },
  sidebarPanel: {
    width: '80%',
    maxWidth: 320,
    position: 'relative',
    overflow: 'hidden',
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
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
  },
  sidebarConversationItemActive: {
    backgroundColor: palette.surfaceAlt,
  },
  sidebarConversationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sidebarConversationContent: {
    flex: 1,
    minWidth: 0,
    gap: 4,
    paddingVertical: 2,
  },
  sidebarConversationTitleRow: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  sidebarConversationTitle: {
    flex: 1,
    minWidth: 0,
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
  sidebarConversationMore: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
  },
  sidebarConversationMoreActive: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.accentBorder,
  },
  sidebarConversationActionMenu: {
    position: 'absolute',
    right: 20,
    zIndex: 31,
    elevation: 31,
    width: 184,
    borderRadius: radii.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.12,
    shadowRadius: 22,
  },
  sidebarConversationFrost: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 30,
    elevation: 30,
    backgroundColor: 'rgba(255, 255, 255, 0.64)',
    ...(Platform.OS === 'web'
      ? ({
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
        } as any)
      : {}),
  },
  sidebarConversationFrostTapTarget: {
    flex: 1,
  },
  sidebarConversationActionRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#EFEFEF',
  },
  sidebarConversationActionDangerRow: {
    borderBottomWidth: 0,
  },
  sidebarConversationActionText: {
    flex: 1,
    minWidth: 0,
    color: palette.text,
    fontSize: 13,
    fontWeight: '700',
  },
  sidebarConversationActionDangerText: {
    color: palette.danger,
  },
  sidebarEmpty: {
    color: palette.placeholder,
    fontSize: 14,
  },
  renameDialogScrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.32)',
    paddingHorizontal: 28,
    zIndex: 1000,
    elevation: 1000,
    ...(Platform.OS === 'web'
      ? ({
          position: 'fixed',
          inset: 0,
        } as any)
      : {}),
  },
  renameDialog: {
    width: '100%',
    maxWidth: 380,
    minWidth: 0,
    borderRadius: radii.lg,
    backgroundColor: palette.bg,
    padding: 18,
    gap: 14,
    zIndex: 1001,
    elevation: 1001,
  },
  renameDialogTitle: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '800',
  },
  renameDialogInput: {
    minHeight: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    color: palette.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 8,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as any : {}),
  },
  renameDialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  renameDialogSecondaryButton: {
    minWidth: 72,
    height: 38,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  renameDialogSecondaryText: {
    color: palette.textSecondary,
    fontSize: 14,
    fontWeight: '700',
  },
  renameDialogPrimaryButton: {
    minWidth: 72,
    height: 38,
    borderRadius: radii.sm,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  renameDialogPrimaryText: {
    color: palette.textOnAccent,
    fontSize: 14,
    fontWeight: '800',
  },
  deleteConfirmScrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.32)',
    paddingHorizontal: 30,
    zIndex: 1000,
    elevation: 1000,
    ...(Platform.OS === 'web'
      ? ({
          position: 'fixed',
          inset: 0,
        } as any)
      : {}),
  },
  deleteConfirmDialog: {
    width: '100%',
    maxWidth: 340,
    minWidth: 0,
    borderRadius: radii.lg,
    backgroundColor: palette.bg,
    padding: 18,
    gap: 12,
    zIndex: 1001,
    elevation: 1001,
  },
  deleteConfirmIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: palette.dangerBg,
    borderWidth: 1,
    borderColor: palette.dangerBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteConfirmTitle: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '800',
  },
  deleteConfirmText: {
    color: palette.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  deleteConfirmButton: {
    minWidth: 72,
    height: 38,
    borderRadius: radii.sm,
    backgroundColor: palette.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  deleteConfirmButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
});
