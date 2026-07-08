import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { isArkStaticDoubaoModelId, isVolcengineArkProvider } from './src/data/arkModels';
import { createDefaultWorkspace } from './src/data/providerCatalog';
import type { AppWorkspace, Capability, ChatMessage, MediaAttachment, ModelInfo, ProviderProfile } from './src/domain/types';
import { pickFiles, pickImages, pickVideos } from './src/services/mediaPicker';
import { sendOpenAiCompatibleChat } from './src/services/openAiCompatible';
import { refreshProviderModels } from './src/services/modelDiscovery';
import { createId } from './src/services/id';
import { loadWorkspace, saveWorkspace } from './src/services/storage';

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

const modelFilterKeywords = {
  reasoning: ['reason', 'thinking', 'think', 'deepseek-r1', '-r1', 'r1-', 'qwq', 'qvq', 'o1', 'o3', 'o4', 'z1'],
  vision: ['vision', 'visual', 'vl', 'image', 'img', 'omni', '4v', 'multimodal', 'multi-modal', 'qwen-vl', 'glm-4v', 'gpt-4o'],
  web: ['web', 'search', 'browsing', 'browser', 'online', 'internet'],
  free: ['free', 'gratis', 'trial'],
  embedding: ['embedding', 'embeddings', 'embed', 'bge', 'm3e', 'jina-embeddings'],
  rerank: ['rerank', 'reranker', 're-rank', 'bge-reranker'],
  tool: ['functioncall', 'function-call', 'function', 'tool', 'tools', 'mcp'],
};

function getSelectableModels(provider: ProviderProfile) {
  return provider.models.filter(
    (model) =>
      !(isVolcengineArkProvider(provider) && model.source !== 'remote' && isArkStaticDoubaoModelId(model.id))
  );
}

