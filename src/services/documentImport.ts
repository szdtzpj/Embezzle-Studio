import { unzipSync } from 'fflate';
import { Parser } from 'htmlparser2';
import { Platform } from 'react-native';

import {
  getDocumentImportNativeModule,
  type NativeOcrScript,
} from './documentImportNative';

export const MAX_DOCUMENT_IMPORT_FILE_BYTES = 20_000_000;
export const MAX_DOCUMENT_IMPORT_HTML_BYTES = 5_000_000;
export const MAX_DOCUMENT_IMPORT_OUTPUT_CHARACTERS = 500_000;
export const MAX_DOCUMENT_IMPORT_SECTION_CHARACTERS = 8_000;
export const MAX_DOCUMENT_IMPORT_SECTIONS = 200;
export const MAX_DOCUMENT_IMPORT_ZIP_ENTRIES = 400;
export const MAX_DOCUMENT_IMPORT_ZIP_ENTRY_BYTES = 8_000_000;
export const MAX_DOCUMENT_IMPORT_ZIP_TOTAL_BYTES = 40_000_000;
export const MAX_DOCUMENT_IMPORT_ZIP_COMPRESSION_RATIO = 200;
export const MAX_DOCUMENT_IMPORT_XLSX_ROWS = 5_000;
export const MAX_DOCUMENT_IMPORT_XLSX_COLUMNS = 100;
export const MAX_DOCUMENT_IMPORT_XLSX_CELLS = 100_000;
export const MAX_DOCUMENT_IMPORT_PPTX_SLIDES = 200;
export const MAX_DOCUMENT_IMPORT_PDF_PAGES = 200;

const plainTextExtensions = new Set([
  '.bash', '.c', '.conf', '.cpp', '.cs', '.css', '.csv', '.fish', '.go', '.h', '.hpp',
  '.ini', '.java', '.js', '.json', '.jsonl', '.jsx', '.kt', '.kts', '.log', '.markdown',
  '.md', '.ndjson', '.php', '.properties', '.py', '.rb', '.rs', '.sh', '.sql', '.swift',
  '.tex', '.text', '.toml', '.ts', '.tsv', '.tsx', '.txt', '.xml', '.yaml', '.yml', '.zsh',
]);

const imageExtensions = new Set(['.bmp', '.gif', '.heic', '.jpeg', '.jpg', '.png', '.webp']);
const legacyOfficeExtensions = new Set(['.doc', '.xls', '.ppt', '.docm', '.xlsm', '.pptm']);

export type DocumentImportFormat =
  | 'text'
  | 'html'
  | 'webpage'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'pdf'
  | 'image';

export type KnowledgeImportSectionKind =
  | 'paragraph'
  | 'heading'
  | 'page'
  | 'sheet'
  | 'slide'
  | 'notes'
  | 'table'
  | 'ocr';

export type DocumentImportStatus =
  | 'ready'
  | 'needs-local-ocr'
  | 'needs-provider-ocr'
  | 'unsupported-platform'
  | 'failed';

export interface KnowledgeImportSection {
  id: string;
  kind: KnowledgeImportSectionKind;
  label: string;
  content: string;
  selected: boolean;
  characterCount: number;
  pageNumber?: number;
  slideNumber?: number;
  sheetName?: string;
}

/**
 * This object is transient UI state. It deliberately has no workspace or
 * credential fields and must not be serialized into backups or sync payloads.
 */
export interface KnowledgeImportDraft {
  id: string;
  title: string;
  fileName: string;
  mimeType?: string;
  format: DocumentImportFormat;
  source: 'local-file' | 'web-url' | 'shared-file';
  sourceUri?: string;
  sourceBytes?: number;
  status: DocumentImportStatus;
  sections: KnowledgeImportSection[];
  selectedSectionIds: string[];
  warnings: string[];
  createdAt: number;
  /** True only when the local native module can render pages for OCR. */
  localOcrAvailable: boolean;
  providerOcrReason?: string;
}

export interface KnowledgeImportSelection {
  sectionIds: readonly string[];
  /** Explicit provider OCR target; this service never invokes it itself. */
  ocr?: {
    mode: 'local' | 'provider';
    providerId?: string;
    modelId?: string;
  };
}

export interface SelectedKnowledgeImport {
  title: string;
  fileName: string;
  mimeType?: string;
  content: string;
  sizeBytes: number;
  sectionIds: string[];
  extraction: 'local-text' | 'local-ocr' | 'provider-ocr';
}

export interface DocumentImportInput {
  fileName: string;
  mimeType?: string;
  bytes?: Uint8Array | ArrayBuffer;
  uri?: string;
  source?: 'local-file' | 'web-url' | 'shared-file';
  now?: number;
}

export interface DocumentImportWebOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface PickedDocumentImportAsset {
  name: string;
  mimeType?: string;
  size?: number;
  uri: string;
  file?: Blob;
}

/**
 * Reads a picker-provided Blob without ever materializing more than the
 * document-import budget in the JavaScript heap. Some Android document
 * providers omit the size metadata, so the streamed byte count remains the
 * authoritative guard.
 */
