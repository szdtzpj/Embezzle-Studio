import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Bing, DeepSeek, Exa, Grok, Tavily } from '@lobehub/icons-rn';
import {
  Activity,
  Check,
  ChevronRight,
  Globe2,
  Minus,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react-native';

import type {
  ExternalSearchProviderKind,
  ExternalSearchService,
  ExternalSearchSettings,
  WebSearchSettings,
} from '../../domain/types';
import {
  DEFAULT_GROK_SEARCH_MODEL,
  allExternalSearchProviderHints,
  allExternalSearchProviderKinds,
  allExternalSearchProviderLabels,
  externalSearchProviderAllowsAnonymous,
  externalSearchProviderRequiresApiKey,
  externalSearchProviderRequiresEndpoint,
  isExternalSearchServiceConfigured,
  runExternalSearch,
  validateExternalSearchEndpoint,
} from '../../services/externalSearch';
import { guardedApiFetch } from '../../services/openAiCompatible';
import { useKelivoTheme, type KelivoTheme } from '../theme';
import { OverlayPortal } from './AppDialogHost';
import { AnimatedPressable } from './AnimatedPressable';
import {
  BochaMark,
  BraveMark,
  DuckDuckGoMark,
  ExaMark,
  FirecrawlMark,
  SearxngMark,
} from './SearchBrandMarks';
import { RowDivider, SectionCard, SectionHeader } from './settings/SettingsList';

// Domain type re-export for context size used by settings.
export type SearchContextSize = WebSearchSettings['searchContextSize'];

export type SearchServiceIconKind = 'off' | 'builtin' | ExternalSearchProviderKind;

export interface SearchServicesPanelProps {
  readOnly: boolean;
  webSearch: WebSearchSettings;
  externalSearch: ExternalSearchSettings;
  webSearchReady: boolean;
  webSearchContextSizeApplies: boolean;
  /** Configure provider-hosted search depth only (selection happens in chat sheet). */
  onSetSearchContextSize: (size: SearchContextSize) => void;
  onRemoveExternalService: (serviceId: string) => void;
  onAddExternalService: (input: {
    kind: ExternalSearchProviderKind;
    apiKey?: string;
    endpoint?: string;
    model?: string;
    serviceId?: string;
  }) => void;
  onSetMaxResults: (count: number) => void;
  onSetMaxToolRounds: (count: number) => void;
}

const brandTint: Record<ExternalSearchProviderKind, string> = {
  bing: '#00809D',
  duckduckgo: '#DE5833',
  tavily: '#468BFF',
  brave: '#FB542B',
  firecrawl: '#E11D48',
  grok: '#111827',
  deepseek: '#4D6BFE',
  bocha: '#0EA5E9',
  exa: '#1F40ED',
  searxng: '#3050FF',
};

const brandLetter: Record<ExternalSearchProviderKind, string> = {
  bing: 'B',
  duckduckgo: 'D',
  tavily: 'T',
  brave: 'b',
  firecrawl: 'F',
  grok: 'G',
  deepseek: 'D',
  bocha: 'B',
  exa: 'E',
  searxng: 'S',
};

/** 全部 10 家外部搜索服务默认 Endpoint 输入占位提示。 */
const endpointPlaceholderByKind: Record<ExternalSearchProviderKind, string> = {
  tavily: 'https://api.tavily.com/search',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  grok: 'https://api.x.ai/v1/responses',
  bing: 'https://www.bing.com/search',
  duckduckgo: 'https://html.duckduckgo.com/html/',
  firecrawl: 'https://api.firecrawl.dev/v2/search',
  deepseek: 'https://api.deepseek.com/v1/tools/search',
  bocha: 'https://api.bochaai.com/v1/web-search',
  exa: 'https://api.exa.ai/search',
  searxng: 'https://search.example.com',
};

function escapeSanitizeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPercentEncodedSecretPattern(encodedValue: string): RegExp {
  const source = escapeSanitizeRegExp(encodedValue).replace(
    /%([0-9a-f]{2})/gi,
    (_, hex: string) => {
      const upper = hex.toUpperCase();
      const lower = hex.toLowerCase();
      if (upper === '20') return '(?:%20|\\+)';
      const c0 = upper[0] === lower[0] ? upper[0] : `[${upper[0]}${lower[0]}]`;
      const c1 = upper[1] === lower[1] ? upper[1] : `[${upper[1]}${lower[1]}]`;
      return `%${c0}${c1}`;
    }
  );
  return new RegExp(source, 'g');
}

const SENSITIVE_URL_PARAM_RE =
  /([?&#])(api[-_]?key|apikey|x[-_](?:api|auth|goog-api|subscription)[-_]?(?:key|token)|(?:ocp-apim-)?subscription[-_]key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|security[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|key|token|secret|password|passwd|credential|signature)=([^&#\s"'<>()[\]{}]+)/gi;

const SENSITIVE_AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=%:~]+/gi;

const AUTH_SCHEME_PREFIX =
  '(?:(?:bearer|basic|token|oauth|key|secret|negotiate|ntlm|aws4-hmac-sha256|api[-_]?key|apikey|digest|hmac|signature)\\s+)?';

const SENSITIVE_AUTH_HEADER_RE = new RegExp(
  `\\b((?:proxy[-_]?)?authorization\\s*[:=]\\s*${AUTH_SCHEME_PREFIX})[^\\s"'<>()\\[\\]{},;&#]+`,
  'gi'
);

const SENSITIVE_JSON_DOUBLE_QUOTED_RE =
  /(")(proxy[-_]?authorization|authorization|x[-_]?api[-_]?key|x[-_]?goog[-_]?api[-_]?key|x[-_]?auth[-_]?token|x[-_]?api[-_]?token|x[-_]?subscription[-_]?token|(?:ocp-apim-)?subscription[-_]?key|x-amz-(?:security-token|signature|credential)|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|security[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|token|secret|password|passwd|credential|signature|key)("\s*:\s*")((?:\\.|[^"\\])+)"?/gi;

