import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

type WorkflowPermissions = string | Record<string, string>;

interface WorkflowStep {
  env?: Record<string, unknown>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  environment?: string;
  env?: Record<string, unknown>;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  permissions?: WorkflowPermissions;
  steps?: WorkflowStep[];
}

interface WorkflowDefinition {
  jobs?: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
  permissions?: WorkflowPermissions;
}

const workflowPaths = [
  '.github/workflows/android-apk.yml',
  '.github/workflows/pages.yml',
  '.github/workflows/quality.yml',
];
const workflows = new Map<string, WorkflowDefinition>();

function parseWorkflow(source: string, filePath: string) {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`${filePath}: ${document.errors.map((error) => error.message).join('; ')}`);
  }
  return document.toJS() as WorkflowDefinition;
}

function androidWorkflow() {
  const workflow = workflows.get(workflowPaths[0]);
  if (!workflow) {
    throw new Error('Android release workflow was not loaded.');
  }
  return workflow;
}

function job(jobId: string) {
  const value = androidWorkflow().jobs?.[jobId];
  if (!value) {
    throw new Error(`Android release workflow does not contain job ${jobId}.`);
  }
  return value;
}

function step(jobId: string, stepName: string) {
  const value = job(jobId).steps?.find((candidate) => candidate.name === stepName);
  if (!value) {
    throw new Error(`Job ${jobId} does not contain step ${stepName}.`);
  }
  return value;
}

function runScript(jobId: string, stepName: string) {
  const run = step(jobId, stepName).run;
  if (!run) {
    throw new Error(`Step ${jobId}/${stepName} does not contain a run script.`);
  }
  return run;
}

function trimmedLines(value: string) {
  return value.trim().split(/\r?\n/).map((line) => line.trim());
}

function permissionContainsWrite(permissions: WorkflowPermissions | undefined) {
  if (typeof permissions === 'string') {
    return permissions.includes('write');
  }
  return Object.values(permissions ?? {}).some((value) => value.includes('write'));
}

beforeAll(async () => {
  await Promise.all(workflowPaths.map(async (filePath) => {
    const source = await readFile(path.resolve(filePath), 'utf8');
    workflows.set(filePath, parseWorkflow(source, filePath));
  }));
});

