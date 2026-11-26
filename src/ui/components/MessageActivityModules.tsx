import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Text, View } from 'react-native';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Globe2,
  Lightbulb,
  Wrench,
} from 'lucide-react-native';

import type { ChatMessage } from '../../domain/types';
import {
  isWeakSearchTitle,
  titleFromSearchUrl,
} from '../../services/externalSearch';
import {
  buildMessageActivityModules,
  displayModuleTitle,
  extractSearchQuery,
  formatActivityElapsed,
  isSearchToolName,
  parseSearchToolDetail,
  type MessageActivityModule,
  type ThinkingActivityModule,
  type ToolActivityModule,
} from '../../services/messageActivity';
import { useKelivoTheme } from '../theme';
import { AnimatedPressable } from './AnimatedPressable';
import { MessageMarkdown } from './MessageMarkdown';

const ICON_COL = 22;
const ICON_SIZE = 16;
const ROW_PAD_V = 7;
const COLLAPSE_THRESHOLD = 4;
const DEFAULT_VISIBLE_TAIL = 2;

export interface ResolveThinkingExpandedStateArgs {
  status: 'running' | 'completed';
  userOverride?: boolean;
  expandAll?: boolean;
}

/**
 * 解析思考过程折叠状态：
 * 1. 用户单步显式点击覆盖最高优先级；
 * 2. 顶部全局“全部展开/收起”覆盖次之；
 * 3. 默认规则为流式运行中自动展开、完成后自动折叠。
 */
export function resolveThinkingExpandedState({
  status,
  userOverride,
  expandAll,
}: ResolveThinkingExpandedStateArgs): boolean {
  if (typeof userOverride === 'boolean') {
    return userOverride;
  }
  if (typeof expandAll === 'boolean') {
    return expandAll;
  }
  return status === 'running';
}

function resolveModuleCanExpand(module: MessageActivityModule): boolean {
  if (module.kind === 'thinking') {
    return Boolean(module.content?.trim()) || module.status === 'running';
  }
  const isSearch = isSearchToolName(module.toolName);
  if (isSearch) {
    const searchParsed = parseSearchToolDetail(module.detail);
    return Boolean(
      extractSearchQuery(module.arguments, module.title, module.detail) ||
        searchParsed.error ||
        searchParsed.answer ||
        searchParsed.items.length > 0 ||
        module.summary ||
        module.status === 'running'
    );
  }
  const genericDetail = [module.summary, module.argumentsPreview, module.detail]
    .filter(Boolean)
    .join('\n')
    .trim();
  return Boolean(genericDetail) || module.status === 'running';
}

function resolveModuleExpandedState(
  module: MessageActivityModule,
  userOverride: boolean | undefined,
  expandAll: boolean | undefined
): boolean {
  if (module.kind === 'thinking') {
    return resolveThinkingExpandedState({
      status: module.status,
      userOverride,
      expandAll,
    });
  }
  if (typeof userOverride === 'boolean') {
    return userOverride;
  }
  if (typeof expandAll === 'boolean') {
    return expandAll;
  }
  return false;
}

function hostnameFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./i, '');
  } catch {
    return raw;
  }
}

function StepIcon({
  module,
  color,
}: {
  module: MessageActivityModule;
  color: string;
}) {
  if (module.status === 'running') {
    return <ActivityIndicator size="small" color={color} />;
  }
  if (module.kind === 'thinking') {
    return <Lightbulb size={ICON_SIZE} color={color} strokeWidth={2} />;
  }
  if (isSearchToolName(module.toolName)) {
    return <Globe2 size={ICON_SIZE} color={color} strokeWidth={2} />;
  }
  return <Wrench size={ICON_SIZE} color={color} strokeWidth={2} />;
}

