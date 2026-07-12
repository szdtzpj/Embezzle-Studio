import type { PromptTemplate } from '../domain/types';
import { unicodeCharacterLength } from './textBounds';

export type { PromptTemplate } from '../domain/types';

export const MAX_PROMPT_TEMPLATES = 100;
export const MAX_PROMPT_TEMPLATE_NAME_LENGTH = 60;
export const MAX_PROMPT_TEMPLATE_CONTENT_LENGTH = 20_000;

export interface PromptTemplateInput {
  name: string;
  content: string;
  mode?: PromptTemplate['mode'];
}

export interface PromptTemplateUpdate {
  name?: string;
  content?: string;
  mode?: PromptTemplate['mode'];
}

const templateVariablePattern = /\{\{\s*([^{}\r\n]+?)\s*\}\}/g;

function validatedName(value: string): string {
  const name = value.trim();
  if (!name) {
    throw new Error('模板名称不能为空。');
  }
  if (unicodeCharacterLength(name) > MAX_PROMPT_TEMPLATE_NAME_LENGTH) {
    throw new Error(`模板名称不能超过 ${MAX_PROMPT_TEMPLATE_NAME_LENGTH} 个字符。`);
  }
  return name;
}

function validatedContent(value: string): string {
  if (!value.trim()) {
    throw new Error('模板内容不能为空。');
  }
  if (unicodeCharacterLength(value) > MAX_PROMPT_TEMPLATE_CONTENT_LENGTH) {
    throw new Error(`模板内容不能超过 ${MAX_PROMPT_TEMPLATE_CONTENT_LENGTH} 个字符。`);
  }
  return value;
}

function requireTemplateIndex(templates: readonly PromptTemplate[], templateId: string): number {
  const index = templates.findIndex((template) => template.id === templateId);
  if (index < 0) {
    throw new Error('找不到要操作的提示词模板。');
  }
  return index;
}

/** Returns a new array with pinned templates first, then most recently edited. */
export function sortPromptTemplates(templates: readonly PromptTemplate[]): PromptTemplate[] {
  return [...templates].sort(
    (left, right) =>
      (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0) ||
      right.updatedAt - left.updatedAt ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id)
  );
}

/** Creates a template without reading the clock or generating an ID implicitly. */
export function createPromptTemplate(
  templates: readonly PromptTemplate[],
  input: PromptTemplateInput,
  metadata: { id: string; now: number }
): PromptTemplate[] {
  if (templates.length >= MAX_PROMPT_TEMPLATES) {
    throw new Error(`提示词模板最多保存 ${MAX_PROMPT_TEMPLATES} 条。`);
  }

  const id = metadata.id.trim();
  if (!id) {
    throw new Error('模板 ID 不能为空。');
  }
  if (templates.some((template) => template.id === id)) {
    throw new Error('模板 ID 已存在。');
  }

  const template: PromptTemplate = {
    id,
    name: validatedName(input.name),
    content: validatedContent(input.content),
    mode: input.mode ?? 'composer',
    createdAt: metadata.now,
    updatedAt: metadata.now,
  };
  return sortPromptTemplates([...templates, template]);
}

/** Updates only editable fields and preserves identity and creation time. */
export function updatePromptTemplate(
  templates: readonly PromptTemplate[],
  templateId: string,
  update: PromptTemplateUpdate,
  now: number
): PromptTemplate[] {
  const index = requireTemplateIndex(templates, templateId);
  const current = templates[index];
  const next: PromptTemplate = {
    ...current,
    ...(update.name !== undefined ? { name: validatedName(update.name) } : {}),
    ...(update.content !== undefined ? { content: validatedContent(update.content) } : {}),
    ...(update.mode !== undefined ? { mode: update.mode } : {}),
    updatedAt: now,
  };
  return sortPromptTemplates(templates.map((template, itemIndex) => (itemIndex === index ? next : template)));
}

export function deletePromptTemplate(
  templates: readonly PromptTemplate[],
  templateId: string
): PromptTemplate[] {
  requireTemplateIndex(templates, templateId);
  return templates.filter((template) => template.id !== templateId);
}

/** Pins at the supplied timestamp, or removes the pin when `pinnedAt` is undefined. */
export function setPromptTemplatePinned(
  templates: readonly PromptTemplate[],
  templateId: string,
  pinnedAt: number | undefined
): PromptTemplate[] {
  const index = requireTemplateIndex(templates, templateId);
  const current = templates[index];
  const next = { ...current };
  if (pinnedAt === undefined) {
    delete next.pinnedAt;
  } else {
    next.pinnedAt = pinnedAt;
  }
  return sortPromptTemplates(templates.map((template, itemIndex) => (itemIndex === index ? next : template)));
}

/** Extracts unique `{{variable}}` names in first-appearance order. */
export function extractPromptTemplateVariables(content: string): string[] {
  const variables: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(templateVariablePattern)) {
    const name = match[1].trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      variables.push(name);
    }
  }
  return variables;
}

/** Performs literal text substitution only; missing variables retain their original token. */
export function renderPromptTemplate(
  content: string,
  values: Readonly<Record<string, string>>
): string {
  return content.replace(templateVariablePattern, (token, capturedName: string) => {
    const name = capturedName.trim();
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : token;
  });
}
