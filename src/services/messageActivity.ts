import type {
  ActivityTimelineStep,
  ChatMessage,
  McpActivitySummary,
  ToolActivityItem,
  WebCitation,
} from '../domain/types';
import { cleanSearchAnswerForDisplay } from './externalSearch';

export type MessageActivityModuleKind = 'thinking' | 'tool';

export interface ThinkingActivityModule {
  kind: 'thinking';
  id: string;
  status: 'running' | 'completed';
  title: string;
  content: string;
  startedAt?: number;
  finishedAt?: number;
  sequence: number;
}

export interface ToolActivityModule {
  kind: 'tool';
  id: string;
  status: ToolActivityItem['status'];
  toolName: string;
  title: string;
  summary?: string;
  detail?: string;
  arguments?: Record<string, unknown>;
  argumentsPreview?: string;
  startedAt?: number;
  finishedAt?: number;
  sequence: number;
}

export type MessageActivityModule = ThinkingActivityModule | ToolActivityModule;

export interface SearchToolResultItem {
  title: string;
  url: string;
  text?: string;
}

export interface ParsedSearchToolDetail {
  query?: string;
  error?: string;
  answer?: string;
  items: SearchToolResultItem[];
  resultCount?: number;
}

const maxDetailChars = 4_000;

function truncate(value: string, max = 160): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export function isSearchToolName(toolName: string): boolean {
  const name = toolName.trim();
  return name === 'search_web' || name === 'web_search' || name === 'builtin_search';
}

/** Human-friendly search step title, e.g. 搜索「阿根廷 瑞士」· 5 条 */
export function formatSearchActivityTitle(args: {
  status: 'running' | 'completed' | 'failed';
  query?: string;
  resultCount?: number;
}): string {
  const q = args.query?.trim();
  const quoted = q ? `「${truncate(q, 40)}」` : '';
  if (args.status === 'running') {
    return q ? `正在搜索${quoted}` : '正在检索…';
  }
  if (args.status === 'failed') {
    return q ? `搜索失败${quoted}` : '搜索失败';
  }
  if (typeof args.resultCount === 'number' && Number.isFinite(args.resultCount)) {
    const n = Math.max(0, Math.trunc(args.resultCount));
    return q ? `搜索${quoted} · ${n} 条` : `检索完成 · ${n} 条`;
  }
  return q ? `搜索${quoted}` : '联网检索';
}

export function parseResultCountFromSummary(summary?: string): number | undefined {
  if (!summary?.trim()) return undefined;
  const match = summary.match(/返回\s*(\d+)\s*条/);
  if (!match) return undefined;
  const n = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(n) ? n : undefined;
}

