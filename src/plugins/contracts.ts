import type { PluginManifest } from '../domain/types';

export const mobileMcpTransports = ['streamable-http', 'sse'] as const;
export const MAX_PLUGIN_MANIFESTS = 500;
export const MAX_MCP_TOOL_NAME_CHARACTERS = 128;
export const MAX_MCP_ALLOWED_TOOLS = 64;
export const MAX_MCP_SERVER_LABEL_CHARACTERS = 64;
export const MAX_MCP_DESCRIPTION_CHARACTERS = 2_048;
export const MAX_MCP_ENDPOINT_CHARACTERS = 2_048;
export const MAX_MCP_AUTHORIZATION_CHARACTERS = 8_192;

export const pluginPermissionLabels: Record<PluginManifest['permissions'][number], string> = {
  network: '网络',
  files: '文件',
  clipboard: '剪贴板',
  tools: '工具调用',
};

export function isRemoteMcpPlugin(plugin: PluginManifest): boolean {
  return plugin.type === 'remote-mcp' && Boolean(plugin.endpoint);
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function isPrivateOrReservedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    !host ||
    (!host.includes('.') && !host.includes(':')) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  ) {
    return true;
  }

  if (host.includes(':')) {
    const segments = host.split(':');
    const first = Number.parseInt(segments[0] || '0', 16);
    const second = Number.parseInt(segments[1] || '0', 16);
    const third = Number.parseInt(segments[2] || '0', 16);
    return (
      host.startsWith('::') ||
      host.startsWith('64:ff9b:') ||
      host.startsWith('100::') ||
      host.startsWith('2002:') ||
      first === 0x5f00 ||
      (first >= 0xfc00 && first <= 0xfdff) ||
      (first >= 0xfe80 && first <= 0xfeff) ||
      (first >= 0xff00 && first <= 0xffff) ||
      (first === 0x3fff && second <= 0x0fff) ||
      (first === 0x2001 &&
        (second === 0 ||
          (second === 2 && third === 0) ||
          second === 0x0db8 ||
          (second >= 0x10 && second <= 0x2f)))
    );
  }

  const octets = host.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return /^[0-9.]+$/.test(host);
  }
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function normalizeMcpToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    unicodeLength(normalized) > MAX_MCP_TOOL_NAME_CHARACTERS ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

export function normalizeMcpAllowedTools(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MCP_ALLOWED_TOOLS) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const toolName = normalizeMcpToolName(candidate);
    if (!toolName) return [];
    if (!seen.has(toolName)) {
      seen.add(toolName);
      normalized.push(toolName);
    }
  }
  return normalized;
}

export function normalizeMcpServerLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    unicodeLength(normalized) > MAX_MCP_SERVER_LABEL_CHARACTERS ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

export function normalizeMcpDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && unicodeLength(normalized) <= MAX_MCP_DESCRIPTION_CHARACTERS
    ? normalized
    : undefined;
}

export function normalizeMcpAuthorization(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_MCP_AUTHORIZATION_CHARACTERS ||
    !/^[\x20-\x7e]+$/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

export function normalizeRemoteMcpEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_MCP_ENDPOINT_CHARACTERS ||
    /[\u0000-\u0020\u007f]/.test(normalized)
  ) {
    return undefined;
  }
  try {
    const url = new URL(normalized);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !url.hostname ||
      isPrivateOrReservedHostname(url.hostname) ||
      normalized.includes('?') ||
      normalized.includes('#')
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export type RemoteMcpReadinessReason =
  | 'not-remote-mcp'
  | 'disabled'
  | 'invalid-transport'
  | 'invalid-endpoint'
  | 'invalid-server-label'
  | 'invalid-provider'
  | 'missing-allowed-tools'
  | 'invalid-permissions'
  | 'invalid-approval-policy'
  | 'invalid-authorization';

export type RemoteMcpExecutableReadiness =
  | {
      executable: true;
      endpoint: string;
      transport: NonNullable<PluginManifest['transport']>;
      serverLabel: string;
      providerId: string;
      allowedTools: string[];
      authorization?: string;
    }
  | { executable: false; reason: RemoteMcpReadinessReason };

export function getRemoteMcpExecutableReadiness(
  plugin: PluginManifest,
  providerIds: ReadonlySet<string>
): RemoteMcpExecutableReadiness {
  if (plugin.type !== 'remote-mcp') return { executable: false, reason: 'not-remote-mcp' };
  if (plugin.enabled !== true) return { executable: false, reason: 'disabled' };
  if (!mobileMcpTransports.includes(plugin.transport as (typeof mobileMcpTransports)[number])) {
    return { executable: false, reason: 'invalid-transport' };
  }
  const endpoint = normalizeRemoteMcpEndpoint(plugin.endpoint);
  if (!endpoint) return { executable: false, reason: 'invalid-endpoint' };
  const serverLabel = normalizeMcpServerLabel(plugin.serverLabel);
  if (!serverLabel) return { executable: false, reason: 'invalid-server-label' };
  const providerId = typeof plugin.providerId === 'string' ? plugin.providerId.trim() : '';
  if (!providerId || !providerIds.has(providerId)) {
    return { executable: false, reason: 'invalid-provider' };
  }
  const allowedTools = normalizeMcpAllowedTools(plugin.allowedTools);
  if (!allowedTools.length) return { executable: false, reason: 'missing-allowed-tools' };
  if (!plugin.permissions.includes('network') || !plugin.permissions.includes('tools')) {
    return { executable: false, reason: 'invalid-permissions' };
  }
  if (plugin.approvalPolicy !== 'always') {
    return { executable: false, reason: 'invalid-approval-policy' };
  }
  const authorization = plugin.authorization === undefined
    ? undefined
    : normalizeMcpAuthorization(plugin.authorization);
  if (plugin.authorization !== undefined && !authorization) {
    return { executable: false, reason: 'invalid-authorization' };
  }
  return {
    executable: true,
    endpoint,
    transport: plugin.transport!,
    serverLabel,
    providerId,
    allowedTools,
    ...(authorization ? { authorization } : {}),
  };
}

export function remoteMcpBindingFingerprint(
  plugin: PluginManifest,
  providerBindings: ReadonlyMap<string, string>
): string | undefined {
  const readiness = getRemoteMcpExecutableReadiness(
    { ...plugin, enabled: true },
    new Set(providerBindings.keys())
  );
  if (!readiness.executable) return undefined;
  const providerBinding = providerBindings.get(readiness.providerId);
  if (!providerBinding) return undefined;
  return JSON.stringify([
    'remote-mcp-v3',
    readiness.transport,
    readiness.endpoint,
    readiness.serverLabel,
    readiness.providerId,
    providerBinding,
    [...readiness.allowedTools].sort(),
    'always',
  ]);
}
