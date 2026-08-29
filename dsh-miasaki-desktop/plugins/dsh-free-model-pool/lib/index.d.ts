import type { Injectable } from '@deepseek-ai/cordis';
import type { Settings } from '@deepseek-ai/dsh-settings';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';

/** Route payload shapes crossing the panel ↔ host JSON boundary. */

export interface FreeModelProfile {
  modality: string;
  reasoning: boolean;
  tools: boolean;
  toolChoice: boolean;
  structuredOutput: boolean;
  vision: boolean;
  code: boolean;
  longContext: boolean;
  canAgent: boolean;
  role: string;
  strengths: string[];
  warnings: string[];
  verdict: string;
}

export interface FreeModelEntry {
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  supported: string;
  profile: FreeModelProfile;
}

/** One scannable platform (llm-pi-ai.providers route with a baseURL). */
export interface FreeModelPlatform {
  id: string;
  displayName: string;
  apiKeyEnv: string | null;
  baseURL: string;
  endpoint: string;
  configuredCount: number;
  configured: { id: string; name: string }[];
}

export interface FreeModelStatus {
  platforms: FreeModelPlatform[];
}

export interface FreeModelSummary {
  total: number;
  agentCount: number;
  qaOnly: number;
  bestAgent: { id: string; name: string; verdict: string; strengths: string[] } | null;
  codingAgent: string | null;
  visionAgent: string | null;
  longContextAgent: string | null;
}

export interface FreeModelDetect {
  platform: string;
  endpoint: string;
  models: FreeModelEntry[];
  total: number;
  summary: FreeModelSummary;
}

export interface FreeModelApply {
  written: number;
  platform: string;
  models: string[];
}

export interface FreeModelSubagent {
  updated: string[];
  provider: string;
  model: string;
  maxTokens: number;
}

export const name = 'free-model-pool';
export const inject = ['settings', 'webServer'] as const satisfies Injectable[];

export function apply(ctx: { settings: Settings; webServer: WebServer }): void;

declare const __devOnly: unique symbol;
export type { Settings, WebServer };
