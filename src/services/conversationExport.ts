import type {
  ChatConversation,
  ChatMessage,
  ChatTokenUsage,
  MediaAttachment,
  WebCitation,
} from '../domain/types';
import { resolveMessageMarkdownLink } from './externalSearch';

const maxFilenameCharacters = 120;
const maxHtmlTagScanLength = 65_536;
const windowsReservedNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const controlAndBidiPattern = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
const namedHtmlEntitiesForProtocol: Record<string, string> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  lpar: '(',
  rpar: ')',
  sol: '/',
  bsol: '\\',
  comma: ',',
  semi: ';',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  excl: '!',
  num: '#',
  quest: '?',
  equals: '=',
  plus: '+',
  period: '.',
  hyphen: '-',
  dash: '-',
  lowbar: '_',
  percnt: '%',
  commat: '@',
};
const dangerousHtmlTagNames = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'style',
  'link',
  'meta',
  'base',
  'applet',
  'form',
  'svg',
  'noscript',
  'template',
  'img',
  'video',
  'audio',
  'source',
  'track',
  'input',
  'button',
  'textarea',
  'select',
  'marquee',
  'math',
  'a',
  'body',
  'frame',
  'frameset',
  'picture',
  'canvas',
  'dialog',
  'area',
  'map',
  'keygen',
  'isindex',
  'plaintext',
  'xmp',
]);
const detailsHtmlTagNames = new Set(['details', 'summary']);
const htmlTagStartCandidatePattern = /<(\/?)([a-z][a-z0-9:-]*)(?=[\s\u0000/>]|$)/gi;
const inlineEventAttrPattern = /(?:^|[\s/"'])on[a-z]+\s*=/i;
const referenceLinkDefPattern = /^(\s{0,3}\[[^\]\n]+\]:\s*)(?:<([^>\n]+)>|([^\s\n]+))/gm;
const unsafeProtocolPattern = /^(?:javascript:|vbscript:|data:(?:text\/html|image\/svg\+xml)(?:[;,]|$))/i;

/** 会话导出格式。 */
export type ConversationExportFormat = 'markdown' | 'json';

/** Markdown 导出可选项。 */
export interface ExportConversationMarkdownOptions {
  includeThinking?: boolean;
  includeCitations?: boolean;
}

/** JSON 导出可选项。 */
export interface ExportConversationJsonOptions {
  pretty?: boolean;
}

/** `exportConversation` 跨端导出入口参数。 */
export interface ExportConversationArgs {
  conversation: ChatConversation;
  format: ConversationExportFormat;
  includeThinking?: boolean;
  includeCitations?: boolean;
  pretty?: boolean;
}

/** `exportConversation` 跨端导出返回值。 */
export interface ExportConversationResult {
  filename: string;
  content: string;
  method: 'web-download' | 'native-share';
}

/**
 * 清洗导出文件名：
 * - 执行 NFKC 规范化并剔除控制字符/双向控制符；
 * - 剥离重复 `.md`/`.json` 尾缀与路径穿越 `..`；
 * - 替换系统非法字符、规避 Windows 保留文件名，并限制总长度不超过 120 字符。
 */
export function sanitizeExportFilename(title: string, extension: 'md' | 'json'): string {
  const normalizedExt: 'md' | 'json' = extension === 'json' ? 'json' : 'md';
  const raw = (title || '')
    .normalize('NFKC')
    .replace(controlAndBidiPattern, '')
    .trim();

  // 先剥除末尾已存在的 .md / .json（兼容重复后缀）
  const withoutExt = raw.replace(/(?:\.(?:md|json))+$/i, '');

  // 替换路径分隔符、连续点号与系统保留非法字符
  let stem = withoutExt
    .replace(/\.{2,}/g, '-')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '');

  if (!stem) {
    stem = 'conversation';
  }

  if (windowsReservedNamePattern.test(stem)) {
    stem = `_${stem}`;
  }

  const maxStemLength = Math.max(1, maxFilenameCharacters - (normalizedExt.length + 1));
  const truncatedStem =
    Array.from(stem)
      .slice(0, maxStemLength)
      .join('')
      .replace(/^[\s.-]+|[\s.-]+$/g, '') || 'conversation';

  const finalStem = windowsReservedNamePattern.test(truncatedStem)
    ? `_${truncatedStem}`.slice(0, maxStemLength)
    : truncatedStem;

  return `${finalStem}.${normalizedExt}`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#([0-9]+);?/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => {
      const decoded = namedHtmlEntitiesForProtocol[name.toLowerCase()];
      return decoded !== undefined ? decoded : match;
    });
}

