import React from 'react';

import { appAdapters } from './src/app/adapters/appAdapters';
import { WorkspaceSessionProvider } from './src/app/workspace/WorkspaceSessionProvider';
import { GenerationTaskBackgroundProvider } from './src/features/background';
import { ChatProvider } from './src/features/chat';
import { ProjectsConversationsProvider } from './src/features/projects/ProjectsConversationsProvider';
import { IncomingShareProvider } from './src/features/share';
import { SettingsProductivityProvider } from './src/features/settings';
import { AppearanceProvider } from './src/ui/appearance/AppearanceProvider';
import { MobileApplication } from './src/ui/mobile/MobileApplication';

export default function App() {
  return (
    <AppearanceProvider>
      <WorkspaceSessionProvider adapters={appAdapters.workspace}>
        <GenerationTaskBackgroundProvider>
          <IncomingShareProvider>
            <ProjectsConversationsProvider ports={appAdapters.projects}>
              <ChatProvider adapters={appAdapters.chat}>
                <SettingsProductivityProvider>
                  <MobileApplication />
                </SettingsProductivityProvider>
              </ChatProvider>
            </ProjectsConversationsProvider>
          </IncomingShareProvider>
        </GenerationTaskBackgroundProvider>
      </WorkspaceSessionProvider>
    </AppearanceProvider>
  );
}