function modelIndexText(model: ModelInfo) {
  return `${model.name ?? ''} ${model.id}`.toLowerCase();
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
  const [input, setInput] = useState('');
  const [manualModelId, setManualModelId] = useState('');
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [modelCapabilityFilter, setModelCapabilityFilter] = useState<CandidateModelFilter>('all');
  const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

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
  const modelCandidates = activeProvider
    ? (workspace.modelCandidatesByProvider[activeProvider.id] ?? []).filter(
        (model) =>
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
    setNotice('已清空会话。');
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
      content: '正在请求模型...',
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
      });

      updateAssistantMessage(assistantMessage.id, {
        content: result.content,
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
          <ActivityIndicator color="#2563eb" />
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
              <Text style={styles.appName}>Embezzle Studio</Text>
              <View style={styles.topActions}>
                <Pressable accessibilityRole="button" onPress={clearMessages} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonText}>清空</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setSettingsOpen((current) => !current)}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>{settingsOpen ? '聊天' : '配置'}</Text>
                </Pressable>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              testID="model-picker-trigger"
              onPress={() => setModelPickerOpen(true)}
              style={styles.modelPickerTrigger}
            >
              <View style={styles.modelPickerLabelBadge}>
                <Text style={styles.modelPickerLabelText}>模型</Text>
              </View>
              <View style={styles.modelPickerCurrent}>
                <Text numberOfLines={1} style={styles.modelPickerProviderText}>
                  {activeProvider.name}
                </Text>
                <Text numberOfLines={1} style={styles.modelPickerModelText}>
                  {(activeModel?.name ?? activeModelId) || '未选择模型'}
                </Text>
              </View>
              <Text style={styles.modelPickerChevron}>v</Text>
            </Pressable>
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
            <ScrollView style={styles.content} contentContainerStyle={styles.settingsContent}>
              <Text style={styles.sectionTitle}>服务商</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.providerRow}>
                {workspace.providers.map((provider) => (
                  <Pressable
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
                  </Pressable>
                ))}
                <Pressable
                  accessibilityRole="button"
                  onPress={addCustomProvider}
                  style={styles.providerChip}
                >
                  <Text style={styles.providerChipText}>新增</Text>
                </Pressable>
              </ScrollView>

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

              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={refreshModels}
                  style={[styles.primaryButton, busy && styles.buttonDisabled]}
                >
                  <Text style={styles.primaryButtonText}>{busy ? '请求中' : '获取模型'}</Text>
                </Pressable>
              </View>

              {notice ? <Text style={styles.settingsNotice}>{notice}</Text> : null}

              <Text style={styles.sectionTitle}>可添加模型</Text>
              {modelCandidates.length ? (
                <>
                  <View style={styles.modelSearchRow}>
                    <TextInput
                      testID="candidate-model-search"
                      autoCapitalize="none"
                      autoCorrect={false}
                      placeholder="搜索模型名称或 ID"
                      placeholderTextColor="#8a94a6"
                      value={modelSearchQuery}
                      onChangeText={setModelSearchQuery}
                      style={[styles.input, styles.modelSearchInput]}
                    />
                    {modelSearchQuery ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setModelSearchQuery('')}
                        style={styles.secondaryButton}
                      >
                        <Text style={styles.secondaryButtonText}>清除</Text>
                      </Pressable>
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

              <Text style={styles.sectionTitle}>已添加模型</Text>
              <View style={styles.inlineField}>
                <TextInput
                  autoCapitalize="none"
                  placeholder="手动模型 ID"
                  placeholderTextColor="#8a94a6"
                  value={manualModelId}
                  onChangeText={setManualModelId}
                  style={[styles.input, styles.inlineInput]}
                />
                <Pressable
                  accessibilityRole="button"
                  onPress={addManualModel}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>添加</Text>
                </Pressable>
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
            </ScrollView>
          ) : (
            <>
              <ScrollView style={styles.content} contentContainerStyle={styles.chatContent}>
                {workspace.messages.map((message) => (
                  <View
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
                      {message.role === 'user' ? '你' : '模型'}
                    </Text>
                    <Text
                      style={[
                        styles.messageText,
                        message.role === 'user' && styles.userMessageText,
                      ]}
                    >
                      {message.content}
                    </Text>
                    {message.attachments?.length ? (
                      <View style={styles.attachmentGrid}>
                        {message.attachments.map((attachment) => (
                          <AttachmentPreview key={attachment.id} attachment={attachment} />
                        ))}
                      </View>
                    ) : null}
                  </View>
                ))}
              </ScrollView>

              {notice ? <Text style={styles.notice}>{notice}</Text> : null}

              {attachments.length ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.pendingAttachments}
                >
                  {attachments.map((attachment) => (
                    <Pressable
                      key={attachment.id}
                      accessibilityRole="button"
                      onPress={() => removeAttachment(attachment.id)}
                      style={styles.pendingAttachment}
                    >
                      <Text style={styles.pendingAttachmentText}>{attachment.kind}</Text>
                      <Text numberOfLines={1} style={styles.pendingAttachmentName}>
                        {attachment.name}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : null}

              <View style={styles.composerTools}>
                <Pressable accessibilityRole="button" onPress={() => addAttachments('image')} style={styles.toolButton}>
                  <Text style={styles.toolButtonText}>图片</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => addAttachments('video')} style={styles.toolButton}>
                  <Text style={styles.toolButtonText}>视频</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => addAttachments('file')} style={styles.toolButton}>
                  <Text style={styles.toolButtonText}>文件</Text>
                </Pressable>
              </View>

              <View style={styles.composer}>
                <TextInput
                  multiline
                  placeholder="输入消息"
                  placeholderTextColor="#8a94a6"
                  value={input}
                  onChangeText={setInput}
                  style={styles.composerInput}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={sendMessage}
                  style={[styles.sendButton, busy && styles.buttonDisabled]}
                >
                  <Text style={styles.sendButtonText}>{busy ? '...' : '发送'}</Text>
                </Pressable>
              </View>
            </>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
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
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modelPickerModalRoot}>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.modelPickerBackdrop} />
        <View testID="model-picker-sheet" style={styles.modelPickerSheet}>
          <View style={styles.modelPickerSheetHeader}>
            <View style={styles.modelPickerTitleBlock}>
              <Text style={styles.modelPickerTitle}>选择模型</Text>
              <Text style={styles.modelPickerSubtitle}>已添加模型</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.modelPickerCloseButton}>
              <Text style={styles.modelPickerCloseText}>×</Text>
            </Pressable>
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
                      <Pressable
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
                        {selected ? <Text style={styles.modelPickerSelectedText}>当前</Text> : null}
                      </Pressable>
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
        </View>
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

function ModelButton({ model, active, onPress, onRemove }: ModelButtonProps) {
  return (
    <View style={[styles.modelButton, active && styles.modelButtonActive]}>
      <Pressable accessibilityRole="button" onPress={onPress} style={styles.modelSelectArea}>
        <Text numberOfLines={1} style={[styles.modelName, active && styles.modelNameActive]}>
          {model.name ?? model.id}
        </Text>
        <Text numberOfLines={1} style={styles.modelMeta}>
          {model.id}
        </Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onRemove} style={styles.compactButton}>
        <Text style={styles.compactButtonText}>删除</Text>
      </Pressable>
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
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={added}
        onPress={onAdd}
        style={[styles.addModelButton, added && styles.buttonDisabled]}
      >
        <Text style={styles.addModelButtonText}>{added ? '已添加' : '+'}</Text>
      </Pressable>
    </View>
  );
}

