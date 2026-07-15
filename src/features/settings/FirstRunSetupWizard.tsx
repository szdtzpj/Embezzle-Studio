import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  ArrowRight,
  Check,
  KeyRound,
  Network,
  Server,
  Sparkles,
  X,
} from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useWorkspaceSelector, useWorkspaceStatus } from '../../app/workspace/WorkspaceSessionProvider';
import { useWorkspaceSession } from '../../app/workspace/internal/WorkspaceSessionContext';
import { useChatConfigurationActions } from '../chat';
import type { ModelInfo, OnboardingStep, ProviderProfile } from '../../domain/types';
import { refreshProviderModels } from '../../services/modelDiscovery';
import { inferModelTask } from '../../services/modelCapabilities';
import { isAbortError } from '../../services/openAiCompatible';
import {
  compareProviderEndpointBinding,
  inspectProviderEndpoint,
} from '../../services/providerSetup';
import { classifyProviderConnectionError } from '../../services/providerDiagnostics';
import { AnimatedPressable } from '../../ui/components/AnimatedPressable';
import { useKelivoTheme, type KelivoTheme } from '../../ui/theme';
import { SettingsWorkspaceRuntime } from './internal/SettingsWorkspaceRuntime';

type WizardStage = OnboardingStep;

const stageOrder: WizardStage[] = [
  'provider',
  'credentials',
  'connection',
  'models',
  'sample',
];

const stageLabels: Record<WizardStage, string> = {
  provider: '服务商',
  credentials: 'API Key',
  connection: '检查连接',
  models: '推荐模型',
  sample: '开始对话',
};

const samplePrompt = '请用三句话介绍你最擅长帮助我完成哪些工作，并给出一个可以立刻开始的例子。';

function providerDescription(provider: ProviderProfile): string {
  if (provider.kind === 'volcengine-ark') return '火山方舟 · 视频与多模态';
  if (provider.kind === 'bailian-compatible') return '阿里百炼 · Qwen 与兼容模型';
  if (provider.kind === 'openai-compatible') return 'OpenAI 官方兼容接口';
  if (provider.kind === 'new-api-relay') return 'New API / One API 中转';
  return '自定义 OpenAI 兼容接口';
}

function scoreRecommendedModel(model: ModelInfo): number {
  if (inferModelTask(model) !== 'chat') return -1;
  let score = 10;
  if (model.capabilities.includes('reasoning')) score += 4;
  if (model.capabilities.includes('image-input')) score += 3;
  if (model.capabilities.includes('streaming')) score += 2;
  if (model.contextWindow) score += Math.min(4, Math.log2(model.contextWindow / 16_000 + 1));
  if (/mini|lite|turbo|flash/i.test(model.id)) score += 1;
  return score;
}

function recommendedModels(models: readonly ModelInfo[]): ModelInfo[] {
  return [...models]
    .filter((model) => inferModelTask(model) === 'chat')
    .sort((left, right) => scoreRecommendedModel(right) - scoreRecommendedModel(left))
    .slice(0, 8);
}

