import { describe, expect, it } from 'vitest';

import {
  MAX_PROMPT_TEMPLATES,
  createPromptTemplate,
  deletePromptTemplate,
  extractPromptTemplateVariables,
  renderPromptTemplate,
  setPromptTemplatePinned,
  sortPromptTemplates,
  updatePromptTemplate,
  type PromptTemplate,
} from '../src/services/promptTemplates';

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'template-1',
    name: '通用模板',
    content: '你好',
    mode: 'composer',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('prompt template mutations', () => {
  it('creates, updates, deletes, and sorts without mutating the source arrays', () => {
    const source = [template({ id: 'old', updatedAt: 3 })];
    const created = createPromptTemplate(source, { name: '  新模板  ', content: '  保留缩进  ' }, {
      id: 'new',
      now: 5,
    });

    expect(source).toHaveLength(1);
    expect(created.map((item) => item.id)).toEqual(['new', 'old']);
    expect(created[0]).toMatchObject({ name: '新模板', content: '  保留缩进  ', mode: 'composer', createdAt: 5, updatedAt: 5 });

    const updated = updatePromptTemplate(created, 'old', { name: '更新名', content: '更新内容', mode: 'system' }, 8);
    expect(updated[0]).toMatchObject({ id: 'old', name: '更新名', content: '更新内容', mode: 'system', createdAt: 1, updatedAt: 8 });
    expect(created.find((item) => item.id === 'old')?.name).toBe('通用模板');

    const deleted = deletePromptTemplate(updated, 'old');
    expect(deleted.map((item) => item.id)).toEqual(['new']);
    expect(updated).toHaveLength(2);
  });

  it('puts newest pins first and restores update ordering after unpinning', () => {
    const source = [
      template({ id: 'recent', name: 'Recent', updatedAt: 10 }),
      template({ id: 'older', name: 'Older', updatedAt: 2 }),
    ];
    const pinned = setPromptTemplatePinned(source, 'older', 20);
    expect(pinned.map((item) => item.id)).toEqual(['older', 'recent']);
    expect(source[1].pinnedAt).toBeUndefined();

    const unpinned = setPromptTemplatePinned(pinned, 'older', undefined);
    expect(unpinned.map((item) => item.id)).toEqual(['recent', 'older']);
  });

  it('enforces collection, name, and content limits using Unicode characters', () => {
    const full = Array.from({ length: MAX_PROMPT_TEMPLATES }, (_, index) =>
      template({ id: `template-${index}` })
    );
    expect(() => createPromptTemplate(full, { name: 'x', content: 'x' }, { id: 'overflow', now: 1 })).toThrow(/100/);
    expect(() => createPromptTemplate([], { name: '🧠'.repeat(61), content: 'x' }, { id: 'long-name', now: 1 })).toThrow(/60/);
    expect(() => createPromptTemplate([], { name: 'x', content: '文'.repeat(20_001) }, { id: 'long-content', now: 1 })).toThrow(/20000/);
    expect(() => createPromptTemplate([], { name: ' ', content: 'x' }, { id: 'empty-name', now: 1 })).toThrow(/名称/);
    expect(() => createPromptTemplate([], { name: 'x', content: '\n\t' }, { id: 'empty-content', now: 1 })).toThrow(/内容/);
    expect(() => createPromptTemplate([template()], { name: 'x', content: 'x' }, { id: 'template-1', now: 1 })).toThrow(/已存在/);
  });

  it('uses deterministic tie breakers when sorting', () => {
    const sorted = sortPromptTemplates([
      template({ id: 'b', name: 'Same', updatedAt: 1 }),
      template({ id: 'a', name: 'Same', updatedAt: 1 }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('prompt template variables', () => {
  it('extracts unique trimmed variables in first-appearance order', () => {
    expect(extractPromptTemplateVariables('你好 {{ name }}，主题 {{主题}}，再次 {{name}}，{{ }}')).toEqual(['name', '主题']);
  });

  it('performs literal substitution and keeps missing variables unchanged', () => {
    const values = Object.create(null) as Record<string, string>;
    values.name = '$& ${not-code}';
    const rendered = renderPromptTemplate('Hello {{ name }} / {{missing}}', values);
    expect(rendered).toBe('Hello $& ${not-code} / {{missing}}');
  });

  it('never evaluates variable contents as code', () => {
    let executed = false;
    const payload = '(() => { executed = true })()';
    expect(renderPromptTemplate('{{payload}}', { payload })).toBe(payload);
    expect(executed).toBe(false);
  });
});
