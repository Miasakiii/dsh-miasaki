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
  /** Draft value from the editor form; wins over the stored profile. */
  baseURL?: string;
  /** Draft protocol; wins over the stored profile. */
  api?: string;
  /** A key typed into the form but not yet saved; wins over the credential store. */
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

export declare const name: 'model-probe';
export declare const inject: readonly ['settings', 'webServer'];

export declare function apply(ctx: Context, config?: { trustedHosts?: string[] }): void;

export declare function fenceRequest(
  headers: Record<string, string | string[] | undefined>,
  trusted: Set<string>,
): { ok: true } | { ok: false; status: number; error: string };

export declare function probeModel(ctx: Context, request: ProbeRequest): Promise<ProbeResult>;
