import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { createDefaultWorkspace } from './src/data/providerCatalog';
import type { AppWorkspace, ChatMessage, MediaAttachment, ModelInfo, ProviderProfile } from './src/domain/types';
import { pickFiles, pickImages, pickVideos } from './src/services/mediaPicker';
import { fetchOpenAiCompatibleModels, sendOpenAiCompatibleChat } from './src/services/openAiCompatible';
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

export default function App() {
  const [workspace, setWorkspace] = useState<AppWorkspace>(() => createDefaultWorkspace());
  const [booting, setBooting] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [manualModelId, setManualModelId] = useState('');
  const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

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

  const activeModelId = activeProvider
    ? workspace.activeModelIdByProvider[activeProvider.id] || activeProvider.models[0]?.id || ''
    : '';

  const activeModel = activeProvider?.models.find((model) => model.id === activeModelId);

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

  function addCustomProvider() {
    const providerId = createId('provider');
    const modelId = 'model-id';
    const provider: ProviderProfile = {
      id: providerId,
      name: 'Custom Provider',
      kind: 'custom',
      baseUrl: 'https://your-provider.example.com/v1',
      capabilities: ['text', 'image-input', 'streaming'],
      models: [
        {
          id: modelId,
          name: modelId,
          capabilities: ['text', 'image-input', 'streaming'],
          source: 'manual',
        },
      ],
    };

    setWorkspace((current) => ({
      ...current,
      providers: [...current.providers, provider],
      activeProviderId: providerId,
      activeModelIdByProvider: {
        ...current.activeModelIdByProvider,
        [providerId]: modelId,
      },
    }));
    setManualModelId('');
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

  async function refreshModels() {
    if (!activeProvider) {
      return;
    }

    setBusy(true);
    setNotice('');

    try {
      const models = await fetchOpenAiCompatibleModels(activeProvider);
      setWorkspace((current) => ({
        ...current,
        providers: current.providers.map((provider) =>
          provider.id === activeProvider.id ? { ...provider, models } : provider
        ),
        activeModelIdByProvider: {
          ...current.activeModelIdByProvider,
          [activeProvider.id]: models[0]?.id ?? '',
        },
      }));
      setNotice(`已获取 ${models.length} 个模型。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '模型列表获取失败。');
    } finally {
      setBusy(false);
    }
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
            <View>
              <Text style={styles.appName}>Embezzle Studio</Text>
              <Text style={styles.activeLine}>
                {activeProvider.name} / {activeModelId || '未选择模型'}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => setSettingsOpen((current) => !current)}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>{settingsOpen ? '聊天' : '配置'}</Text>
            </Pressable>
          </View>

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

              <Text style={styles.sectionTitle}>模型</Text>
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
                {activeProvider.models.map((model) => (
                  <ModelButton
                    key={model.id}
                    model={model}
                    active={model.id === activeModelId}
                    onPress={() => selectModel(model.id)}
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

interface ModelButtonProps {
  model: ModelInfo;
  active: boolean;
  onPress: () => void;
}

function ModelButton({ model, active, onPress }: ModelButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.modelButton, active && styles.modelButtonActive]}
    >
      <Text style={[styles.modelName, active && styles.modelNameActive]}>{model.name ?? model.id}</Text>
      <Text style={styles.modelMeta}>{model.id}</Text>
    </Pressable>
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
    minHeight: 72,
    paddingHorizontal: 18,
    paddingVertical: 12,
    backgroundColor: '#ffffff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d9e1ec',
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
  activeLine: {
    marginTop: 4,
    color: '#596779',
    fontSize: 12,
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
  modelButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d4deeb',
    backgroundColor: '#ffffff',
    padding: 12,
  },
  modelButtonActive: {
    borderColor: '#1f5fbf',
    backgroundColor: '#edf5ff',
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