const SENSITIVE_JSON_SINGLE_QUOTED_RE =
  /(')(proxy[-_]?authorization|authorization|x[-_]?api[-_]?key|x[-_]?goog[-_]?api[-_]?key|x[-_]?auth[-_]?token|x[-_]?api[-_]?token|x[-_]?subscription[-_]?token|(?:ocp-apim-)?subscription[-_]?key|x-amz-(?:security-token|signature|credential)|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|security[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|token|secret|password|passwd|credential|signature|key)('\s*:\s*')((?:\\.|[^'\\])+)'?/gi;

// 与 JSON 引号规则同步字段清单，并在引号值正则中额外覆盖无引号键的 Authorization / Proxy-Authorization。
const SENSITIVE_HEADER_FIELDS =
  'x[-_]api[-_]key|x[-_]goog[-_]api[-_]key|x[-_]auth[-_]token|x[-_]api[-_]token|x[-_]subscription[-_]token|(?:ocp-apim-)?subscription[-_]key|x-amz-(?:security-token|signature|credential)|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|security[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|token|secret|password|passwd|credential|signature';

const SENSITIVE_QUOTED_HEADER_FIELDS = `(?:proxy[-_]?authorization|authorization)\\s*[:=]\\s*${AUTH_SCHEME_PREFIX}|(?:${SENSITIVE_HEADER_FIELDS})\\s*[:=]\\s*`;

const SENSITIVE_UNQUOTED_KEY_DOUBLE_VAL_RE = new RegExp(
  `\\b((?:${SENSITIVE_QUOTED_HEADER_FIELDS})")((?:\\\\.|[^"\\\\])+)"?`,
  'gi'
);

const SENSITIVE_UNQUOTED_KEY_SINGLE_VAL_RE = new RegExp(
  `\\b((?:${SENSITIVE_QUOTED_HEADER_FIELDS})')((?:\\\\.|[^'\\\\])+)'?`,
  'gi'
);

const SENSITIVE_UNQUOTED_KEY_PLAIN_VAL_RE = new RegExp(
  `\\b((?:${SENSITIVE_HEADER_FIELDS})\\s*[:=]\\s*)[^\\s"'<>()\\[\\]{},;&#]+`,
  'gi'
);

