// ============================================================
// VEROQ External MCP — Secure proxy for external MCP servers
// ============================================================
// Every external tool call passes through: permission engine,
// decision lineage, escalation, observability, cost routing,
// budget tracking, rate limiting, and feedback loop.
// ============================================================

import {
  checkPermissions,
  checkOutputSafety,
  getDecisionLineage,
  type PermissionResult,
  type DecisionLineage,
} from "../safety/index.js";
import { recordToolCall } from "../observability/index.js";

// ── Types ──

export type TrustLevel = "read-only" | "write" | "high-risk";

export type ExternalAuthType = "api-key" | "oauth" | "oidc" | "bearer" | "none";

export interface ExternalAuthConfig {
  type: ExternalAuthType;
  /** Credential value (API key, bearer token, etc.) — stored in memory only, never logged */
  credential?: string;
  /** OAuth/OIDC token endpoint for refresh */
  tokenEndpoint?: string;
  /** Token expiry in seconds (for short-lived tokens) */
  expiresIn?: number;
}

export interface ExternalServerConfig {
  /** Unique identifier for this server (e.g., "alphavantage", "bloomberg") */
  serverId: string;
  /** Display name */
  name: string;
  /** Server URL (base URL for API calls) */
  serverUrl: string;
  /** Authentication configuration */
  auth: ExternalAuthConfig;
  /** Tools allowed from this server — exact names or wildcard patterns */
  allowedTools: string[];
  /** Trust level determines default permission rules */
  trustLevel: TrustLevel;
  /** Cache policy for responses */
  cachePolicy?: {
    enabled: boolean;
    ttlMs: number;
  };
  /** Credit cost per call (default: 1) */
  creditsPerCall?: number;
  /** Rate limit: max calls per minute (default: 60) */
  rateLimitPerMinute?: number;
  /** Custom permission rules (mapped to permission engine patterns) */
  permissionRules?: {
    denied?: string[];
    review?: string[];
  };
}

export interface ExternalCallResult {
  serverId: string;
  toolName: string;
  prefixedToolName: string;
  data: Record<string, unknown>;
  permission: PermissionResult;
  lineage: DecisionLineage;
  escalated: boolean;
  escalationNotice?: string;
  cached: boolean;
  durationMs: number;
  creditsUsed: number;
  rateLimited: boolean;
}

export interface ExternalServerInfo {
  serverId: string;
  name: string;
  serverUrl: string;
  trustLevel: TrustLevel;
  allowedTools: string[];
  registeredToolCount: number;
  totalCalls: number;
  errorCount: number;
  avgLatencyMs: number;
  rateLimitRemaining: number;
}

// ── Constants ──

const EXTERNAL_PREFIX = "external_";
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_CREDITS_PER_CALL = 1;

// ── Trust-Level Defaults ──

/** Tool name patterns that are dangerous in finance context */
const FINANCE_DANGEROUS_PATTERNS = [
  "*trade*", "*execute*", "*order*", "*buy*", "*sell*",
  "*transfer*", "*withdraw*", "*margin*", "*liquidat*",
];

/** Conservative defaults per trust level */
const TRUST_DEFAULTS: Record<TrustLevel, {
  rateLimitPerMinute: number;
  creditsPerCall: number;
  cacheEnabled: boolean;
  cacheTtlMs: number;
  reviewPatterns: string[];
  denyPatterns: string[];
}> = {
  "read-only": {
    rateLimitPerMinute: 60,
    creditsPerCall: 1,
    cacheEnabled: true,
    cacheTtlMs: 60_000,
    reviewPatterns: [],
    denyPatterns: [],
  },
  "write": {
    rateLimitPerMinute: 20,
    creditsPerCall: 3,
    cacheEnabled: false,
    cacheTtlMs: 0,
    reviewPatterns: FINANCE_DANGEROUS_PATTERNS,
    denyPatterns: [],
  },
  "high-risk": {
    rateLimitPerMinute: 5,
    creditsPerCall: 5,
    cacheEnabled: false,
    cacheTtlMs: 0,
    reviewPatterns: [],
    denyPatterns: FINANCE_DANGEROUS_PATTERNS,
  },
};

