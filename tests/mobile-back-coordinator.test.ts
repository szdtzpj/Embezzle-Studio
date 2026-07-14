import { describe, expect, it, vi } from 'vitest';

import {
  coordinateMobileBack,
  type MobileBackActions,
  type MobileBackState,
} from '../src/ui/mobile/MobileBackCoordinator';

function state(overrides: Partial<MobileBackState> = {}): MobileBackState {
  return {
    contextInspectorOpen: false,
    workbenchOpen: false,
    costDecisionOpen: false,
    mcpDecisionOpen: false,
    moveDialogOpen: false,
    renameDialogOpen: false,
    deleteConversationDialogOpen: false,
    deleteProviderDialogOpen: false,
    modelPickerOpen: false,
    projectDrawerOpen: false,
    settingsOpen: false,
    chatTransientOpen: false,
    ...overrides,
  };
}

function actions(): MobileBackActions {
  return {
    closeContextInspector: vi.fn(),
    closeWorkbench: vi.fn(),
    cancelCostDecision: vi.fn(),
    cancelMcpDecision: vi.fn(),
    closeMoveDialog: vi.fn(),
    closeRenameDialog: vi.fn(),
    closeDeleteConversationDialog: vi.fn(),
    closeDeleteProviderDialog: vi.fn(),
    closeModelPicker: vi.fn(),
    closeProjectDrawer: vi.fn(),
    settingsBack: vi.fn(() => true),
    closeChatTransients: vi.fn(),
  };
}

describe('MobileBackCoordinator', () => {
  it('honors context, workbench, decisions, dialogs, drawer, settings, then chat order', () => {
    const handlers = actions();
    expect(coordinateMobileBack(state({
      contextInspectorOpen: true,
      workbenchOpen: true,
      settingsOpen: true,
    }), handlers)).toBe(true);
    expect(handlers.closeContextInspector).toHaveBeenCalledOnce();
    expect(handlers.closeWorkbench).not.toHaveBeenCalled();
    expect(handlers.settingsBack).not.toHaveBeenCalled();
  });

  it('lets the operating system handle back when nothing is open', () => {
    expect(coordinateMobileBack(state(), actions())).toBe(false);
  });
});
