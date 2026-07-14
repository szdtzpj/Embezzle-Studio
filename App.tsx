import React from 'react';

import { appAdapters } from './src/app/adapters/appAdapters';
import { WorkspaceSessionProvider } from './src/app/workspace/WorkspaceSessionProvider';
import { ChatProvider } from './src/features/chat';
import { ProjectsConversationsProvider } from './src/features/projects/ProjectsConversationsProvider';
import { SettingsProductivityProvider } from './src/features/settings';
import { AppearanceProvider } from './src/ui/appearance/AppearanceProvider';
import { MobileApplication } from './src/ui/mobile/MobileApplication';

export default function App() {
  return (
    <AppearanceProvider>
      <WorkspaceSessionProvider adapters={appAdapters.workspace}>
        <ProjectsConversationsProvider ports={appAdapters.projects}>
          <ChatProvider adapters={appAdapters.chat}>
            <SettingsProductivityProvider>
              <MobileApplication />
            </SettingsProductivityProvider>
          </ChatProvider>
        </ProjectsConversationsProvider>
      </WorkspaceSessionProvider>
    </AppearanceProvider>
  );
}
