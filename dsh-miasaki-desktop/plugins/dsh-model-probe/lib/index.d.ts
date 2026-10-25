import type { Context } from '@deepseek-ai/cordis';

/** Probe outcome vocabulary, shared with the client patch's copy table. */
export type ProbeKind =
  | 'ok'
  | 'unauthorized'
  | 'model-missing'
  | 'quota'
  | 'rate-limited'
  | 'timeout'
  | 'unreachable'
  | 'bad-request'
  | 'server-error'
  | 'unknown'
  | 'unsupported'
  | 'no-credential'
  | 'no-endpoint'
  | 'no-model';

/** Which half of the two-stage probe produced the result. */
export type ProbeStage = 'handshake' | 'generate';

/** What the settings page sends when its「测试连通性」button is pressed. */
export interface ProbeRequest {
  /** llm-pi-ai provider route key. */
  provider?: string;
  /** Model id from the row being tested. */
  model: string;
  /**
   * Draft value from the editor form; wins over the stored profile.
   * A draft on another origin than the stored `baseURL` requires its own
   * `apiKey` — otherwise the probe answers `no-credential` and sends nothing
   * (the stored credential is never carried to a third-party target).
   */
  baseURL?: string;
  /** Draft protocol; wins over the stored profile. */
  api?: string;
  /**
   * A key typed into the form but not yet saved; wins over the credential
   * store. Mandatory whenever `baseURL` leaves the stored endpoint's origin.
   */
  apiKey?: string;
}

export interface ProbeResult {
  /** Whether the model answered a real generation. */
  ok: boolean;
  kind: ProbeKind;
  status?: number;
  latencyMs?: number;
  stage?: ProbeStage;
  /** The URL actually called (useful when a baseURL is misconfigured). */
  endpoint?: string;
  /** Redacted, bounded excerpt of the endpoint's own words. */
  detail?: string;
  api?: string;
  apiKeyEnv?: string | null;
}

/** 围栏判定：通过，或拒绝（带 HTTP 状态、用户可读原因与稳定 reason）。 */
export type FenceVerdict =
  | { ok: true }
  | {
      ok: false;
      status: number;
      error: string;
      reason:
        | 'untrusted-host'
        | 'cross-site'
        | 'cross-origin'
        | 'cross-port-origin'
        | 'unauthorized'
        | 'forbidden';
    };

export declare const name: 'model-probe';
export declare const inject: readonly ['settings', 'webServer'];

export declare function apply(ctx: Context, config?: { trustedHosts?: string[] }): void;

/**
 * 两个 URL 是否同源（scheme + host + port，默认端口规范化）。
 * 凭据边界用：解析失败 / 非 http(s) 一律判不同源（fail closed）。
 */
export declare function sameOrigin(a: string | null | undefined, b: string | null | undefined): boolean;

/** 结构围栏（Host / cross-site / Origin 同 hostname 且同端口）；`trusted` 省略时用内置回环集。 */
export declare function structuralFence(
  headers: Record<string, string | string[] | undefined>,
  trusted?: Set<string>,
): FenceVerdict;

/** `structuralFence` 的旧导出名（包已发布，保留兼容）。 */
export declare const fenceRequest: typeof structuralFence;

/**
 * 两层准入：`connection.requestRejection` 优先（逐请求读取），
 * 缺席 / 抛错 / 给出未知值时退回结构围栏。
 */
export declare function trustFence(
  headers: Record<string, string | string[] | undefined>,
  connection?: unknown,
  trusted?: Set<string>,
): FenceVerdict;

export declare function probeModel(ctx: Context, request: ProbeRequest): Promise<ProbeResult>;
