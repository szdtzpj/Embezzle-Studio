import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  Dimensions,
  Modal,
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
import { Bing, Grok, Tavily } from '@lobehub/icons-rn';
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
  externalSearchProviderAllowsAnonymous,
  externalSearchProviderHints,
  externalSearchProviderKinds,
  externalSearchProviderLabels,
  externalSearchProviderRequiresApiKey,
  isExternalSearchServiceConfigured,
  runExternalSearch,
} from '../../services/externalSearch';
import { guardedApiFetch } from '../../services/openAiCompatible';
import { useKelivoTheme, type KelivoTheme } from '../theme';
import { AnimatedPressable } from './AnimatedPressable';
import { BraveMark, DuckDuckGoMark, FirecrawlMark } from './SearchBrandMarks';
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
};

const brandLetter: Record<ExternalSearchProviderKind, string> = {
  bing: 'B',
  duckduckgo: 'D',
  tavily: 'T',
  brave: 'b',
  firecrawl: 'F',
  grok: 'G',
};

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
  const [model, setModel] = useState('grok-4-1-fast-reasoning');
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [actionService, setActionService] = useState<ExternalSearchService | null>(null);
  const [testingServiceId, setTestingServiceId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    Record<string, 'ok' | 'fail' | undefined>
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
    setModel('grok-4-1-fast-reasoning');
  };

  const openAddForm = (kind: ExternalSearchProviderKind) => {
    setAddPickerOpen(false);
    setFormKind(kind);
    setEditingServiceId(null);
    setApiKey('');
    setEndpoint('');
    setModel(kind === 'grok' ? 'grok-4-1-fast-reasoning' : '');
  };

  const openEditForm = (service: ExternalSearchService) => {
    setActionService(null);
    setAddPickerOpen(false);
    setFormKind(service.kind);
    setEditingServiceId(service.id);
    setApiKey(service.apiKey ?? '');
    setEndpoint(service.endpoint ?? '');
    setModel(service.model ?? (service.kind === 'grok' ? 'grok-4-1-fast-reasoning' : ''));
  };

  const formRequiresKey = formKind ? externalSearchProviderRequiresApiKey(formKind) : true;
  const formAllowsAnonymous = formKind
    ? externalSearchProviderAllowsAnonymous(formKind)
    : false;
  const canSubmitForm = Boolean(formKind) && (formRequiresKey ? Boolean(apiKey.trim()) : true);

  const handleSubmit = () => {
    if (!formKind || !canSubmitForm) return;
    onAddExternalService({
      kind: formKind,
      apiKey: apiKey.trim() || undefined,
      ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
      ...(formKind === 'grok' && model.trim() ? { model: model.trim() } : {}),
      ...(editingServiceId ? { serviceId: editingServiceId } : {}),
    });
    closeForms();
  };

  const addProviderKind = (kind: ExternalSearchProviderKind) => {
    // Pure free local engines: one-tap. Firecrawl / key services open config sheet
    // so the user can optionally fill API Key (or leave blank for free tier).
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
    try {
      await runExternalSearch({
        query: 'connectivity test',
        service,
        maxResults: 1,
        timeoutMs: 15_000,
        fetchImpl: guardedApiFetch,
      });
      setConnectionStatus((current) => ({ ...current, [service.id]: 'ok' }));
    } catch {
      setConnectionStatus((current) => ({ ...current, [service.id]: 'fail' }));
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
                ? 'OpenAI / 方舟 / 百炼官方搜索'
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
            </View>
          );
        })}
      </SectionCard>

      {/* Long-press actions — kelivo style: 测试连接 / 删除 */}
      <Modal
        visible={actionService != null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setActionService(null)}
      >
        <View style={styles.sheetScrim}>
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
      </Modal>

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
      <Modal
        visible={addPickerOpen}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closeForms}
      >
        <View style={styles.sheetScrim}>
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
              {externalSearchProviderKinds.map((kind) => (
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
                    <Text style={styles.pickTitle}>{externalSearchProviderLabels[kind]}</Text>
                    <Text style={styles.settingsHint} numberOfLines={2}>
                      {externalSearchProviderHints[kind]}
                    </Text>
                  </View>
                  <ChevronRight size={16} color={colors.textTertiary} strokeWidth={2} />
                </AnimatedPressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Provider config form */}
      <Modal
        visible={formKind != null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closeForms}
      >
        <View style={styles.sheetScrim}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeForms} />
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
                  {formKind ? externalSearchProviderLabels[formKind] : ''}
                </Text>
              </View>
              {formKind ? (
                <Text style={styles.formHint}>{externalSearchProviderHints[formKind]}</Text>
              ) : null}
              <View style={styles.formField}>
                <Text style={styles.formLabel}>
                  API Key{formRequiresKey ? '' : formAllowsAnonymous ? '（可选）' : ''}
                </Text>
                <TextInput
                  value={apiKey}
                  onChangeText={setApiKey}
                  placeholder={
                    formRequiresKey
                      ? '粘贴你的 API Key'
                      : formKind === 'firecrawl'
                        ? '可留空使用免费额度；填写可提升配额'
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
                    value={model}
                    onChangeText={setModel}
                    placeholder="grok-4-1-fast-reasoning"
                    placeholderTextColor={colors.placeholder}
                    autoCapitalize="none"
                    style={styles.formInput}
                  />
                </View>
              ) : null}
              {formKind === 'tavily' ||
              formKind === 'grok' ||
              formKind === 'firecrawl' ||
              formKind === 'bing' ||
              formKind === 'duckduckgo' ||
              formKind === 'brave' ? (
                <View style={styles.formField}>
                  <Text style={styles.formLabel}>自定义 URL（可选）</Text>
                  <TextInput
                    value={endpoint}
                    onChangeText={setEndpoint}
                    placeholder={
                      formKind === 'grok'
                        ? 'https://api.x.ai/v1/responses'
                        : formKind === 'firecrawl'
                          ? 'https://api.firecrawl.dev/v2/search'
                          : formKind === 'bing'
                            ? 'https://www.bing.com/search'
                            : formKind === 'duckduckgo'
                              ? 'https://html.duckduckgo.com/html/'
                              : formKind === 'brave'
                                ? 'https://api.search.brave.com/res/v1/web/search'
                                : 'https://api.tavily.com/search'
                    }
                    placeholderTextColor={colors.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.formInput}
                  />
                </View>
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
        </View>
      </Modal>
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
  onClose,
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
  onClose: () => void;
  onSelectOff: () => void;
  onSelectProvider: () => void;
  onSelectExternal: (serviceId: string) => void;
  onManage: () => void;
}) {
  const theme = useKelivoTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const windowH = Dimensions.get('window').height;
  const sheetMaxH = Math.round(windowH * 0.72);
  const sheetBottomPad = Math.max(insets.bottom, 16) + 8;
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

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.sheetScrim} testID="composer-search-menu">
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="关闭搜索设置"
          onPress={onClose}
        />
        <View
          style={[
            styles.composerSheet,
            { maxHeight: sheetMaxH, paddingBottom: sheetBottomPad },
          ]}
          testID="composer-search-tags"
        >
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>搜索设置</Text>

            {/* Master: 网络搜索 + gear + switch — kelivo IosCardPress row */}
            <View style={styles.masterCard}>
              <View style={styles.masterLeft}>
                <Globe2 size={20} color={colors.primary} strokeWidth={2.1} />
                <Text style={styles.masterTitle}>网络搜索</Text>
              </View>
              <View style={styles.masterRight}>
                <AnimatedPressable
                  accessibilityRole="button"
                  accessibilityLabel="管理搜索服务"
                  testID="composer-search-manage"
                  onPress={onManage}
                  style={styles.masterGear}
                  hitSlop={10}
                  haptic="light"
                >
                  <Settings size={20} color={colors.textSecondary} strokeWidth={2} />
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
                style={styles.serviceListScroll}
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
                      style={[styles.serviceCard, (!available && !selected) && styles.disabled]}
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
    </Modal>
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

    /* Composer sheet — kelivo search_settings_sheet */
    composerSheet: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 16,
      paddingTop: 10,
      width: '100%',
      overflow: 'visible',
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
    serviceListScroll: {
      flexGrow: 0,
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
