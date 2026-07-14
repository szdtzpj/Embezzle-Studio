export type WorkspacePhase = 'booting' | 'ready' | 'read-only' | 'replacing';

export interface WorkspaceStatus {
  phase: WorkspacePhase;
  revision: number;
  dirty: boolean;
  issue?: string;
  recoveryNotice?: string;
}