async function readBlobBytesBounded(blob: Blob, limit: number): Promise<Uint8Array> {
  if (Number.isFinite(blob.size) && blob.size > limit) {
    throw new Error(`资料文件不能超过 ${limit.toLocaleString()} 字节。`);
  }
  const reader = typeof blob.stream === 'function' ? blob.stream().getReader() : undefined;
  if (!reader) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new Error(`资料文件不能超过 ${limit.toLocaleString()} 字节。`);
    }
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`资料文件不能超过 ${limit.toLocaleString()} 字节。`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface DocumentImportHandle {
  draft: KnowledgeImportDraft;
  cleanup: () => Promise<void>;
}

interface ParsedTextBlock {
  content: string;
  kind?: KnowledgeImportSectionKind;
  label?: string;
  pageNumber?: number;
  slideNumber?: number;
  sheetName?: string;
}

function extensionOf(fileName: string): string {
  const base = fileName.replaceAll('\\', '/').split('/').pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

function normalizedMimeType(mimeType: string | undefined): string | undefined {
  const value = mimeType?.trim().toLowerCase();
  return value || undefined;
}

function titleFromFilename(fileName: string): string {
  const base = fileName.replaceAll('\\', '/').split('/').pop() ?? fileName;
  const extension = extensionOf(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  return Array.from(stem.normalize('NFKC').trim() || '导入资料').slice(0, 120).join('');
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeText(value: string): string {
  return value
    .replace(/^\uFEFF/u, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+$/gu, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function boundedText(value: string, limit = MAX_DOCUMENT_IMPORT_OUTPUT_CHARACTERS): {
  text: string;
  truncated: boolean;
} {
  const normalized = normalizeText(value);
  const chars = Array.from(normalized);
  if (chars.length <= limit) return { text: normalized, truncated: false };
  return { text: chars.slice(0, limit).join('').trimEnd(), truncated: true };
}

function bytesFrom(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Read an untrusted response body while enforcing the byte limit during the read. */
async function readResponseTextBounded(response: Response, limit: number): Promise<string> {
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isSafeInteger(declaredLength) && declaredLength > limit) {
    throw new Error(`HTML response exceeds ${limit.toLocaleString()} bytes.`);
  }

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) {
      throw new Error(`HTML response exceeds ${limit.toLocaleString()} bytes.`);
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array
        ? next.value
        : new Uint8Array(next.value);
      total += chunk.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // Best effort: the bounded read is already being rejected.
        }
        throw new Error(`HTML response exceeds ${limit.toLocaleString()} bytes.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeUtf8(bytes);
}

function safeSourceSize(size: number | undefined): number | undefined {
  if (size === undefined) return undefined;
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('资料文件大小无效。');
  return size;
}

function sectionId(index: number, kind: KnowledgeImportSectionKind): string {
  return `import-${kind}-${index.toString(36)}`;
}

/** Keep PDF section IDs tied to the source page, not filtered preview indexes. */
function pdfSectionId(pageNumber: number, partIndex = 0): string {
  const page = Math.max(1, Math.trunc(pageNumber)).toString(36);
  return `import-page-${page}${partIndex > 0 ? `-${partIndex.toString(36)}` : ''}`;
}

function makeSections(blocks: readonly ParsedTextBlock[], warnings: string[] = []): KnowledgeImportSection[] {
  const sections: KnowledgeImportSection[] = [];
  let outputCharacters = 0;
  for (const [index, block] of blocks.entries()) {
    const normalized = normalizeText(block.content);
    if (!normalized) continue;
    const pieces = Array.from(normalized);
    for (let offset = 0; offset < pieces.length; offset += MAX_DOCUMENT_IMPORT_SECTION_CHARACTERS) {
      if (sections.length >= MAX_DOCUMENT_IMPORT_SECTIONS) {
        warnings.push(`资料分段超过 ${MAX_DOCUMENT_IMPORT_SECTIONS} 段，后续内容未进入预览。`);
        return sections;
      }
      const content = pieces.slice(offset, offset + MAX_DOCUMENT_IMPORT_SECTION_CHARACTERS).join('');
      outputCharacters += characterCount(content);
      if (outputCharacters > MAX_DOCUMENT_IMPORT_OUTPUT_CHARACTERS) {
        warnings.push(`资料正文超过 ${MAX_DOCUMENT_IMPORT_OUTPUT_CHARACTERS.toLocaleString()} 字符，后续内容未进入预览。`);
        return sections;
      }
      const suffix = pieces.length > MAX_DOCUMENT_IMPORT_SECTION_CHARACTERS
        ? `（${Math.floor(offset / MAX_DOCUMENT_IMPORT_SECTION_CHARACTERS) + 1}）`
        : '';
      sections.push({
        id: block.pageNumber !== undefined
          ? pdfSectionId(block.pageNumber, Math.floor(offset / MAX_DOCUMENT_IMPORT_SECTION_CHARACTERS))
          : sectionId(index + sections.length, block.kind ?? 'paragraph'),
        kind: block.kind ?? 'paragraph',
        label: `${block.label ?? `第 ${index + 1} 段`}${suffix}`,
        content,
        selected: true,
        characterCount: characterCount(content),
        ...(block.pageNumber !== undefined ? { pageNumber: block.pageNumber } : {}),
        ...(block.slideNumber !== undefined ? { slideNumber: block.slideNumber } : {}),
        ...(block.sheetName ? { sheetName: block.sheetName } : {}),
      });
    }
  }
  return sections;
}

function splitPlainText(text: string): ParsedTextBlock[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return normalized
    .split(/\n{2,}/u)
    .map((content, index) => ({ content, kind: 'paragraph' as const, label: `第 ${index + 1} 段` }));
}

function xmlDecode(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/gu, (_, decimal: string) => {
      const code = Number.parseInt(decimal, 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function assertSafeXml(xml: string, label: string): void {
  if (xml.includes('<!DOCTYPE') || xml.includes('<!ENTITY') || xml.includes('<!doctype') || xml.includes('<!entity')) {
    throw new Error(`${label} 包含不安全的 XML 实体声明，已拒绝解析。`);
  }
  if (xml.length > MAX_DOCUMENT_IMPORT_ZIP_ENTRY_BYTES) {
    throw new Error(`${label} 解压后超过安全上限。`);
  }
}

function xmlTextNodes(fragment: string, tag: string): string {
  const textRe = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'giu');
  return Array.from(fragment.matchAll(textRe))
    .map((match) => xmlDecode((match[1] ?? '').replace(/<[^>]+>/gu, '')))
    .join('');
}

function xmlParagraphs(xml: string, textTag: string, paragraphTag: string): string[] {
  assertSafeXml(xml, paragraphTag);
  const paragraphRe = new RegExp(`<${paragraphTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${paragraphTag}>`, 'giu');
  const text: string[] = [];
  for (const match of xml.matchAll(paragraphRe)) {
    const fragment = (match[1] ?? '')
      .replace(/<[^>]*?(?:tab)[^>]*\/>/giu, '\t')
      .replace(/<[^>]*?(?:br)[^>]*\/>/giu, '\n');
    const textRe = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>`, 'giu');
    const value = fragment
      .replace(textRe, (_, body: string) => xmlDecode(body))
      .replace(/<[^>]+>/gu, '');
    const normalized = normalizeText(value);
    if (normalized) text.push(normalized);
  }
  return text;
}

function parseDocx(entries: Map<string, Uint8Array>, warnings: string[]): ParsedTextBlock[] {
  const blocks: ParsedTextBlock[] = [];
  const ordered = [...entries.keys()]
    .filter((name) => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/iu.test(name))
    .sort((left, right) => left.localeCompare(right));
  for (const name of ordered) {
    const xml = decodeUtf8(entries.get(name)!);
    const paragraphs = xmlParagraphs(xml, 'w:t', 'w:p');
    paragraphs.forEach((content, index) => blocks.push({
      content,
      kind: /header|footer/iu.test(name) ? 'paragraph' : 'paragraph',
      label: `${name.includes('document') ? '正文' : '附加内容'} · 第 ${index + 1} 段`,
    }));
  }
  if (!blocks.length) warnings.push('DOCX 未发现可提取的文字段落。');
  return blocks;
}

function parsePptx(entries: Map<string, Uint8Array>, warnings: string[]): ParsedTextBlock[] {
  const slideNames = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/iu.test(name))
    .sort((left, right) => Number(left.match(/slide(\d+)/iu)?.[1] ?? 0) - Number(right.match(/slide(\d+)/iu)?.[1] ?? 0));
  if (slideNames.length > MAX_DOCUMENT_IMPORT_PPTX_SLIDES) {
    warnings.push(`演示文稿超过 ${MAX_DOCUMENT_IMPORT_PPTX_SLIDES} 页，后续页未进入预览。`);
  }
  const blocks: ParsedTextBlock[] = [];
  for (const [index, name] of slideNames.slice(0, MAX_DOCUMENT_IMPORT_PPTX_SLIDES).entries()) {
    const xml = decodeUtf8(entries.get(name)!);
    const paragraphs = xmlParagraphs(xml, 'a:t', 'a:p');
    const slideNumber = index + 1;
    if (!paragraphs.length) {
      blocks.push({ content: '', kind: 'slide', label: `第 ${slideNumber} 页`, slideNumber });
    }
    paragraphs.forEach((content, paragraphIndex) => blocks.push({
      content,
      kind: 'slide',
      label: `第 ${slideNumber} 页 · 第 ${paragraphIndex + 1} 段`,
      slideNumber,
    }));
  }
  const notes = [...entries.keys()].filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/iu.test(name));
  notes.sort((left, right) => left.localeCompare(right));
  notes.slice(0, MAX_DOCUMENT_IMPORT_PPTX_SLIDES).forEach((name, index) => {
    const xml = decodeUtf8(entries.get(name)!);
    xmlParagraphs(xml, 'a:t', 'a:p').forEach((content) => blocks.push({
      content,
      kind: 'notes',
      label: `第 ${index + 1} 页备注`,
      slideNumber: index + 1,
    }));
  });
  if (!slideNames.length) warnings.push('PPTX 未发现可提取的幻灯片。');
  return blocks;
}

function attributeValue(tag: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = tag.match(new RegExp(`\\b${escapedName}\\s*=\\s*["']([^"']*)["']`, 'iu'));
  return match?.[1];
}

function parseSharedStrings(xml: string): string[] {
  assertSafeXml(xml, 'XLSX sharedStrings.xml');
  const values: string[] = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/giu;
  for (const match of xml.matchAll(re)) {
    values.push(xmlDecode(xmlTextNodes(match[1] ?? '', 't')));
    if (values.length > MAX_DOCUMENT_IMPORT_XLSX_CELLS) break;
  }
  return values;
}

function parseXlsx(entries: Map<string, Uint8Array>, warnings: string[]): ParsedTextBlock[] {
  const shared = entries.has('xl/sharedStrings.xml')
    ? parseSharedStrings(decodeUtf8(entries.get('xl/sharedStrings.xml')!))
    : [];
  const workbook = entries.has('xl/workbook.xml') ? decodeUtf8(entries.get('xl/workbook.xml')!) : '';
  const rels = entries.has('xl/_rels/workbook.xml.rels') ? decodeUtf8(entries.get('xl/_rels/workbook.xml.rels')!) : '';
  assertSafeXml(workbook, 'XLSX workbook.xml');
  assertSafeXml(rels, 'XLSX workbook.xml.rels');
  const relationshipTargets = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b([^>]*)\/>/giu)) {
    const attrs = match[1] ?? '';
    const id = attributeValue(attrs, 'Id');
    const target = attributeValue(attrs, 'Target');
    if (id && target) relationshipTargets.set(id, `xl/${target.replace(/^\/+/, '')}`);
  }
  const sheets: Array<{ name: string; path: string }> = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/>/giu)) {
    const attrs = match[1] ?? '';
    const name = xmlDecode(attributeValue(attrs, 'name') ?? `工作表 ${sheets.length + 1}`);
    const relId = attributeValue(attrs, 'r:id') ?? attributeValue(attrs, 'id');
    const rawPath = relId ? relationshipTargets.get(relId) : undefined;
    const path = rawPath
      ? rawPath.split('/').reduce<string[]>((parts, segment) => {
          if (!segment || segment === '.') return parts;
          if (segment === '..') return parts.slice(0, -1);
          parts.push(segment);
          return parts;
        }, []).join('/')
      : undefined;
    if (path && entries.has(path)) sheets.push({ name, path });
  }
  if (!sheets.length) {
    for (const path of [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/iu.test(name)).sort()) {
      sheets.push({ name: `工作表 ${sheets.length + 1}`, path });
    }
  }
  const blocks: ParsedTextBlock[] = [];
  let cellCount = 0;
  for (const sheet of sheets) {
    if (blocks.length >= MAX_DOCUMENT_IMPORT_SECTIONS) break;
    const xml = decodeUtf8(entries.get(sheet.path)!);
    assertSafeXml(xml, `${sheet.name} XML`);
    const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/giu;
    let rowNumber = 0;
    for (const rowMatch of xml.matchAll(rowRe)) {
      rowNumber += 1;
      if (rowNumber > MAX_DOCUMENT_IMPORT_XLSX_ROWS) {
        warnings.push(`工作表「${sheet.name}」超过 ${MAX_DOCUMENT_IMPORT_XLSX_ROWS} 行，后续行未进入预览。`);
        break;
      }
      const cells: string[] = [];
      const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/giu;
      for (const cellMatch of (rowMatch[2] ?? '').matchAll(cellRe)) {
        cellCount += 1;
        if (cellCount > MAX_DOCUMENT_IMPORT_XLSX_CELLS) {
          warnings.push(`工作簿超过 ${MAX_DOCUMENT_IMPORT_XLSX_CELLS.toLocaleString()} 个单元格，后续单元格未进入预览。`);
          break;
        }
        const attrs = cellMatch[1] ?? '';
        const fragment = cellMatch[2] ?? '';
        const type = attributeValue(attrs, 't');
        const value = xmlDecode(xmlTextNodes(fragment, 'v'));
        const inline = xmlDecode(xmlTextNodes(fragment, 't'));
        const formula = xmlDecode(xmlTextNodes(fragment, 'f'));
        let rendered = type === 's' ? (shared[Number(value)] ?? value) : type === 'inlineStr' ? inline : value || inline;
        if (type === 'b') rendered = rendered === '1' ? 'TRUE' : 'FALSE';
        if (formula) rendered = rendered ? `${rendered}（公式：${formula}）` : `公式：${formula}`;
        cells.push(rendered);
        if (cells.length >= MAX_DOCUMENT_IMPORT_XLSX_COLUMNS) break;
      }
      const rowText = cells.join('\t').trim();
      if (rowText) blocks.push({ content: rowText, kind: 'sheet', label: `${sheet.name} · 第 ${rowNumber} 行`, sheetName: sheet.name });
      if (cellCount > MAX_DOCUMENT_IMPORT_XLSX_CELLS) break;
    }
  }
  if (!sheets.length) warnings.push('XLSX 未发现可读取的工作表。');
  return blocks;
}

