import { useMemo, useState } from 'react';
import { ArrowLeft, Check, Lock, Pencil, Plus, Search, Trash2, X } from 'lucide-react-native';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { ModelAvatar } from '../../components/ModelAvatar';
import { MotionItem, MotionSwap } from '../../components/Motion';
import { useKelivoTheme, type KelivoTheme } from '../../theme';
import { isUserCreatedProvider } from '../../../data/providerCatalog';
import type { ProviderProfile } from '../../../domain/types';

export interface ProviderListScreenProps {
  readOnly: boolean;
  providers: ProviderProfile[];
  activeProviderId: string;
  onBack: () => void;
  onSelectProvider: (providerId: string) => void;
  onToggleEnabled: (providerId: string) => void;
  onDeleteProvider: (providerId: string) => void;
  onAddProvider: () => void;
}

export function ProviderListScreen({
  readOnly,
  providers,
  activeProviderId,
  onBack,
  onSelectProvider,
  onToggleEnabled,
  onDeleteProvider,
  onAddProvider,
}: ProviderListScreenProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const hasUserCreatedProviders = providers.some(isUserCreatedProvider);

  const filtered = useMemo(() => {
    if (!normalizedQuery) return providers;
    return providers.filter((p) =>
      p.name.toLowerCase().includes(normalizedQuery),
    );
  }, [providers, normalizedQuery]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeading}>
          <AnimatedPressable
            accessibilityRole="button"
            accessibilityLabel="返回"
            onPress={onBack}
            style={styles.headerButton}
          >
            <ArrowLeft size={22} color={theme.colors.text} strokeWidth={2.2} />
          </AnimatedPressable>
        </View>
        <Text style={styles.headerTitle}>供应商</Text>
        <View style={styles.headerActions}>
          <AnimatedPressable
            accessibilityRole="button"
            accessibilityLabel={editing ? '完成编辑' : '编辑供应商'}
            accessibilityState={{ disabled: readOnly || (!editing && !hasUserCreatedProviders), selected: editing }}
            disabled={readOnly || (!editing && !hasUserCreatedProviders)}
            onPress={() => setEditing((value) => !value)}
            haptic="selection"
            style={[styles.headerButton, editing && styles.headerButtonActive]}
          >
            <MotionSwap
              motionKey={editing ? 'done' : 'edit'}
              style={styles.headerIconSwap}
            >
              {editing ? (
                <Check size={20} color={theme.colors.primary} strokeWidth={2.3} />
              ) : (
                <Pencil size={19} color={theme.colors.textSecondary} strokeWidth={2.1} />
              )}
            </MotionSwap>
          </AnimatedPressable>
          <AnimatedPressable
            accessibilityRole="button"
            accessibilityLabel="添加供应商"
            accessibilityState={{ disabled: readOnly }}
            disabled={readOnly}
            onPress={() => {
              setEditing(false);
              onAddProvider();
            }}
            style={styles.headerButton}
          >
            <Plus size={22} color={theme.colors.text} strokeWidth={2.2} />
          </AnimatedPressable>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchField}>
          <Search size={16} color={theme.colors.placeholder} strokeWidth={2} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索供应商或分组"
            placeholderTextColor={theme.colors.placeholder}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <MotionSwap
            motionKey={query.length > 0 ? 'clear' : 'empty'}
            style={styles.clearButton}
          >
            {query.length > 0 ? (
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityLabel="清除搜索"
                onPress={() => setQuery('')}
                style={styles.clearButtonInner}
              >
                <X size={14} color={theme.colors.placeholder} strokeWidth={2} />
              </AnimatedPressable>
            ) : (
              <View style={styles.clearButtonInner} />
            )}
          </MotionSwap>
        </View>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={filtered.length > 8}
      >
        <View style={styles.card}>
          {filtered.map((provider, index) => {
            const enabled = provider.enabled ?? true;
            const isLast = index === filtered.length - 1;
            const canDelete = isUserCreatedProvider(provider);
            const navigationDisabled = readOnly && provider.id !== activeProviderId;
            const providerIdentity = (
              <View style={styles.rowMainInner}>
                <View style={styles.avatarSlot}>
                  <ModelAvatar
                    modelId={undefined}
                    providerName={provider.name}
                    size={18}
                    containerSize={26}
                  />
                </View>
                <Text style={styles.providerName} numberOfLines={1}>
                  {provider.name}
                </Text>
              </View>
            );

            return (
              <MotionItem
                key={provider.id}
                index={index}
                delay={45}
                distance={8}
                style={[styles.row, !isLast && styles.rowBorder]}
              >
                {editing ? (
                  <View style={styles.rowMain}>{providerIdentity}</View>
                ) : (
                  <AnimatedPressable
                    accessibilityRole="button"
                    accessibilityLabel={`打开 ${provider.name}`}
                    accessibilityState={{ disabled: navigationDisabled }}
                    disabled={navigationDisabled}
                    onPress={() => onSelectProvider(provider.id)}
                    haptic="light"
                    style={styles.rowMain}
                  >
                    {providerIdentity}
                  </AnimatedPressable>
                )}

                <MotionSwap
                  motionKey={editing ? 'editing' : `status-${enabled ? 'on' : 'off'}`}
                  style={styles.trailingSlot}
                  contentStyle={editing ? styles.editTrailing : styles.normalTrailing}
                >
                  {editing ? (
                    canDelete ? (
                      <AnimatedPressable
                        accessibilityRole="button"
                        accessibilityLabel={`删除 ${provider.name}`}
                        accessibilityState={{ disabled: readOnly }}
                        disabled={readOnly}
                        onPress={() => onDeleteProvider(provider.id)}
                        haptic="warning"
                        style={styles.deleteButton}
                      >
                        <Trash2 size={16} color={theme.colors.error} strokeWidth={2.2} />
                      </AnimatedPressable>
                    ) : (
                      <View
                        accessible
                        accessibilityLabel="内置供应商不可删除"
                        style={styles.protectedButton}
                      >
                        <Lock size={14} color={theme.colors.textTertiary} strokeWidth={2} />
                      </View>
                    )
                  ) : (
                    <>
                      <AnimatedPressable
                        accessibilityRole="button"
                        accessibilityLabel={`${enabled ? '禁用' : '启用'} ${provider.name}`}
                        accessibilityState={{ disabled: readOnly, selected: enabled }}
                        disabled={readOnly}
                        onPress={() => onToggleEnabled(provider.id)}
                        haptic="selection"
                        style={[
                          styles.statusBadge,
                          enabled ? styles.statusEnabled : styles.statusDisabled,
                        ]}
                      >
                        <Text
                          style={[
                            styles.statusText,
                            enabled ? styles.statusTextEnabled : styles.statusTextDisabled,
                          ]}
                        >
                          {enabled ? '启用' : '禁用'}
                        </Text>
                      </AnimatedPressable>

                      <AnimatedPressable
                        accessibilityRole="button"
                        accessibilityLabel={`打开 ${provider.name}`}
                        accessibilityState={{ disabled: navigationDisabled }}
                        disabled={navigationDisabled}
                        onPress={() => onSelectProvider(provider.id)}
                        style={styles.chevronSlot}
                      >
                        <View style={styles.chevronCircle}>
                          <Text style={styles.chevronText}>›</Text>
                        </View>
                      </AnimatedPressable>
                    </>
                  )}
                </MotionSwap>
              </MotionItem>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 6,
      paddingTop: 8,
      paddingBottom: 6,
      borderBottomWidth: 0.6,
      borderBottomColor: theme.colors.outlineVariant,
    },
    headerLeading: {
      width: 76,
      alignItems: 'flex-start',
    },
    headerActions: {
      width: 76,
      flexDirection: 'row',
      justifyContent: 'flex-end',
    },
    headerButton: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerButtonActive: {
      backgroundColor: theme.colors.surfaceSunken,
    },
    headerIconSwap: {
      width: 22,
      height: 22,
    },
    headerTitle: {
      flex: 1,
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'center',
    },
    searchWrap: {
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    searchField: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: theme.colors.surfaceSunken,
      borderRadius: 10,
      paddingHorizontal: 10,
      minHeight: 38,
    },
    searchInput: {
      flex: 1,
      fontSize: 14,
      color: theme.colors.text,
      minHeight: 38,
    },
    clearButton: {
      width: 24,
      height: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    clearButtonInner: {
      width: 24,
      height: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    content: {
      flex: 1,
    },
    listContent: {
      paddingHorizontal: 12,
      paddingBottom: 24,
    },
    card: {
      backgroundColor: theme.colors.card,
      borderRadius: 12,
      borderWidth: 0.6,
      borderColor: theme.colors.outlineVariant,
      overflow: 'hidden',
      ...theme.shadows.soft,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 11,
      paddingLeft: 12,
      paddingRight: 8,
      minHeight: 48,
    },
    rowMain: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'stretch',
    },
    rowMainInner: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
    },
    rowBorder: {
      borderBottomWidth: 0.6,
      borderBottomColor: theme.colors.divider,
    },
    avatarSlot: {
      width: 30,
      alignItems: 'center',
      justifyContent: 'center',
    },
    providerName: {
      flex: 1,
      fontSize: 15,
      color: theme.colors.text,
      fontWeight: '500',
      marginLeft: 8,
    },
    trailingSlot: {
      width: 74,
      alignItems: 'flex-end',
    },
    normalTrailing: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
    },
    editTrailing: {
      width: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    deleteButton: {
      width: 30,
      height: 30,
      borderRadius: 15,
      marginHorizontal: 3,
      backgroundColor: theme.colors.errorContainer,
      alignItems: 'center',
      justifyContent: 'center',
    },
    protectedButton: {
      width: 30,
      height: 30,
      borderRadius: 15,
      marginHorizontal: 3,
      backgroundColor: theme.colors.surfaceSunken,
      alignItems: 'center',
      justifyContent: 'center',
    },
    statusBadge: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      marginRight: 8,
    },
    statusEnabled: {
      backgroundColor: theme.colors.successContainer,
    },
    statusDisabled: {
      backgroundColor: theme.colors.warningContainer,
    },
    statusText: {
      fontSize: 11,
      fontWeight: '600',
    },
    statusTextEnabled: {
      color: theme.colors.success,
    },
    statusTextDisabled: {
      color: theme.colors.warning,
    },
    chevronSlot: {
      width: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chevronCircle: {
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: theme.colors.surfaceSunken,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chevronText: {
      fontSize: 14,
      color: theme.colors.textTertiary,
      fontWeight: '600',
      lineHeight: 18,
    },
  });
}

const styleCache = new WeakMap<KelivoTheme, ReturnType<typeof createStyles>>();

function getStyles(theme: KelivoTheme) {
  let styles = styleCache.get(theme);
  if (!styles) {
    styles = createStyles(theme);
    styleCache.set(theme, styles);
  }
  return styles;
}
