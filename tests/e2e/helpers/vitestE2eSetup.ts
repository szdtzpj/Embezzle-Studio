import { afterEach, vi } from 'vitest';

/**
 * E2E Node 测试环境下的 React Native 最小平台桩状态。
 * 避免 Vite/Rolldown 在 Node 环境加载 `node_modules/react-native/index.js`（含 Flow 语法）失败。
 */
const platformState: {
  OS: 'android' | 'ios' | 'web';
  select: <T>(specifics: Partial<Record<'android' | 'ios' | 'web' | 'default', T>>) => T | undefined;
} = {
  OS: 'android',
  select(specifics) {
    return specifics[platformState.OS] ?? specifics.default;
  },
};

vi.mock('react-native', () => ({
  Platform: platformState,
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
    flatten: <T>(style: T): T => style,
  },
  Dimensions: {
    get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
    addEventListener: () => ({ remove: () => undefined }),
  },
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => undefined }),
  },
  Keyboard: {
    addListener: () => ({ remove: () => undefined }),
    dismiss: () => undefined,
  },
  Linking: {
    openURL: async () => undefined,
    canOpenURL: async () => true,
  },
}));

/**
 * 在单个测试用例中临时切换 `Platform.OS`（afterEach 会自动复位为 `'android'`）。
 */
export function setE2EPlatformOs(os: 'android' | 'ios' | 'web'): void {
  platformState.OS = os;
}

/**
 * Node E2E 运行时缺少浏览器原生 `FileReader` 时提供的最小 polyfill。
 * 绝不覆盖已有实现，仅在 `typeof globalThis.FileReader === 'undefined'` 时注册。
 */
if (typeof globalThis.FileReader === 'undefined') {
  type FileReaderListener = (event: { target: E2EFileReaderPolyfill }) => void;

  class E2EFileReaderPolyfill {
    static readonly EMPTY = 0;
    static readonly LOADING = 1;
    static readonly DONE = 2;

    readonly EMPTY = 0;
    readonly LOADING = 1;
    readonly DONE = 2;

    readyState = 0;
    result: string | ArrayBuffer | null = null;
    error: Error | null = null;
    onload: FileReaderListener | null = null;
    onerror: FileReaderListener | null = null;
    onloadend: FileReaderListener | null = null;

    private readonly listeners = new Map<string, Set<FileReaderListener>>();

    addEventListener(type: string, listener: FileReaderListener): void {
      if (typeof listener !== 'function') return;
      let bucket = this.listeners.get(type);
      if (!bucket) {
        bucket = new Set();
        this.listeners.set(type, bucket);
      }
      bucket.add(listener);
    }

    removeEventListener(type: string, listener: FileReaderListener): void {
      this.listeners.get(type)?.delete(listener);
    }

    private emit(type: 'load' | 'error' | 'loadend'): void {
      const event = { target: this };
      if (type === 'load') {
        this.onload?.(event);
      } else if (type === 'error') {
        this.onerror?.(event);
      } else {
        this.onloadend?.(event);
      }
      const bucket = this.listeners.get(type);
      if (bucket) {
        for (const listener of Array.from(bucket)) {
          listener(event);
        }
      }
    }

    readAsDataURL(blob: Blob): void {
      this.readyState = E2EFileReaderPolyfill.LOADING;
      this.error = null;
      this.result = null;

      Promise.resolve()
        .then(() => {
          if (!blob || typeof blob.arrayBuffer !== 'function') {
            throw new TypeError('Parameter is not of type Blob.');
          }
          return blob.arrayBuffer();
        })
        .then(
          (buffer) => {
            // 剥离 `;charset=...` 等参数，防止 `data:<mime>;base64,...` 解析异常
            const rawMime = typeof blob.type === 'string' ? blob.type : '';
            const mimeType = rawMime.split(';', 1)[0]?.trim() || 'application/octet-stream';
            this.result = `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
            this.readyState = E2EFileReaderPolyfill.DONE;
            this.emit('load');
            this.emit('loadend');
          },
          (err: unknown) => {
            this.error = err instanceof Error ? err : new Error(String(err));
            this.readyState = E2EFileReaderPolyfill.DONE;
            this.emit('error');
            this.emit('loadend');
          }
        );
    }
  }

  Object.defineProperty(globalThis, 'FileReader', {
    value: E2EFileReaderPolyfill,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  platformState.OS = 'android';
});