function isUnsafeLinkDestination(rawDestination: string): boolean {
  const unwrapped = rawDestination.trim().replace(/^<+|>+$/g, '');
  const decoded = decodeHtmlEntities(unwrapped);
  const compact = decoded.replace(/[\u0000-\u0020\u007F-\u009F\s]+/g, '').toLowerCase();
  return unsafeProtocolPattern.test(compact);
}

/**
 * 拦截 Markdown 内联链接、图片、引用式链接定义以及 CommonMark Autolink 中的危险伪协议
 * （含尖括号包裹、空白/控制字符混淆、数字/命名 HTML 实体混淆及 SVG Data URI）。
 */
function sanitizeMarkdownLinks(text: string): string {
  let result = '';
  let cursor = 0;

  while (cursor < text.length) {
    const markerIndex = text.indexOf('](', cursor);
    if (markerIndex === -1) {
      result += text.slice(cursor);
      break;
    }

    const openParenIndex = markerIndex + 1;
    let scan = openParenIndex + 1;
    let depth = 1;
    let inSingleQuote = false;
    let inDoubleQuote = false;

    while (scan < text.length && depth > 0) {
      const ch = text[scan];
      if (ch === '\\' && scan + 1 < text.length) {
        scan += 2;
        continue;
      }
      if (!inSingleQuote && ch === '"') {
        inDoubleQuote = !inDoubleQuote;
      } else if (!inDoubleQuote && ch === "'") {
        inSingleQuote = !inSingleQuote;
      } else if (!inSingleQuote && !inDoubleQuote) {
        if (ch === '(') {
          depth += 1;
        } else if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }
      }
      scan += 1;
    }

    if (depth !== 0) {
      // 未闭合的括号同样检查其中是否包含危险协议，防止畸形载荷绕过
      const rawTail = text.slice(openParenIndex + 1);
      if (isUnsafeLinkDestination(rawTail)) {
        result += `${text.slice(cursor, openParenIndex + 1)}blocked:`;
        cursor = text.length;
        break;
      }
      result += text.slice(cursor, openParenIndex + 1);
      cursor = openParenIndex + 1;
      continue;
    }

    const rawInner = text.slice(openParenIndex + 1, scan);
    if (isUnsafeLinkDestination(rawInner)) {
      result += `${text.slice(cursor, openParenIndex + 1)}blocked:)`;
    } else {
      result += text.slice(cursor, scan + 1);
    }
    cursor = scan + 1;
  }

  const sanitizedRefs = result.replace(
    referenceLinkDefPattern,
    (fullMatch, prefix: string, bracketed?: string, bare?: string) => {
      const target = bracketed ?? bare ?? '';
      return isUnsafeLinkDestination(target) ? `${prefix}blocked:` : fullMatch;
    }
  );

  // 拦截 CommonMark Autolink（如 <javascript:alert(1)>、<vbscript:...>、<data:text/html,...>）
  return sanitizedRefs.replace(/<([^<>\r\n]+)>/g, (fullMatch, inner: string) => {
    return isUnsafeLinkDestination(inner) ? 'blocked:' : fullMatch;
  });
}

function scanOpeningTagTail(
  fullString: string,
  startOffset: number
): { tail: string; closed: boolean; truncated: boolean; hasUnclosedQuote: boolean } {
  const maxScanEnd = Math.min(fullString.length, startOffset + maxHtmlTagScanLength);
  let quote: '"' | "'" | null = null;
  for (let i = startOffset; i < maxScanEnd; i += 1) {
    const ch = fullString[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') {
      return {
        tail: fullString.slice(startOffset, i),
        closed: true,
        truncated: false,
        hasUnclosedQuote: false,
      };
    }
  }
  return {
    tail: fullString.slice(startOffset, maxScanEnd),
    closed: false,
    truncated: maxScanEnd < fullString.length,
    hasUnclosedQuote: quote !== null,
  };
}