describe('Android production release workflow', () => {
  it('can be started only by an explicit workflow dispatch', () => {
    expect(Object.keys(androidWorkflow().on ?? {})).toEqual(['workflow_dispatch']);
  });

  it('isolates repository write access to draft preflight and publication', () => {
    const workflow = androidWorkflow();
    const writeJobs = Object.entries(workflow.jobs ?? {})
      .filter(([, value]) => permissionContainsWrite(value.permissions))
      .map(([jobId]) => jobId);

    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(writeJobs).toEqual(['release_contract', 'publish']);
    expect(job('release_contract').permissions).toEqual({ contents: 'write' });
    expect(job('publish').permissions).toEqual({ contents: 'write' });
    expect(job('build').permissions).toBeUndefined();
    expect(job('sign').permissions).toEqual({});
  });

  it('keeps the write-capable release preflight data-only and main-only', () => {
    const preflight = job('release_contract');
    const checkout = step('release_contract', 'Checkout release metadata');
    const ownerGate = runScript('release_contract', 'Require owner-triggered release');
    const contract = runScript('release_contract', 'Validate release tag and owner-authored draft');
    const preflightScripts = preflight.steps?.map(({ run }) => run ?? '').join('\n') ?? '';
    const contractLines = trimmedLines(contract);
    const mismatchIndex = contractLines.indexOf('if [[ "$tag_commit" != "$main_commit" ]]; then');

    expect(preflight.environment).toBe('android-release');
    expect(preflight.steps?.map(({ name }) => name)).toEqual([
      'Require owner-triggered release',
      'Checkout release metadata',
      'Validate release tag and owner-authored draft',
    ]);
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout.with).toMatchObject({
      'fetch-depth': 0,
      'persist-credentials': false,
    });
    expect(ownerGate).toContain('if [[ "$GITHUB_REF" != "refs/heads/main" ]]');
    expect(step('release_contract', 'Validate release tag and owner-authored draft').env).toEqual({
      GH_TOKEN: '${{ github.token }}',
    });
    expect(contract).toContain('gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY"');
    expect(preflightScripts).not.toMatch(/npm ci|npm run|expo prebuild|gradlew|secrets\./);
    expect(preflightScripts).not.toMatch(/\bgh\s+(?:api|release\s+(?:create|delete|edit|upload))\b/);
    expect(contract).not.toMatch(/remediation|merge-base|git diff --name-only|0062d16329989cdcbba1edad4ff8945176126feb/);
    expect(mismatchIndex).toBeGreaterThan(-1);
    expect(contractLines.slice(mismatchIndex, mismatchIndex + 4)).toEqual([
      'if [[ "$tag_commit" != "$main_commit" ]]; then',
      'echo "::error::Tag $RELEASE_TAG must point to the exact current origin/main commit ($main_commit)."',
      'exit 1',
      'fi',
    ]);
  });

  it('pins the read-only build to the validated tag commit', () => {
    const build = job('build');
    const checkout = step('build', 'Checkout repository');
    const validation = runScript('build', 'Verify validated release checkout');

    expect(build.needs).toBe('release_contract');
    expect(checkout.with).toMatchObject({
      ref: '${{ needs.release_contract.outputs.tag_commit }}',
      'fetch-depth': 1,
      'persist-credentials': false,
    });
    expect(build.outputs).toEqual({
      tag_commit: '${{ steps.validated_checkout.outputs.tag_commit }}',
      main_commit: '${{ steps.validated_checkout.outputs.main_commit }}',
    });
    expect(JSON.stringify(build)).not.toMatch(/GH_TOKEN|gh release view/);
    expect(validation).toContain('actual_head="$(git rev-parse HEAD)"');
    expect(validation).toContain('if [[ "$actual_head" != "$EXPECTED_TAG_COMMIT" ]]');
  });

  it('enforces the intentional Android permission contract for voice input', () => {
    const permissionCheck = runScript(
      'build',
      'Verify packaged identity, SDK levels, and permission contract'
    );

    expect(permissionCheck).toContain('android.permission.SYSTEM_ALERT_WINDOW');
    expect(permissionCheck).toContain('android.permission.CAMERA');
    expect(permissionCheck).toContain('android.permission.USE_BIOMETRIC');
    expect(permissionCheck).toContain('android.permission.USE_FINGERPRINT');
    expect(permissionCheck).toContain('android.permission.REQUEST_INSTALL_PACKAGES');
    expect(permissionCheck).toContain('if ! grep -Fq "android.permission.RECORD_AUDIO"');
    expect(permissionCheck).not.toMatch(
      /for forbidden_permission in[\s\S]*android\.permission\.RECORD_AUDIO[\s\S]*; do/
    );
  });

  it('keeps signing secret access separate from repository permissions', () => {
    const sign = job('sign');
    const ownerGate = runScript('sign', 'Require owner-controlled signing');
    const signing = runScript('sign', 'Sign and verify release APK');

    expect(sign.environment).toBe('android-release');
    expect(ownerGate).toContain('if [[ "$GITHUB_REF" != "refs/heads/main" ]]');
    expect(signing).toContain('Verified using v2 scheme (APK Signature Scheme v2): true');
    expect(signing).toContain('Verified using v3 scheme (APK Signature Scheme v3): true');
  });

  it('keeps the generated Android window and backup contract explicit', () => {
    const prebuild = runScript('build', 'Prebuild Android project');
    const manifest = runScript('build', 'Verify generated Android manifest contract');
    expect(prebuild).toContain('npx expo prebuild --platform android --clean --no-install');
    expect(prebuild).not.toContain('--non-interactive');
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
  });

  it('carries both validated refs through all three publication checks', () => {
    const publish = job('publish');
    const ownerGate = runScript('publish', 'Require owner-triggered publication');
    const draftCheck = runScript('publish', 'Validate empty owner-authored draft');
    const publication = runScript('publish', 'Verify assets and publish immutable Release');
    const publicationLines = trimmedLines(publication);
    const refCheckCalls = publicationLines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line === 'verify_remote_refs')
      .map(({ index }) => index);
    const releaseEditIndex = publicationLines.findIndex((line) => line.startsWith('gh release edit '));

    expect(publish.environment).toBe('android-release');
    expect(publish.needs).toEqual(['build', 'sign']);
    expect(JSON.stringify(publish)).not.toContain('secrets.');
    expect(publish.env).toMatchObject({
      EXPECTED_TAG_COMMIT: '${{ needs.build.outputs.tag_commit }}',
      EXPECTED_MAIN_COMMIT: '${{ needs.build.outputs.main_commit }}',
    });
    expect(ownerGate).toContain('if [[ "$GITHUB_REF" != "refs/heads/main" ]]');
    expect(draftCheck).toContain('if [[ "$remote_tag_commit" != "$EXPECTED_TAG_COMMIT" ||');
    expect(draftCheck).toContain('"$remote_main_commit" != "$EXPECTED_MAIN_COMMIT" ]]');
    expect(publication).toContain('if [[ "$remote_tag_commit" != "$EXPECTED_TAG_COMMIT" ||');
    expect(publication).toContain('"$remote_main_commit" != "$EXPECTED_MAIN_COMMIT" ]]');
    expect(refCheckCalls).toHaveLength(2);
    expect(refCheckCalls[0]).toBeLessThan(releaseEditIndex);
    expect(refCheckCalls[1]).toBeGreaterThan(releaseEditIndex);
    expect(publication).toContain('--draft=false');
    expect(publication).toContain('--latest');
    expect(publication).toContain('--verify-tag');
  });

  it('pins every GitHub-owned Action in every workflow to a full commit SHA', () => {
    for (const [filePath, workflow] of workflows) {
      const uses = Object.values(workflow.jobs ?? {}).flatMap((value) => (
        value.steps?.flatMap((candidate) => candidate.uses ?? []) ?? []
      ));

      expect(uses.length, filePath).toBeGreaterThan(0);
      for (const use of uses) {
        expect(use, `${filePath}: ${use}`).toMatch(/^actions\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
      }
    }
  });
});