function AttachmentPreview({ attachment }: { attachment: MediaAttachment }) {
  if (attachment.kind === 'image') {
    return <Image source={{ uri: attachment.uri }} style={styles.attachmentImage} />;
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
    backgroundColor: '#f4f7fb',
  },
  keyboard: {
    flex: 1,
  },
  loadingShell: {
    flex: 1,
    backgroundColor: '#f4f7fb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 12,
    color: '#526070',
    fontSize: 14,
  },
  topBar: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    backgroundColor: '#ffffff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d9e1ec',
    gap: 10,
  },
  topHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  appName: {
    color: '#142033',
    fontSize: 20,
    fontWeight: '700',
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modelPickerTrigger: {
    minHeight: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd8ea',
    backgroundColor: '#f7faff',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
  },
  modelPickerLabelBadge: {
    height: 26,
    borderRadius: 7,
    backgroundColor: '#e8f1ff',
    borderWidth: 1,
    borderColor: '#c7dcfb',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 9,
  },
  modelPickerLabelText: {
    color: '#174ea6',
    fontSize: 12,
    fontWeight: '900',
  },
  modelPickerCurrent: {
    flex: 1,
    minWidth: 0,
  },
  modelPickerProviderText: {
    color: '#5c6a7d',
    fontSize: 11,
    fontWeight: '700',
  },
  modelPickerModelText: {
    marginTop: 2,
    color: '#142033',
    fontSize: 14,
    fontWeight: '800',
  },
  modelPickerChevron: {
    color: '#526070',
    fontSize: 13,
    fontWeight: '900',
  },
  secondaryButton: {
    height: 40,
    minWidth: 64,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c8d4e3',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  secondaryButtonText: {
    color: '#1f3b64',
    fontWeight: '700',
  },
  content: {
    flex: 1,
  },
  settingsContent: {
    padding: 18,
    gap: 16,
  },
  chatContent: {
    padding: 14,
    gap: 12,
  },
  sectionTitle: {
    color: '#142033',
    fontSize: 15,
    fontWeight: '700',
  },
  providerRow: {
    gap: 10,
    paddingRight: 18,
  },
  providerChip: {
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd6e5',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  providerChipActive: {
    backgroundColor: '#1f5fbf',
    borderColor: '#1f5fbf',
  },
  providerChipText: {
    color: '#35465f',
    fontWeight: '700',
  },
  providerChipTextActive: {
    color: '#ffffff',
  },
  fieldGroup: {
    gap: 8,
  },
  fieldLabel: {
    color: '#425166',
    fontSize: 13,
    fontWeight: '700',
  },
  input: {
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd6e5',
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    color: '#142033',
    fontSize: 15,
  },
  capabilityRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  capabilityChip: {
    borderRadius: 7,
    backgroundColor: '#e9f1fb',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  capabilityText: {
    color: '#27496d',
    fontSize: 12,
    fontWeight: '700',
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
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 8,
    backgroundColor: '#1f5fbf',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '800',
  },
  buttonDisabled: {
    opacity: 0.55,
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
    gap: 24,
  },
  modelFilterTab: {
    height: 34,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modelFilterTabText: {
    color: '#26384d',
    fontSize: 14,
    fontWeight: '700',
  },
  modelFilterTabTextActive: {
    color: '#00a76f',
    fontWeight: '900',
  },
  modelFilterTabLine: {
    width: '100%',
    height: 2,
    borderRadius: 2,
    backgroundColor: 'transparent',
  },
  modelFilterTabLineActive: {
    backgroundColor: '#00a76f',
  },
  modelSearchMeta: {
    marginTop: -8,
    color: '#66758a',
    fontSize: 12,
    fontWeight: '700',
  },
  modelSearchEmpty: {
    minHeight: 70,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d8e2ef',
    backgroundColor: '#f8fbff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelSearchEmptyText: {
    color: '#607086',
    fontSize: 13,
    fontWeight: '800',
  },
  modelButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d4deeb',
    backgroundColor: '#ffffff',
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  modelButtonActive: {
    borderColor: '#1f5fbf',
    backgroundColor: '#edf5ff',
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
    color: '#142033',
    fontSize: 14,
    fontWeight: '700',
  },
  modelNameActive: {
    color: '#174ea6',
  },
  modelMeta: {
    marginTop: 4,
    color: '#6a778a',
    fontSize: 12,
  },
  candidateRow: {
    minHeight: 58,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d4deeb',
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  addModelButton: {
    minWidth: 48,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#1f5fbf',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  addModelButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '900',
  },
  compactButton: {
    height: 34,
    minWidth: 52,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c8d4e3',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  compactButtonText: {
    color: '#39516d',
    fontSize: 12,
    fontWeight: '800',
  },
  modelPickerModalRoot: {
    flex: 1,
    justifyContent: 'flex-start',
    paddingHorizontal: 14,
    paddingTop: 104,
    backgroundColor: 'rgba(20, 32, 51, 0.24)',
  },
  modelPickerBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  modelPickerSheet: {
    maxHeight: '72%',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d8e2ef',
    backgroundColor: '#ffffff',
    shadowColor: '#142033',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 8,
    overflow: 'hidden',
  },
  modelPickerSheetHeader: {
    minHeight: 58,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#dbe4f0',
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
    color: '#142033',
    fontSize: 16,
    fontWeight: '800',
  },
  modelPickerSubtitle: {
    marginTop: 3,
    color: '#64748b',
    fontSize: 12,
    fontWeight: '700',
  },
  modelPickerCloseButton: {
    width: 34,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d5dfec',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  modelPickerCloseText: {
    color: '#425166',
    fontSize: 20,
    lineHeight: 22,
    fontWeight: '700',
  },
  modelPickerList: {
    padding: 12,
    gap: 12,
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
    color: '#40516a',
    fontSize: 13,
    fontWeight: '900',
  },
  modelPickerGroupCount: {
    minWidth: 24,
    height: 22,
    borderRadius: 7,
    backgroundColor: '#edf3fb',
    color: '#50627b',
    overflow: 'hidden',
    textAlign: 'center',
    textAlignVertical: 'center',
    fontSize: 11,
    fontWeight: '800',
  },
  modelPickerRow: {
    minHeight: 54,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d6e0ed',
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  modelPickerRowActive: {
    borderColor: '#1f5fbf',
    backgroundColor: '#edf5ff',
  },
  modelPickerRowTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  modelPickerRowName: {
    color: '#142033',
    fontSize: 14,
    fontWeight: '800',
  },
  modelPickerRowNameActive: {
    color: '#174ea6',
  },
  modelPickerRowMeta: {
    marginTop: 4,
    color: '#6a778a',
    fontSize: 12,
  },
  modelPickerSelectedText: {
    borderRadius: 7,
    backgroundColor: '#1f5fbf',
    color: '#ffffff',
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 5,
    fontSize: 12,
    fontWeight: '800',
  },
  modelPickerEmpty: {
    minHeight: 84,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d8e2ef',
    backgroundColor: '#f8fbff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelPickerEmptyText: {
    color: '#607086',
    fontSize: 13,
    fontWeight: '800',
  },
  messageBubble: {
    maxWidth: '92%',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#1f5fbf',
    borderColor: '#1f5fbf',
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#ffffff',
    borderColor: '#d9e1ec',
  },
  errorBubble: {
    borderColor: '#f0a3a3',
    backgroundColor: '#fff6f6',
  },
  messageRole: {
    marginBottom: 6,
    fontSize: 11,
    fontWeight: '800',
  },
  userRole: {
    color: '#dceaff',
  },
  assistantRole: {
    color: '#617086',
  },
  messageText: {
    color: '#142033',
    fontSize: 15,
    lineHeight: 21,
  },
  userMessageText: {
    color: '#ffffff',
  },
  attachmentGrid: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  attachmentImage: {
    width: 92,
    height: 92,
    borderRadius: 8,
    backgroundColor: '#dbe5f2',
  },
  attachmentFile: {
    width: 118,
    minHeight: 72,
    borderRadius: 8,
    backgroundColor: '#e8eef7',
    padding: 10,
    justifyContent: 'space-between',
  },
  attachmentKind: {
    color: '#36567f',
    fontSize: 11,
    fontWeight: '800',
  },
  attachmentFileName: {
    color: '#142033',
    fontSize: 12,
  },
  notice: {
    marginHorizontal: 14,
    marginBottom: 8,
    color: '#9a4d12',
    fontSize: 12,
  },
  settingsNotice: {
    color: '#9a4d12',
    fontSize: 12,
    lineHeight: 18,
  },
  pendingAttachments: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 8,
  },
  pendingAttachment: {
    width: 132,
    minHeight: 52,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d4deeb',
    padding: 8,
  },
  pendingAttachmentText: {
    color: '#1f5fbf',
    fontSize: 11,
    fontWeight: '800',
  },
  pendingAttachmentName: {
    marginTop: 4,
    color: '#425166',
    fontSize: 12,
  },
  composerTools: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  toolButton: {
    minWidth: 60,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#e7edf6',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  toolButtonText: {
    color: '#2b496f',
    fontWeight: '800',
    fontSize: 12,
  },
  composer: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 14,
    backgroundColor: '#ffffff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#d9e1ec',
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  composerInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 8,
    backgroundColor: '#f2f5f9',
    borderWidth: 1,
    borderColor: '#d5deea',
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#142033',
    fontSize: 15,
  },
  sendButton: {
    width: 64,
    height: 44,
    borderRadius: 8,
    backgroundColor: '#1f5fbf',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonText: {
    color: '#ffffff',
    fontWeight: '800',
  },
});