/** 对连接测试异常消息进行脱敏与长度截断，防止意外回显密钥与 URL 凭据。 */
export function formatSanitizedConnectionError(
  error: unknown,
  rawApiKey?: string
): string {
  const rawMessage =
    error instanceof Error ? error.message : '连接测试失败，请检查配置。';
  let sanitized = rawMessage.replace(/\s+/g, ' ').trim();
  const trimmedKey = rawApiKey?.trim();
  // 仅当用户密钥长度达到 4 位时执行字面与百分号编码替换，避免短测试字符误伤提示文本。
  if (trimmedKey && trimmedKey.length >= 4) {
    sanitized = sanitized.split(trimmedKey).join('***');
    const encodedKey = encodeURIComponent(trimmedKey);
    if (encodedKey && encodedKey !== trimmedKey) {
      sanitized = sanitized.replace(
        buildPercentEncodedSecretPattern(encodedKey),
        '***'
      );
    }
  }
  sanitized = sanitized
    // 1. URL userinfo 凭据（含 user:pass@、单用户名 user@、多 @ 特殊密码及 :@）
    .replace(/(\b[a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/?#"'<>]*@/gi, '$1***@')
    // 2. URL query 与 hash fragment 敏感参数（保留空参数如 api_key=&token=***）
    .replace(SENSITIVE_URL_PARAM_RE, '$1$2=***')
    // 3. Bearer / Basic 方案（含 URL-safe Base64 `-`/`_`/`.` 与 `%`/`:`/`~`）
    .replace(SENSITIVE_AUTH_SCHEME_RE, '$1 ***')
    // 4. JSON / 单引号键值对（支持转义引号与日志截断未闭合引号）
    .replace(SENSITIVE_JSON_DOUBLE_QUOTED_RE, '$1$2$3***"')
    .replace(SENSITIVE_JSON_SINGLE_QUOTED_RE, "$1$2$3***'")
    // 5. 无引号键名接引号值（含 Authorization / Proxy-Authorization 及带方案后接引号）
    .replace(SENSITIVE_UNQUOTED_KEY_DOUBLE_VAL_RE, '$1***"')
    .replace(SENSITIVE_UNQUOTED_KEY_SINGLE_VAL_RE, "$1***'")
    // 6. Authorization / Proxy-Authorization 无引号鉴权方案或裸凭据（在引号脱敏后执行，防方案名被误替而遗留引号原文）
    .replace(SENSITIVE_AUTH_HEADER_RE, '$1***')
    // 7. 其余无引号键名接无引号值（含 Signature=、Ocp-Apim-Subscription-Key 等）
    .replace(SENSITIVE_UNQUOTED_KEY_PLAIN_VAL_RE, '$1***')
    // 8. 常见服务商 API Key 前缀兜底
    .replace(/\b(?:sk|tvly|bsk|fc|xai|exa)-[A-Za-z0-9_\-]{6,}/gi, '***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '***')
    .replace(/\bAIza[0-9A-Za-z_\-]{20,}/g, '***');

  if (!sanitized) return '连接测试失败，请检查配置。';
  return sanitized.length > 160 ? `${sanitized.slice(0, 157)}...` : sanitized;
}

function renderBrandMark(
  kind: ExternalSearchProviderKind,
  iconSize: number,
  isDark: boolean
): ReactNode {
  if (kind === 'bing') return <Bing.Color size={iconSize} />;
  if (kind === 'tavily') return <Tavily.Color size={iconSize} />;
  if (kind === 'grok') return <Grok size={iconSize} color={isDark ? '#E5E7EF' : '#111827'} />;
  if (kind === 'brave') return <BraveMark size={iconSize} />;
  if (kind === 'firecrawl') return <FirecrawlMark size={iconSize} />;
  if (kind === 'duckduckgo') return <DuckDuckGoMark size={iconSize} />;
  if (kind === 'deepseek') {
    let DeepSeekIcon: typeof DeepSeek.Color | typeof DeepSeek | undefined;
    try {
      const candidate = DeepSeek?.Color ?? DeepSeek;
      if (typeof candidate === 'function') {
        DeepSeekIcon = candidate;
      }
    } catch {
      DeepSeekIcon = undefined;
    }
    if (DeepSeekIcon) return <DeepSeekIcon size={iconSize} />;
  }
  if (kind === 'exa') {
    let ExaIcon: typeof Exa.Color | typeof Exa | undefined;
    try {
      const candidate = Exa?.Color ?? Exa;
      if (typeof candidate === 'function') {
        ExaIcon = candidate;
      }
    } catch {
      ExaIcon = undefined;
    }
    return ExaIcon ? <ExaIcon size={iconSize} /> : <ExaMark size={iconSize} />;
  }
  if (kind === 'bocha') return <BochaMark size={iconSize} />;
  if (kind === 'searxng') return <SearxngMark size={iconSize} />;
  return (
    <Text
      style={{
        color: brandTint[kind],
        fontSize: Math.max(11, Math.round(iconSize * 0.72)),
        fontWeight: '800',
      }}
    >
      {brandLetter[kind]}
    </Text>
  );
}

/**
 * Brand mark for lists (badge) or composer toolbar (plain, no circular chip).
 */
export function SearchServiceIcon({
  kind,
  size = 22,
  color,
  active = false,
  variant = 'badge',
}: {
  kind: SearchServiceIconKind;
  size?: number;
  color: string;
  active?: boolean;
  /** `toolbar` matches other composer tool glyphs (no circular chip). */
  variant?: 'badge' | 'toolbar';
}): ReactNode {
  const theme = useKelivoTheme();
  const isDark = theme.scheme === 'dark';

  if (variant === 'toolbar') {
    if (kind === 'off' || kind === 'builtin') {
      return <Globe2 size={size} color={color} strokeWidth={2.2} />;
    }
    return renderBrandMark(kind, size, isDark);
  }

  const badgeBg = isDark ? 'rgba(255,255,255,0.08)' : `${theme.colors.primary}14`;
  const iconSize = Math.round(size * 0.62);

  if (kind === 'off') {
    return <Globe2 size={size} color={color} strokeWidth={2.1} />;
  }

  if (kind === 'builtin') {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: active ? `${theme.colors.primary}22` : badgeBg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Globe2 size={iconSize} color={theme.colors.primary} strokeWidth={2.1} />
      </View>
    );
  }

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: active ? `${brandTint[kind]}18` : badgeBg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {renderBrandMark(kind, iconSize, isDark)}
    </View>
  );
}

export interface SearchServicesPanelHandle {
  openAdd: () => void;
}

export function resolveActiveSearchIconKind(args: {
  webSearchEnabled: boolean;
  externalSearch: ExternalSearchSettings;
}): SearchServiceIconKind {
  if (args.externalSearch.enabled) {
    const service =
      args.externalSearch.services.find(
        (item) => item.id === args.externalSearch.selectedServiceId
      ) ?? args.externalSearch.services[0];
    return service?.kind ?? 'off';
  }
  if (args.webSearchEnabled) return 'builtin';
  return 'off';
}

function Stepper({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  const theme = useKelivoTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.stepper}>
      <AnimatedPressable
        accessibilityRole="button"
        disabled={disabled || value <= min}
        onPress={() => onChange(Math.max(min, value - 1))}
        haptic="selection"
        style={[styles.stepperBtn, (disabled || value <= min) && styles.disabled]}
      >
        <Minus size={14} color={theme.colors.textSecondary} strokeWidth={2.2} />
      </AnimatedPressable>
      <Text style={styles.stepperValue}>{value}</Text>
      <AnimatedPressable
        accessibilityRole="button"
        disabled={disabled || value >= max}
        onPress={() => onChange(Math.min(max, value + 1))}
        haptic="selection"
        style={[styles.stepperBtn, (disabled || value >= max) && styles.disabled]}
      >
        <Plus size={14} color={theme.colors.textSecondary} strokeWidth={2.2} />
      </AnimatedPressable>
    </View>
  );
}

/**
 * Settings page: Kelivo iOS section cards + brand rows.
 * Add action lives in the nav bar (+); call via ref.openAdd().
 */
export const SearchServicesPanel = forwardRef<
  SearchServicesPanelHandle,
  SearchServicesPanelProps
>(function SearchServicesPanel(
  {
    readOnly,
    webSearch,
    externalSearch,
    webSearchReady,
    webSearchContextSizeApplies,
    onSetSearchContextSize,
    onRemoveExternalService,
    onAddExternalService,
    onSetMaxResults,
    onSetMaxToolRounds,
  },
  ref
) {
  const theme = useKelivoTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const windowH = Dimensions.get('window').height;
  const sheetMaxH = Math.round(windowH * 0.88);

  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const [formKind, setFormKind] = useState<ExternalSearchProviderKind | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState(DEFAULT_GROK_SEARCH_MODEL);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [actionService, setActionService] = useState<ExternalSearchService | null>(null);
  const [testingServiceId, setTestingServiceId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    Record<string, 'ok' | 'fail' | undefined>
  >({});
  const [connectionErrors, setConnectionErrors] = useState<
    Record<string, string | undefined>
  >({});

  useImperativeHandle(ref, () => ({
    openAdd: () => {
      if (!readOnly) setAddPickerOpen(true);
    },
  }));

  const closeForms = () => {
    setAddPickerOpen(false);
    setFormKind(null);
    setEditingServiceId(null);
    setApiKey('');
    setEndpoint('');
    setModel(DEFAULT_GROK_SEARCH_MODEL);
  };

  const openAddForm = (kind: ExternalSearchProviderKind) => {
    setAddPickerOpen(false);
    setFormKind(kind);
    setEditingServiceId(null);
    setApiKey('');
    setEndpoint('');
    setModel(kind === 'grok' ? DEFAULT_GROK_SEARCH_MODEL : '');
  };

  const openEditForm = (service: ExternalSearchService) => {
    setActionService(null);
    setAddPickerOpen(false);
    setFormKind(service.kind);
    setEditingServiceId(service.id);
    setApiKey(service.apiKey ?? '');
    setEndpoint(service.endpoint ?? '');
    setModel(service.model ?? (service.kind === 'grok' ? DEFAULT_GROK_SEARCH_MODEL : ''));
  };

  const formRequiresKey = formKind
    ? externalSearchProviderRequiresApiKey(formKind, endpoint)
    : true;
  const formAllowsAnonymous = formKind
    ? externalSearchProviderAllowsAnonymous(formKind, endpoint)
    : false;
  const formRequiresEndpoint = formKind
    ? externalSearchProviderRequiresEndpoint(formKind)
    : false;
  const endpointValidation = formKind
    ? validateExternalSearchEndpoint(formKind, endpoint)
    : { ok: true as const, endpoint: undefined };
  const canSubmitForm =
    Boolean(formKind) &&
    (formRequiresKey ? Boolean(apiKey.trim()) : true) &&
    endpointValidation.ok;

  const handleSubmit = () => {
    if (!formKind || !canSubmitForm || !endpointValidation.ok) return;
    onAddExternalService({
      kind: formKind,
      apiKey: apiKey.trim() || undefined,
      ...(endpointValidation.endpoint ? { endpoint: endpointValidation.endpoint } : {}),
      ...(formKind === 'grok' && model.trim() ? { model: model.trim() } : {}),
      ...(editingServiceId ? { serviceId: editingServiceId } : {}),
    });
    closeForms();
  };

  const addProviderKind = (kind: ExternalSearchProviderKind) => {
    // Pure free local engines are one-tap. Firecrawl still uses the form so the
    // user can optionally add a key for higher limits or choose a self-hosted endpoint.
    if (kind === 'bing' || kind === 'duckduckgo') {
      onAddExternalService({ kind });
      closeForms();
      return;
    }
    openAddForm(kind);
  };

  const testServiceConnection = async (service: ExternalSearchService) => {
    setActionService(null);
    setTestingServiceId(service.id);
    setConnectionErrors((current) => ({ ...current, [service.id]: undefined }));
    try {
      await runExternalSearch({
        query: 'connectivity test',
        service,
        maxResults: 1,
        timeoutMs: 15_000,
        fetchImpl: guardedApiFetch,
      });
      setConnectionStatus((current) => ({ ...current, [service.id]: 'ok' }));
      setConnectionErrors((current) => ({ ...current, [service.id]: undefined }));
    } catch (error) {
      setConnectionStatus((current) => ({ ...current, [service.id]: 'fail' }));
      setConnectionErrors((current) => ({
        ...current,
        [service.id]: formatSanitizedConnectionError(error, service.apiKey),
      }));
    } finally {
      setTestingServiceId(null);
    }
  };

  const sheetBottomPad = Math.max(insets.bottom, 16) + 8;
  const sheetListMaxH = Math.max(220, sheetMaxH - 120 - sheetBottomPad);

  return (
    <View style={styles.root} testID="web-search-settings-card">
      <SectionHeader title="搜索提供商" first />
      <Text style={styles.pageHint}>
        此处仅管理服务配置。要开启联网并选择供应商，请在对话页点地球图标。
      </Text>
      <SectionCard>
        {/* Built-in — configure only (depth); do not toggle active pathway here */}
        <View style={styles.settingsRow} testID="search-service-row-builtin">
          <SearchServiceIcon kind="builtin" size={28} color={colors.primary} />
          <View style={styles.settingsTextBlock}>
            <Text style={styles.settingsTitle}>服务商内置</Text>
            <Text style={styles.settingsHint} numberOfLines={1}>
              {webSearchReady
                ? 'OpenAI / Claude / Gemini / Grok / DeepSeek / 方舟 / 百炼'
                : '当前模型或端点未满足条件'}
            </Text>
          </View>
        </View>

        {webSearchContextSizeApplies ? (
          <>
            <RowDivider />
            <View style={styles.depthBlock}>
              <Text style={styles.depthLabel}>搜索深度</Text>
              <View style={styles.chipRow}>
                {(['low', 'medium', 'high'] as const).map((size) => {
                  const selected = webSearch.searchContextSize === size;
                  return (
                    <AnimatedPressable
                      key={size}
                      disabled={readOnly}
                      onPress={() => onSetSearchContextSize(size)}
                      haptic="selection"
                      style={[styles.miniChip, selected && styles.miniChipActive]}
                    >
                      <Text style={[styles.miniChipText, selected && styles.miniChipTextActive]}>
                        {size === 'low' ? '精简' : size === 'medium' ? '均衡' : '深入'}
                      </Text>
                    </AnimatedPressable>
                  );
                })}
              </View>
            </View>
          </>
        ) : null}

        {externalSearch.services.map((service) => {
          const status = connectionStatus[service.id];
          const connectionError = connectionErrors[service.id];
          const testing = testingServiceId === service.id;
          return (
            <View key={service.id}>
              <RowDivider />
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityLabel={`配置 ${service.name}`}
                accessibilityHint="点按编辑配置，长按可测试连接或删除"
                disabled={readOnly}
                testID={`search-service-row-${service.kind}`}
                onPress={() => openEditForm(service)}
                onLongPress={() => {
                  if (!readOnly) setActionService(service);
                }}
                delayLongPress={350}
                haptic="light"
                pressScale={0.995}
                style={styles.settingsRow}
              >
                <SearchServiceIcon kind={service.kind} size={28} color={colors.primary} />
                <Text
                  style={[styles.settingsTitle, styles.settingsRowTitle]}
                  numberOfLines={1}
                >
                  {service.name}
                </Text>
                {testing ? (
                  <View style={[styles.statusPill, styles.statusPillTesting]}>
                    <Text style={styles.statusPillTextTesting}>测试中</Text>
                  </View>
                ) : status === 'ok' ? (
                  <View style={[styles.statusPill, styles.statusPillOk]}>
                    <Text style={styles.statusPillTextOk}>已连接</Text>
                  </View>
                ) : status === 'fail' ? (
                  <View style={[styles.statusPill, styles.statusPillFail]}>
                    <Text style={styles.statusPillTextFail}>失败</Text>
                  </View>
                ) : null}
                <ChevronRight size={16} color={colors.textTertiary} strokeWidth={2} />
              </AnimatedPressable>
              {status === 'fail' && connectionError ? (
                <Text
                  testID="search-service-connection-error"
                  style={styles.connectionErrorText}
                  numberOfLines={2}
                >
                  {connectionError}
                </Text>
              ) : null}
            </View>
          );
        })}
      </SectionCard>

      {/* Long-press actions — kelivo style: 测试连接 / 删除 */}
      <OverlayPortal
        visible={actionService != null}
        layer="sheet"
        onRequestClose={() => setActionService(null)}
      >
        <View
          style={[
            styles.sheetScrim,
            {
              paddingTop: Math.max(16, insets.top),
              paddingLeft: insets.left,
              paddingRight: insets.right,
            },
          ]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setActionService(null)}
            accessibilityRole="button"
            accessibilityLabel="关闭"
          />
          <View
            style={[
              styles.actionSheet,
              { paddingBottom: Math.max(insets.bottom, 14) },
            ]}
            testID="search-service-actions"
          >
            <View style={styles.sheetHandle} />
            <AnimatedPressable
              accessibilityRole="button"
              testID="search-service-action-test"
              onPress={() => {
                if (actionService) void testServiceConnection(actionService);
              }}
              haptic="light"
              style={styles.actionSheetRow}
            >
              <Activity size={18} color={colors.text} strokeWidth={2.1} />
              <Text style={styles.actionSheetLabel}>测试连接</Text>
            </AnimatedPressable>
            <View style={styles.actionSheetDivider} />
            <AnimatedPressable
              accessibilityRole="button"
              testID="search-service-action-delete"
              onPress={() => {
                if (actionService) {
                  onRemoveExternalService(actionService.id);
                  setActionService(null);
                }
              }}
              haptic="warning"
              style={styles.actionSheetRow}
            >
              <Trash2 size={18} color={colors.error} strokeWidth={2.1} />
              <Text style={[styles.actionSheetLabel, styles.actionSheetDanger]}>删除</Text>
            </AnimatedPressable>
          </View>
        </View>
      </OverlayPortal>

      <SectionHeader title="通用选项" />
      <SectionCard>
        <View style={styles.optionRow}>
          <View style={styles.settingsTextBlock}>
            <Text style={styles.settingsTitle}>最大结果数</Text>
            <Text style={styles.settingsHint}>单次 search_web 返回条数上限</Text>
          </View>
          <Stepper
            value={externalSearch.maxResults}
            min={1}
            max={10}
            disabled={readOnly}
            onChange={onSetMaxResults}
          />
        </View>
        <RowDivider />
        <View style={styles.optionRow}>
          <View style={styles.settingsTextBlock}>
            <Text style={styles.settingsTitle}>工具轮次</Text>
            <Text style={styles.settingsHint}>主模型可连续调用搜索的最大轮数</Text>
          </View>
          <Stepper
            value={externalSearch.maxToolRounds}
            min={1}
            max={4}
            disabled={readOnly}
            onChange={onSetMaxToolRounds}
          />
        </View>
      </SectionCard>

      {/* Add provider picker — full scrollable bottom sheet (no mid-list clip) */}
      <OverlayPortal
        visible={addPickerOpen}
        layer="sheet"
        onRequestClose={closeForms}
      >
        <View
          style={[
            styles.sheetScrim,
            {
              paddingTop: Math.max(16, insets.top),
              paddingLeft: insets.left,
              paddingRight: insets.right,
            },
          ]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={closeForms} />
          <View
            style={[
              styles.sheet,
              { maxHeight: sheetMaxH, paddingBottom: sheetBottomPad },
            ]}
          >
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>添加搜索服务</Text>
            <ScrollView
              style={{ maxHeight: sheetListMaxH }}
              contentContainerStyle={styles.sheetListContent}
              bounces
              showsVerticalScrollIndicator
              keyboardShouldPersistTaps="handled"
            >
              {allExternalSearchProviderKinds.map((kind) => (
                <AnimatedPressable
                  key={kind}
                  accessibilityRole="button"
                  testID={`search-add-kind-${kind}`}
                  onPress={() => addProviderKind(kind)}
                  haptic="light"
                  pressScale={0.98}
                  style={styles.pickRow}
                >
                  <SearchServiceIcon kind={kind} size={28} color={colors.primary} />
                  <View style={styles.settingsTextBlock}>
                    <Text style={styles.pickTitle}>{allExternalSearchProviderLabels[kind]}</Text>
                    <Text style={styles.settingsHint} numberOfLines={2}>
                      {allExternalSearchProviderHints[kind]}
                    </Text>
                  </View>
                  <ChevronRight size={16} color={colors.textTertiary} strokeWidth={2} />
                </AnimatedPressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </OverlayPortal>

      {/* Provider config form */}
      <OverlayPortal
        visible={formKind != null}
        layer="sheet"
        onRequestClose={closeForms}
      >
        <View
          style={[
            styles.sheetScrim,
            {
              paddingTop: Math.max(16, insets.top),
              paddingLeft: insets.left,
              paddingRight: insets.right,
            },
          ]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={closeForms} />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.sheetKeyboard}
          >
            <View
              style={[
                styles.sheet,
                { maxHeight: sheetMaxH, paddingBottom: sheetBottomPad },
              ]}
            >
              <View style={styles.sheetHandle} />
              <ScrollView
                keyboardShouldPersistTaps="handled"
                bounces={false}
                showsVerticalScrollIndicator={false}
              >
                <View style={styles.formHeader}>
                  {formKind ? (
                    <SearchServiceIcon kind={formKind} size={32} color={colors.primary} />
                  ) : null}
                  <Text style={[styles.sheetTitle, { marginBottom: 4 }]}>
                    {formKind ? allExternalSearchProviderLabels[formKind] : ''}
                  </Text>
                </View>
                {formKind ? (
                  <Text style={styles.formHint}>{allExternalSearchProviderHints[formKind]}</Text>
                ) : null}
                <View style={styles.formField}>
                  <Text style={styles.formLabel}>
                    API Key{formRequiresKey ? '' : formAllowsAnonymous ? '（可选）' : ''}
                  </Text>
                  <TextInput
                    testID="search-service-form-apikey"
                    value={apiKey}
                    onChangeText={setApiKey}
                    placeholder={
                      formRequiresKey
                        ? '粘贴你的 API Key'
                        : formKind === 'firecrawl'
                          ? '可留空使用匿名额度；填写可提升额度'
                          : formKind === 'searxng'
                            ? '可留空；若实例开启鉴权可填写 Bearer Token'
                            : '可留空'
                    }
                    placeholderTextColor={colors.placeholder}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.formInput}
                  />
                </View>
                {formKind === 'grok' ? (
                  <View style={styles.formField}>
                    <Text style={styles.formLabel}>模型</Text>
                    <TextInput
                      testID="search-service-form-model"
                      value={model}
                      onChangeText={setModel}
                      placeholder={DEFAULT_GROK_SEARCH_MODEL}
                      placeholderTextColor={colors.placeholder}
                      autoCapitalize="none"
                      style={styles.formInput}
                    />
                  </View>
                ) : null}
                {formKind ? (
                  <View style={styles.formField}>
                    <Text style={styles.formLabel}>
                      {formRequiresEndpoint ? '实例 URL（必填，HTTPS）' : '自定义 URL（可选）'}
                    </Text>
                    <TextInput
                      testID="search-service-form-endpoint"
                      value={endpoint}
                      onChangeText={setEndpoint}
                      placeholder={endpointPlaceholderByKind[formKind]}
                      placeholderTextColor={colors.placeholder}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={styles.formInput}
                    />
                    {formKind === 'searxng' ? (
                      <Text style={styles.formFieldNote}>
                        需启用 SearXNG format=json 输出；仅支持公网 HTTPS 地址，禁止 http:// 或内网地址。
                      </Text>
                    ) : null}
                  </View>
                ) : null}
                {!endpointValidation.ok ? (
                  <Text
                    testID="search-service-form-error"
                    accessibilityLiveRegion="assertive"
                    style={styles.formError}
                  >
                    {endpointValidation.error}
                  </Text>
                ) : null}
                <AnimatedPressable
                  accessibilityRole="button"
                  disabled={readOnly || !canSubmitForm}
                  testID="search-service-form-submit"
                  onPress={handleSubmit}
                  haptic="light"
                  style={[styles.sheetPrimary, (!canSubmitForm || readOnly) && styles.disabled]}
                >
                  <Text style={styles.sheetPrimaryText}>
                    {editingServiceId ? '保存' : '添加'}
                  </Text>
                </AnimatedPressable>
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </View>
      </OverlayPortal>
    </View>
  );
});

/**
 * Composer search settings sheet — mirrors kelivo search_settings_sheet.dart:
 * handle · title · master toggle row · independent rounded provider rows with brand badge + check.
 */
export function ComposerSearchSheet({
  visible,
  webSearchEnabled,
  webSearchReady,
  externalSearch,
  modelSupportsTools,
  maxHeight,
  onClose: _onClose,
  onSelectOff,
  onSelectProvider,
  onSelectExternal,
  onManage,
}: {
  visible: boolean;
  webSearchEnabled: boolean;
  webSearchReady: boolean;
  externalSearch: ExternalSearchSettings;
  modelSupportsTools: boolean;
  maxHeight?: number;
  onClose: () => void;
  onSelectOff: () => void;
  onSelectProvider: () => void;
  onSelectExternal: (serviceId: string) => void;
  onManage: () => void;
}) {
  const theme = useKelivoTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { colors } = theme;
  const windowH = Dimensions.get('window').height;
  const sheetMaxH = Math.round(windowH * 0.72);
  const searchOn = webSearchEnabled || externalSearch.enabled;

  const handleToggle = (next: boolean) => {
    if (!next) {
      onSelectOff();
      return;
    }
    const selectedExternal =
      externalSearch.services.find((s) => s.id === externalSearch.selectedServiceId) ??
      externalSearch.services[0];
    if (
      selectedExternal &&
      isExternalSearchServiceConfigured(selectedExternal) &&
      modelSupportsTools
    ) {
      onSelectExternal(selectedExternal.id);
      return;
    }
    if (webSearchReady) {
      onSelectProvider();
      return;
    }
    const firstReady = externalSearch.services.find((s) =>
      isExternalSearchServiceConfigured(s)
    );
    if (firstReady && modelSupportsTools) {
      onSelectExternal(firstReady.id);
      return;
    }
    onSelectProvider();
  };

  if (!visible) return null;

  const popoverMaxH =
    maxHeight !== undefined
      ? Math.max(120, Math.min(sheetMaxH, maxHeight))
      : sheetMaxH;
  const isCompact = popoverMaxH <= 180;
  // 紧凑模式固定头部总高：composerSheetCompact(4+4+2=10) + title(16+2=18) + masterCardCompact(34+4=38) = 66px
  const listMaxH = isCompact
    ? Math.max(48, popoverMaxH - 66)
    : Math.max(80, Math.min(320, popoverMaxH - 130));

  return (
    <View style={styles.composerPopover} testID="composer-search-menu">
      <View
        style={[
          styles.composerSheet,
          isCompact && styles.composerSheetCompact,
          { maxHeight: popoverMaxH },
        ]}
        testID="composer-search-tags"
      >
        {!isCompact ? <View style={styles.sheetHandle} /> : null}
        <Text style={[styles.sheetTitle, isCompact && styles.sheetTitleCompact]}>搜索设置</Text>

        {/* Master: 网络搜索 + gear + switch — kelivo IosCardPress row */}
        <View style={[styles.masterCard, isCompact && styles.masterCardCompact]}>
          <View style={styles.masterLeft}>
            <Globe2 size={isCompact ? 18 : 20} color={colors.primary} strokeWidth={2.1} />
            <Text style={styles.masterTitle}>网络搜索</Text>
          </View>
          <View style={styles.masterRight}>
            <AnimatedPressable
              accessibilityRole="button"
              accessibilityLabel="管理搜索服务"
              testID="composer-search-manage"
              onPress={onManage}
              style={[styles.masterGear, isCompact && styles.masterGearCompact]}
              hitSlop={10}
              haptic="light"
            >
              <Settings size={isCompact ? 17 : 20} color={colors.textSecondary} strokeWidth={2} />
            </AnimatedPressable>
            <Switch
              value={searchOn}
              onValueChange={handleToggle}
              trackColor={{
                false: colors.outlineVariant,
                true: colors.primary,
              }}
              thumbColor={Platform.OS === 'android' ? colors.card : undefined}
              ios_backgroundColor={colors.outlineVariant}
              testID="composer-search-toggle"
            />
          </View>
        </View>

        {searchOn ? (
          <ScrollView
            style={[styles.serviceListScroll, { maxHeight: listMaxH }]}
            contentContainerStyle={styles.serviceList}
            bounces
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Built-in as independent rounded row */}
            <AnimatedPressable
              accessibilityRole="button"
              accessibilityState={{
                selected: webSearchEnabled,
                disabled: !webSearchReady && !webSearchEnabled,
              }}
              disabled={!webSearchReady && !webSearchEnabled}
              testID="composer-search-option-builtin"
              onPress={onSelectProvider}
              haptic="light"
              pressScale={0.98}
              style={[
                styles.serviceCard,
                isCompact && styles.serviceCardCompact,
                (!webSearchReady && !webSearchEnabled) && styles.disabled,
              ]}
            >
              <SearchServiceIcon
                kind="builtin"
                size={22}
                color={colors.primary}
                active={webSearchEnabled}
              />
              <Text
                style={[
                  styles.serviceName,
                  webSearchEnabled && styles.serviceNameActive,
                ]}
                numberOfLines={1}
              >
                服务商内置
              </Text>
              {webSearchEnabled ? (
                <Check size={18} color={colors.primary} strokeWidth={2.4} />
              ) : (
                <View style={styles.checkSpacer} />
              )}
            </AnimatedPressable>

            {externalSearch.services.map((service) => {
              const selected =
                externalSearch.enabled &&
                externalSearch.selectedServiceId === service.id;
              const available =
                isExternalSearchServiceConfigured(service) && modelSupportsTools;
              return (
                <AnimatedPressable
                  key={service.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled: !available && !selected }}
                  disabled={!available && !selected}
                  testID={`composer-search-option-${service.kind}`}
                  onPress={() => onSelectExternal(service.id)}
                  haptic="light"
                  pressScale={0.98}
                  style={[
                    styles.serviceCard,
                    isCompact && styles.serviceCardCompact,
                    (!available && !selected) && styles.disabled,
                  ]}
                >
                  <SearchServiceIcon
                    kind={service.kind}
                    size={22}
                    color={colors.primary}
                    active={selected}
                  />
                  <Text
                    style={[styles.serviceName, selected && styles.serviceNameActive]}
                    numberOfLines={1}
                  >
                    {service.name}
                  </Text>
                  {selected ? (
                    <Check size={18} color={colors.primary} strokeWidth={2.4} />
                  ) : (
                    <View style={styles.checkSpacer} />
                  )}
                </AnimatedPressable>
              );
            })}

            {externalSearch.services.length === 0 ? (
              <Text style={styles.emptyHint}>
                尚未添加外部搜索。点齿轮可添加 Bing / DuckDuckGo（免费）等。
              </Text>
            ) : null}
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

/** @deprecated Use ComposerSearchSheet */
export const SearchServiceTags = ComposerSearchSheet;

function createStyles(theme: KelivoTheme) {
  const { colors, radius } = theme;
  return StyleSheet.create({
    root: {
      paddingBottom: 8,
    },
    pageHint: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 17,
      paddingHorizontal: 24,
      marginBottom: 8,
      marginTop: -2,
    },

    /* Settings page rows */
    settingsRow: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 11,
      gap: 12,
    },
    settingsRowMain: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    settingsTextBlock: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    settingsTitle: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '500',
    },
    settingsRowTitle: {
      flex: 1,
      minWidth: 0,
    },
    settingsTitleActive: {
      color: colors.primary,
      fontWeight: '600',
    },
    settingsHint: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
    },
    statusPill: {
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    statusPillTesting: {
      backgroundColor: `${colors.primary}14`,
    },
    statusPillOk: {
      backgroundColor: 'rgba(22, 163, 74, 0.12)',
    },
    statusPillFail: {
      backgroundColor: 'rgba(217, 119, 6, 0.12)',
    },
    statusPillTextTesting: {
      color: colors.primary,
      fontSize: 11,
      fontWeight: '600',
    },
    statusPillTextOk: {
      color: '#16A34A',
      fontSize: 11,
      fontWeight: '600',
    },
    statusPillTextFail: {
      color: '#D97706',
      fontSize: 11,
      fontWeight: '600',
    },
    connectionErrorText: {
      color: colors.error,
      fontSize: 12,
      lineHeight: 16,
      paddingHorizontal: 12,
      paddingBottom: 10,
      marginTop: -4,
    },
    actionSheet: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingTop: 10,
      paddingHorizontal: 4,
      width: '100%',
    },
    actionSheetRow: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      paddingHorizontal: 18,
      paddingVertical: 12,
    },
    actionSheetLabel: {
      flex: 1,
      color: colors.text,
      fontSize: 16,
      fontWeight: '500',
    },
    actionSheetDanger: {
      color: colors.error,
    },
    actionSheetDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.divider,
      marginLeft: 50,
    },
    depthBlock: {
      paddingHorizontal: 12,
      paddingBottom: 12,
      gap: 8,
    },
    depthLabel: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '600',
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    miniChip: {
      height: 30,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.outline,
      backgroundColor: colors.surface,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    miniChipActive: {
      borderColor: colors.primary,
      backgroundColor: colors.primary,
    },
    miniChipText: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '500',
    },
    miniChipTextActive: {
      color: colors.onPrimary,
      fontWeight: '600',
    },
    optionRow: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 11,
      gap: 12,
    },
    stepper: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    stepperBtn: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.outline,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepperValue: {
      minWidth: 22,
      textAlign: 'center',
      color: colors.text,
      fontSize: 14,
      fontWeight: '600',
    },

    /* Shared sheets */
    sheetScrim: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: colors.scrim,
      ...(Platform.OS === 'web'
        ? ({ position: 'fixed', inset: 0 } as object)
        : {}),
    },
    sheetKeyboard: {
      width: '100%',
    },
    sheet: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 16,
      paddingTop: 10,
      width: '100%',
      // Avoid clipping children; height is set inline from screen metrics.
      overflow: 'visible',
    },
    sheetHandle: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: `${colors.onSurface}33`,
      marginBottom: 12,
    },
    sheetTitle: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '600',
      textAlign: 'center',
      marginBottom: 14,
    },
    sheetTitleCompact: {
      fontSize: 12,
      lineHeight: 16,
      marginBottom: 2,
    },
    sheetListContent: {
      paddingBottom: 8,
    },
    pickRow: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.divider,
    },
    pickTitle: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    formHeader: {
      alignItems: 'center',
      gap: 8,
      marginBottom: 4,
    },
    formHint: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 17,
      textAlign: 'center',
      marginBottom: 14,
    },
    formField: {
      marginBottom: 12,
      gap: 6,
    },
    formLabel: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '600',
    },
    formInput: {
      minHeight: 44,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.outline,
      backgroundColor: colors.surface,
      paddingHorizontal: 12,
      color: colors.text,
      fontSize: 15,
    },
    formFieldNote: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
      marginTop: 2,
    },
    formError: {
      color: colors.error,
      fontSize: 12,
      lineHeight: 17,
      marginBottom: 8,
    },
    sheetPrimary: {
      marginTop: 8,
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetPrimaryText: {
      color: colors.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },

    /* Composer popover — kelivo search_settings_sheet */
    composerPopover: {
      position: 'absolute',
      bottom: '100%',
      left: 0,
      right: 0,
      marginBottom: 8,
      zIndex: 30,
      elevation: 12,
    },
    composerSheet: {
      backgroundColor: colors.card,
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.outline,
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 12,
      width: '100%',
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 16,
      elevation: 12,
    },
    composerSheetCompact: {
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingTop: 4,
      paddingBottom: 4,
    },
    masterCard: {
      minHeight: 48,
      borderRadius: 14,
      backgroundColor: colors.surface,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingVertical: 6,
      marginBottom: 10,
    },
    masterCardCompact: {
      minHeight: 34,
      height: 34,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 2,
      marginBottom: 4,
    },
    masterLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      flex: 1,
      minWidth: 0,
    },
    masterTitle: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '600',
    },
    masterRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    masterGear: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    masterGearCompact: {
      width: 28,
      height: 28,
    },
    serviceListScroll: {
      flexGrow: 0,
      flexShrink: 1,
      minHeight: 0,
      maxHeight: 320,
    },
    serviceList: {
      gap: 8,
      paddingBottom: 4,
    },
    /** Independent iOS-style cards like kelivo service rows */
    serviceCard: {
      height: 48,
      borderRadius: 14,
      backgroundColor: colors.surface,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      gap: 10,
    },
    serviceCardCompact: {
      height: 42,
      borderRadius: 12,
    },
    serviceName: {
      flex: 1,
      minWidth: 0,
      color: colors.text,
      fontSize: 15,
      fontWeight: '500',
    },
    serviceNameActive: {
      color: colors.primary,
      fontWeight: '600',
    },
    checkSpacer: {
      width: 18,
      height: 18,
    },
    emptyHint: {
      color: colors.textTertiary,
      fontSize: 12,
      lineHeight: 17,
      paddingHorizontal: 4,
      paddingVertical: 8,
    },
    disabled: {
      opacity: 0.4,
    },
  });
}
