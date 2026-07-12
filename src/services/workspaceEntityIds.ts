export const MAX_WORKSPACE_ENTITY_ID_CHARACTERS = 256;

const legacyWorkspaceIdPattern = /^[A-Za-z0-9._-]+$/;
const colonCapableWorkspaceEntityIdPattern = /^[A-Za-z0-9._:-]+$/;

function matchesBoundedId(value: unknown, pattern: RegExp): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_WORKSPACE_ENTITY_ID_CHARACTERS &&
    pattern.test(value)
  );
}

/** Provider and project IDs retain their legacy no-colon policy. */
export function isLegacyWorkspaceId(value: unknown): value is string {
  return matchesBoundedId(value, legacyWorkspaceIdPattern);
}

/** Artifact, revision, knowledge, message, and conversation IDs may contain colons. */
export function isColonCapableWorkspaceEntityId(value: unknown): value is string {
  return matchesBoundedId(value, colonCapableWorkspaceEntityIdPattern);
}

/** Length-delimited JSON tuples cannot collide when model IDs themselves contain colons. */
export function providerModelIdentityKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}

export function providerModelCurrencyIdentityKey(
  providerId: string,
  modelId: string,
  currency: string
): string {
  return JSON.stringify([providerId, modelId, currency]);
}
