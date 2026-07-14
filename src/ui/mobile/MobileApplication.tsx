import React from 'react';
import { StyleSheet } from 'react-native';

import { useChatProjectNavigation } from '../../features/chat';
import { ChatPane } from '../../features/chat/ChatPane';
import { ProjectDrawer } from '../../features/projects/ProjectDrawer';
import { SettingsPane, useSettingsLauncher } from '../../features/settings';
import { AppDialogHost } from '../components/AppDialogHost';
import { MobileShell } from './MobileShell';

/** Owns application-level native roots and global overlays around semantic feature views. */
export function MobileApplication(): React.ReactElement {
  const settings = useSettingsLauncher();
  const projectChat = useChatProjectNavigation();
  return (
    <MobileShell style={styles.root}>
      <ChatPane settings={settings} />
      <SettingsPane />
      <ProjectDrawer chat={projectChat} />
      <AppDialogHost />
    </MobileShell>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
