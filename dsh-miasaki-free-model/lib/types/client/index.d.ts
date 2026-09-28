import type { Injectable } from '@deepseek-ai/cordis';

/**
 * Client plugin entry: registers the 设置 → 免费模型 section.
 * The panel talks to the Host half through /freemodel-api/* routes.
 */
export const name = 'free-model';
export const inject = ['slots'] as const satisfies Injectable[];
export function apply(ctx: unknown): void;
