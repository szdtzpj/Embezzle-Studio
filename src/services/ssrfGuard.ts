/**
 * 零运行时平台依赖的 SSRF 主机校验与流式取消原语模块。
 * 供 `networkTransport.ts`、`externalSearch.ts`、`providerAudio.ts` 等服务共享。
 */

/** 构造标准名称为 `AbortError` 的取消异常。 */
export function createAbortError(message = '请求已取消。'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** 判断异常是否属于取消中断错误。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** 从 `AbortSignal` 提取已有的取消/超时原因，或生成标准 `AbortError`。 */
export function resolveStreamAbortError(signal?: AbortSignal): Error {
  if (
    signal?.reason instanceof Error &&
    (signal.reason.name === 'AbortError' || signal.reason.name === 'TimeoutError')
  ) {
    return signal.reason;
  }
  return createAbortError();
}

/** 构造与 `AbortSignal` 绑定的竞态拒绝 Promise 及监听器清理函数。 */
export function createAbortPromise(
  signal: AbortSignal | undefined,
  onAbortCleanup: () => void
): { promise?: Promise<never>; cleanup: () => void } {
  if (!signal) {
    return { cleanup: () => undefined };
  }
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(resolveStreamAbortError(signal));
      onAbortCleanup();
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  promise.catch(() => undefined);
  return {
    promise,
    cleanup: () => {
      if (onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

/**
 * 有限时间内等待底层可读流 `cancel()` 收敛，避免取消挂起导致未释放流锁或无限阻塞。
 */
export async function awaitStreamCancelSettled(
  cancelPromise: Promise<unknown> | null
): Promise<void> {
  if (!cancelPromise) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancelPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 50);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPercentEncodedSecretPattern(encodedValue: string): RegExp {
  const source = escapeRegExp(encodedValue).replace(/%([0-9a-f]{2})/gi, (_, hex: string) => {
    const upper = hex.toUpperCase();
    const lower = hex.toLowerCase();
    if (upper === '20') {
      return '(?:%20|\\+)';
    }
    const c0 = upper[0] === lower[0] ? upper[0] : `[${upper[0]}${lower[0]}]`;
    const c1 = upper[1] === lower[1] ? upper[1] : `[${upper[1]}${lower[1]}]`;
    return `%${c0}${c1}`;
  });
  return new RegExp(source, 'g');
}

/**
 * 对文本中的 API Key 原文及其大小写混合 URL 编码形态（含空格 `+` 变体）统一脱敏。
 */
export function redactApiKeySecrets(text: string, apiKey?: string): string {
  const trimmedKey = apiKey?.trim();
  if (!trimmedKey || trimmedKey.length < 4) {
    return text;
  }
  let sanitized = text.split(trimmedKey).join('[REDACTED]');
  const encodedKey = encodeURIComponent(trimmedKey);
  if (encodedKey && encodedKey !== trimmedKey) {
    sanitized = sanitized.replace(buildPercentEncodedSecretPattern(encodedKey), '[REDACTED]');
  }
  return sanitized;
}

/** 判断主机名是否为本机回环地址（`localhost` / `127.0.0.1` / `::1`）。 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function parseIpv4Octets(value: string): [number, number, number, number] | null {
  // 拒绝含前导零的八进制混淆段（如 012.0.0.1），仅允许规范十进制 0-255
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
    return null;
  }
  const octets = value.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return octets as [number, number, number, number];
}

function parseIpv6SegmentList(segmentText: string, allowTrailingIpv4: boolean): number[] | null {
  if (!segmentText) {
    return [];
  }
  const parts = segmentText.split(':');
  const groups: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) {
      return null;
    }
    if (allowTrailingIpv4 && index === parts.length - 1 && part.includes('.')) {
      const octets = parseIpv4Octets(part);
      if (!octets) {
        return null;
      }
      groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) {
      return null;
    }
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function parseIpv6Groups(value: string): number[] | null {
  if (!value || !value.includes(':') || value.includes('%')) {
    return null;
  }
  const compressionParts = value.split('::');
  if (compressionParts.length > 2) {
    return null;
  }
  if (compressionParts.length === 1) {
    const groups = parseIpv6SegmentList(compressionParts[0], true);
    return groups && groups.length === 8 ? groups : null;
  }

  const [headText, tailText] = compressionParts;
  const headGroups = parseIpv6SegmentList(headText, !tailText);
  const tailGroups = parseIpv6SegmentList(tailText, true);
  if (!headGroups || !tailGroups) {
    return null;
  }
  const missingCount = 8 - (headGroups.length + tailGroups.length);
  if (missingCount < 1) {
    return null;
  }
  return [...headGroups, ...new Array<number>(missingCount).fill(0), ...tailGroups];
}

function isBlockedIpv4Octets(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  return Boolean(
    a === 0 || // 0.0.0.0/8 未指定网络
      a === 10 || // 10.0.0.0/8 私网
      a === 127 || // 127.0.0.0/8 回环
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT / 云元数据
      (a === 169 && b === 254) || // 169.254.0.0/16 链路本地 / IMDS
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 私网
      (a === 192 && b === 168) || // 192.168.0.0/16 私网
      (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24 与 TEST-NET-1
      (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 6to4 任播中继
      (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 基准测试网段
      (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
      (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
      a >= 224 // 224.0.0.0/4 组播与 240.0.0.0/4 保留地址
  );
}

function isBlockedIpv6Groups(groups: number[]): boolean {
  if (groups.every((group) => group === 0)) {
    // ::/128 未指定地址
    return true;
  }
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    // ::1/128 回环地址
    return true;
  }

  const first = groups[0];
  const second = groups[1];
  const third = groups[2];

  // 链路本地 fe80::/10、站点本地 fec0::/10、ULA fc00::/7、组播 ff00::/8
  if (
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xff00) === 0xff00
  ) {
    return true;
  }

  // ::/96 (IPv4 兼容)、::ffff:0:0/96 (IPv4 映射)、::ffff:0:0:0/96 (IPv4 转换)
  if (
    groups.slice(0, 6).every((group) => group === 0) ||
    (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) ||
    (groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0)
  ) {
    return true;
  }

  // NAT64: 64:ff9b::/96 与 64:ff9b:1::/48
  if (
    first === 0x0064 &&
    second === 0xff9b &&
    (groups.slice(2, 6).every((group) => group === 0) || third === 0x0001)
  ) {
    return true;
  }

  // Teredo 2001::/32、6to4 2002::/16、ISATAP (*::5efe:<ipv4>)
  if (
    (first === 0x2001 && second === 0x0000) ||
    first === 0x2002 ||
    ((groups[4] & 0xfcff) === 0x0000 && groups[5] === 0x5efe)
  ) {
    return true;
  }

  // 丢弃前缀 100::/64、文档与基准前缀 2001:db8::/32、2001:2::/48、2001:10::/28、2001:20::/28、3fff::/20、5f00::/16
  if (
    (first === 0x0100 && second === 0 && third === 0 && groups[3] === 0) ||
    (first === 0x2001 &&
      ((second === 2 && third === 0) ||
        second === 0x0db8 ||
        (second & 0xfff0) === 0x0010 ||
        (second & 0xfff0) === 0x0020)) ||
    (first === 0x3fff && (second & 0xf000) === 0x0000) ||
    first === 0x5f00
  ) {
    return true;
  }

  return false;
}

/**
 * 判断目标主机名是否属于本机、私网、云元数据或 IPv6 过渡/特殊前缀（严格公网 SSRF 拦截）。
 */
export function isBlockedPublicHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (
    !host ||
    (!host.includes('.') && !host.includes(':')) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa') ||
    host === 'metadata' ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }

  if (host.includes(':')) {
    const groups = parseIpv6Groups(host);
    if (!groups) {
      return true;
    }
    return isBlockedIpv6Groups(groups);
  }

  const octets = parseIpv4Octets(host);
  if (!octets) {
    // 拦截纯数字整数 IP、八进制 IP 或混合十六进制多段混淆 IPv4（如 2130706433 / 0x7f.0.0.1 / 0177.0.0.1）
    const parts = host.split('.');
    return (
      parts.length > 0 &&
      parts.every((part) => part.length > 0 && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(part))
    );
  }
  return isBlockedIpv4Octets(octets);
}

/**
 * 校验并规范化严格公网 HTTPS URL：
 * 仅允许 `https:`、无凭据、默认/443 端口且非本机/私网/IMDS/IPv6 过渡地址。
 */
export function safePublicHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8192 || /[\u0000-\u0020\u007f]/.test(trimmed)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port !== '' && url.port !== '443') ||
    !url.hostname ||
    isBlockedPublicHost(url.hostname)
  ) {
    return undefined;
  }
  return url.toString();
}