/**
 * Apply conservative defaults to an external server config based on trust level.
 * Does NOT overwrite values the caller explicitly set.
 *
 * @example
 * ```typescript
 * const config = applyExternalDefaults({
 *   serverId: "broker",
 *   name: "Broker API",
 *   serverUrl: "https://api.broker.com",
 *   auth: { type: "bearer", credential: "..." },
 *   allowedTools: ["get_positions", "submit_order"],
 *   trustLevel: "write",
 * });
 * // config now has: rateLimitPerMinute: 20, creditsPerCall: 3,
 * // permissionRules.review includes *order*, *trade*, *buy*, *sell*
 * ```
 */
export function applyExternalDefaults(config: ExternalServerConfig): ExternalServerConfig {
  const defaults = TRUST_DEFAULTS[config.trustLevel] || TRUST_DEFAULTS["read-only"];
  const prefix = `external_${config.serverId}_`;

  // Build prefixed review/deny patterns from trust defaults
  const defaultReview = defaults.reviewPatterns.map(p => `${prefix}${p}`);
  const defaultDeny = defaults.denyPatterns.map(p => `${prefix}${p}`);

  // Merge with any explicit rules (explicit rules take precedence)
  const existingReview = (config.permissionRules?.review || []);
  const existingDeny = (config.permissionRules?.denied || []);

  return {
    ...config,
    rateLimitPerMinute: config.rateLimitPerMinute ?? defaults.rateLimitPerMinute,
    creditsPerCall: config.creditsPerCall ?? defaults.creditsPerCall,
    cachePolicy: config.cachePolicy ?? (defaults.cacheEnabled
      ? { enabled: true, ttlMs: defaults.cacheTtlMs }
      : undefined),
    permissionRules: {
      review: [...new Set([...existingReview, ...defaultReview])],
      denied: [...new Set([...existingDeny, ...defaultDeny])],
    },
  };
}

// ── Rate Limiter ──

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

class RateLimiter {
  private buckets = new Map<string, RateLimitBucket>();

  check(serverId: string, limit: number): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const bucket = this.buckets.get(serverId);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(serverId, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, remaining: limit - 1 };
    }

    if (bucket.count >= limit) {
      return { allowed: false, remaining: 0 };
    }

    bucket.count++;
    return { allowed: true, remaining: limit - bucket.count };
  }

  getRemaining(serverId: string, limit: number): number {
    const bucket = this.buckets.get(serverId);
    if (!bucket || Date.now() >= bucket.resetAt) return limit;
    return Math.max(0, limit - bucket.count);
  }

  reset(): void {
    this.buckets.clear();
  }
}

// ── Response Cache ──

interface CachedResponse {
  data: Record<string, unknown>;
  timestamp: number;
  ttlMs: number;
}

class ExternalCache {
  private store = new Map<string, CachedResponse>();
  private hits = 0;
  private misses = 0;