function zipEntries(bytes: Uint8Array, allow: (name: string) => boolean): Map<string, Uint8Array> {
  if (bytes.byteLength > MAX_DOCUMENT_IMPORT_FILE_BYTES) {
    throw new Error(`文档文件不能超过 ${MAX_DOCUMENT_IMPORT_FILE_BYTES.toLocaleString()} 字节。`);
  }
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('文档不是有效的 OOXML 压缩包。');
  }
  let entryCount = 0;
  let totalOriginalBytes = 0;
  const files = unzipSync(bytes, {
    filter: (info) => {
      entryCount += 1;
      if (entryCount > MAX_DOCUMENT_IMPORT_ZIP_ENTRIES) {
        throw new Error(`文档压缩包条目超过 ${MAX_DOCUMENT_IMPORT_ZIP_ENTRIES} 个。`);
      }
      if (info.name.includes('\\') || info.name.startsWith('/') || info.name.split('/').includes('..')) {
        throw new Error('文档压缩包包含不安全的路径。');
      }
      if (info.originalSize > MAX_DOCUMENT_IMPORT_ZIP_ENTRY_BYTES) {
        throw new Error('文档压缩包单个条目解压后过大。');
      }
      totalOriginalBytes += info.originalSize;
      if (totalOriginalBytes > MAX_DOCUMENT_IMPORT_ZIP_TOTAL_BYTES) {
        throw new Error('文档压缩包解压总大小超过安全上限。');
      }
      if (info.size > 0 && info.originalSize / info.size > MAX_DOCUMENT_IMPORT_ZIP_COMPRESSION_RATIO) {
        throw new Error('文档压缩包压缩比异常，已拒绝可能的 ZIP 炸弹。');
      }
      return allow(info.name);
    },
  });
  return new Map(Object.entries(files));
}

