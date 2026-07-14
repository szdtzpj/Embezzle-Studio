import React, { type ReactNode } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

/** Owns the native gesture and safe-area roots shared by boot and ready views. */
export function MobileShell(props: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
}): React.ReactElement {
  return (
    <GestureHandlerRootView style={props.style}>
      <SafeAreaProvider>{props.children}</SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
