import { useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AnimatePresence, MotiView } from 'moti';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ModelInfo, ProviderProfile } from '../../../../domain/types';
import { inferModelTask } from '../../../../services/modelCapabilities';
import { ModelAvatar } from '../../../../ui/components/ModelAvatar';
import { useChatModelPickerTheme } from './ChatModelPickerStyles';
import { AnimatedPressable } from './ChatMotion';
import {
  formatParameterValue,
  modelTaskLabel,
  normalizeParameterValue,
  parameterControls,
} from './chatModelControls';
function ParameterSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const { styles } = useChatModelPickerTheme();
  const trackWidth = useRef(0);
  const currentValue = useRef(value);
  currentValue.current = value;

  const setByLocation = (locationX: number) => {
    const width = trackWidth.current;
    if (!width) return;
    const ratio = Math.max(0, Math.min(1, locationX / width));
    const raw = min + ratio * (max - min);
    const next = normalizeParameterValue(raw, min, max, step);
    if (next !== currentValue.current) {
      onChange(next);
    }
  };

  // Only claim horizontal pans so the parameter menu ScrollView can still scroll
  // when the user drags vertically over a slider track.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_event, gestureState) =>
        Math.abs(gestureState.dx) > 4 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
      onPanResponderTerminationRequest: () => true,
      onShouldBlockNativeResponder: () => false,
      onPanResponderGrant: (event) => {
        setByLocation(event.nativeEvent.locationX);
      },
      onPanResponderMove: (event) => {
        setByLocation(event.nativeEvent.locationX);
      },
    })
  ).current;

  const thumbPosition = ((value - min) / (max - min)) * 100;
  const adjust = (direction: 1 | -1) => {
    onChange(normalizeParameterValue(value + direction * step, min, max, step));
  };

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: formatParameterValue(value) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'increment') adjust(1);
        if (event.nativeEvent.actionName === 'decrement') adjust(-1);
      }}
      style={styles.parameterSliderTrackArea}
      onLayout={(event) => {
        trackWidth.current = event.nativeEvent.layout.width;
      }}
      {...panResponder.panHandlers}
    >
      <View style={styles.parameterSliderTrack} />
      <View
        style={[
          styles.parameterSliderFill,
          { width: `${Math.max(0, Math.min(100, thumbPosition))}%` as any },
        ]}
      />
      <View
        style={[
          styles.parameterSliderThumb,
          { left: `${Math.max(0, Math.min(100, thumbPosition))}%` as any },
        ]}
      />
    </View>
  );
}


export function ParameterControl({
  control,
  value,
  onChange,
}: {
  control: (typeof parameterControls)[number];
  value: number;
  onChange: (value: number) => void;
}) {
  const { styles } = useChatModelPickerTheme();
  const [draft, setDraft] = useState(formatParameterValue(value));

  useEffect(() => {
    setDraft(formatParameterValue(value));
  }, [value]);

  return (
    <View style={styles.parameterControl}>
      <View style={styles.parameterControlHeader}>
        <View style={styles.parameterControlTitleBlock}>
          <Text style={styles.parameterControlLabel}>{control.label}</Text>
          <Text style={styles.parameterControlHint}>{control.description}</Text>
        </View>
        <TextInput
          accessibilityLabel={`${control.label}数值`}
          value={draft}
          onChangeText={(text) => {
            setDraft(text);
            const parsed = Number.parseFloat(text.replace(',', '.'));
            if (Number.isFinite(parsed)) {
              onChange(parsed);
            }
          }}
          onBlur={() => setDraft(formatParameterValue(value))}
          keyboardType="default"
          returnKeyType="done"
          onSubmitEditing={Keyboard.dismiss}
          selectTextOnFocus
          style={styles.parameterValueInput}
        />
      </View>
      <ParameterSlider
        label={control.label}
        value={value}
        min={control.min}
        max={control.max}
        step={control.step}
        onChange={onChange}
      />
      <View style={styles.parameterRangeRow}>
        <Text style={styles.parameterRangeText}>{formatParameterValue(control.min)}</Text>
        <Text style={styles.parameterRangeText}>{formatParameterValue(control.max)}</Text>
      </View>
    </View>
  );
}


interface ModelPickerModalProps {
  visible: boolean;
  groups: Array<{
    provider: ProviderProfile;
    models: ModelInfo[];
  }>;
  activeProviderId: string;
  activeModelId: string;
  onClose: () => void;
  onSelect: (providerId: string, modelId: string) => void;
  onOpenProviders: () => void;
  onOpenModels: () => void;
}