function safeHtmlBlocks(html: string, warnings: string[]): ParsedTextBlock[] {
  if (new TextEncoder().encode(html).byteLength > MAX_DOCUMENT_IMPORT_HTML_BYTES) {
    throw new Error(`网页正文不能超过 ${MAX_DOCUMENT_IMPORT_HTML_BYTES.toLocaleString()} 字节。`);
  }
  const blocks: ParsedTextBlock[] = [];
  const ignored = new Set(['script', 'style', 'noscript', 'template', 'nav', 'footer', 'header', 'aside', 'form', 'svg', 'canvas']);
  const blockTags = new Set(['p', 'div', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'td', 'th', 'caption', 'tr']);
  let ignoredDepth = 0;
  let current: { tag: string; kind: KnowledgeImportSectionKind; text: string } | null = null;
  const finish = () => {
    if (!current) return;
    const text = normalizeText(current.text);
    if (text) blocks.push({ content: text, kind: current.kind, label: current.kind === 'heading' ? '网页标题' : undefined });
    current = null;
  };
  const parser = new Parser({
    onopentag(name) {
      if (ignored.has(name)) {
        ignoredDepth += 1;
        finish();
        return;
      }
      if (ignoredDepth) return;
      if (name === 'br') {
        if (current) current.text += '\n';
        return;
      }
      if (name === 'tr' && current?.tag !== 'tr') finish();
      if (blockTags.has(name)) {
        if (current && current.tag !== name && name !== 'td' && name !== 'th') finish();
        if (!current) {
          const heading = /^h[1-6]$/u.test(name);
          current = { tag: name, kind: heading ? 'heading' : name === 'tr' ? 'table' : 'paragraph', text: '' };
        } else if (name === 'td' || name === 'th') {
          current.text += current.text ? '\t' : '';
        }
      }
    },
    ontext(text) {
      if (!ignoredDepth && current) current.text += text;
    },
    onclosetag(name) {
      if (ignored.has(name)) {
        ignoredDepth = Math.max(0, ignoredDepth - 1);
        return;
      }
      if (ignoredDepth) return;
      if (current?.tag === name) finish();
    },
    onerror(error) {
      warnings.push(`网页 HTML 结构不完整：${error.message}`);
    },
  }, {
    decodeEntities: true,
    lowerCaseTags: true,
  });
  parser.write(html);
  parser.end();
  finish();
  return blocks;
}

