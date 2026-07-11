import { describe, expect, it } from 'vitest';

import {
  MAX_WORKSPACE_ENTITY_ID_CHARACTERS,
  isColonCapableWorkspaceEntityId,
  isLegacyWorkspaceId,
  providerModelCurrencyIdentityKey,
  providerModelIdentityKey,
} from '../src/services/workspaceEntityIds';

describe('workspace entity ID policies', () => {
  it('keeps provider and project IDs colon-free while allowing colons in bounded entity IDs', () => {
    expect(isLegacyWorkspaceId('provider-valid_1.0')).toBe(true);
    expect(isLegacyWorkspaceId('provider:invalid')).toBe(false);
    expect(isLegacyWorkspaceId('p'.repeat(MAX_WORKSPACE_ENTITY_ID_CHARACTERS))).toBe(true);
    expect(isLegacyWorkspaceId('p'.repeat(MAX_WORKSPACE_ENTITY_ID_CHARACTERS + 1))).toBe(false);
    expect(isColonCapableWorkspaceEntityId('knowledge:valid')).toBe(true);
    expect(isColonCapableWorkspaceEntityId('x'.repeat(MAX_WORKSPACE_ENTITY_ID_CHARACTERS))).toBe(true);
    expect(isColonCapableWorkspaceEntityId('x'.repeat(MAX_WORKSPACE_ENTITY_ID_CHARACTERS + 1))).toBe(false);
  });

  it('uses collision-free provider/model tuple keys even when model IDs contain colons', () => {
    expect(providerModelIdentityKey('provider', 'model:variant')).not.toBe(
      providerModelIdentityKey('provider:model', 'variant')
    );
    expect(providerModelCurrencyIdentityKey('provider', 'model:USD', 'CNY')).not.toBe(
      providerModelCurrencyIdentityKey('provider', 'model', 'USD:CNY')
    );
  });
});
