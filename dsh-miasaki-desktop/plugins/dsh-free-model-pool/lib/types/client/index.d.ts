import type { Injectable } from '@deepseek-ai/cordis';

export interface SettingsSectionPanelProps {
  close: () => void;
}

/**
 * Client plugin entry: registers the 设置 → 免费模型池 section.
 * The panel talks to the Host half through /freepool-api/* routes.
 */
export const name = 'free-model-pool';
export const inject = ['slots'] as const satisfies Injectable[];
export function apply(ctx: unknown): void;

declare const __devOnly: unique symbol;