function formatFor(input: DocumentImportInput): DocumentImportFormat {
  const extension = extensionOf(input.fileName);
  const mime = normalizedMimeType(input.mimeType);
  if (mime === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || extension === '.docx') return 'docx';
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || extension === '.xlsx') return 'xlsx';
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || extension === '.pptx') return 'pptx';
  if (mime?.startsWith('image/') || imageExtensions.has(extension)) return 'image';
  if (mime === 'text/html' || extension === '.html' || extension === '.htm') return 'html';
  if (legacyOfficeExtensions.has(extension)) throw new Error('暂不解析旧版二进制 Office 文件，请另存为 DOCX、XLSX 或 PPTX。');
  if (plainTextExtensions.has(extension) || mime?.startsWith('text/')) return 'text';
  throw new Error('无法确认这是受支持的资料格式。');
}

function draftFromBlocks(input: DocumentImportInput, format: DocumentImportFormat, blocks: ParsedTextBlock[], warnings: string[], status: DocumentImportStatus = 'ready'): KnowledgeImportDraft {
  const boundedWarnings = [...new Set(warnings)].slice(0, 20);
  const sections = makeSections(blocks, boundedWarnings);
  if (!sections.length && status === 'ready') status = 'failed';
  return {
    id: `knowledge-import-${Math.max(0, Math.trunc(input.now ?? Date.now())).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: titleFromFilename(input.fileName),
    fileName: input.fileName,
    ...(normalizedMimeType(input.mimeType) ? { mimeType: normalizedMimeType(input.mimeType) } : {}),
    format,
    source: input.source ?? 'local-file',
    ...(input.uri ? { sourceUri: input.uri } : {}),
    ...(input.bytes ? { sourceBytes: bytesFrom(input.bytes).byteLength } : {}),
    status,
    sections,
    selectedSectionIds: sections.filter((section) => section.selected).map((section) => section.id),
    warnings: boundedWarnings,
    createdAt: input.now ?? Date.now(),
    localOcrAvailable: Boolean(getDocumentImportNativeModule()?.recognizeImageText),
  };
}

async function parsePdf(input: DocumentImportInput, warnings: string[]): Promise<KnowledgeImportDraft> {
  const native = getDocumentImportNativeModule();
  if (input.uri && native?.extractPdfText) {
    const result = await native.extractPdfText(input.uri, {
      maxPages: MAX_DOCUMENT_IMPORT_PDF_PAGES,
      maxCharacters: MAX_DOCUMENT_IMPORT_OUTPUT_CHARACTERS,
    });
    warnings.push(...(result.warnings ?? []));
    if (result.pageCount > MAX_DOCUMENT_IMPORT_PDF_PAGES) {
      warnings.push(`PDF 超过 ${MAX_DOCUMENT_IMPORT_PDF_PAGES} 页，后续页面未进入预览。`);
    }
    const seenPageNumbers = new Set<number>();
    const pages = result.pages
      .slice(0, MAX_DOCUMENT_IMPORT_PDF_PAGES)
      .map((page, index) => ({
        ...page,
        pageNumber: Number.isInteger(page.pageNumber) && page.pageNumber > 0
          ? page.pageNumber
          : index + 1,
      }))
      .filter((page) => {
        if (seenPageNumbers.has(page.pageNumber)) return false;
        seenPageNumbers.add(page.pageNumber);
        return true;
      });
    const blocks = pages.map((page) => ({
      content: page.text,
      kind: 'page' as const,
      label: `第 ${page.pageNumber} 页`,
      pageNumber: page.pageNumber,
    }));
    const hasBlankPages = pages.some((page) => !normalizeText(page.text));
    const draft = draftFromBlocks(
      input,
      'pdf',
      blocks,
      warnings,
      result.hasTextLayer && !hasBlankPages ? 'ready' : 'needs-local-ocr'
    );
    if (!result.hasTextLayer && !draft.sections.length) {
      draft.sections = pages.map((page) => ({
        id: pdfSectionId(page.pageNumber),
        kind: 'page',
        label: `第 ${page.pageNumber} 页（待本机 OCR）`,
        content: '',
        selected: true,
        characterCount: 0,
        pageNumber: page.pageNumber,
      }));
      draft.selectedSectionIds = draft.sections.map((section) => section.id);
    }
    // Mixed PDFs can contain a text layer on some pages and scanned pages on
    // others. Preserve each blank page as an explicit OCR target instead of
    // silently dropping it from the import draft.
    if (hasBlankPages) {
      const existingPageNumbers = new Set(
        draft.sections
          .map((section) => section.pageNumber)
          .filter((pageNumber): pageNumber is number => pageNumber !== undefined),
      );
      for (const page of pages) {
        if (normalizeText(page.text) || existingPageNumbers.has(page.pageNumber) || draft.sections.length >= MAX_DOCUMENT_IMPORT_SECTIONS) continue;
        draft.sections.push({
          id: pdfSectionId(page.pageNumber),
          kind: 'page',
          label: `Page ${page.pageNumber} (awaiting local OCR)`,
          content: '',
          selected: true,
          characterCount: 0,
          pageNumber: page.pageNumber,
        });
        existingPageNumbers.add(page.pageNumber);
      }
      draft.selectedSectionIds = draft.sections.filter((section) => section.selected).map((section) => section.id);
    }
    draft.localOcrAvailable = Boolean(native.renderPdfPage && native.recognizeImageText);
    if (!result.hasTextLayer) draft.providerOcrReason = draft.localOcrAvailable
      ? 'PDF 没有可读取的文字层，可先逐页本机 OCR；若不支持，请显式选择已配置的视觉模型。'
      : 'PDF 没有可读取的文字层；需要显式选择已配置的视觉模型进行 OCR。';
    return draft;
  }
  // Web PDF parsing intentionally degrades until a Web Worker-backed PDF.js
  // build is wired. Never upload or invoke a provider implicitly here.
  warnings.push(Platform.OS === 'web'
    ? '浏览器端暂不内置 PDF 文字解析，请下载后在 Android 本机导入，或显式选择服务商 OCR。'
    : '当前安装包没有可用的原生 PDF 解析模块。');
  return draftFromBlocks(input, 'pdf', [], warnings, 'unsupported-platform');
}

export async function parseDocumentImport(input: DocumentImportInput): Promise<KnowledgeImportDraft> {
  const fileName = input.fileName.trim();
  if (!fileName) throw new Error('资料文件名不能为空。');
  const sourceBytes = safeSourceSize(input.bytes ? bytesFrom(input.bytes).byteLength : undefined);
  if (sourceBytes !== undefined && sourceBytes > MAX_DOCUMENT_IMPORT_FILE_BYTES) {
    throw new Error(`资料文件不能超过 ${MAX_DOCUMENT_IMPORT_FILE_BYTES.toLocaleString()} 字节。`);
  }
  const normalizedInput = { ...input, fileName, ...(sourceBytes !== undefined ? { bytes: input.bytes } : {}) };
  const format = formatFor(normalizedInput);
  const warnings: string[] = [];
  if (format === 'pdf') return parsePdf(normalizedInput, warnings);
  if (format === 'image') {
    const native = getDocumentImportNativeModule();
    if (input.uri && native?.recognizeImageText) {
      const result = await native.recognizeImageText(input.uri, 'Chinese');
      const draft = draftFromBlocks(normalizedInput, format, [{ content: result.text, kind: 'ocr', label: '本机 OCR' }], warnings);
      draft.localOcrAvailable = true;
      return draft;
    }
    const draft = draftFromBlocks(normalizedInput, format, [], ['当前平台没有本机 OCR；请显式选择已配置的服务商视觉模型。'], 'needs-provider-ocr');
    draft.providerOcrReason = '当前平台没有本机 OCR；请显式选择已配置的服务商视觉模型。';
    return draft;
  }
  if (!input.bytes) throw new Error('此格式需要读取文件内容，但没有可用的本地文件数据。');
  const bytes = bytesFrom(input.bytes);
  let blocks: ParsedTextBlock[];
  if (format === 'text') blocks = splitPlainText(decodeUtf8(bytes));
  else if (format === 'html') blocks = safeHtmlBlocks(decodeUtf8(bytes), warnings);
  else {
    const allow = format === 'docx'
      ? (name: string) => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/iu.test(name)
      : format === 'pptx'
        ? (name: string) => /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/iu.test(name)
        : (name: string) => /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/iu.test(name);
    const entries = zipEntries(bytes, allow);
    blocks = format === 'docx' ? parseDocx(entries, warnings) : format === 'pptx' ? parsePptx(entries, warnings) : parseXlsx(entries, warnings);
  }
  const draft = draftFromBlocks(normalizedInput, format, blocks, warnings);
  if (draft.warnings.length) draft.status = draft.sections.length ? 'ready' : 'failed';
  return draft;
}

function normalizePublicHttpsUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('网页地址不是有效网址。');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  const privateHost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host === '::1' || host === '::' || host.startsWith('127.') || host.startsWith('10.') ||
    host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./u.test(host) || host.startsWith('169.254.');
  if (url.protocol !== 'https:' || url.username || url.password || privateHost) {
    throw new Error('网页导入只允许不含凭据的公开 HTTPS 地址。');
  }
  return url.toString();
}

export async function parseWebPageImport(
  rawUrl: string,
  options: DocumentImportWebOptions = {}
): Promise<KnowledgeImportDraft> {
  const url = normalizePublicHttpsUrl(rawUrl);
  const fetcher = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs ?? 12_000));
  try {
    const response = await fetcher(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}。`);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error('网页响应不是 HTML，已拒绝作为网页资料导入。');
    }
    const text = await readResponseTextBounded(response, MAX_DOCUMENT_IMPORT_HTML_BYTES);
    const warnings: string[] = [];
    const draft = draftFromBlocks({
      fileName: titleFromFilename(new URL(url).hostname) || '网页资料',
      mimeType: contentType || 'text/html',
      source: 'web-url',
      now: Date.now(),
    }, 'webpage', safeHtmlBlocks(text, warnings), warnings);
    draft.title = new URL(url).hostname;
    draft.sourceUri = url;
    return draft;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('网页读取超时，请检查网络后重试。');
    if (error instanceof TypeError && Platform.OS === 'web') {
      throw new Error('浏览器阻止了跨域网页读取；请复制网页正文、使用允许 CORS 的地址，或在 Android 分享入口导入。');
    }
    throw error instanceof Error ? error : new Error('网页读取失败。');
  } finally {
    clearTimeout(timeout);
  }
}

