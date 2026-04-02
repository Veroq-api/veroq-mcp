// ============================================================
// VEROQ Hooks — Lightweight lifecycle hooks for tools & runtime
// ============================================================
// Customers inject custom logging, safety checks, or domain
// transforms without forking core code.
// ============================================================

// ── Types ──

export interface HookContext {
  toolName: string;
  params: Record<string, unknown>;
  timestamp: string;
  sessionId?: string;
  enterpriseId?: string;
}

export interface HookResult {
  /** Modified params (preExecute only) — return undefined to keep original */
  params?: Record<string, unknown>;
  /** Block execution (preExecute only) — return a reason string to deny */
  block?: string;
  /** Additional metadata to attach to the response */
  metadata?: Record<string, unknown>;
}

export type PreExecuteHook = (context: HookContext) => HookResult | Promise<HookResult> | void | Promise<void>;
export type PostExecuteHook = (context: HookContext & { result: unknown; durationMs: number }) => void | Promise<void>;
export type OnVerificationHook = (context: HookContext & { verdict: string; confidence: number; corrections: unknown[] }) => void | Promise<void>;
export type OnEscalationHook = (context: HookContext & { reason: string; tradeSignal?: unknown }) => void | Promise<void>;
export type OnErrorHook = (context: HookContext & { error: Error }) => void | Promise<void>;

export interface HookRegistry {
  preExecute: PreExecuteHook[];
  postExecute: PostExecuteHook[];
  onVerification: OnVerificationHook[];
  onEscalation: OnEscalationHook[];
  onError: OnErrorHook[];
}

// ── Global Registry ──

const hooks: HookRegistry = {
  preExecute: [],
  postExecute: [],
  onVerification: [],
  onEscalation: [],
  onError: [],
};

/**
 * Register a hook.
 *
 * @example
 * ```typescript
 * import { registerHook } from "veroq-mcp";
 *
 * // Log every tool call
 * registerHook("postExecute", (ctx) => {
 *   console.log(`${ctx.toolName} took ${ctx.durationMs}ms`);
 * });
 *
 * // Block high-risk tools
 * registerHook("preExecute", (ctx) => {
 *   if (ctx.toolName.includes("trade")) return { block: "Trading disabled" };
 * });
 *
 * // Alert on escalation
 * registerHook("onEscalation", (ctx) => {
 *   slack.send(`⚠️ Escalation: ${ctx.reason}`);
 * });
 * ```
 */
export function registerHook<K extends keyof HookRegistry>(
  event: K,
  handler: HookRegistry[K][number],
): void {
  (hooks[event] as any[]).push(handler);
}

/** Remove all hooks (for testing) */
export function clearHooks(): void {
  hooks.preExecute = [];
  hooks.postExecute = [];
  hooks.onVerification = [];
  hooks.onEscalation = [];
  hooks.onError = [];
}

/** Get current hook counts (for introspection) */
export function getHookCounts(): Record<keyof HookRegistry, number> {
  return {
    preExecute: hooks.preExecute.length,
    postExecute: hooks.postExecute.length,
    onVerification: hooks.onVerification.length,
    onEscalation: hooks.onEscalation.length,
    onError: hooks.onError.length,
  };
}

// ── Execution Helpers ──

/** Run all preExecute hooks. Returns block reason if any hook blocks. */
export async function runPreExecuteHooks(context: HookContext): Promise<{ blocked: boolean; reason?: string; params: Record<string, unknown> }> {
  let params = context.params;
  for (const hook of hooks.preExecute) {
    try {
      const result = await hook({ ...context, params });
      if (result?.block) return { blocked: true, reason: result.block, params };
      if (result?.params) params = result.params;
    } catch { /* hooks must not break execution */ }
  }
  return { blocked: false, params };
}

/** Run all postExecute hooks (fire-and-forget). */
export function runPostExecuteHooks(context: HookContext & { result: unknown; durationMs: number }): void {
  for (const hook of hooks.postExecute) {
    try { Promise.resolve(hook(context)).catch(() => {}); } catch { /* ignore */ }
  }
}

/** Run all onVerification hooks (fire-and-forget). */
export function runVerificationHooks(context: HookContext & { verdict: string; confidence: number; corrections: unknown[] }): void {
  for (const hook of hooks.onVerification) {
    try { Promise.resolve(hook(context)).catch(() => {}); } catch { /* ignore */ }
  }
}

/** Run all onEscalation hooks (fire-and-forget). */
export function runEscalationHooks(context: HookContext & { reason: string; tradeSignal?: unknown }): void {
  for (const hook of hooks.onEscalation) {
    try { Promise.resolve(hook(context)).catch(() => {}); } catch { /* ignore */ }
  }
}

/** Run all onError hooks (fire-and-forget). */
export function runErrorHooks(context: HookContext & { error: Error }): void {
  for (const hook of hooks.onError) {
    try { Promise.resolve(hook(context)).catch(() => {}); } catch { /* ignore */ }
  }
}
