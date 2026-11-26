import Svg, { Circle, Path, Rect } from 'react-native-svg';

/** Compact official-ish brand marks for search providers (list + toolbar). */

export function BraveMark({ size = 16 }: { size?: number }) {
  // Simplified Brave lion mark in brand orange.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 2.2c1.4 0 2.7.4 3.6 1.1.7.5 1.6.5 2.3.1l.8-.4c.7-.4 1.5.2 1.3 1l-.3 1.2c-.2.7.1 1.4.7 1.8 1 .7 1.6 1.9 1.6 3.2 0 1.3-.3 2.4-1 3.4-.4.6-.6 1.3-.5 2 .3 2.1-1 4-3 4.8-.7.3-1.2.9-1.4 1.6l-.5 1.8c-.2.7-1.1.9-1.6.4L12 21.3l-2 .9c-.5.2-1.1-.1-1.2-.6l-.5-1.8c-.2-.7-.7-1.3-1.4-1.6-2-.8-3.3-2.7-3-4.8.1-.7-.1-1.4-.5-2-.7-1-1-2.1-1-3.4 0-1.3.6-2.5 1.6-3.2.6-.4.9-1.1.7-1.8l-.3-1.2c-.2-.8.6-1.4 1.3-1l.8.4c.7.4 1.6.4 2.3-.1C9.3 2.6 10.6 2.2 12 2.2z"
        fill="#FB542B"
      />
      <Path
        d="M9.6 10.2c.5 0 .9.5.9 1.1 0 .6-.4 1.1-.9 1.1s-.9-.5-.9-1.1c0-.6.4-1.1.9-1.1zm4.8 0c.5 0 .9.5.9 1.1 0 .6-.4 1.1-.9 1.1s-.9-.5-.9-1.1c0-.6.4-1.1.9-1.1z"
        fill="#fff"
      />
      <Path
        d="M12 16.6c1.4 0 2.5-.5 2.8-1.1.1-.2 0-.4-.2-.4H9.4c-.2 0-.3.2-.2.4.3.6 1.4 1.1 2.8 1.1z"
        fill="#fff"
      />
    </Svg>
  );
}

export function FirecrawlMark({ size = 16 }: { size?: number }) {
  // Firecrawl flame-ish mark in brand orange-red.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12.2 2.4c.4 2.2-.2 3.7-1.5 5.1-1 1.1-1.5 2.2-1.4 3.5.1 1.4.8 2.5 1.9 3.3-.7-.1-1.3-.5-1.7-1.1-.6-1-.7-2.1-.2-3.3-2.1 1.4-3.3 3.5-3.3 6 0 3.5 2.8 6.4 6.3 6.4s6.3-2.9 6.3-6.4c0-3.7-2.1-5.9-4.4-8.2-1-1-1.7-2.2-2-5.3z"
        fill="#FF4D00"
      />
      <Path
        d="M12.1 13.2c.9 0 1.6.8 1.5 1.7-.1 1.3-1 2.3-2.1 2.8.9-.1 1.6-.6 2-1.3.5-.9.5-2 0-2.9-.3-.6-.9-1-1.6-1.1.1 0 .1 0 .2 0z"
        fill="#FFB199"
      />
    </Svg>
  );
}

export function DuckDuckGoMark({ size = 16 }: { size?: number }) {
  // Simplified DDG duck on orange disc.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="10" fill="#DE5833" />
      <Path
        d="M8.8 11.2c0-2.2 1.8-3.6 3.9-3.6 1.5 0 2.7.6 3.4 1.5.3-.6.9-1 1.6-1 .2 1.1-.3 2.1-1.3 2.6.2.6.3 1.2.3 1.9 0 2.7-1.9 4.7-4.5 4.7-1.4 0-2.5-.5-3.3-1.3-.3.7-.9 1.2-1.7 1.3-.2-1 .2-2 1.1-2.5-.3-.6-.5-1.3-.5-2.1 0-.5.1-1 .3-1.5z"
        fill="#fff"
      />
      <Circle cx="11.2" cy="11.1" r="0.85" fill="#1a1a1a" />
      <Path d="M14.8 12.4c.9.2 1.8.1 2.5-.4.1.7-.3 1.4-1 1.7-.8.4-1.7.2-2.3-.3.3-.3.6-.7.8-1z" fill="#FFCC33" />
    </Svg>
  );
}

/** Bocha 博查搜索品牌图标（蓝色圆角底标 + 白色几何波纹检索标识）。 */
export function BochaMark({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="2" y="2" width="20" height="20" rx="6" fill="#0EA5E9" />
      <Circle cx="11" cy="11" r="4.2" stroke="#fff" strokeWidth="2.1" />
      <Path
        d="M14.3 14.3L18 18"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <Circle cx="11" cy="11" r="1.4" fill="#BAE6FD" />
    </Svg>
  );
}

/** SearXNG 自托管元搜索品牌图标（品牌蓝环形放大镜）。 */
export function SearxngMark({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="10.5" cy="10.5" r="6.5" stroke="#3050FF" strokeWidth="2.8" />
      <Circle cx="10.5" cy="10.5" r="2.2" fill="#3050FF" />
      <Path
        d="M15.4 15.4L20.5 20.5"
        stroke="#3050FF"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Exa AI 兜底品牌图标（当精简测试 mock 未提供 Exa.Color 时降级使用）。 */
export function ExaMark({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="2" y="2" width="20" height="20" rx="5" fill="#1F40ED" />
      <Path
        d="M7.5 7.5H16.5V10H10.3V11H15.5V13.2H10.3V14.2H16.5V16.7H7.5V7.5Z"
        fill="#fff"
      />
    </Svg>
  );
}
