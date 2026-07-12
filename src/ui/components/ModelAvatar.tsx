import { StyleSheet, View } from 'react-native';
import { MessageSquare } from 'lucide-react-native';
import {
  Bailian,
  ChatGLM,
  Claude,
  DeepSeek,
  Doubao,
  Gemini,
  Kimi,
  Minimax,
  NewAPI,
  OpenAI,
  Qwen,
  Volcengine,
  Zhipu,
} from '@lobehub/icons-rn';
import { useKelivoTheme, type KelivoTheme } from '../theme';
import { modelIconKey } from '../utils/modelDisplay';

export interface ModelAvatarProps {
  modelId?: string;
  providerName?: string;
  size?: number;
  containerSize?: number;
}

export function ModelAvatar({ modelId, providerName, size = 18, containerSize = 24 }: ModelAvatarProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const iconKey = modelIconKey(modelId, providerName);

  return (
    <View
      style={[
        styles.container,
        {
          width: containerSize,
          height: containerSize,
          borderRadius: containerSize / 2,
        },
      ]}
    >
      {iconKey === 'claude' ? <Claude.Color size={size} /> : null}
      {iconKey === 'gemini' ? <Gemini.Color size={size} /> : null}
      {iconKey === 'qwen' ? <Qwen.Color size={size} /> : null}
      {iconKey === 'deepseek' ? <DeepSeek.Color size={size} /> : null}
      {iconKey === 'doubao' ? <Doubao.Color size={size} /> : null}
      {iconKey === 'chatglm' ? <ChatGLM.Color size={size} /> : null}
      {iconKey === 'zhipu' ? <Zhipu.Color size={size} /> : null}
      {iconKey === 'kimi' ? <Kimi.Color size={size} /> : null}
      {iconKey === 'minimax' ? <Minimax.Color size={size} /> : null}
      {iconKey === 'bailian' ? <Bailian.Color size={size} /> : null}
      {iconKey === 'volcengine' ? <Volcengine.Color size={size} /> : null}
      {iconKey === 'newapi' ? <NewAPI.Color size={size} /> : null}
      {iconKey === 'openai' ? <OpenAI size={size} color={theme.colors.text} /> : null}
      {iconKey === 'unknown' ? (
        <MessageSquare size={Math.max(14, size - 8)} color={theme.colors.textSecondary} strokeWidth={2} />
      ) : null}
    </View>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
    container: {
      backgroundColor: theme.colors.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}

const styleCache = new WeakMap<KelivoTheme, ReturnType<typeof createStyles>>();

function getStyles(theme: KelivoTheme) {
  let styles = styleCache.get(theme);
  if (!styles) {
    styles = createStyles(theme);
    styleCache.set(theme, styles);
  }
  return styles;
}