export function ModelPickerModal({
  visible,
  groups,
  activeProviderId,
  activeModelId,
  onClose,
  onSelect,
  onOpenProviders,
  onOpenModels,
}: ModelPickerModalProps) {
  const { styles } = useChatModelPickerTheme();
  const [mounted, setMounted] = useState(visible);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (unmountTimer.current) {
      clearTimeout(unmountTimer.current);
      unmountTimer.current = null;
    }

    if (visible) {
      setMounted(true);
      return undefined;
    }

    unmountTimer.current = setTimeout(() => {
      setMounted(false);
      unmountTimer.current = null;
    }, 240);

    return () => {
      if (unmountTimer.current) {
        clearTimeout(unmountTimer.current);
        unmountTimer.current = null;
      }
    };
  }, [visible]);

  if (!mounted) {
    return null;
  }

  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.modelPickerModalRoot}>
        <AnimatePresence>
          {visible ? (
            <MotiView
              key="model-picker-backdrop"
              from={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: 'timing', duration: 180 }}
              style={styles.modelPickerBackdrop}
            >
              <Pressable accessibilityRole="button" accessibilityLabel="关闭模型选择" onPress={onClose} style={styles.modelPickerBackdropPressable} />
            </MotiView>
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {visible ? (
            <MotiView
              key="model-picker-sheet"
              testID="model-picker-sheet"
              from={{ opacity: 0, translateY: 48, scale: 0.98 }}
              animate={{ opacity: 1, translateY: 0, scale: 1 }}
              exit={{ opacity: 0, translateY: 48, scale: 0.98 }}
              transition={{ type: 'timing', duration: 220 }}
              style={[styles.modelPickerSheet, { paddingBottom: insets.bottom }]}
            >
              <View style={styles.modelPickerHandle} />
              <View style={styles.modelPickerSheetHeader}>
                <View style={styles.modelPickerTitleBlock}>
                  <Text style={styles.modelPickerTitle}>选择模型</Text>
                  <Text style={styles.modelPickerSubtitle}>已添加模型</Text>
                </View>
                <AnimatedPressable accessibilityRole="button" accessibilityLabel="关闭模型选择" onPress={onClose} style={styles.modelPickerCloseButton}>
                  <Text style={styles.modelPickerCloseText}>×</Text>
                </AnimatedPressable>
              </View>

              <ScrollView style={styles.modelPickerScroll} contentContainerStyle={styles.modelPickerList}>
                {groups.length ? (
                  groups.map((group) => (
                    <View key={group.provider.id} style={styles.modelPickerGroup}>
                      <View style={styles.modelPickerGroupHeader}>
                        <Text numberOfLines={1} style={styles.modelPickerGroupName}>
                          {group.provider.name}
                        </Text>
                        <Text style={styles.modelPickerGroupCount}>{group.models.length}</Text>
                      </View>
                      {group.models.map((model) => {
                        const selected = group.provider.id === activeProviderId && model.id === activeModelId;

                        return (
                          <AnimatedPressable
                            key={`${group.provider.id}:${model.id}`}
                            accessibilityRole="button"
                            onPress={() => onSelect(group.provider.id, model.id)}
                            haptic="selection"
                            style={[
                              styles.modelPickerRow,
                              selected && styles.modelPickerRowActive,
                            ]}
                          >
                            <ModelAvatar
                              modelId={model.id}
                              providerName={group.provider.name}
                              size={17}
                              containerSize={26}
                            />
                            <View style={styles.modelPickerRowTextBlock}>
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.modelPickerRowName,
                                  selected && styles.modelPickerRowNameActive,
                                ]}
                              >
                                {model.name ?? model.id}
                              </Text>
                              <Text numberOfLines={1} style={styles.modelPickerRowMeta}>
                                {model.id}
                              </Text>
                            </View>
                            <ModelTaskBadge model={model} />
                            {selected ? <Text style={styles.modelPickerSelectedText}>当前</Text> : null}
                          </AnimatedPressable>
                        );
                      })}
                    </View>
                  ))
                ) : (
                  <View style={styles.modelPickerEmpty}>
                    <Text style={styles.modelPickerEmptyText}>暂无已添加模型</Text>
                    <Text style={styles.modelPickerEmptyDescription}>
                      先配置自己的服务商，再从模型目录添加需要的模型。
                    </Text>
                    <View style={styles.modelPickerEmptyActions}>
                      <AnimatedPressable
                        accessibilityRole="button"
                        accessibilityLabel="前往配置供应商"
                        testID="model-picker-open-providers"
                        onPress={onOpenProviders}
                        style={styles.modelPickerEmptyPrimaryButton}
                      >
                        <Text style={styles.modelPickerEmptyPrimaryText}>配置供应商</Text>
                      </AnimatedPressable>
                      <AnimatedPressable
                        accessibilityRole="button"
                        accessibilityLabel="前往模型配置"
                        testID="model-picker-open-models"
                        onPress={onOpenModels}
                        style={styles.modelPickerEmptySecondaryButton}
                      >
                        <Text style={styles.modelPickerEmptySecondaryText}>模型配置</Text>
                      </AnimatedPressable>
                    </View>
                  </View>
                )}
              </ScrollView>
            </MotiView>
          ) : null}
        </AnimatePresence>
      </View>
    </Modal>
  );
}


function ModelTaskBadge({ model }: { model: ModelInfo }) {
  const { styles } = useChatModelPickerTheme();
  const task = inferModelTask(model);

  return (
    <View style={styles.modelTaskBadge}>
      <Text style={styles.modelTaskBadgeText}>{modelTaskLabel[task]}</Text>
    </View>
  );
}