function SearchStepDetail({ module }: { module: ToolActivityModule }) {
  const { colors } = useKelivoTheme();
  const parsed = useMemo(() => parseSearchToolDetail(module.detail), [module.detail]);
  const query = extractSearchQuery(module.arguments, module.title, module.detail);
  const muted = colors.onSurfaceVariant;
  const previewItems = parsed.items.slice(0, 5);

  return (
    <View style={{ gap: 8 }} testID="search-step-detail">
      {query ? (
        <View style={{ gap: 2 }}>
          <Text style={{ color: muted, fontSize: 11, fontWeight: '600' }}>查询</Text>
          <Text selectable style={{ color: colors.onSurface, fontSize: 13, lineHeight: 19 }}>
            {query}
          </Text>
        </View>
      ) : null}

      {module.status === 'running' && !parsed.items.length && !parsed.error ? (
        <Text style={{ color: muted, fontSize: 12, lineHeight: 18 }}>正在检索网页…</Text>
      ) : null}

      {parsed.error ? (
        <Text selectable style={{ color: colors.error, fontSize: 12, lineHeight: 18 }}>
          {parsed.error}
        </Text>
      ) : null}

      {parsed.answer ? (
        <View style={{ gap: 2 }}>
          <Text style={{ color: muted, fontSize: 11, fontWeight: '600' }}>摘要</Text>
          <MessageMarkdown content={parsed.answer} variant="muted" />
        </View>
      ) : null}

      {previewItems.length ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: muted, fontSize: 11, fontWeight: '600' }}>
            结果{parsed.items.length > previewItems.length ? `（前 ${previewItems.length} 条）` : ''}
          </Text>
          {previewItems.map((item, index) => {
            const host = item.url ? hostnameFromUrl(item.url) : '';
            const label =
              item.url && isWeakSearchTitle(item.title || '', item.url)
                ? titleFromSearchUrl(item.url)
                : item.title?.trim() || host || '来源';
            return (
              <AnimatedPressable
                key={`${item.url}:${index}`}
                accessibilityRole="link"
                accessibilityLabel={`打开 ${label}`}
                disabled={!item.url}
                onPress={() => {
                  if (item.url) void Linking.openURL(item.url).catch(() => undefined);
                }}
                style={{
                  paddingVertical: 4,
                  gap: 2,
                }}
              >
                <Text
                  numberOfLines={2}
                  style={{
                    color: colors.accentText,
                    fontSize: 13,
                    lineHeight: 18,
                    fontWeight: '600',
                  }}
                >
                  {index + 1}. {label}
                </Text>
                {host ? (
                  <Text numberOfLines={1} style={{ color: muted, fontSize: 11, lineHeight: 15 }}>
                    {host}
                  </Text>
                ) : null}
                {item.text ? (
                  <Text numberOfLines={2} style={{ color: muted, fontSize: 12, lineHeight: 17 }}>
                    {item.text}
                  </Text>
                ) : null}
              </AnimatedPressable>
            );
          })}
          {parsed.items.length > previewItems.length ? (
            <Text style={{ color: muted, fontSize: 11, lineHeight: 15 }}>
              共 {parsed.items.length} 条；完整来源见消息下方引用
            </Text>
          ) : null}
        </View>
      ) : null}

      {!query &&
      !parsed.error &&
      !parsed.answer &&
      !previewItems.length &&
      module.summary ? (
        <Text style={{ color: muted, fontSize: 12, lineHeight: 18 }}>{module.summary}</Text>
      ) : null}
    </View>
  );
}

/**
 * 链式思考与工具活动单行渲染：
 * 左侧图标与时间线轨道，中间标题，右侧实时耗时 Badge 与折叠箭头。
 */