/**
 * 转义危险 HTML 标签、带内联事件属性的 HTML 标签及伪协议链接，同时保留普通文本、数学公式及常规比较符号。
 */
function escapeDangerousHtml(
  text: string,
  options: { escapeDetails?: boolean } = {}
): string {
  const linkSanitized = sanitizeMarkdownLinks(text);
  return linkSanitized.replace(
    htmlTagStartCandidatePattern,
    (match, slash: string, tagName: string, offset: number, fullString: string) => {
      const lowerTag = tagName.toLowerCase();
      if (dangerousHtmlTagNames.has(lowerTag)) {
        return `&lt;${slash}${tagName}`;
      }
      if (options.escapeDetails && detailsHtmlTagNames.has(lowerTag)) {
        return `&lt;${slash}${tagName}`;
      }
      if (!slash) {
        const tagScan = scanOpeningTagTail(fullString, offset + match.length);
        // 超过安全扫描上限（fail-closed）、未闭合引号吞掉 '>' 或包含内联事件属性时一律保守转义
        if (
          tagScan.truncated ||
          (tagScan.hasUnclosedQuote && tagScan.tail.includes('>')) ||
          inlineEventAttrPattern.test(tagScan.tail)
        ) {
          return `&lt;${tagName}`;
        }
      }
      return match;
    }
  );
}

/**
 * 基于逐行状态机对顶层（非 3 反引号代码块内部）真正的 4+ 反引号围栏进行安全升阶（5+ 反引号），
 * 绝不误伤行内反引号、3 反引号代码块内部内容或 LaTeX 公式。
 */
function escalateMarkdownFences(rawText: string): string {
  const normalized = rawText.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  let activeFenceLength = 0;
  let maxTopLevelFourPlusRun = 0;
  const topLevelFourPlusMarks = new Map<
    number,
    { indent: string; tail: string; isClose: boolean }
  >();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = line.match(/^(\s{0,3})(`{3,})([^`]*)$/);
    if (!fenceMatch) {
      continue;
    }

    const [, indent, ticks, tail] = fenceMatch;
    const trimmedTail = tail.trim();

    if (activeFenceLength === 0) {
      if (ticks.length === 3) {
        activeFenceLength = 3;
      } else {
        activeFenceLength = ticks.length;
        maxTopLevelFourPlusRun = Math.max(maxTopLevelFourPlusRun, ticks.length);
        topLevelFourPlusMarks.set(i, { indent, tail, isClose: false });
      }
      continue;
    }

    // 处于已打开围栏内部时，仅在遇到匹配的闭合围栏行（>= 开围栏长度且无后缀信息）时退出围栏状态
    if (!trimmedTail && ticks.length >= activeFenceLength) {
      if (activeFenceLength >= 4) {
        maxTopLevelFourPlusRun = Math.max(maxTopLevelFourPlusRun, ticks.length);
        topLevelFourPlusMarks.set(i, { indent, tail: '', isClose: true });
      }
      activeFenceLength = 0;
    }
  }

  let processed = normalized;
  if (topLevelFourPlusMarks.size > 0) {
    const targetFence = '`'.repeat(Math.max(5, maxTopLevelFourPlusRun + 1));
    const rewritten = lines.map((line, index) => {
      const mark = topLevelFourPlusMarks.get(index);
      if (!mark) {
        return line;
      }
      return mark.isClose
        ? `${mark.indent}${targetFence}`
        : `${mark.indent}${targetFence}${mark.tail}`;
    });
    processed = rewritten.join('\n');
    if (activeFenceLength >= 4) {
      processed = `${processed}\n${targetFence}`;
    }
  }

  return escapeDangerousHtml(processed, { escapeDetails: true });
}

