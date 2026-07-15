import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MobileApplication composition', () => {
  it('owns native roots and global overlays instead of passing Chat through', async () => {
    const source = await readFile(
      path.resolve('src/ui/mobile/MobileApplication.tsx'),
      'utf8'
    );

    expect(source).toContain('<MobileShell style={styles.root}>');
    expect(source).toContain('<ChatPane settings={settings}');
    expect(source).toContain('<SettingsPane />');
    expect(source).toContain('<ProjectDrawer chat={projectChat} />');
    expect(source).toContain('<AppDialogHost />');
    expect(source).not.toContain('return <ChatPane />');
  });

  it('recovers the durable task outbox before routing a cold-start notification', async () => {
    const source = await readFile(
      path.resolve('src/ui/mobile/MobileApplication.tsx'),
      'utf8'
    );

    expect(source).toContain('await workspaceSessionRef.current.boot()');
    expect(source).toContain('await generationBackgroundRef.current.recoverNow()');
    expect(source).toContain('clearLastGenerationTaskNotificationResponse()');
    expect(source).toContain('handlingNotificationRef');
    expect(source.match(/clearLastGenerationTaskNotificationResponse\(\)/g)).toHaveLength(2);
    expect(source).toContain('if (handlingNotificationRef.current.has(key)) return false');
  });
});
