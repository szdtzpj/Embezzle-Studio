import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), 'utf8');
}

describe('expo-sharing Android hardening patch', () => {
  it('is applied through patch-package at install time', async () => {
    const [packageJson, patch] = await Promise.all([
      readSource('package.json').then((source) => JSON.parse(source)),
      readSource('patches/expo-sharing+57.0.3.patch'),
    ]);

    expect(packageJson.devDependencies['patch-package']).toBeTruthy();
    expect(packageJson.scripts.postinstall).toBe('patch-package');
    expect(patch).toContain('SimpleShareIntentDataParser.kt');
    expect(patch).toContain('ResolvingShareIntentDataParser.kt');
  });

  it('handles every text MIME family before falling back to streams', async () => {
    const patch = await readSource('patches/expo-sharing+57.0.3.patch');
    const additions = patch
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n');

    expect(additions).toContain('getCharSequenceExtra(Intent.EXTRA_TEXT)');
    expect(additions).toContain('getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)');
    expect(additions).not.toContain('getStringArrayListExtra(Intent.EXTRA_TEXT)');
    expect(additions).toContain('it.startsWith("text/", ignoreCase = true)');
    expect(additions).toContain('take(MAX_SHARE_ITEMS)');
  });

  it('merges captions with shared streams instead of dropping either payload type', async () => {
    const patch = await readSource('patches/expo-sharing+57.0.3.patch');
    const additions = patch
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n');

    expect(additions).toContain('val textPayloads = extractTextPayloads(intent, type)');
    expect(additions).toContain('val uriPayloads = if (textPayloads.size < MAX_SHARE_ITEMS)');
    expect(additions).toContain('return (textPayloads + uriPayloads).take(MAX_SHARE_ITEMS)');
    expect(additions).toContain('val remainingItemCount = MAX_SHARE_ITEMS - textPayloads.size');
    expect(additions).toContain('return textPayloads + uriPayloads');
    expect(additions).toContain('?: "text/plain"');
  });

  it('bounds copied bytes, uses actual size, and never returns a failed cache URI', async () => {
    const patch = await readSource('patches/expo-sharing+57.0.3.patch');
    const additions = patch
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n');

    expect(additions).toContain('MAX_IMAGE_BYTES = 10L * 1024 * 1024');
    expect(additions).toContain('MAX_VIDEO_BYTES = 100L * 1024 * 1024');
    expect(additions).toContain('MAX_OTHER_BYTES = 20L * 1024 * 1024');
    expect(additions).toContain('MAX_TOTAL_BYTES = 120L * 1024 * 1024');
    expect(additions).toContain('validateDeclaredSize(declaredSize, itemByteLimit, copyBatch.totalBytes)');
    expect(additions).toContain('val read = input.read(buffer)');
    expect(additions).toContain('contentSize = copiedBytes');
    expect(additions).toContain('file.delete()');
    expect(additions).toContain('throw FailedToResolveSharedDataException');
    expect(additions).toContain('UUID.randomUUID()');
    expect(additions).toContain('substringAfterLast(\'\\\\\')');
    expect(additions).not.toContain('e.printStackTrace()');
    expect(additions).not.toContain('contentSize = fileSize');
  });

  it('rolls back every copied file when a multi-item resolve fails', async () => {
    const patch = await readSource('patches/expo-sharing+57.0.3.patch');
    const additions = patch
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n');

    expect(additions).toContain('val copyBatch = CopyBatch()');
    expect(additions).toContain('copyBatch.rollback()');
    expect(additions).toContain('copyBatch.files += file');
    expect(additions).toContain('files.clear()');
  });

  it('treats URL captions as opaque text and clears the dedicated cache', async () => {
    const patch = await readSource('patches/expo-sharing+57.0.3.patch');
    const additions = patch
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n');

    expect(additions).toContain('fun clearCache(context: Context)');
    expect(additions).toContain('File(context.cacheDir, CACHE_DIRECTORY).deleteRecursively()');
    expect(additions).toContain('ResolvingShareIntentDataParser.clearCache(context)');
    expect(additions).toContain('Captions are intentionally treated as opaque user text');
    expect(additions).not.toContain('HttpURLConnection');
    expect(additions).not.toContain('openConnection()');
    expect(additions).not.toContain('requestMethod = "GET"');
  });
});
