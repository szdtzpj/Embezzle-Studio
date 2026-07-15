/** Public Projects + Conversations capability seam. */
export {
  ProjectsConversationsProvider,
  useProjectConversationNavigation,
  type ProjectsConversationsPorts,
} from './ProjectsConversationsProvider';
export { ProjectDrawer, type ProjectDrawerChatPort } from './ProjectDrawer';
export {
  applyProjectConversationChatEffects,
  type ProjectConversationChatEffects,
  type ProjectConversationResult,
} from './projectConversationResults';
export type { ProjectConversationCommand } from './projectConversationCommands';