  static buildKey(serverId: string, toolName: string, params: Record<string, unknown>): string {
    // Stable serialization — sort keys recursively for consistent cache keys
    const stable = JSON.stringify(params, (_key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.keys(value).sort().reduce<Record<string, unknown>>((sorted, k) => {
          sorted[k] = (value as Record<string, unknown>)[k];
          return sorted;
        }, {});
      }
      return value;
    }).slice(0, 300);
    return `${serverId}:${toolName}:${stable}`;
  }

  get(key: string): CachedResponse | undefined {
    const entry = this.store.get(key);
    if (!entry || Date.now() - entry.timestamp > entry.ttlMs) {
      if (entry) this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry;
  }

  set(key: string, data: Record<string, unknown>, ttlMs: number): void {
    this.store.set(key, { data, timestamp: Date.now(), ttlMs });
  }

  getStats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

// ── Server Metrics ──

interface ServerMetrics {
  totalCalls: number;
  errors: number;
  totalLatencyMs: number;
}

// ── Input Sanitization ──

const SENSITIVE_PATTERNS = [
  /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
];

function sanitizeForAudit(input: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      let cleaned = value.length > 500 ? value.slice(0, 500) + "..." : value;
      for (const p of SENSITIVE_PATTERNS) {
        cleaned = cleaned.replace(p, "[REDACTED]");
      }
      safe[key] = cleaned;
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

// ── External MCP Registry ──

export class ExternalMcpRegistry {
  private servers = new Map<string, ExternalServerConfig>();
  private rateLimiter = new RateLimiter();
  private cache = new ExternalCache();
  private metrics = new Map<string, ServerMetrics>();
  /** External call function — injected for testability (default: actual fetch) */
  private callFn: ((url: string, options: { method: string; headers: Record<string, string>; body?: string }) => Promise<Record<string, unknown>>) | null = null;

  constructor(callFn?: typeof ExternalMcpRegistry.prototype.callFn) {
    this.callFn = callFn ?? null;
  }

  // ── Registration ──

  /** Register an external MCP server. Applies conservative defaults based on trustLevel. */
  registerServer(config: ExternalServerConfig): void {
    if (!config.serverId || !config.serverUrl) {
      throw new Error("serverId and serverUrl are required");
    }
    if (config.allowedTools.length === 0) {
      throw new Error("At least one allowed tool is required (least-privilege)");
    }
    const enriched = applyExternalDefaults(config);
    this.servers.set(config.serverId, enriched);
    this.metrics.set(config.serverId, { totalCalls: 0, errors: 0, totalLatencyMs: 0 });
  }

  /** Unregister a server */
  unregisterServer(serverId: string): boolean {
    this.metrics.delete(serverId);
    return this.servers.delete(serverId);
  }

  /** Get a registered server config (credentials redacted) */
  getServer(serverId: string): (Omit<ExternalServerConfig, "auth"> & { auth: Omit<ExternalAuthConfig, "credential"> & { credential?: "***" } }) | undefined {
    const server = this.servers.get(serverId);
    if (!server) return undefined;
    return {
      ...server,
      auth: { ...server.auth, credential: server.auth.credential ? "***" : undefined },
    };
  }

  /** Get all registered server IDs */
  getServerIds(): string[] {
    return [...this.servers.keys()];
  }

  /** List all registered external tools (prefixed) */
  getRegisteredTools(): Array<{ serverId: string; toolName: string; prefixedName: string; trustLevel: TrustLevel }> {
    const tools: Array<{ serverId: string; toolName: string; prefixedName: string; trustLevel: TrustLevel }> = [];
    for (const server of this.servers.values()) {
      for (const tool of server.allowedTools) {
        tools.push({
          serverId: server.serverId,
          toolName: tool,
          prefixedName: `${EXTERNAL_PREFIX}${server.serverId}_${tool}`,
          trustLevel: server.trustLevel,
        });
      }
    }
    return tools;
  }

  /** Get server info for observability */
  getServerInfo(serverId: string): ExternalServerInfo | undefined {
    const server = this.servers.get(serverId);
    const m = this.metrics.get(serverId);
    if (!server || !m) return undefined;
    return {
      serverId: server.serverId,
      name: server.name,
      serverUrl: server.serverUrl,
      trustLevel: server.trustLevel,
      allowedTools: server.allowedTools,
      registeredToolCount: server.allowedTools.length,
      totalCalls: m.totalCalls,
      errorCount: m.errors,
      avgLatencyMs: m.totalCalls > 0 ? Math.round(m.totalLatencyMs / m.totalCalls) : 0,
      rateLimitRemaining: this.rateLimiter.getRemaining(
        serverId, server.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT,
      ),
    };
  }

  // ── Tool Call ──

  /**
   * Call an external tool through the secure proxy.
   *
   * Every call passes through: permission check → rate limit → cache check →
   * execution → output safety → lineage → observability → feedback.
   */
  async callTool(
    serverId: string,
    toolName: string,
    params: Record<string, unknown>,
    context?: { sessionId?: string; enterpriseId?: string },
  ): Promise<ExternalCallResult> {
    const startTime = Date.now();
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`External server "${serverId}" is not registered`);
    }

    const prefixedName = `${EXTERNAL_PREFIX}${serverId}_${toolName}`;
    const metrics = this.metrics.get(serverId)!;

    // 0. Validate tool name (prevent path traversal in URL construction)
    if (!/^[a-zA-Z0-9_-]+$/.test(toolName)) {
      return {
        serverId, toolName, prefixedToolName: prefixedName,
        data: { error: `Invalid tool name "${toolName}" — only alphanumeric, hyphens, and underscores allowed` },
        permission: { decision: "deny", reason: "Invalid tool name", highStakesTriggered: false, escalated: false, lineage: { toolName: prefixedName, input: {}, rulesEvaluated: [], confidenceFactors: {}, finalDecision: "deny", finalReason: "Invalid tool name", escalated: false, timestamp: new Date().toISOString(), durationMs: 0 } as DecisionLineage },
        lineage: { toolName: prefixedName, input: {}, rulesEvaluated: [], confidenceFactors: {}, finalDecision: "deny", finalReason: "Invalid tool name", escalated: false, timestamp: new Date().toISOString(), durationMs: 0 } as DecisionLineage,
        escalated: false, cached: false, durationMs: Date.now() - startTime, creditsUsed: 0, rateLimited: false,
      };
    }

    // 1. Verify tool is in allowed list
    const isAllowed = server.allowedTools.some(pattern => {
      if (pattern === toolName) return true;
      if (pattern.includes("*")) {
        return new RegExp("^" + pattern.replace(/\*/g, ".*") + "$").test(toolName);
      }
      return false;
    });
    if (!isAllowed) {
      const denyLineage: DecisionLineage = {
        toolName: prefixedName, input: sanitizeForAudit(params),
        rulesEvaluated: [{ ruleType: "deny", pattern: "allowed-tools-list", matched: true, result: "deny" }],
        confidenceFactors: {}, finalDecision: "deny",
        finalReason: "Tool not in allowed list", escalated: false,
        timestamp: new Date().toISOString(), durationMs: Date.now() - startTime,
      };
      return {
        serverId, toolName, prefixedToolName: prefixedName,
        data: { error: `Tool "${toolName}" is not in the allowed list for server "${serverId}"` },
        permission: { decision: "deny", reason: "Tool not in allowed list", highStakesTriggered: false, escalated: false, lineage: denyLineage },
        lineage: denyLineage,
        escalated: false, cached: false, durationMs: Date.now() - startTime, creditsUsed: 0, rateLimited: false,
      };
    }

    // 2. Permission engine check (merges server-specific rules with global context)
    // Only override global rules when the server has its own; otherwise let global rules apply.
    const serverDenyRules = (server.permissionRules?.denied || []).map(p => ({ pattern: p }));
    const serverReviewRules = (server.permissionRules?.review || []).map(p => ({ pattern: p }));
    const permOverrides: Record<string, unknown> = {};
    if (serverDenyRules.length > 0) permOverrides.alwaysDenyRules = serverDenyRules;
    if (serverReviewRules.length > 0) permOverrides.alwaysAskRules = serverReviewRules;
    const permResult = checkPermissions(
      prefixedName,
      { ...sanitizeForAudit(params), _serverId: serverId, _trustLevel: server.trustLevel },
      Object.keys(permOverrides).length > 0 ? permOverrides as any : undefined,
    );

    if (permResult.decision === "deny") {
      return {
        serverId, toolName, prefixedToolName: prefixedName,
        data: { error: `Permission denied: ${permResult.reason}` },
        permission: permResult, lineage: permResult.lineage,
        escalated: false, cached: false, durationMs: Date.now() - startTime, creditsUsed: 0, rateLimited: false,
      };
    }

    // 3. Trust-level escalation for write/high-risk
    let escalated = false;
    let escalationNotice: string | undefined;
    if (server.trustLevel === "high-risk") {
      escalated = true;
      escalationNotice = `External tool "${toolName}" on server "${serverId}" has trust level "high-risk". Human review required.`;
    } else if (server.trustLevel === "write" && permResult.highStakesTriggered) {
      escalated = true;
      escalationNotice = `Write-level external tool "${toolName}" triggered high-stakes detection.`;
    }

    // 4. Rate limit check
    const rateLimit = server.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT;
    const rateLimitResult = this.rateLimiter.check(serverId, rateLimit);
    if (!rateLimitResult.allowed) {
      metrics.errors++;
      metrics.totalCalls++;
      return {
        serverId, toolName, prefixedToolName: prefixedName,
        data: { error: `Rate limit exceeded for server "${serverId}" (${rateLimit}/min)` },
        permission: permResult, lineage: permResult.lineage,
        escalated: false, cached: false, durationMs: Date.now() - startTime, creditsUsed: 0, rateLimited: true,
      };
    }

    // 5. Cache check
    if (server.cachePolicy?.enabled) {
      const cacheKey = ExternalCache.buildKey(serverId, toolName, params);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const lineage = getDecisionLineage(prefixedName, sanitizeForAudit(params), cached.data);
        recordToolCall(prefixedName, Date.now() - startTime, false, false, false);
        return {
          serverId, toolName, prefixedToolName: prefixedName,
          data: cached.data, permission: permResult, lineage,
          escalated, escalationNotice, cached: true,
          durationMs: Date.now() - startTime, creditsUsed: 0, rateLimited: false,
        };
      }
    }

    // 6. Execute external call
    let data: Record<string, unknown>;
    try {
      if (this.callFn) {
        // Injected call function (for testing or custom transports)
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (server.auth.type === "api-key" && server.auth.credential) {
          headers["X-API-Key"] = server.auth.credential;
        } else if ((server.auth.type === "bearer" || server.auth.type === "oauth") && server.auth.credential) {
          headers["Authorization"] = `Bearer ${server.auth.credential}`;
        }
        data = await this.callFn(`${server.serverUrl}/tools/${toolName}`, {
          method: "POST",
          headers,
          body: JSON.stringify(params),
        });
      } else {
        // Default: HTTP fetch
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (server.auth.type === "api-key" && server.auth.credential) {
          headers["X-API-Key"] = server.auth.credential;
        } else if ((server.auth.type === "bearer" || server.auth.type === "oauth") && server.auth.credential) {
          headers["Authorization"] = `Bearer ${server.auth.credential}`;
        }
        const resp = await fetch(`${server.serverUrl}/tools/${toolName}`, {
          method: "POST",
          headers,
          body: JSON.stringify(params),
        });
        data = await resp.json() as Record<string, unknown>;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      metrics.errors++;
      metrics.totalCalls++;
      recordToolCall(prefixedName, Date.now() - startTime, true, false, false);
      return {
        serverId, toolName, prefixedToolName: prefixedName,
        data: { error: msg },
        permission: permResult, lineage: permResult.lineage,
        escalated, escalationNotice, cached: false,
        durationMs: Date.now() - startTime, creditsUsed: 0, rateLimited: false,
      };
    }

    // 7. Output safety check
    const safetyCheck = checkOutputSafety(prefixedName, data);
    if (safetyCheck.escalated) {
      escalated = true;
      escalationNotice = safetyCheck.escalationNotice || escalationNotice;
    }

    // 8. Decision lineage
    const lineage = getDecisionLineage(prefixedName, sanitizeForAudit(params), data);

    // 9. Cache result
    if (server.cachePolicy?.enabled) {
      const cacheKey = ExternalCache.buildKey(serverId, toolName, params);
      this.cache.set(cacheKey, data, server.cachePolicy.ttlMs);
    }

    // 10. Record metrics
    const durationMs = Date.now() - startTime;
    const creditsUsed = server.creditsPerCall ?? DEFAULT_CREDITS_PER_CALL;
    metrics.totalCalls++;
    metrics.totalLatencyMs += durationMs;
    recordToolCall(prefixedName, durationMs, false, permResult.highStakesTriggered, escalated);

    return {
      serverId, toolName, prefixedToolName: prefixedName,
      data, permission: permResult, lineage,
      escalated, escalationNotice, cached: false,
      durationMs, creditsUsed, rateLimited: false,
    };
  }

  // ── Utilities ──

  /** Reset all state (for testing) */
  reset(): void {
    this.servers.clear();
    this.metrics.clear();
    this.rateLimiter.reset();
    this.cache.clear();
  }

  /** Get cache stats */
  getCacheStats(): { hits: number; misses: number } {
    return this.cache.getStats();
  }
}

// ── Module-Level Default Registry ──

let defaultRegistry: ExternalMcpRegistry | null = null;

/** Get or create the default external MCP registry */
export function getExternalRegistry(): ExternalMcpRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new ExternalMcpRegistry();
  }
  return defaultRegistry;
}

/** Register an external MCP server on the default registry */
export function registerExternalMcpServer(config: ExternalServerConfig): void {
  getExternalRegistry().registerServer(config);
}

/** Call an external tool on the default registry */
export async function callExternalTool(
  serverId: string,
  toolName: string,
  params: Record<string, unknown>,
  context?: { sessionId?: string; enterpriseId?: string },
): Promise<ExternalCallResult> {
  return getExternalRegistry().callTool(serverId, toolName, params, context);
}

/** Reset the default registry (for testing) */
export function resetExternalRegistry(): void {
  if (defaultRegistry) defaultRegistry.reset();
  defaultRegistry = null;
}
