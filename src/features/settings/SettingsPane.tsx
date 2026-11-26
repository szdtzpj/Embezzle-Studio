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
 * 公共设置页面视图宿主：仅在打开期间挂载，关闭即卸载，
 * 避免后台流式输出期间仍维持不必要的设置页状态订阅。
 */
export function SettingsPane(): ReactElement | null {
  const { isOpen, close } = useSettingsLauncher();
  const settingsScreenRef = useSettingsScreenRef();

  if (!isOpen) {
    return null;
  }

  return (
    <MountedSettingsPane
      close={close}
      settingsScreenRef={settingsScreenRef}
    />
  );
}

function MountedSettingsPane(props: {
  close(): void;
  settingsScreenRef: React.RefObject<SettingsScreenHandle | null>;
}): ReactElement {
  const model = useSettingsScreenModel(props.close);

  return (
    <View
      style={styles.pane}
      pointerEvents="auto"
      accessibilityElementsHidden={false}
      importantForAccessibility="auto"
    >
      <SettingsScreen
        ref={props.settingsScreenRef as React.RefObject<SettingsScreenHandle>}
        {...model}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  pane: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20 },
});
