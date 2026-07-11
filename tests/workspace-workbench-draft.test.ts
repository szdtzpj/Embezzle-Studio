import { describe, expect, it, vi } from 'vitest';

import { createKnowledgeAndClearDraft } from '../src/components/workspaceWorkbenchDraft';

describe('WorkspaceWorkbench knowledge draft persistence', () => {
  it('preserves both draft fields when the parent rejects the save', () => {
    let title = '超出预算但不能丢失的标题';
    let content = '超出聚合预算后仍需保留的正文';
    const clearTitle = vi.fn(() => { title = ''; });
    const clearContent = vi.fn(() => { content = ''; });

    const created = createKnowledgeAndClearDraft(
      () => false,
      title,
      content,
      clearTitle,
      clearContent
    );

    expect(created).toBe(false);
    expect(title).toBe('超出预算但不能丢失的标题');
    expect(content).toBe('超出聚合预算后仍需保留的正文');
    expect(clearTitle).not.toHaveBeenCalled();
    expect(clearContent).not.toHaveBeenCalled();
  });

  it('clears both draft fields only after a successful save', () => {
    let title = '可保存标题';
    let content = '可保存正文';
    const createKnowledge = vi.fn(() => true);

    const created = createKnowledgeAndClearDraft(
      createKnowledge,
      title,
      content,
      () => { title = ''; },
      () => { content = ''; }
    );

    expect(created).toBe(true);
    expect(createKnowledge).toHaveBeenCalledWith('可保存标题', '可保存正文');
    expect(title).toBe('');
    expect(content).toBe('');
  });
});