export function extractSearchQuery(
  args?: Record<string, unknown>,
  title?: string,
  detail?: string
): string | undefined {
  if (typeof args?.query === 'string' && args.query.trim()) {
    return args.query.trim();
  }
  const fromTitle = title
    ?.replace(/^(正在搜索|搜索失败|搜索|联网检索|联网搜索)\s*/u, '')
    .replace(/^[「『"']/, '')
    .replace(/[」』"']\s*(·\s*\d+\s*条)?\s*$/u, '')
    .replace(/^[：:]\s*/, '')
    .trim();
  if (fromTitle && fromTitle !== '联网检索' && fromTitle !== '检索完成') {
    // Drop trailing " · N 条" if still present
    const cleaned = fromTitle.replace(/\s*·\s*\d+\s*条\s*$/u, '').trim();
    if (cleaned) return cleaned;
  }
  const parsed = parseSearchToolDetail(detail);
  return parsed.query;
}

/** Parse tool content JSON produced by formatExternalSearchToolResult (or error payload). */
export function parseSearchToolDetail(detail?: string): ParsedSearchToolDetail {
  const empty: ParsedSearchToolDetail = { items: [] };
  if (!detail?.trim()) return empty;
  try {
    const raw = JSON.parse(detail) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
    const record = raw as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) {
      return { error: record.error.trim(), items: [] };
    }
    const answer =
      typeof record.answer === 'string' && record.answer.trim()
        ? record.answer.trim()
        : undefined;
    const query =
      typeof record.query === 'string' && record.query.trim()
        ? record.query.trim()
        : undefined;
    const list = Array.isArray(record.items) ? record.items : [];
    const items: SearchToolResultItem[] = [];
    for (const entry of list.slice(0, 20)) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const url = typeof row.url === 'string' ? row.url.trim() : '';
      const rawTitle = typeof row.title === 'string' ? row.title.trim() : '';
      // Grok-style weak titles ("1") should not beat the URL host fallback in UI.
      const title = rawTitle || url;
      if (!url && !title) continue;
      items.push({
        title: title.slice(0, 200),
        url: url.slice(0, 2000),
        ...(typeof row.text === 'string' && row.text.trim()
          ? { text: row.text.trim().slice(0, 400) }
          : {}),
      });
    }
    const cleanedAnswer = answer ? cleanSearchAnswerForDisplay(answer) : undefined;
    return {
      ...(query ? { query } : {}),
      ...(cleanedAnswer ? { answer: cleanedAnswer } : {}),
      items,
      resultCount: items.length,
    };
  } catch {
    // Non-JSON tool body — treat as plain error/summary text.
    const text = detail.trim();
    if (/失败|error|timeout|超时/i.test(text) && text.length < 500) {
      return { error: text, items: [] };
    }
    return empty;
  }
}

export function toolActivityTitle(toolName: string, args?: Record<string, unknown>): string {
  const name = toolName.trim() || 'tool';
  if (isSearchToolName(name)) {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    return formatSearchActivityTitle({ status: 'completed', query });
  }
  if (name.startsWith('mcp:')) {
    return `MCP: ${name.slice(4) || 'tool'}`;
  }
  return `工具: ${name}`;
}

/** Compact row title matching consumer chat UIs: `深度思考 (0.7s)`. */
export function formatThinkingRowTitle(
  status: 'running' | 'completed' | 'failed',
  startedAt?: number,
  finishedAt?: number
): string {
  const elapsed = formatActivityElapsed(startedAt, finishedAt, status === 'running');
  if (status === 'running') {
    return elapsed ? `深度思考 (${elapsed})` : '深度思考';
  }
  return elapsed ? `深度思考 (${elapsed})` : '深度思考';
}

/** Prefer clean display titles; strip legacy status-y prefixes when possible. */
export function displayModuleTitle(module: MessageActivityModule): string {
  if (module.kind === 'thinking') {
    return formatThinkingRowTitle(module.status, module.startedAt, module.finishedAt);
  }
  if (isSearchToolName(module.toolName)) {
    const parsed = parseSearchToolDetail(module.detail);
    const query = extractSearchQuery(module.arguments, module.title, module.detail);
    const resultCount =
      parseResultCountFromSummary(module.summary) ??
      parsed.resultCount ??
      (parsed.items.length ? parsed.items.length : undefined);
    const status =
      module.status === 'running'
        ? 'running'
        : module.status === 'failed'
          ? 'failed'
          : 'completed';
    return formatSearchActivityTitle({ status, query, resultCount });
  }
  if (module.title.trim()) {
    // Normalize legacy "联网搜索：" → human search title when possible
    const legacy = module.title
      .replace(/^联网搜索[：:]/, '')
      .replace(/^联网检索[：:]/, '')
      .replace(/^服务商联网搜索$/, '')
      .trim();
    if (legacy && isSearchToolName(module.toolName)) {
      return formatSearchActivityTitle({
        status: module.status === 'failed' ? 'failed' : 'completed',
        query: legacy,
      });
    }
    return module.title;
  }
  return toolActivityTitle(module.toolName, module.arguments);
}

export function formatToolArgumentsPreview(args?: Record<string, unknown>): string | undefined {
  if (!args || !Object.keys(args).length) return undefined;
  try {
    const entries = Object.entries(args).slice(0, 3).map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}=${truncate(String(text ?? ''), 40)}`;
    });
    const more = Object.keys(args).length > 3 ? ' …' : '';
    return `${entries.join(', ')}${more}`;
  } catch {
    return undefined;
  }
}

export function nextTimelineSequence(timeline: readonly ActivityTimelineStep[]): number {
  if (!timeline.length) return 0;
  return Math.max(...timeline.map((step) => step.sequence)) + 1;
}

export function normalizeActivityTimeline(value: unknown): ActivityTimelineStep[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const out: ActivityTimelineStep[] = [];
  for (const entry of value.slice(0, 48)) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const kind = row.kind === 'thinking' || row.kind === 'tool' ? row.kind : null;
    const status = row.status;
    const sequence =
      typeof row.sequence === 'number' && Number.isFinite(row.sequence)
        ? Math.trunc(row.sequence)
        : out.length;
    if (!id || !kind) continue;
    if (status !== 'running' && status !== 'completed' && status !== 'failed') continue;
    if (kind === 'tool') {
      const toolName = typeof row.toolName === 'string' ? row.toolName.trim() : '';
      if (!toolName) continue;
      out.push({
        id: id.slice(0, 120),
        kind: 'tool',
        sequence,
        status,
        toolName: toolName.slice(0, 120),
        ...(typeof row.title === 'string' && row.title.trim()
          ? { title: row.title.trim().slice(0, 200) }
          : {}),
        ...(row.arguments && typeof row.arguments === 'object' && !Array.isArray(row.arguments)
          ? { arguments: row.arguments as Record<string, unknown> }
          : {}),
        ...(typeof row.summary === 'string' && row.summary.trim()
          ? { summary: row.summary.trim().slice(0, 500) }
          : {}),
        ...(typeof row.content === 'string' && row.content.trim()
          ? { content: row.content.trim().slice(0, maxDetailChars) }
          : {}),
        ...(typeof row.startedAt === 'number' && Number.isFinite(row.startedAt)
          ? { startedAt: row.startedAt }
          : {}),
        ...(typeof row.finishedAt === 'number' && Number.isFinite(row.finishedAt)
          ? { finishedAt: row.finishedAt }
          : {}),
      });
      continue;
    }
    out.push({
      id: id.slice(0, 120),
      kind: 'thinking',
      sequence,
      status: status === 'failed' ? 'completed' : status,
      ...(typeof row.title === 'string' && row.title.trim()
        ? { title: row.title.trim().slice(0, 200) }
        : {}),
      ...(typeof row.content === 'string'
        ? { content: row.content.slice(0, maxDetailChars) }
        : {}),
      ...(typeof row.startedAt === 'number' && Number.isFinite(row.startedAt)
        ? { startedAt: row.startedAt }
        : {}),
      ...(typeof row.finishedAt === 'number' && Number.isFinite(row.finishedAt)
        ? { finishedAt: row.finishedAt }
        : {}),
    });
  }
  return out.length
    ? out.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    : undefined;
}

export function normalizeToolActivityItems(value: unknown): ToolActivityItem[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const out: ToolActivityItem[] = [];
  for (const entry of value.slice(0, 32)) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const toolName = typeof row.toolName === 'string' ? row.toolName.trim() : '';
    const status = row.status;
    if (!id || !toolName) continue;
    if (status !== 'running' && status !== 'completed' && status !== 'failed') continue;
    const item: ToolActivityItem = {
      id: id.slice(0, 120),
      toolName: toolName.slice(0, 120),
      status,
      ...(typeof row.title === 'string' && row.title.trim()
        ? { title: row.title.trim().slice(0, 200) }
        : {}),
      ...(row.arguments && typeof row.arguments === 'object' && !Array.isArray(row.arguments)
        ? { arguments: row.arguments as Record<string, unknown> }
        : {}),
      ...(typeof row.summary === 'string' && row.summary.trim()
        ? { summary: row.summary.trim().slice(0, 500) }
        : {}),
      ...(typeof row.content === 'string' && row.content.trim()
        ? { content: row.content.trim().slice(0, maxDetailChars) }
        : {}),
      ...(typeof row.startedAt === 'number' && Number.isFinite(row.startedAt)
        ? { startedAt: row.startedAt }
        : {}),
      ...(typeof row.finishedAt === 'number' && Number.isFinite(row.finishedAt)
        ? { finishedAt: row.finishedAt }
        : {}),
      ...(typeof row.sequence === 'number' && Number.isFinite(row.sequence)
        ? { sequence: Math.trunc(row.sequence) }
        : {}),
    };
    out.push(item);
  }
  return out.length ? out : undefined;
}

export function toolItemsFromMcpActivity(activity: McpActivitySummary): ToolActivityItem[] {
  const items: ToolActivityItem[] = [];
  activity.approvals.forEach((approval, index) => {
    items.push({
      id: `mcp-approval-${index}-${approval.toolName}`,
      toolName: `mcp:${approval.toolName}`,
      title:
        approval.decision === 'approve'
          ? `已批准 ${approval.toolName}`
          : `已拒绝 ${approval.toolName}`,
      status: approval.decision === 'approve' ? 'completed' : 'failed',
      summary: approval.decision === 'approve' ? '用户批准了这次工具调用' : '用户拒绝了这次工具调用',
      sequence: index * 2,
    });
  });
  activity.calls.forEach((call, index) => {
    items.push({
      id: `mcp-call-${index}-${call.toolName}`,
      toolName: `mcp:${call.toolName}`,
      title: call.toolName,
      status:
        call.outcome === 'completed'
          ? 'completed'
          : call.outcome === 'failed'
            ? 'failed'
            : 'running',
      summary:
        call.outcome === 'completed'
          ? '执行完成'
          : call.outcome === 'failed'
            ? '执行失败'
            : '结果不确定（可能已产生副作用）',
      sequence: activity.approvals.length * 2 + index * 2 + 1,
    });
  });
  return items;
}

export function toolItemsFromWebSearchEvidence(args: {
  triggered?: boolean;
  citations?: WebCitation[];
  existing?: ToolActivityItem[];
  existingTimeline?: ActivityTimelineStep[];
}): ToolActivityItem[] {
  const hasSearch =
    args.existing?.some((item) => item.toolName === 'search_web' || item.toolName === 'web_search') ||
    args.existingTimeline?.some(
      (step) =>
        step.kind === 'tool' &&
        (step.toolName === 'search_web' || step.toolName === 'web_search')
    );
  if (hasSearch) return [];
  if (args.triggered === true || (args.citations?.length ?? 0) > 0) {
    const count = args.citations?.length ?? 0;
    return [
      {
        id: 'web-search-evidence',
        toolName: 'web_search',
        title: '联网检索',
        status: 'completed',
        summary: count > 0 ? `已返回 ${count} 条可点击来源` : '已触发联网搜索',
        sequence: 0,
      },
    ];
  }
  if (args.triggered === false) {
    return [
      {
        id: 'web-search-no-evidence',
        toolName: 'web_search',
        title: '联网检索',
        status: 'failed',
        summary: '响应未提供已触发联网搜索的证据',
        sequence: 0,
      },
    ];
  }
  return [];
}

function moduleFromTimelineStep(step: ActivityTimelineStep): MessageActivityModule | null {
  if (step.kind === 'thinking') {
    const status = step.status === 'failed' ? 'completed' : step.status;
    return {
      kind: 'thinking',
      id: step.id,
      status,
      title: formatThinkingRowTitle(status, step.startedAt, step.finishedAt),
      content: step.content?.trim() ?? '',
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      sequence: step.sequence,
    };
  }
  if (!step.toolName) return null;
  return {
    kind: 'tool',
    id: step.id,
    status: step.status,
    toolName: step.toolName,
    title: step.title?.trim() || toolActivityTitle(step.toolName, step.arguments),
    summary: step.summary,
    detail: step.content,
    ...(step.arguments ? { arguments: step.arguments } : {}),
    argumentsPreview: formatToolArgumentsPreview(step.arguments),
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    sequence: step.sequence,
  };
}

function toolModuleFromItem(tool: ToolActivityItem, sequence: number): ToolActivityModule {
  return {
    kind: 'tool',
    id: tool.id,
    status: tool.status,
    toolName: tool.toolName,
    title: tool.title?.trim() || toolActivityTitle(tool.toolName, tool.arguments),
    summary: tool.summary,
    detail: tool.content,
    ...(tool.arguments ? { arguments: tool.arguments } : {}),
    argumentsPreview: formatToolArgumentsPreview(tool.arguments),
    startedAt: tool.startedAt,
    finishedAt: tool.finishedAt,
    sequence: tool.sequence ?? sequence,
  };
}

/**
 * Build ordered modules for the message activity timeline.
 * Prefer explicit `activityTimeline` (preserves thought→tool→thought order).
 * Fall back to reasoning + toolActivity sorted by sequence/startedAt.
 */
export function buildMessageActivityModules(message: ChatMessage): MessageActivityModule[] {
  if (message.activityTimeline?.length) {
    const finishedAt =
      message.requestMetrics?.durationMs != null
        ? message.createdAt + message.requestMetrics.durationMs
        : undefined;
    // Defensive: terminal messages must not keep a live "running" timer in the UI.
    const timeline =
      finalizeActivityTimelineForTerminalMessage(message.activityTimeline, {
        messageStatus: message.status,
        ...(finishedAt !== undefined ? { finishedAt } : {}),
      }) ?? message.activityTimeline;

    const modules = timeline
      .slice()
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
      .map(moduleFromTimelineStep)
      .filter((item): item is MessageActivityModule => item != null);

    // Still surface synthetic web-search evidence if timeline has no search step.
    const extras = toolItemsFromWebSearchEvidence({
      triggered: message.webSearchTriggered,
      citations: message.citations,
      existingTimeline: timeline,
    });
    let seq = nextTimelineSequence(timeline);
    for (const tool of extras) {
      modules.push(toolModuleFromItem(tool, seq++));
    }
    return modules;
  }

  const modules: MessageActivityModule[] = [];
  const reasoning = message.reasoningContent?.trim() ?? '';
  const thinkingRunning =
    message.role === 'assistant' && message.status === 'pending' && Boolean(reasoning);
  const thinkingIdleRunning =
    message.role === 'assistant' &&
    message.status === 'pending' &&
    !message.content.trim() &&
    !reasoning &&
    !(message.toolActivity?.length);

  if (thinkingIdleRunning) {
    modules.push({
      kind: 'thinking',
      id: `${message.id}:thinking-pending`,
      status: 'running',
      title: formatThinkingRowTitle('running', message.createdAt),
      content: '',
      startedAt: message.createdAt,
      sequence: 0,
    });
  } else if (reasoning || thinkingRunning) {
    const status =
      thinkingRunning || message.status === 'pending' ? 'running' : 'completed';
    const finishedAt =
      message.status === 'ready' || message.status === 'error' || message.status === 'cancelled'
        ? message.requestMetrics?.durationMs
          ? message.createdAt + message.requestMetrics.durationMs
          : undefined
        : undefined;
    modules.push({
      kind: 'thinking',
      id: `${message.id}:thinking`,
      status,
      title: formatThinkingRowTitle(status, message.createdAt, finishedAt),
      content: reasoning,
      startedAt: message.createdAt,
      finishedAt,
      sequence: 0,
    });
  }

  const tools: ToolActivityItem[] = [
    ...(message.toolActivity ?? []),
    ...(message.mcpActivity ? toolItemsFromMcpActivity(message.mcpActivity) : []),
    ...toolItemsFromWebSearchEvidence({
      triggered: message.webSearchTriggered,
      citations: message.citations,
      existing: message.toolActivity,
    }),
  ];

  const seen = new Set<string>();
  const orderedTools = tools
    .filter((tool) => {
      if (seen.has(tool.id)) return false;
      seen.add(tool.id);
      return true;
    })
    .sort((left, right) => {
      const leftSeq = left.sequence ?? Number.MAX_SAFE_INTEGER;
      const rightSeq = right.sequence ?? Number.MAX_SAFE_INTEGER;
      if (leftSeq !== rightSeq) return leftSeq - rightSeq;
      const leftStart = left.startedAt ?? Number.MAX_SAFE_INTEGER;
      const rightStart = right.startedAt ?? Number.MAX_SAFE_INTEGER;
      if (leftStart !== rightStart) return leftStart - rightStart;
      return left.id.localeCompare(right.id);
    });

  let seq = modules.length ? 1 : 0;
  for (const tool of orderedTools) {
    modules.push(toolModuleFromItem(tool, tool.sequence ?? seq++));
  }

  return modules.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

export function upsertToolActivity(
  current: ToolActivityItem[] | undefined,
  next: ToolActivityItem
): ToolActivityItem[] {
  const list = [...(current ?? [])];
  const index = list.findIndex((item) => item.id === next.id);
  if (index >= 0) {
    list[index] = { ...list[index], ...next };
  } else {
    list.push(next);
  }
  return list.slice(-32);
}

export function upsertTimelineStep(
  timeline: ActivityTimelineStep[] | undefined,
  next: ActivityTimelineStep
): ActivityTimelineStep[] {
  const list = [...(timeline ?? [])];
  const index = list.findIndex((step) => step.id === next.id);
  if (index >= 0) {
    list[index] = { ...list[index], ...next, sequence: list[index].sequence };
  } else {
    list.push({
      ...next,
      sequence: Number.isFinite(next.sequence) ? next.sequence : nextTimelineSequence(list),
    });
  }
  return list
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .slice(-48);
}

/** Mark the latest running thinking step as completed before a tool starts. */
export function completeOpenThinkingSteps(
  timeline: ActivityTimelineStep[] | undefined,
  finishedAt = Date.now()
): ActivityTimelineStep[] {
  if (!timeline?.length) return timeline ?? [];
  return timeline.map((step) => {
    if (step.kind !== 'thinking' || step.status !== 'running') return step;
    const end = step.finishedAt ?? finishedAt;
    return {
      ...step,
      status: 'completed',
      finishedAt: end,
      title: formatThinkingRowTitle('completed', step.startedAt, end),
    };
  });
}

/**
 * When a message ends (error / cancel / ready), freeze any still-running timeline
 * steps so UI timers stop. Thinking → completed; tools → failed (or completed if cancelled cancel?).
 */
export function finalizeActivityTimelineForTerminalMessage(
  timeline: ActivityTimelineStep[] | undefined,
  args: {
    messageStatus: ChatMessage['status'];
    finishedAt?: number;
  }
): ActivityTimelineStep[] | undefined {
  if (!timeline?.length) return timeline;
  if (args.messageStatus === 'pending') return timeline;
  const finishedAt = args.finishedAt ?? Date.now();
  const toolStatus: ActivityTimelineStep['status'] =
    args.messageStatus === 'cancelled' ? 'failed' : 'failed';
  const toolSummary =
    args.messageStatus === 'cancelled' ? '已取消' : '请求已结束';

  return timeline.map((step) => {
    if (step.status !== 'running') return step;
    const end = step.finishedAt ?? finishedAt;
    if (step.kind === 'thinking') {
      return {
        ...step,
        status: 'completed',
        finishedAt: end,
        title: formatThinkingRowTitle('completed', step.startedAt, end),
      };
    }
    return {
      ...step,
      status: toolStatus,
      finishedAt: end,
      summary: step.summary?.trim() || toolSummary,
    };
  });
}

export function finalizeToolActivityForTerminalMessage(
  tools: ToolActivityItem[] | undefined,
  messageStatus: ChatMessage['status'],
  finishedAt = Date.now()
): ToolActivityItem[] | undefined {
  if (!tools?.length) return tools;
  if (messageStatus === 'pending') return tools;
  const summary = messageStatus === 'cancelled' ? '已取消' : '请求已结束';
  return tools.map((tool) => {
    if (tool.status !== 'running') return tool;
    return {
      ...tool,
      status: 'failed',
      finishedAt: tool.finishedAt ?? finishedAt,
      summary: tool.summary?.trim() || summary,
    };
  });
}

export function formatActivityElapsed(
  startedAt?: number,
  finishedAt?: number,
  running = false
): string | undefined {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
  const end =
    typeof finishedAt === 'number' && Number.isFinite(finishedAt)
      ? finishedAt
      : running
        ? Date.now()
        : startedAt;
  const ms = Math.max(0, end - startedAt);
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