const exportSensitiveFieldPattern =
  /(x-amz-[a-z-]+|x-api-key|x-goog-api-key|authorization|password|secret|access[_-]?key|access[_-]?token|client[_-]?secret|session[_-]?token|security[_-]?token|api[_-]?key|refresh[_-]?token|private[_-]?key|token|signature|credential)\s*(?:\\*["'])?\s*[:=]\s*(?:((?:\\+)["'])[^\r\n]{0,2048}?\2|"[^"\r\n]*"|'[^'\r\n]*'|(?:bearer|basic|token)\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'\r\n\\,;&}\])\uFF0C\u3002\uFF1B\uFF01\uFF1F\uFF09\u3011]+)|[^\s"'\r\n\\,;&}\])\uFF0C\u3002\uFF1B\uFF01\uFF1F\uFF09\u3011]+)/giu;
const exportSensitiveBearerPattern =
  /\bBearer\s+(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s"'`,;)}\]\uFF0C\u3002\uFF1B\uFF01\uFF1F\uFF09\u3011]+)/giu;
const exportSensitiveQueryPattern =
  /([?&](?:api[_-]?key|x-api-key|access[_-]?token|client[_-]?secret|token|key|password|secret|signature|credential)=)[^&\s"'\uFF0C\u3002\uFF1B\uFF01\uFF1F\uFF09\u3011]*/giu;

function redactExportCredentials(text: string): string {
  return text
    .replace(exportSensitiveFieldPattern, '$1=[redacted]')
    .replace(exportSensitiveBearerPattern, 'Bearer [redacted]')
    .replace(exportSensitiveQueryPattern, '$1[redacted]');
}

function redactSensitiveError(errorText: string): string {
  return redactExportCredentials(errorText).replace(/\s+/gu, ' ').trim().slice(0, 500);
}

/**
 * 仅在错误消息直写场景对 message.content 执行凭据脱敏：
 * 当正文与 error 一致时直接走 redactSensitiveError；
 * 否则在保留换行与 Markdown 结构的前提下脱敏凭据键值、裸 Bearer 与查询参数，避免误改正常对话内容或吞噬后续正文。
 */
function sanitizeContentForExport(message: ChatMessage): string {
  if (message.status !== 'error') {
    return message.content;
  }
  if (message.error?.trim() && message.content.trim() === message.error.trim()) {
    return redactSensitiveError(message.content);
  }
  return redactExportCredentials(message.content);
}

function roleLabel(role: ChatMessage['role']): string {
  switch (role) {
    case 'system':
      return '系统';
    case 'user':
      return '用户';
    case 'assistant':
      return '助手';
    default:
      return role;
  }
}

function statusBadge(status: ChatMessage['status']): string {
  switch (status) {
    case 'error':
      return ' [错误]';
    case 'cancelled':
      return ' [已取消]';
    case 'pending':
      return ' [生成中]';
    default:
      return '';
  }
}

function attachmentKindLabel(kind: MediaAttachment['kind']): string {
  switch (kind) {
    case 'image':
      return '图片';
    case 'video':
      return '视频';
    case 'file':
      return '文件';
    default:
      return kind;
  }
}

function sanitizeCitationUrl(rawUrl: string): string {
  const safeHttpsUrl = resolveMessageMarkdownLink(rawUrl);
  if (!safeHttpsUrl) {
    return '#';
  }
  return safeHttpsUrl
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E');
}

function formatThinkingDurationSuffix(durationMs: number | undefined): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }
  return ` (${(durationMs / 1000).toFixed(1)}s)`;
}

/**
 * 将会话导出为结构清晰、经过 XSS 与敏感凭据安全清洗的 Markdown 文档。
 */
