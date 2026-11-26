export type ComposerKeyAction = 'submit' | 'newline' | 'select-slash-command' | 'ignore';

export interface ComposerKeyActionInput {
  platformOs: 'android' | 'ios' | 'web';
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  text: string;
  hasAttachments?: boolean;
  isStreaming?: boolean;
  disabled?: boolean;
  slashMenuOpen?: boolean;
}

/**
 * 解析消息输入框的键盘按键动作（用于 Web 端桌面快捷提交与中文 IME 防误触发）：
 * - 移动端（android/ios）始终返回 `'ignore'`，保持原生软键盘回车行为；
 * - 中文/日韩文输入法组词期（`isComposing`、`keyCode === 229` 或 `key === 'Process'`）一律返回 `'ignore'`；
 * - `Shift+Enter` 返回 `'newline'`；其他修饰键组合或无效空态返回 `'ignore'`；
 * - 斜杠菜单打开时按 `Enter` 返回 `'select-slash-command'`；否则非空/有附件时返回 `'submit'`。
 */
export function resolveComposerKeyAction(input: ComposerKeyActionInput): ComposerKeyAction {
  if (input.platformOs !== 'web') {
    return 'ignore';
  }

  // IME 组词期最高优先级放行，避免候选词确认回车误发送
  if (input.isComposing === true || input.keyCode === 229 || input.key === 'Process') {
    return 'ignore';
  }

  if (input.key !== 'Enter') {
    return 'ignore';
  }

  if (input.disabled === true) {
    return 'ignore';
  }

  if (input.shiftKey === true && !input.altKey && !input.ctrlKey && !input.metaKey) {
    return 'newline';
  }

  if (input.altKey === true || input.ctrlKey === true || input.metaKey === true) {
    return 'ignore';
  }

  if (input.slashMenuOpen === true) {
    return 'select-slash-command';
  }

  if (input.isStreaming === true) {
    return 'ignore';
  }

  if (!input.text.trim() && !input.hasAttachments) {
    return 'ignore';
  }

  return 'submit';
}