export function selectKnowledgeImportSections(
  draft: KnowledgeImportDraft,
  selection: KnowledgeImportSelection
): SelectedKnowledgeImport {
  if (draft.status === 'needs-provider-ocr' || draft.status === 'unsupported-platform') {
    throw new Error('当前资料需要先完成显式 OCR 选择，不能直接保存。');
  }
  const requested = new Set(selection.sectionIds);
  const sections = draft.sections.filter((section) => requested.has(section.id));
  if (!sections.length) throw new Error('至少选择一段资料后才能保存。');
  if (sections.length > MAX_DOCUMENT_IMPORT_SECTIONS) throw new Error('选择的资料段落过多。');
  const content = normalizeText(sections.map((section) => `【${section.label}】\n${section.content}`).join('\n\n'));
  if (!content) throw new Error('所选资料没有可用文本。');
  const bounded = boundedText(content);
  if (bounded.truncated) throw new Error(`所选资料超过 ${MAX_DOCUMENT_IMPORT_OUTPUT_CHARACTERS.toLocaleString()} 字符，请减少勾选范围。`);
  const extraction = selection.ocr?.mode === 'provider'
    ? 'provider-ocr'
    : selection.ocr?.mode === 'local' || draft.format === 'image' || draft.status === 'needs-local-ocr'
      ? 'local-ocr'
      : 'local-text';
  return {
    title: draft.title,
    fileName: draft.fileName,
    ...(draft.mimeType ? { mimeType: draft.mimeType } : {}),
    content,
    sizeBytes: utf8Bytes(content),
    sectionIds: sections.map((section) => section.id),
    extraction,
  };
}

