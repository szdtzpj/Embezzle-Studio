import React, { type ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  SettingsScreen,
  type SettingsScreenHandle,
} from './internal/SettingsScreen';
import { useSettingsLauncher } from './useSettingsLauncher';
import { useSettingsScreenRef } from './SettingsProductivityProvider';
import { useSettingsScreenModel } from './internal/useSettingsScreenModel';

/**
 * Public Settings visual host: lazy-mounted once, then shown/hidden.
 * Owns pointer-events and accessibility suppression while closed.
 */
export function SettingsPane(): ReactElement | null {
  const { isOpen, hasMounted, close } = useSettingsLauncher();
  const settingsScreenRef = useSettingsScreenRef();

  if (!hasMounted) {
    return null;
  }

  return (
    <MountedSettingsPane
      close={close}
      isOpen={isOpen}
      settingsScreenRef={settingsScreenRef}
    />
  );
}

function MountedSettingsPane(props: {
  close(): void;
  isOpen: boolean;
  settingsScreenRef: React.RefObject<SettingsScreenHandle | null>;
}): ReactElement {
  const model = useSettingsScreenModel(props.close);

  const screen = (
    <SettingsScreen
      ref={props.settingsScreenRef as React.RefObject<SettingsScreenHandle>}
      {...model}
    />
  );

  return (
    <View
      style={[styles.pane, !props.isOpen && styles.hidden]}
      pointerEvents={props.isOpen ? 'auto' : 'none'}
      accessibilityElementsHidden={!props.isOpen}
      importantForAccessibility={props.isOpen ? 'auto' : 'no-hide-descendants'}
    >
      {screen}
    </View>
  );
}

const styles = StyleSheet.create({
  pane: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20 },
  hidden: { opacity: 0 },
});