function TimelineStepRow({
  module,
  isFirst,
  isLast,
  userOverride,
  expandAll,
  onToggleExpanded,
}: {
  module: MessageActivityModule;
  isFirst: boolean;
  isLast: boolean;
  userOverride?: boolean;
  expandAll?: boolean;
  onToggleExpanded: (id: string, nextExpanded: boolean) => void;
}) {
  const { colors } = useKelivoTheme();
  const [tick, setTick] = useState(0);
  const muted = colors.onSurfaceVariant;
  const title = useMemo(() => {
    void tick;
    return displayModuleTitle(module);
  }, [module, tick]);

  const elapsedBadgeText = useMemo(() => {
    void tick;
    return formatActivityElapsed(
      module.startedAt,
      module.finishedAt,
      module.status === 'running'
    );
  }, [module.startedAt, module.finishedAt, module.status, tick]);

  useEffect(() => {
    if (module.status !== 'running') return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [module.status]);

  const isSearch = module.kind === 'tool' && isSearchToolName(module.toolName);
  const thinkingContent =
    module.kind === 'thinking' ? module.content?.trim() ?? '' : '';
  const genericDetail =
    module.kind === 'tool' && !isSearch
      ? [module.summary, module.argumentsPreview, module.detail]
          .filter(Boolean)
          .join('\n')
          .trim()
      : '';

  const canExpand = resolveModuleCanExpand(module);
  const expanded = resolveModuleExpandedState(module, userOverride, expandAll);

  return (
    <View>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        disabled={!canExpand}
        onPress={() => {
          if (canExpand) onToggleExpanded(module.id, !expanded);
        }}
        style={{
          minHeight: 36,
          paddingVertical: ROW_PAD_V,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        {/* Icon column + continuous rail */}
        <View style={{ width: ICON_COL, alignSelf: 'stretch', alignItems: 'center' }}>
          {!isFirst ? (
            <View
              style={{
                position: 'absolute',
                top: 0,
                width: 1,
                height: ROW_PAD_V + 2,
                backgroundColor: colors.outlineVariant,
                opacity: 0.9,
              }}
            />
          ) : null}
          <View
            style={{
              width: ICON_COL,
              height: ICON_SIZE + 4,
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 0,
            }}
          >
            <StepIcon module={module} color={muted} />
          </View>
          {!isLast || expanded ? (
            <View
              style={{
                flex: 1,
                width: 1,
                minHeight: expanded ? 8 : 4,
                backgroundColor: colors.outlineVariant,
                opacity: 0.9,
              }}
            />
          ) : null}
        </View>

        <View style={{ flex: 1, minWidth: 0, paddingLeft: 10, paddingRight: 6 }}>
          <Text
            numberOfLines={1}
            style={{
              color: colors.onSurface,
              fontSize: 14,
              lineHeight: 20,
              fontWeight: '500',
            }}
          >
            {title}
          </Text>
        </View>

        {elapsedBadgeText ? (
          <View
            testID={`activity-elapsed-badge-${module.id}`}
            style={{
              marginRight: 6,
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 999,
              backgroundColor:
                module.status === 'running' ? colors.accentSoft : colors.surfaceSunken,
            }}
          >
            <Text
              style={{
                color: module.status === 'running' ? colors.accentText : muted,
                fontSize: 11,
                lineHeight: 14,
                fontWeight: '600',
              }}
            >
              {elapsedBadgeText}
            </Text>
          </View>
        ) : null}

        {canExpand ? (
          expanded ? (
            <ChevronDown size={16} color={muted} strokeWidth={2} />
          ) : (
            <ChevronRight size={16} color={muted} strokeWidth={2} />
          )
        ) : (
          <View style={{ width: 16 }} />
        )}
      </AnimatedPressable>

      {expanded && canExpand ? (
        <View style={{ flexDirection: 'row' }}>
          <View style={{ width: ICON_COL, alignItems: 'center' }}>
            {!isLast ? (
              <View
                style={{
                  width: 1,
                  flex: 1,
                  minHeight: 12,
                  backgroundColor: colors.outlineVariant,
                  opacity: 0.9,
                }}
              />
            ) : null}
          </View>
          <View style={{ flex: 1, minWidth: 0, paddingLeft: 10, paddingBottom: 8, paddingRight: 4 }}>
            {module.kind === 'thinking' ? (
              thinkingContent ? (
                <MessageMarkdown content={thinkingContent} variant="muted" />
              ) : module.status === 'running' ? (
                <Text style={{ color: muted, fontSize: 12, lineHeight: 18 }}>思考中…</Text>
              ) : null
            ) : isSearch && module.kind === 'tool' ? (
              <SearchStepDetail module={module} />
            ) : genericDetail ? (
              <Text
                selectable
                style={{
                  color: muted,
                  fontSize: 13,
                  lineHeight: 19,
                }}
              >
                {genericDetail}
              </Text>
            ) : module.status === 'running' ? (
              <Text style={{ color: muted, fontSize: 12, lineHeight: 18 }}>执行中…</Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function MessageActivityModules({ message }: { message: ChatMessage }) {
  const { colors } = useKelivoTheme();
  const modules = useMemo(() => buildMessageActivityModules(message), [message]);
  // Multi-step chain also stays collapsed by default (only last few steps visible).
  const [showAll, setShowAll] = useState(false);
  const [expandAllOverride, setExpandAllOverride] = useState<boolean | undefined>(undefined);
  const [userOverrides, setUserOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setExpandAllOverride(undefined);
    setUserOverrides({});
  }, [message.id]);

  if (!modules.length) return null;

  const canCollapse = modules.length > COLLAPSE_THRESHOLD;
  const visible =
    canCollapse && !showAll ? modules.slice(-DEFAULT_VISIBLE_TAIL) : modules;
  const hiddenCount = modules.length - visible.length;
  const expandableVisible = visible.filter(resolveModuleCanExpand);
  const allVisibleExpanded =
    expandableVisible.length > 0 &&
    expandableVisible.every((item) =>
      resolveModuleExpandedState(item, userOverrides[item.id], expandAllOverride)
    );

  const handleToggleRow = (id: string, nextExpanded: boolean) => {
    setUserOverrides((prev) => ({
      ...prev,
      [id]: nextExpanded,
    }));
  };

  const handleToggleExpandAll = () => {
    const nextExpandAll = !allVisibleExpanded;
    setExpandAllOverride(nextExpandAll);
    setUserOverrides({});
  };

  return (
    <View
      testID="message-activity-modules"
      style={{
        alignSelf: 'stretch',
        marginBottom: 8,
        borderRadius: 16,
        backgroundColor: colors.reasoningCard,
        paddingHorizontal: 12,
        paddingTop: 4,
        paddingBottom: 4,
        overflow: 'hidden',
      }}
    >
      {canCollapse || expandableVisible.length > 0 ? (
        <View
          style={{
            minHeight: 30,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            {canCollapse && hiddenCount > 0 ? (
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityLabel={`展开其余 ${hiddenCount} 个步骤`}
                onPress={() => setShowAll(true)}
                style={{
                  minHeight: 30,
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 4,
                  gap: 8,
                }}
              >
                <View style={{ width: ICON_COL, alignItems: 'center' }}>
                  <ChevronDown size={16} color={colors.onSurfaceVariant} strokeWidth={2} />
                </View>
                <Text
                  style={{
                    color: colors.onSurface,
                    fontSize: 13,
                    fontWeight: '600',
                  }}
                >
                  展开 {hiddenCount} 个步骤
                </Text>
              </AnimatedPressable>
            ) : canCollapse && showAll ? (
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityLabel="收起过程步骤"
                onPress={() => setShowAll(false)}
                style={{
                  minHeight: 30,
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 4,
                  gap: 8,
                }}
              >
                <View style={{ width: ICON_COL, alignItems: 'center' }}>
                  <ChevronUp size={16} color={colors.onSurfaceVariant} strokeWidth={2} />
                </View>
                <Text
                  style={{
                    color: colors.onSurface,
                    fontSize: 13,
                    fontWeight: '600',
                  }}
                >
                  收起步骤
                </Text>
              </AnimatedPressable>
            ) : null}
          </View>

          {expandableVisible.length > 0 ? (
            <AnimatedPressable
              accessibilityRole="button"
              accessibilityLabel={allVisibleExpanded ? '全部收起思考与工具详情' : '全部展开思考与工具详情'}
              testID="activity-toggle-expand-all"
              onPress={handleToggleExpandAll}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 999,
              }}
            >
              <Text
                style={{
                  color: colors.accentText,
                  fontSize: 12,
                  fontWeight: '600',
                }}
              >
                {allVisibleExpanded ? '全部收起' : '全部展开'}
              </Text>
            </AnimatedPressable>
          ) : null}
        </View>
      ) : null}

      {visible.map((module, index) => (
        <TimelineStepRow
          key={module.id}
          module={module}
          isFirst={index === 0 && hiddenCount === 0}
          isLast={index === visible.length - 1}
          userOverride={userOverrides[module.id]}
          expandAll={expandAllOverride}
          onToggleExpanded={handleToggleRow}
        />
      ))}
    </View>
  );
}

// Re-export types used by tests/imports if needed
export type { ThinkingActivityModule, ToolActivityModule };
