export interface MobileBackState {
  contextInspectorOpen: boolean;
  workbenchOpen: boolean;
  costDecisionOpen: boolean;
  mcpDecisionOpen: boolean;
  moveDialogOpen: boolean;
  renameDialogOpen: boolean;
  deleteConversationDialogOpen: boolean;
  deleteProviderDialogOpen: boolean;
  modelPickerOpen: boolean;
  projectDrawerOpen: boolean;
  settingsOpen: boolean;
  chatTransientOpen: boolean;
}

export interface MobileBackActions {
  closeContextInspector(): void;
  closeWorkbench(): void;
  cancelCostDecision(): void;
  cancelMcpDecision(): void;
  closeMoveDialog(): void;
  closeRenameDialog(): void;
  closeDeleteConversationDialog(): void;
  closeDeleteProviderDialog(): void;
  closeModelPicker(): void;
  closeProjectDrawer(): void;
  settingsBack(): boolean;
  closeChatTransients(): void;
}

/** Explicit Android back precedence; deliberately not a priority registry. */
export function coordinateMobileBack(
  state: MobileBackState,
  actions: MobileBackActions
): boolean {
  if (state.contextInspectorOpen) {
    actions.closeContextInspector();
    return true;
  }
  if (state.workbenchOpen) {
    actions.closeWorkbench();
    return true;
  }
  if (state.costDecisionOpen) {
    actions.cancelCostDecision();
    return true;
  }
  if (state.mcpDecisionOpen) {
    actions.cancelMcpDecision();
    return true;
  }
  if (state.moveDialogOpen) {
    actions.closeMoveDialog();
    return true;
  }
  if (state.renameDialogOpen) {
    actions.closeRenameDialog();
    return true;
  }
  if (state.deleteConversationDialogOpen) {
    actions.closeDeleteConversationDialog();
    return true;
  }
  if (state.deleteProviderDialogOpen) {
    actions.closeDeleteProviderDialog();
    return true;
  }
  if (state.modelPickerOpen) {
    actions.closeModelPicker();
    return true;
  }
  if (state.projectDrawerOpen) {
    actions.closeProjectDrawer();
    return true;
  }
  if (state.settingsOpen) {
    return actions.settingsBack();
  }
  if (state.chatTransientOpen) {
    actions.closeChatTransients();
    return true;
  }
  return false;
}
