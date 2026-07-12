import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  bindAppDialogHost,
  requestConfirm,
  requestNotice,
  type ConfirmDialogRequest,
  type DialogRequest,
  type NoticeDialogRequest,
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
});