export function exportConversationToMarkdown(
  conversation: ChatConversation,
  options: ExportConversationMarkdownOptions = {}
): string {
  const includeThinking = options.includeThinking ?? true;
  const includeCitations = options.includeCitations ?? true;

  const rawTitle = (conversation.title || '').replace(/[\r\n]+/g, ' ').trim() || '未命名对话';
  const safeTitle = escapeDangerousHtml(rawTitle, { escapeDetails: true });
  const sections: string[] = [`# ${safeTitle}`];

  if (!conversation.messages.length) {
    sections.push('_暂无消息记录。_');
    return sections.join('\n\n');
  }

  for (const message of conversation.messages) {
    const modelMeta = [message.providerName, message.modelId]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => escapeDangerousHtml(item.trim(), { escapeDetails: true }))
      .join(' / ');
    const metaSuffix = modelMeta ? ` (${modelMeta})` : '';
    const header = `## ${roleLabel(message.role)}${metaSuffix}${statusBadge(message.status)}`;
    const blocks: string[] = [header];

    if (includeThinking && message.reasoningContent?.trim()) {
      const durationSuffix = formatThinkingDurationSuffix(message.thinkingDurationMs);
      const safeThinking = escalateMarkdownFences(message.reasoningContent.trim());
      blocks.push(
        `<details>\n<summary>深度思考${durationSuffix}</summary>\n\n${safeThinking}\n\n</details>`
      );
    }

    const safeContent = sanitizeContentForExport(message);
    if (safeContent?.trim()) {
      blocks.push(escalateMarkdownFences(safeContent));
    }

    if (message.error?.trim()) {
      const safeError = escapeDangerousHtml(redactSensitiveError(message.error), {
        escapeDetails: true,
      });
      blocks.push(`> **错误**：${safeError}`);
    }

    if (message.attachments?.length) {
      const attachmentLines = message.attachments.map((attachment) => {
        const safeName = escapeDangerousHtml(
          (attachment.name || attachment.id || '未命名附件').replace(/[\r\n]+/g, ' ').trim(),
          { escapeDetails: true }
        );
        return `- 附件：[${attachmentKindLabel(attachment.kind)}] ${safeName}`;
      });
      blocks.push(attachmentLines.join('\n'));
    }

    if (includeCitations && message.citations?.length) {
      const citationLines = message.citations.map((citation, idx) => {
        const order = citation.index ?? idx + 1;
        const safeCiteUrl = sanitizeCitationUrl(citation.url);
        const safeCiteTitle = escapeDangerousHtml(
          (citation.title || safeCiteUrl).replace(/[\r\n\[\]]+/g, ' ').trim(),
          { escapeDetails: true }
        );
        return `- [${order}] [${safeCiteTitle}](${safeCiteUrl})`;
      });
      blocks.push(`**参考来源**\n${citationLines.join('\n')}`);
    }

    sections.push(blocks.join('\n\n'));
  }

  return sections.join('\n\n');
}

function sanitizeUsageForJson(usage: ChatTokenUsage | undefined): ChatTokenUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const clean: ChatTokenUsage = {};
  if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) {
    clean.inputTokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) {
    clean.outputTokens = usage.outputTokens;
  }
  if (typeof usage.reasoningTokens === 'number' && Number.isFinite(usage.reasoningTokens)) {
    clean.reasoningTokens = usage.reasoningTokens;
  }
  if (typeof usage.cachedInputTokens === 'number' && Number.isFinite(usage.cachedInputTokens)) {
    clean.cachedInputTokens = usage.cachedInputTokens;
  }
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) {
    clean.totalTokens = usage.totalTokens;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function sanitizeAttachmentForJson(attachment: MediaAttachment) {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(typeof attachment.size === 'number' && Number.isFinite(attachment.size)
      ? { size: attachment.size }
      : {}),
    ...(typeof attachment.width === 'number' && Number.isFinite(attachment.width)
      ? { width: attachment.width }
      : {}),
    ...(typeof attachment.height === 'number' && Number.isFinite(attachment.height)
      ? { height: attachment.height }
      : {}),
    ...(typeof attachment.durationMs === 'number' && Number.isFinite(attachment.durationMs)
      ? { durationMs: attachment.durationMs }
      : {}),
  };
}

function sanitizeCitationForJson(citation: WebCitation): WebCitation {
  const safeUrl = resolveMessageMarkdownLink(citation.url) ?? '#';
  return {
    url: safeUrl,
    ...(citation.title ? { title: citation.title } : {}),
    ...(citation.text ? { text: citation.text } : {}),
    ...(citation.id ? { id: citation.id } : {}),
    ...(typeof citation.index === 'number' ? { index: citation.index } : {}),
    ...(typeof citation.startIndex === 'number' ? { startIndex: citation.startIndex } : {}),
    ...(typeof citation.endIndex === 'number' ? { endIndex: citation.endIndex } : {}),
  };
}

