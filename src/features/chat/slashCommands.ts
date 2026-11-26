import type { PromptTemplate } from '../../domain/types';
import { renderPromptTemplate, sortPromptTemplates } from '../../services/promptTemplates';

export type BuiltinSlashAction =
  | 'export-markdown'
  | 'export-json'
  | 'new-conversation'
  | 'open-context'
  | 'clear-input';

export interface SlashCommandItem {
  id: string;
  command: string;
  title: string;
  description: string;
  kind: 'builtin' | 'template';
  action?: BuiltinSlashAction;
  keywords?: readonly string[];
  template?: PromptTemplate;
}

export interface SlashCommandSelectionResult {
  kind: 'builtin' | 'template';
  action?: BuiltinSlashAction;
  nextText?: string;
  templateId?: string;
  templateMode?: PromptTemplate['mode'];
}

const MAX_SLASH_QUERY_LENGTH = 80;
const LEADING_SLASH_PATTERN = /^[ \t]*\/([^\s/\r\n]*)$/;

const BUILTIN_SLASH_COMMANDS: readonly SlashCommandItem[] = [
  {
    id: 'builtin:export-markdown',
    command: '/export',
    title: '导出 Markdown',
    description: '将当前对话导出为 Markdown 文件',
    kind: 'builtin',
    action: 'export-markdown',
    keywords: ['export', 'markdown', 'md', '导出', '保存'],
  },
  {
    id: 'builtin:export-json',
    command: '/export-json',
    title: '导出 JSON',
    description: '将当前对话导出为脱敏结构化 JSON',
    kind: 'builtin',
    action: 'export-json',
    keywords: ['export-json', 'json', '导出'],
  },
  {
    id: 'builtin:new-conversation',
    command: '/new',
    title: '新对话',
    description: '在当前项目创建一条新的对话',
    kind: 'builtin',
    action: 'new-conversation',
    keywords: ['new', 'chat', '新建', '新对话'],
  },
  {
    id: 'builtin:open-context',
    command: '/context',
    title: '检查上下文',
    description: '打开当前请求的上下文与项目资料检查器',
    kind: 'builtin',
    action: 'open-context',
    keywords: ['context', 'inspect', '上下文', '资料'],
  },
  {
    id: 'builtin:clear-input',
    command: '/clear',
    title: '清空输入',
    description: '清空当前消息输入框文本',
    kind: 'builtin',
    action: 'clear-input',
    keywords: ['clear', 'reset', '清空', '重置'],
  },
];

function extractSlashQuery(text: string, cursorOffset?: number): string | null {
  if (typeof text !== 'string' || !text) {
    return null;
  }

  const end =
    typeof cursorOffset === 'number' && Number.isFinite(cursorOffset)
      ? Math.max(0, Math.min(text.length, Math.floor(cursorOffset)))
      : text.length;
  const slice = text.slice(0, end);
  // 限制前置长度避免超长输入做无意义正则扫描
  if (slice.length > MAX_SLASH_QUERY_LENGTH + 32) {
    return null;
  }

  const match = slice.match(LEADING_SLASH_PATTERN);
  if (!match) {
    return null;
  }

  const query = match[1] ?? '';
  if (query.length > MAX_SLASH_QUERY_LENGTH) {
    return null;
  }
  return query;
}

/**
 * 判断当前输入框文本及光标位置是否应当激活 `/` 快捷指令浮层。
 * 仅允许行首（可带前导空格/Tab）且不含后续路径分隔符与换行的单段 `/query` 触发，
 * 彻底防止 URL（`https://...`）、文件路径（`src/services/...`）与行内斜杠（`A / B`）误触。
 */
export function shouldOpenSlashCommandMenu(text: string, cursorOffset?: number): boolean {
  return extractSlashQuery(text, cursorOffset) !== null;
}

/**
 * 筛选匹配的内置动作与工作区 PromptTemplate 快捷指令。
 */
export function filterSlashCommands(
  inputText: string,
  options?: { promptTemplates?: readonly PromptTemplate[] }
): SlashCommandItem[] {
  const query = extractSlashQuery(inputText);
  if (query === null) {
    return [];
  }

  const templateItems: SlashCommandItem[] = sortPromptTemplates(
    options?.promptTemplates ?? []
  ).map((template) => {
    const cleanName = template.name.trim();
    return {
      id: `template:${template.id}`,
      command: `/${cleanName}`,
      title: cleanName,
      description: template.mode === 'system' ? '会话指令模板' : '输入框模板',
      kind: 'template',
      keywords: [cleanName, template.mode === 'system' ? 'system' : 'composer'],
      template,
    };
  });

  const combined = [...BUILTIN_SLASH_COMMANDS, ...templateItems];
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return combined;
  }

  const matched = combined.filter((item) => {
    const commandBody = item.command.slice(1).toLowerCase();
    const fullCommand = item.command.toLowerCase();
    const titleLower = item.title.toLowerCase();
    if (
      commandBody.includes(normalizedQuery) ||
      fullCommand.includes(`/${normalizedQuery}`) ||
      titleLower.includes(normalizedQuery)
    ) {
      return true;
    }
    return Boolean(
      item.keywords?.some((keyword) => keyword.toLowerCase().includes(normalizedQuery))
    );
  });

  // 优先排序前缀匹配的命令
  return matched.sort((left, right) => {
    const leftPrefix = left.command.slice(1).toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
    const rightPrefix = right.command.slice(1).toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
    return leftPrefix - rightPrefix;
  });
}

/**
 * 解析用户选中 `/` 快捷指令后的状态变更结果：
 * - 内置动作返回 `action` 与清空输入 `nextText: ''`；
 * - 提示词模板使用 `renderPromptTemplate(content, {})` 保留原始 `{{var}}` 占位符并替换前置 `/query`。
 */
export function resolveSlashCommandSelection(
  item: SlashCommandItem,
  currentText: string
): SlashCommandSelectionResult {
  if (item.kind === 'builtin') {
    return {
      kind: 'builtin',
      action: item.action,
      nextText: '',
    };
  }

  const rendered = renderPromptTemplate(item.template?.content ?? '', {});
  // 使用函数替换避免模板中的 $$、$1、$& 等序列被 String.prototype.replace 解析展开
  const replaced = LEADING_SLASH_PATTERN.test(currentText)
    ? currentText.replace(LEADING_SLASH_PATTERN, () => rendered)
    : rendered;

  return {
    kind: 'template',
    nextText: replaced,
    templateId: item.template?.id,
    templateMode: item.template?.mode,
  };
}