export function defaultKnowledgeImportSelection(draft: KnowledgeImportDraft): KnowledgeImportSelection {
  return { sectionIds: draft.selectedSectionIds.slice() };
}

export function markKnowledgeImportSection(
  draft: KnowledgeImportDraft,
  sectionId: string,
  selected: boolean
): KnowledgeImportDraft {
  const sections = draft.sections.map((section) => section.id === sectionId ? { ...section, selected } : section);
  return {
    ...draft,
    sections,
    selectedSectionIds: sections.filter((section) => section.selected).map((section) => section.id),
  };
}

/** Replaces a transient page/image placeholder after explicit OCR approval. */
export function setKnowledgeImportSectionContent(
  draft: KnowledgeImportDraft,
  sectionId: string,
  content: string,
  kind: KnowledgeImportSectionKind = 'ocr'
): KnowledgeImportDraft {
  const nextSections = draft.sections.map((section) => {
    if (section.id !== sectionId) return section;
    const normalized = normalizeText(content);
    return {
      ...section,
      kind,
      content: normalized,
      characterCount: characterCount(normalized),
    };
  });
  return {
    ...draft,
    status: nextSections.some((section) => section.content.trim()) ? 'ready' : draft.status,
    sections: nextSections,
    selectedSectionIds: nextSections.filter((section) => section.selected).map((section) => section.id),
  };
}

