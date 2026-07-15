import type { ProviderProfile } from '../domain/types';
import { inspectProviderEndpoint } from './providerSetup';

export type ProviderConnectionIssueKind =
  | 'api-key'
  | 'endpoint'
  | 'permission'
  | 'quota'
  | 'network'
  | 'timeout'
  | 'unknown';

export interface ProviderConnectionIssue {
  kind: ProviderConnectionIssueKind;
  title: string;
  guidance: string;
  detail: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '未知错误');
}

export function classifyProviderConnectionError(error: unknown): ProviderConnectionIssue {
  const detail = messageOf(error).slice(0, 1_000);
  const normalized = detail.toLowerCase();
  if (/\b401\b|unauthori[sz]ed|invalid[_ -]?(api[_ -]?)?key|authentication|鉴权|密钥/.test(normalized)) {
    return {
      kind: 'api-key',
      title: 'API Key 未通过验证',
      guidance: '请确认 Key 属于当前 Endpoint、没有多余空格，并且仍处于启用状态。',
      detail,
    };
  }
  if (/\b403\b|forbidden|permission|not enabled|未开通|无权限|权限/.test(normalized)) {
    return {
      kind: 'permission',
      title: '账号或模型权限不足',
      guidance: '请在服务商控制台确认产品已开通、模型已授权，并检查账号或工作空间范围。',
      detail,
    };
  }
  if (/\b429\b|quota|rate.?limit|insufficient|balance|配额|余额|限流/.test(normalized)) {
    return {
      kind: 'quota',
      title: '配额、余额或速率限制',
      guidance: '请检查服务商账户配额、余额和限流策略；Embezzle Studio 不提供或补贴额度。',
      detail,
    };
  }
  if (/timeout|timed out|abort|超时/.test(normalized)) {
    return {
      kind: 'timeout',
      title: '连接超时',
      guidance: '请检查网络、代理和服务商区域；稍后重试仍失败时再核对 Endpoint。',
      detail,
    };
  }
  if (/network|failed to fetch|fetch failed|dns|socket|offline|网络|连接失败/.test(normalized)) {
    return {
      kind: 'network',
      title: '网络无法到达服务商',
      guidance: '请确认手机网络、系统代理、DNS 和服务商区域可用。',
      detail,
    };
  }
  if (/\b404\b|not found|endpoint|base url|url|路径|地址/.test(normalized)) {
    return {
      kind: 'endpoint',
      title: 'Endpoint 或接口路径不正确',
      guidance: '请使用服务商官方 API Base URL，不要粘贴控制台页面地址或具体模型页面。',
      detail,
    };
  }
  return {
    kind: 'unknown',
    title: '服务商返回了未识别错误',
    guidance: '请保留脱敏错误信息，并在诊断中心导出诊断包后核对服务商文档。',
    detail,
  };
}

export type ProviderConfigurationHealth =
  | 'ready-for-check'
  | 'missing-key'
  | 'invalid-endpoint'
  | 'no-model';

export function providerConfigurationHealth(provider: ProviderProfile): {
  health: ProviderConfigurationHealth;
  summary: string;
} {
  const inspection = inspectProviderEndpoint(provider.baseUrl, {
    kind: provider.kind,
    apiKey: provider.apiKey,
  });
  if (!inspection.valid || inspection.policy === 'blocked') {
    return {
      health: 'invalid-endpoint',
      summary: inspection.errors[0] ?? 'Endpoint 未通过本地安全检查。',
    };
  }
  if (!provider.apiKey?.trim()) {
    return { health: 'missing-key', summary: '尚未配置 API Key。' };
  }
  if (!provider.models.some((model) => model.source !== 'remote')) {
    return { health: 'no-model', summary: 'Key 已保存，但尚未添加可用模型。' };
  }
  return {
    health: 'ready-for-check',
    summary: '本地配置完整；仍需通过真实服务商请求确认账号权限和配额。',
  };
}
