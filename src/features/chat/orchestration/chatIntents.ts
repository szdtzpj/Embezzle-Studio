export type ChatIntent =
  | { type: 'send' }
  | { type: 'retry'; messageId: string }
  | { type: 'regenerate'; messageId: string }
  | { type: 'edit-and-rerun'; messageId: string }
  | { type: 'comparison'; targetCount: number }
  | { type: 'refresh-generation-task'; messageId: string };