export interface FirstRunSetupWizardProps {
  visible: boolean;
  onUseSample: (prompt: string) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

export function FirstRunSetupWizard({
  visible,
  onUseSample,
  onOpenSettings,
  onClose,
}: FirstRunSetupWizardProps): React.ReactElement | null {
  const theme = useKelivoTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const session = useWorkspaceSession();
  const workspace = useWorkspaceSelector((snapshot) => snapshot);
  const status = useWorkspaceStatus();
  const runtime = useMemo(() => new SettingsWorkspaceRuntime(session), [session]);
  const configuration = useChatConfigurationActions();
  const enabledProviders = workspace.providers.filter((provider) => provider.enabled !== false);
  const initialProvider = enabledProviders.find((provider) => provider.id === workspace.activeProviderId)
    ?? enabledProviders[0]
    ?? workspace.providers[0];
  const [stage, setStage] = useState<WizardStage>('provider');
  const [providerId, setProviderId] = useState(initialProvider?.id ?? '');
  const selectedProvider = workspace.providers.find((provider) => provider.id === providerId)
    ?? initialProvider;
  const [baseUrl, setBaseUrl] = useState(selectedProvider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(selectedProvider?.apiKey ?? '');
  const [candidates, setCandidates] = useState<ModelInfo[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [manualModelId, setManualModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [connectionProven, setConnectionProven] = useState(false);

  useEffect(() => {
    if (!visible || !selectedProvider) return;
    setBaseUrl(selectedProvider.baseUrl);
    setApiKey(selectedProvider.apiKey ?? '');
    const currentStep = workspace.onboarding.status === 'pending'
      ? workspace.onboarding.lastStep
      : 'provider';
    setStage(currentStep);
  }, [selectedProvider?.id, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const models = recommendedModels(candidates);
    if (!models.some((model) => model.id === selectedModelId)) {
      setSelectedModelId(models[0]?.id ?? '');
    }
  }, [candidates, selectedModelId]);

  if (!visible || !selectedProvider) return null;

  const writable = status.phase === 'ready';
  const showEndpoint = workspace.experienceMode === 'advanced' || selectedProvider.kind === 'custom' || selectedProvider.kind === 'new-api-relay';
  const models = recommendedModels(candidates);
  const stageIndex = stageOrder.indexOf(stage);

  async function updateOnboarding(lastStep: WizardStage) {
    await runtime.execute({ type: 'onboarding.update', patch: { status: 'pending', lastStep } });
  }

  async function chooseProvider(next: ProviderProfile) {
    setProviderId(next.id);
    setBaseUrl(next.baseUrl);
    setApiKey(next.apiKey ?? '');
    setCandidates([]);
    setSelectedModelId('');
    setConnectionProven(false);
    setNotice('');
    await runtime.execute({ type: 'provider.select', providerId: next.id });
  }

  async function goTo(next: WizardStage) {
    setStage(next);
    await updateOnboarding(next);
  }

  async function checkConnectionAndLoadModels() {
    if (!writable || busy) return;
    const key = apiKey.trim();
    if (!key) {
      setNotice('请填写该服务商自己的 API Key。Key 只保存在本机安全存储，不会进入备份。');
      setStage('credentials');
      return;
    }
    const inspection = inspectProviderEndpoint(baseUrl, {
      kind: selectedProvider.kind,
      apiKey: key,
    });
    if (!inspection.valid || inspection.policy === 'blocked' || !inspection.normalizedBaseUrl) {
      setNotice(inspection.errors[0] ?? 'Endpoint 未通过本地安全检查。');
      return;
    }
    const nextProvider: ProviderProfile = {
      ...selectedProvider,
      baseUrl: inspection.normalizedBaseUrl,
      apiKey: key,
    };
    const binding = compareProviderEndpointBinding(selectedProvider, nextProvider);
    const saved = await runtime.execute({
      type: 'provider.save',
      providerId: selectedProvider.id,
      provider: {
        ...nextProvider,
        models: binding.mustClearModels ? [] : selectedProvider.models,
        capabilities: binding.mustClearModels ? ['text', 'streaming'] : selectedProvider.capabilities,
      },
      binding,
      apiKeyChanged: (selectedProvider.apiKey ?? '') !== key,
      now: Date.now(),
    });
    if (!saved) {
      setNotice('工作区当前不可写，配置没有保存。');
      return;
    }
    setStage('connection');
    await updateOnboarding('connection');
    setBusy(true);
    setNotice('正在请求服务商模型目录。这不是生成请求，也不能证明所有模型都有调用权限。');
    try {
      await runtime.flush({ propagateFailure: true });
      const result = await configuration.run('首次连接检查', (signal) =>
        refreshProviderModels(nextProvider, signal)
      );
      if (!result.ok) {
        if (result.reason === 'busy') throw new Error(result.notice);
        throw result.error;
      }
      setCandidates(result.value.models);
      await runtime.execute({
        type: 'model.set-candidates',
        providerId: nextProvider.id,
        models: result.value.models,
      });
      const proven = result.value.source === 'remote';
      setConnectionProven(proven);
      setNotice(
        proven
          ? `${result.value.notice} 目录请求已成功，但账号是否能真实推理仍要以第一条消息为准。`
          : `${result.value.notice} 当前只拿到了本地目录，尚未证明账号连接成功；可填写控制台 Endpoint ID 后继续测试。`
      );
      await goTo('models');
    } catch (error) {
      if (isAbortError(error)) return;
      const issue = classifyProviderConnectionError(error);
      setConnectionProven(false);
      setNotice(`${issue.title}：${issue.guidance}\n${issue.detail}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveRecommendedModel() {
    if (!writable || busy) return;
    const manualId = manualModelId.trim();
    const selected = candidates.find((model) => model.id === selectedModelId);
    const model: ModelInfo | undefined = selected
      ? { ...selected, task: inferModelTask(selected), source: 'manual' }
      : manualId
        ? {
            id: manualId,
            name: manualId,
            capabilities: ['text', 'streaming'],
            task: 'chat',
            source: 'manual',
          }
        : undefined;
    if (!model) {
      setNotice('请选择一个推荐模型，或填写服务商控制台中的模型 / Endpoint ID。');
      return;
    }
    setBusy(true);
    try {
      await runtime.execute({ type: 'model.add', providerId: selectedProvider.id, model });
      await runtime.execute({
        type: 'model.select',
        providerId: selectedProvider.id,
        modelId: model.id,
        activateProvider: true,
      });
      await runtime.flush({ propagateFailure: true });
      setNotice(
        `${model.name ?? model.id} 已保存。${connectionProven ? '' : ' 连接仍需用第一条真实消息确认。'}`
      );
      await goTo('sample');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '模型保存失败。');
    } finally {
      setBusy(false);
    }
  }

  async function finishWithSample(prompt: string) {
    await runtime.execute({
      type: 'onboarding.update',
      patch: { status: 'completed', lastStep: 'sample', completedAt: Date.now() },
    });
    onUseSample(prompt);
    onClose();
  }

  async function dismiss() {
    await runtime.execute({
      type: 'onboarding.update',
      patch: { status: 'dismissed', lastStep: stage, dismissedAt: Date.now() },
    });
    onClose();
  }

  return (
    <Modal visible animationType="fade" onRequestClose={() => void dismiss()}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <Image source={require('../../../assets/splash-icon.png')} style={styles.logo} />
            <View style={styles.headerCopy}>
              <Text style={styles.title}>三分钟完成首次回答</Text>
              <Text style={styles.subtitle}>所有调用都使用你的服务商账号与额度</Text>
            </View>
          </View>
          <AnimatedPressable
            accessibilityRole="button"
            accessibilityLabel="暂时关闭配置向导"
            onPress={() => void dismiss()}
            style={styles.closeButton}
          >
            <X size={20} color={theme.colors.textSecondary} strokeWidth={2.2} />
          </AnimatedPressable>
        </View>

        <View style={styles.progressRow} accessibilityRole="progressbar" accessibilityValue={{ min: 1, max: stageOrder.length, now: stageIndex + 1 }}>
          {stageOrder.map((item, index) => (
            <View key={item} style={styles.progressItem}>
              <View style={[styles.progressDot, index <= stageIndex && styles.progressDotActive]}>
                {index < stageIndex ? <Check size={11} color={theme.colors.textOnAccent} strokeWidth={3} /> : null}
              </View>
              <Text style={[styles.progressLabel, index === stageIndex && styles.progressLabelActive]}>
                {stageLabels[item]}
              </Text>
            </View>
          ))}
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {stage === 'provider' ? (
            <View style={styles.stageBlock}>
              <Server size={28} color={theme.colors.accent} strokeWidth={2} />
              <Text style={styles.stageTitle}>选择你已经开通的服务商</Text>
              <Text style={styles.body}>Embezzle Studio 不销售 API，也不会替你充值。选择后仍可随时在设置中修改。</Text>
              <View style={styles.optionList}>
                {workspace.providers.map((provider) => {
                  const selected = provider.id === selectedProvider.id;
                  return (
                    <AnimatedPressable
                      key={provider.id}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      onPress={() => void chooseProvider(provider)}
                      style={[styles.optionCard, selected && styles.optionCardSelected]}
                    >
                      <View style={styles.optionText}>
                        <Text style={styles.optionTitle}>{provider.name}</Text>
                        <Text style={styles.optionDetail}>{providerDescription(provider)}</Text>
                      </View>
                      {selected ? <Check size={18} color={theme.colors.accent} strokeWidth={2.6} /> : null}
                    </AnimatedPressable>
                  );
                })}
              </View>
              <PrimaryButton label="下一步：填写 API Key" onPress={() => void goTo('credentials')} styles={styles} theme={theme} />
            </View>
          ) : null}

          {stage === 'credentials' ? (
            <View style={styles.stageBlock}>
              <KeyRound size={28} color={theme.colors.accent} strokeWidth={2} />
              <Text style={styles.stageTitle}>填写 {selectedProvider.name} 的 Key</Text>
              <Text style={styles.body}>Android 写入系统 SecureStore；Web 只保留在当前标签页。Key 不进入工作区明文、备份或诊断包。</Text>
              {showEndpoint ? (
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>API Base URL</Text>
                  <TextInput
                    value={baseUrl}
                    onChangeText={setBaseUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType={Platform.OS === 'web' ? 'url' : 'default'}
                    style={styles.input}
                  />
                </View>
              ) : (
                <View style={styles.endpointSummary}>
                  <Text style={styles.fieldLabel}>官方 Endpoint</Text>
                  <Text selectable style={styles.endpointText}>{baseUrl}</Text>
                </View>
              )}
              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>API Key</Text>
                <TextInput
                  value={apiKey}
                  onChangeText={setApiKey}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="粘贴服务商控制台创建的 Key"
                  placeholderTextColor={theme.colors.placeholder}
                  style={styles.input}
                />
              </View>
              <PrimaryButton label="保存并检查连接" loading={busy} disabled={!apiKey.trim() || !writable} onPress={() => void checkConnectionAndLoadModels()} styles={styles} theme={theme} />
              <SecondaryButton label="返回选择服务商" onPress={() => void goTo('provider')} styles={styles} theme={theme} />
            </View>
          ) : null}

          {stage === 'connection' ? (
            <View style={styles.stageBlock}>
              <Network size={28} color={theme.colors.accent} strokeWidth={2} />
              <Text style={styles.stageTitle}>检查连接</Text>
              <Text style={styles.body}>只请求模型目录，不发送对话内容。目录成功也不等于模型权限、配额和计费已经验证。</Text>
              <PrimaryButton label="开始检查" loading={busy} onPress={() => void checkConnectionAndLoadModels()} styles={styles} theme={theme} />
            </View>
          ) : null}

          {stage === 'models' ? (
            <View style={styles.stageBlock}>
              <Sparkles size={28} color={theme.colors.accent} strokeWidth={2} />
              <Text style={styles.stageTitle}>选择第一个对话模型</Text>
              <Text style={styles.body}>推荐顺序综合了对话用途、推理、多模态和上下文信息；费用状态仍以你的服务商控制台为准。</Text>
              {models.length ? (
                <View style={styles.optionList}>
                  {models.map((model) => {
                    const selected = model.id === selectedModelId && !manualModelId.trim();
                    return (
                      <AnimatedPressable
                        key={model.id}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        onPress={() => { setSelectedModelId(model.id); setManualModelId(''); }}
                        style={[styles.optionCard, selected && styles.optionCardSelected]}
                      >
                        <View style={styles.optionText}>
                          <Text numberOfLines={1} style={styles.optionTitle}>{model.name ?? model.id}</Text>
                          <Text numberOfLines={2} style={styles.optionDetail}>
                            {model.capabilities.includes('reasoning') ? '推理 · ' : ''}
                            {model.capabilities.includes('image-input') ? '图片理解 · ' : ''}
                            {model.contextWindow ? `${model.contextWindow.toLocaleString()} 上下文 · ` : ''}
                            费用由服务商决定
                          </Text>
                        </View>
                        {selected ? <Check size={18} color={theme.colors.accent} strokeWidth={2.6} /> : null}
                      </AnimatedPressable>
                    );
                  })}
                </View>
              ) : null}
              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>或填写控制台模型 / Endpoint ID</Text>
                <TextInput
                  value={manualModelId}
                  onChangeText={setManualModelId}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="例如 qwen-plus 或 ep-xxxxxxxx"
                  placeholderTextColor={theme.colors.placeholder}
                  style={styles.input}
                />
              </View>
              <PrimaryButton label="使用这个模型" loading={busy} onPress={() => void saveRecommendedModel()} styles={styles} theme={theme} />
              <SecondaryButton label="重新检查连接" onPress={() => void checkConnectionAndLoadModels()} styles={styles} theme={theme} />
            </View>
          ) : null}

          {stage === 'sample' ? (
            <View style={styles.stageBlock}>
              <View style={styles.successIcon}><Check size={28} color={theme.colors.textOnAccent} strokeWidth={3} /></View>
              <Text style={styles.stageTitle}>配置完成，准备第一条消息</Text>
              <Text style={styles.body}>点击后只会把示例放进输入框，不会自动扣费；你确认内容并主动发送后，才会调用自己的服务商。</Text>
              <View style={styles.sampleCard}><Text style={styles.sampleText}>{samplePrompt}</Text></View>
              <PrimaryButton label="放入对话框" onPress={() => void finishWithSample(samplePrompt)} styles={styles} theme={theme} />
              <SecondaryButton label="直接进入空白对话" onPress={() => void finishWithSample('')} styles={styles} theme={theme} />
            </View>
          ) : null}

          {notice ? (
            <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.noticeCard}>
              <Text selectable style={styles.noticeText}>{notice}</Text>
            </View>
          ) : null}

          <AnimatedPressable
            accessibilityRole="button"
            onPress={() => { onClose(); onOpenSettings(); }}
            style={styles.advancedLink}
          >
            <Text style={styles.advancedLinkText}>需要代理、自定义 Endpoint 或更多控制？打开高级设置</Text>
            <ArrowRight size={15} color={theme.colors.accent} strokeWidth={2.2} />
          </AnimatedPressable>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function PrimaryButton(props: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  styles: ReturnType<typeof createStyles>;
  theme: KelivoTheme;
}) {
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled || props.loading }}
      disabled={props.disabled || props.loading}
      onPress={props.onPress}
      haptic="medium"
      style={[props.styles.primaryButton, (props.disabled || props.loading) && props.styles.disabled]}
    >
      {props.loading ? <ActivityIndicator color={props.theme.colors.textOnAccent} /> : null}
      <Text style={props.styles.primaryButtonText}>{props.label}</Text>
      {!props.loading ? <ArrowRight size={17} color={props.theme.colors.textOnAccent} strokeWidth={2.4} /> : null}
    </AnimatedPressable>
  );
}

function SecondaryButton(props: {
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  theme: KelivoTheme;
}) {
  return (
    <AnimatedPressable accessibilityRole="button" onPress={props.onPress} style={props.styles.secondaryButton}>
      <Text style={props.styles.secondaryButtonText}>{props.label}</Text>
    </AnimatedPressable>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: theme.colors.background },
    header: { minHeight: 68, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.outline },
    brandRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 11 },
    logo: { width: 42, height: 42, borderRadius: 12 },
    headerCopy: { flex: 1, minWidth: 0 },
    title: { color: theme.colors.text, fontSize: 17, lineHeight: 23, fontWeight: '800' },
    subtitle: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
    closeButton: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
    progressRow: { paddingHorizontal: 18, paddingVertical: 12, flexDirection: 'row', gap: 5, backgroundColor: theme.colors.surface },
    progressItem: { flex: 1, minWidth: 0, alignItems: 'center', gap: 4 },
    progressDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: theme.colors.outline, backgroundColor: theme.colors.card, alignItems: 'center', justifyContent: 'center' },
    progressDotActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
    progressLabel: { color: theme.colors.textSecondary, fontSize: 10, lineHeight: 14, fontWeight: '600' },
    progressLabelActive: { color: theme.colors.accentText, fontWeight: '800' },
    content: { padding: 20, paddingBottom: 40, gap: 16 },
    stageBlock: { gap: 14 },
    stageTitle: { color: theme.colors.text, fontSize: 24, lineHeight: 32, fontWeight: '800' },
    body: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 22 },
    optionList: { gap: 9 },
    optionCard: { minHeight: 66, paddingHorizontal: 14, paddingVertical: 11, borderRadius: 16, borderWidth: 1, borderColor: theme.colors.outline, backgroundColor: theme.colors.card, flexDirection: 'row', alignItems: 'center', gap: 12 },
    optionCardSelected: { borderColor: theme.colors.accentBorder, backgroundColor: theme.colors.accentSoft },
    optionText: { flex: 1, minWidth: 0, gap: 3 },
    optionTitle: { color: theme.colors.text, fontSize: 15, lineHeight: 21, fontWeight: '800' },
    optionDetail: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
    fieldGroup: { gap: 7 },
    fieldLabel: { color: theme.colors.text, fontSize: 13, lineHeight: 18, fontWeight: '700' },
    input: { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.outline, backgroundColor: theme.colors.card, color: theme.colors.text, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, outlineStyle: 'none' as never },
    endpointSummary: { gap: 5, borderRadius: 14, padding: 13, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.outline },
    endpointText: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
    primaryButton: { minHeight: 50, borderRadius: 15, backgroundColor: theme.colors.accent, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9, paddingHorizontal: 18 },
    primaryButtonText: { color: theme.colors.textOnAccent, fontSize: 15, fontWeight: '800' },
    secondaryButton: { minHeight: 46, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.outline, backgroundColor: theme.colors.card, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
    secondaryButtonText: { color: theme.colors.text, fontSize: 14, fontWeight: '700' },
    disabled: { opacity: 0.5 },
    noticeCard: { borderRadius: 14, padding: 13, backgroundColor: theme.colors.warningContainer, borderWidth: 1, borderColor: theme.colors.warningBorder },
    noticeText: { color: theme.colors.text, fontSize: 13, lineHeight: 20 },
    successIcon: { width: 58, height: 58, borderRadius: 29, backgroundColor: theme.colors.accent, alignItems: 'center', justifyContent: 'center' },
    sampleCard: { borderRadius: 16, padding: 16, backgroundColor: theme.colors.card, borderWidth: 1, borderColor: theme.colors.outline },
    sampleText: { color: theme.colors.text, fontSize: 15, lineHeight: 24 },
    advancedLink: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8 },
    advancedLinkText: { color: theme.colors.accentText, fontSize: 12, lineHeight: 18, fontWeight: '700', textAlign: 'center' },
  });
}
