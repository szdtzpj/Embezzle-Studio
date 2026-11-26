import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  bindAppDialogHost,
  getOverlayHostSnapshot,
  removeOverlayPortal,
  requestConfirm,
  requestNotice,
  showConfirmDialog,
  showModalSheet,
  subscribeOverlayHost,
  upsertOverlayPortal,
  type ConfirmDialogRequest,
  type DialogRequest,
  type NoticeDialogRequest,
  type OverlayHostSnapshot,
} from '../src/ui/components/dialogService';

afterEach(() => {
  bindAppDialogHost(null);
});

function requireConfirm(request: DialogRequest | null): ConfirmDialogRequest {
  expect(request?.kind).toBe('confirm');
  return request as ConfirmDialogRequest;
}

function requireNotice(request: DialogRequest | null): NoticeDialogRequest {
  expect(request?.kind).toBe('notice');
  return request as NoticeDialogRequest;
}

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const [red = 0, green = 0, blue = 0] = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

describe('dialog service safety', () => {
  it('presents requests in FIFO order without replacing the active promise', async () => {
    let current: DialogRequest | null = null;
    const history: Array<string | null> = [];
    bindAppDialogHost((request) => {
      current = request;
      history.push(request?.title ?? null);
    });

    const firstResult = requestConfirm({ title: 'first', description: 'first body' });
    const secondResult = requestNotice({ title: 'second', description: 'second body' });

    expect(history).toEqual(['first']);
    requireConfirm(current).resolve(true);
    await expect(firstResult).resolves.toBe(true);

    expect(history).toEqual(['first', null, 'second']);
    requireNotice(current).resolve();
    await expect(secondResult).resolves.toBeUndefined();
    expect(history).toEqual(['first', null, 'second', null]);
  });

  it('fails closed immediately when no host is mounted', async () => {
    bindAppDialogHost(null);

    await expect(requestConfirm({ title: 'confirm', description: 'body' })).resolves.toBe(false);
    await expect(requestNotice({ title: 'notice', description: 'body' })).resolves.toBeUndefined();
  });

  it('ignores a stale double settle without dismissing the next request', async () => {
    let current: DialogRequest | null = null;
    const history: Array<string | null> = [];
    bindAppDialogHost((request) => {
      current = request;
      history.push(request?.title ?? null);
    });

    const firstResult = requestConfirm({ title: 'first', description: 'body' });
    const secondResult = requestConfirm({ title: 'second', description: 'body' });
    const firstRequest = requireConfirm(current);

    firstRequest.resolve(true);
    const historyAfterFirstSettle = [...history];
    firstRequest.resolve(false);

    await expect(firstResult).resolves.toBe(true);
    expect(history).toEqual(historyAfterFirstSettle);
    expect(requireConfirm(current).title).toBe('second');

    requireConfirm(current).resolve(false);
    await expect(secondResult).resolves.toBe(false);
  });

  it('also ignores a notice double settle while advancing to the next confirmation', async () => {
    let current: DialogRequest | null = null;
    bindAppDialogHost((request) => {
      current = request;
    });

    const noticeResult = requestNotice({ title: 'notice', description: 'body' });
    const confirmResult = requestConfirm({ title: 'confirm', description: 'body' });
    const noticeRequest = requireNotice(current);

    noticeRequest.resolve();
    noticeRequest.resolve();

    await expect(noticeResult).resolves.toBeUndefined();
    expect(requireConfirm(current).title).toBe('confirm');
    requireConfirm(current).resolve(false);
    await expect(confirmResult).resolves.toBe(false);
  });

  it('settles the active and queued confirmations safely when the host unmounts', async () => {
    bindAppDialogHost(() => {});
    const firstResult = requestConfirm({ title: 'first', description: 'body' });
    const secondResult = requestConfirm({ title: 'second', description: 'body' });

    bindAppDialogHost(null);

    await expect(firstResult).resolves.toBe(false);
    await expect(secondResult).resolves.toBe(false);
  });

  it('supports showConfirmDialog with tone/subject and AbortSignal cancellation', async () => {
    let current: DialogRequest | null = null;
    bindAppDialogHost((request) => {
      current = request;
    });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      showConfirmDialog({
        title: 'pre-aborted',
        description: 'body',
        signal: preAborted.signal,
      })
    ).resolves.toBe(false);
    expect(current).toBeNull();

    const activeAbort = new AbortController();
    const first = showConfirmDialog({
      title: 'abortable confirm',
      description: 'body',
      subject: '目标项',
      tone: 'warning',
      signal: activeAbort.signal,
    });
    const second = requestNotice({ title: 'queued notice', description: 'body' });

    expect(requireConfirm(current).subject).toBe('目标项');
    expect(requireConfirm(current).tone).toBe('warning');

    activeAbort.abort();
    await expect(first).resolves.toBe(false);
    expect(requireNotice(current).title).toBe('queued notice');

    requireNotice(current).resolve();
    await expect(second).resolves.toBeUndefined();
  });

  it('queues modal sheets independently from alert/confirm dialogs without deadlocking', async () => {
    let currentDialog: DialogRequest | null = null;
    let currentOverlay: OverlayHostSnapshot = getOverlayHostSnapshot();
    const dismissedTitles: string[] = [];

    bindAppDialogHost((request) => {
      currentDialog = request;
    });
    const unsubscribe = subscribeOverlayHost((snapshot) => {
      currentOverlay = snapshot;
    });

    try {
      const sheet1 = showModalSheet<string>({
        title: 'sheet-1',
        onDismiss: () => dismissedTitles.push('sheet-1'),
        render: () => null,
      });
      const sheet2 = showModalSheet<string>({
        title: 'sheet-2',
        onDismiss: () => dismissedTitles.push('sheet-2'),
        render: () => null,
      });

      expect(currentOverlay.activeSheet?.title).toBe('sheet-1');

      // 模拟在全屏/Sheet 内部弹出二次确认（如 WorkspaceWorkbench 放弃修改确认），不得被同层 Sheet 阻塞死锁
      const nestedConfirm = showConfirmDialog({
        title: '放弃未保存修改？',
        description: '确认放弃',
        tone: 'warning',
      });
      expect(requireConfirm(currentDialog).title).toBe('放弃未保存修改？');
      expect(currentOverlay.activeSheet?.title).toBe('sheet-1');

      requireConfirm(currentDialog).resolve(true);
      await expect(nestedConfirm).resolves.toBe(true);
      expect(currentDialog).toBeNull();

      // 关闭第一个 sheet 后，第二个 sheet 才按 FIFO 激活
      currentOverlay.activeSheet?.resolve('saved');
      await expect(sheet1).resolves.toBe('saved');
      expect(currentOverlay.activeSheet?.title).toBe('sheet-2');

      // 宿主卸载时，剩余排队或激活的 sheet 也必须 fail-closed 结算并触发 onDismiss
      bindAppDialogHost(null);
      unsubscribe();
      await expect(sheet2).resolves.toBeUndefined();
      expect(dismissedTitles).toEqual(['sheet-2']);
    } finally {
      unsubscribe();
    }
  });

  it('fails closed for showModalSheet when no host is mounted or when aborted', async () => {
    bindAppDialogHost(null);
    await expect(
      showModalSheet({
        title: 'no-host',
        render: () => null,
      })
    ).resolves.toBeUndefined();

    bindAppDialogHost(() => {});
    const controller = new AbortController();
    const sheetPromise = showModalSheet({
      title: 'abort-sheet',
      signal: controller.signal,
      render: () => null,
    });
    controller.abort();
    await expect(sheetPromise).resolves.toBeUndefined();
  });

  it('fails closed when onDismiss synchronously re-enters showModalSheet or requestConfirm during bindAppDialogHost(null)', async () => {
    const events: string[] = [];
    let latestOverlay: OverlayHostSnapshot = getOverlayHostSnapshot();
    let reentrantSheetPromise: Promise<string | undefined> | null = null;
    let reentrantConfirmPromise: Promise<boolean> | null = null;

    bindAppDialogHost(() => {});
    const unsubscribe = subscribeOverlayHost((snapshot) => {
      latestOverlay = snapshot;
    });

    try {
      const initialSheet = showModalSheet<string>({
        title: 'initial-sheet',
        onDismiss: () => {
          events.push('initial-dismiss');
          // 即使 subscribeOverlayHost 尚未解除，bindAppDialogHost(null) 清算期间重入调用也必须立即 fail-closed
          reentrantSheetPromise = showModalSheet<string>({
            title: 'reentrant-sheet',
            onDismiss: () => events.push('reentrant-dismiss'),
            render: () => null,
          });
          reentrantConfirmPromise = requestConfirm({
            title: 'reentrant-confirm',
            description: 'body',
          });
        },
        render: () => null,
      });

      expect(latestOverlay.activeSheet?.title).toBe('initial-sheet');

      // 故意在 unsubscribe() 之前单独调用 bindAppDialogHost(null)
      bindAppDialogHost(null);

      await expect(initialSheet).resolves.toBeUndefined();
      expect(reentrantSheetPromise).not.toBeNull();
      expect(reentrantConfirmPromise).not.toBeNull();
      await expect(reentrantSheetPromise!).resolves.toBeUndefined();
      await expect(reentrantConfirmPromise!).resolves.toBe(false);

      expect(events).toEqual(['initial-dismiss', 'reentrant-dismiss']);
      expect(getOverlayHostSnapshot().activeSheet).toBeNull();
      expect(latestOverlay.activeSheet).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it('orders declarative OverlayPortal entries by layer priority and avoids no-op updates', () => {
    const snapshots: OverlayHostSnapshot[] = [];
    const unsubscribe = subscribeOverlayHost((snapshot) => {
      snapshots.push(snapshot);
    });

    try {
      const initialVersion = getOverlayHostSnapshot().version;
      removeOverlayPortal('non-existent-portal');
      expect(getOverlayHostSnapshot().version).toBe(initialVersion);

      upsertOverlayPortal({
        id: 'p-dialog',
        layer: 'dialog',
        render: () => 'dialog',
      });
      upsertOverlayPortal({
        id: 'p-sheet',
        layer: 'sheet',
        render: () => 'sheet',
      });
      upsertOverlayPortal({
        id: 'p-full',
        layer: 'fullscreen',
        render: () => 'fullscreen',
      });

      const ordered = getOverlayHostSnapshot().portals.map((entry) => entry.id);
      expect(ordered).toEqual(['p-sheet', 'p-full', 'p-dialog']);
      expect(snapshots.length).toBeGreaterThanOrEqual(4);
    } finally {
      removeOverlayPortal('p-dialog');
      removeOverlayPortal('p-sheet');
      removeOverlayPortal('p-full');
      unsubscribe();
    }

    expect(getOverlayHostSnapshot().portals).toHaveLength(0);
  });
});

describe('dialog visual safety contracts', () => {
  it('uses an accessible warning foreground in both themes', async () => {
    const themeSource = await readFile(new URL('../src/ui/theme.ts', import.meta.url), 'utf8');
    const warningColors = [...themeSource.matchAll(/\n\s+warning:\s*'(#[0-9a-f]{6})'/gi)]
      .map((match) => match[1]);
    const onWarningColors = [...themeSource.matchAll(/\n\s+onWarning:\s*'(#[0-9a-f]{6})'/gi)]
      .map((match) => match[1]);

    expect(warningColors).toHaveLength(2);
    expect(onWarningColors).toHaveLength(2);
    warningColors.forEach((warning, index) => {
      expect(contrastRatio(onWarningColors[index], warning)).toBeGreaterThanOrEqual(4.5);
    });
  });

  it('keeps long dialog content scrollable above a fixed keyboard-safe action area', async () => {
    const [confirmSource, noticeSource] = await Promise.all([
      readFile(new URL('../src/ui/components/ConfirmDialog.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/ui/components/NoticeDialog.tsx', import.meta.url), 'utf8'),
    ]);

    for (const source of [confirmSource, noticeSource]) {
      expect(source).toContain('<KeyboardAvoidingView');
      expect(source).toContain('<ScrollView');
      expect(source).toContain("maxHeight: '100%'");
      expect(source).toContain('? theme.colors.onWarning');
    }
    expect(confirmSource.indexOf('</ScrollView>')).toBeLessThan(
      confirmSource.indexOf('<View style={styles.actions}>')
    );
    expect(noticeSource.indexOf('</ScrollView>')).toBeLessThan(
      noticeSource.indexOf('<View style={styles.footer}>')
    );
  });

  it('routes all M2.2 overlays through unified OverlayPortal without raw <Modal> or Portal recursion', async () => {
    const overlayFiles = [
      '../src/ui/components/AppDialogHost.tsx',
      '../src/ui/components/ConfirmDialog.tsx',
      '../src/ui/components/NoticeDialog.tsx',
      '../src/ui/components/PromptDialog.tsx',
      '../src/ui/components/ActionSheetDialog.tsx',
      '../src/ui/components/settings/SettingsSelect.tsx',
      '../src/components/McpApprovalModal.tsx',
      '../src/components/ContextInspectorModal.tsx',
      '../src/components/KnowledgeImportPreview.tsx',
      '../src/components/WorkspaceWorkbench.tsx',
      '../src/features/settings/FirstRunSetupWizard.tsx',
      '../src/features/share/IncomingShareSheet.tsx',
      '../src/features/chat/internal/presentation/ChatModelPicker.tsx',
      '../src/features/chat/internal/presentation/ChatMessagePresentation.tsx',
      '../src/features/projects/ProjectDrawerShell.tsx',
    ];

    const contents = await Promise.all(
      overlayFiles.map((filePath) => readFile(new URL(filePath, import.meta.url), 'utf8'))
    );

    contents.forEach((source, index) => {
      expect(source, `${overlayFiles[index]} should not render raw <Modal>`).not.toMatch(/<Modal\b/);
    });

    const hostSource = contents[0];
    expect(hostSource).toContain('<ConfirmDialogContent');
    expect(hostSource).toContain('<NoticeDialogContent');
    expect(hostSource).not.toContain('<ConfirmDialog\n');
    expect(hostSource).not.toContain('<NoticeDialog\n');
  });
});