export async function pickDocumentImportAsset(): Promise<PickedDocumentImportAsset | null> {
  const DocumentPicker = await import('expo-document-picker');
  const result = await DocumentPicker.getDocumentAsync({
    type: [
      'text/*', 'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'image/*',
    ],
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  return {
    name: asset.name,
    ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
    ...(asset.size !== undefined ? { size: asset.size } : {}),
    uri: asset.uri,
    ...(asset.file ? { file: asset.file } : {}),
  };
}

async function cleanupPickedDocumentAsset(asset: PickedDocumentImportAsset): Promise<void> {
  if (Platform.OS === 'web' || !asset.uri) return;
  try {
    const { File } = await import('expo-file-system');
    const file = new File(asset.uri);
    if (file.exists) file.delete();
  } catch {
    // Picker cache cleanup is best effort and must not hide the parse error.
  }
}

export async function parsePickedDocumentImport(asset: PickedDocumentImportAsset): Promise<DocumentImportHandle> {
  try {
  const format = formatFor({ fileName: asset.name, mimeType: asset.mimeType });
  const shouldReadBytes = format !== 'pdf' && format !== 'image';
  if (asset.size !== undefined && (!Number.isFinite(asset.size) || asset.size < 0 || asset.size > MAX_DOCUMENT_IMPORT_FILE_BYTES)) {
    throw new Error(`资料文件不能超过 ${MAX_DOCUMENT_IMPORT_FILE_BYTES.toLocaleString()} 字节。`);
  }
  if (asset.file?.size !== undefined && asset.file.size > MAX_DOCUMENT_IMPORT_FILE_BYTES) {
    throw new Error(`资料文件不能超过 ${MAX_DOCUMENT_IMPORT_FILE_BYTES.toLocaleString()} 字节。`);
  }
  let bytes: Uint8Array | undefined;
  if (shouldReadBytes) {
    if (asset.file) bytes = await readBlobBytesBounded(asset.file, MAX_DOCUMENT_IMPORT_FILE_BYTES);
    else {
      const { File } = await import('expo-file-system');
      const file = new File(asset.uri);
      if (file.size > MAX_DOCUMENT_IMPORT_FILE_BYTES) {
        throw new Error(`资料文件不能超过 ${MAX_DOCUMENT_IMPORT_FILE_BYTES.toLocaleString()} 字节。`);
      }
      bytes = await readBlobBytesBounded(file, MAX_DOCUMENT_IMPORT_FILE_BYTES);
    }
  }
  const draft = await parseDocumentImport({
    fileName: asset.name,
    mimeType: asset.mimeType,
    uri: asset.uri,
    ...(bytes ? { bytes } : {}),
    source: 'local-file',
    ...(asset.size !== undefined ? { now: Date.now() } : {}),
  });
  return {
    draft,
    cleanup: () => cleanupPickedDocumentAsset(asset),
  };
  } catch (error) {
    await cleanupPickedDocumentAsset(asset);
    throw error;
  }
}

export async function renderPdfPageForLocalOcr(
  draft: KnowledgeImportDraft,
  pageNumber: number
): Promise<{ uri: string; width: number; height: number }> {
  if (draft.format !== 'pdf' || !draft.sourceUri) throw new Error('找不到可供本机 OCR 的 PDF。');
  const native = getDocumentImportNativeModule();
  if (!native?.renderPdfPage) throw new Error('当前平台没有本机 PDF 页面渲染能力。');
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_DOCUMENT_IMPORT_PDF_PAGES) {
    throw new Error('PDF 页码超出本机 OCR 安全范围。');
  }
  return native.renderPdfPage(draft.sourceUri, pageNumber, 144);
}

export async function recognizeImageForLocalOcr(
  uri: string,
  script: NativeOcrScript = 'Chinese'
): Promise<{ text: string; blocks?: unknown[] }> {
  const native = getDocumentImportNativeModule();
  if (!native?.recognizeImageText) throw new Error('当前平台没有本机 OCR；请显式选择已配置的服务商视觉模型。');
  return native.recognizeImageText(uri, script);
}
