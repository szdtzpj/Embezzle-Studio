export type CreateKnowledgeDraft = (
  title: string,
  content: string
) => boolean | Promise<boolean>;

/**
 * Clears the local editor only after the parent confirms that persistence
 * succeeded. A rejected validation or aggregate-budget save keeps both fields
 * intact so the user can correct or recover the draft.
 */
export function createKnowledgeAndClearDraft(
  createKnowledge: CreateKnowledgeDraft,
  title: string,
  content: string,
  clearTitle: () => void,
  clearContent: () => void
): boolean | Promise<boolean> {
  const created = createKnowledge(title, content);
  if (created instanceof Promise) {
    return created.then((saved) => {
      if (!saved) return false;
      clearTitle();
      clearContent();
      return true;
    });
  }
  if (!created) return false;
  clearTitle();
  clearContent();
  return true;
}