function sanitizeMessageForJson(message: ChatMessage) {
  const usage = sanitizeUsageForJson(message.usage);
  const attachments = message.attachments?.map(sanitizeAttachmentForJson);
  const citations = message.citations?.map(sanitizeCitationForJson);

  return {
    id: message.id,
    ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
    role: message.role,
    content: sanitizeContentForExport(message),
    createdAt: message.createdAt,
    status: message.status,
    ...(message.reasoningContent !== undefined
      ? { reasoningContent: message.reasoningContent }
      : {}),
    ...(typeof message.thinkingDurationMs === 'number' &&
    Number.isFinite(message.thinkingDurationMs) &&
    message.thinkingDurationMs >= 0
      ? { thinkingDurationMs: message.thinkingDurationMs }
      : {}),
    ...(message.modelId ? { modelId: message.modelId } : {}),
    ...(message.providerId ? { providerId: message.providerId } : {}),
    ...(message.providerName ? { providerName: message.providerName } : {}),
    ...(usage ? { usage } : {}),
    ...(message.requestMetrics ? { requestMetrics: { ...message.requestMetrics } } : {}),
    ...(message.costEstimate ? { costEstimate: { ...message.costEstimate } } : {}),
    ...(message.webSearchTriggered !== undefined
      ? { webSearchTriggered: message.webSearchTriggered }
      : {}),
    ...(citations?.length ? { citations } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(message.error ? { error: redactSensitiveError(message.error) } : {}),
  };
}

/**
 * 将会话导出为严格白名单过滤后的安全 JSON 字符串：
 * 彻底剥离 `apiKey`、`authorization`、`raw`、`providerContinuations` 加密续接块及附件 `base64`/`data:` 载荷。
 */
export function exportConversationToJson(
  conversation: ChatConversation,
  options: ExportConversationJsonOptions = {}
): string {
  const pretty = options.pretty ?? true;
  const payload = {
    schemaVersion: 1,
    id: conversation.id,
    title: conversation.title,
    ...(conversation.customTitle !== undefined ? { customTitle: conversation.customTitle } : {}),
    ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
    ...(conversation.parentConversationId
      ? { parentConversationId: conversation.parentConversationId }
      : {}),
    ...(conversation.branchPointMessageId
      ? { branchPointMessageId: conversation.branchPointMessageId }
      : {}),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    exportedAt: new Date().toISOString(),
    messages: conversation.messages.map(sanitizeMessageForJson),
  };

  return pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

/**
 * 跨端导出会话：
 * - Web 端生成 `Blob` 触发 `<a download>` 下载并在 1000ms 后释放 ObjectURL；
 * - Native 端写入 `Paths.cache` 临时文件并拉起系统分享面板，完成后自动清理缓存文件。
 */
export async function exportConversation(
  args: ExportConversationArgs
): Promise<ExportConversationResult> {
  const extension: 'md' | 'json' = args.format === 'json' ? 'json' : 'md';
  const mimeType = args.format === 'json' ? 'application/json' : 'text/markdown';
  const content =
    args.format === 'json'
      ? exportConversationToJson(args.conversation, { pretty: args.pretty })
      : exportConversationToMarkdown(args.conversation, {
          includeThinking: args.includeThinking,
          includeCitations: args.includeCitations,
        });
  const filename = sanitizeExportFilename(args.conversation.title, extension);

  const { Platform } = await import('react-native');

  if (Platform.OS === 'web') {
    if (typeof document === 'undefined' || !document.body) {
      throw new Error('当前浏览器无法创建会话导出下载。');
    }
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    try {
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      return {
        filename,
        content,
        method: 'web-download',
      };
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
  }

  const Sharing = await import('expo-sharing');
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('当前设备没有可用的保存或分享应用。');
  }

  const { File, Paths } = await import('expo-file-system');
  const file = new File(Paths.cache, filename);
  file.create({ overwrite: true, intermediates: true });
  try {
    file.write(content);
    await Sharing.shareAsync(file.uri, {
      dialogTitle: '导出 Embezzle Studio 对话记录',
      mimeType,
    });
    return {
      filename,
      content,
      method: 'native-share',
    };
  } finally {
    try {
      if (file.exists) {
        file.delete();
      }
    } catch {
      // 尽最大努力清理临时缓存文件
    }
  }
}
