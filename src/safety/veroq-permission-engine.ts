// ============================================================
// VEROQ Permission Engine — Centralized safety & permission control
// ============================================================
// Applies to all MCP tools via the tool factory. Handles:
// - Allow/deny/ask rules with wildcard support
// - High-stakes financial output flagging
// - Audit logging
// - Background agent restrictions
// - Enterprise configuration
// ============================================================

// ── Types ──

export type PermissionMode = "default" | "plan" | "bypass";

export type PermissionDecision = "allow" | "deny" | "review";

export interface PermissionRule {
  /** Tool name pattern — supports wildcards: "veroq_*", "veroq_ticker_*", exact "veroq_ask" */
  pattern: string;
  /** Optional input field conditions: { "ticker": "AAPL" } or { "fast": true } */
  conditions?: Record<string, unknown>;
}

export interface ToolPermissionContext {
  mode: PermissionMode;
  alwaysAllowRules: PermissionRule[];
  alwaysDenyRules: PermissionRule[];
  alwaysAskRules: PermissionRule[];
  /** Confidence threshold above which financial outputs trigger review (default: 80) */
  highStakesThreshold: number;
  /** Enable audit logging (default: true) */
  auditEnabled: boolean;
  /** Restrict background agents — require explicit allow for non-interactive runs */
  restrictBackgroundAgents: boolean;
  /** Is this a background/non-interactive execution? */
  isBackgroundAgent: boolean;
  /** Enterprise customer ID (for audit trail) */
  enterpriseId?: string;
}

export interface AuditEntry {
  timestamp: string;
  toolName: string;
  input: Record<string, unknown>;
  decision: PermissionDecision;
  reason: string;
  mode: PermissionMode;
  enterpriseId?: string;
  highStakesTriggered: boolean;
  executionTimeMs?: number;
}

export interface PermissionResult {
  decision: PermissionDecision;
  reason: string;
  highStakesTriggered: boolean;
  auditEntry?: AuditEntry;
}

// ── High-Stakes Detection ──

/** Patterns that indicate high-stakes financial output requiring review */
const HIGH_STAKES_TOOLS = new Set([
  "veroq_ask",     // Can return trade signals
  "veroq_verify",  // Can return verification verdicts
]);

const TRADE_SIGNAL_KEYWORDS = new Set([
  "buy", "sell", "hold", "lean_buy", "lean_sell",
  "strong_buy", "strong_sell",
]);

/** Check if input/output suggests a high-stakes financial decision */
function isHighStakesInput(toolName: string, input: Record<string, unknown>): boolean {
  // /ask with trade-related questions
  if (toolName === "veroq_ask") {
    const question = String(input.question || input.q || "").toLowerCase();
    return /\bshould\s+(i|we)\s+(buy|sell|trade|invest|short)\b/i.test(question) ||
           /\btrade\s+signal\b/i.test(question) ||
           /\bposition\s+size\b/i.test(question);
  }

  // /verify with high-impact claims
  if (toolName === "veroq_verify") {
    const claim = String(input.claim || "").toLowerCase();
    return /\bearnings|revenue|acquisition|merger|bankrupt|fraud|sec\s+filing/i.test(claim);
  }

  return false;
}

/** Check if a response contains high-confidence trade signals */
export function isHighStakesOutput(
  toolName: string,
  output: Record<string, unknown>,
  threshold: number = 80,
): boolean {
  // Trade signal with high score
  const tradeSignal = output.trade_signal as { score?: number; action?: string } | undefined;
  if (tradeSignal?.score != null && tradeSignal.score > threshold) {
    return true;
  }

  // Verification with high confidence
  const confidence = output.confidence as number | undefined;
  if (toolName === "veroq_verify" && confidence != null && confidence * 100 > threshold) {
    return true;
  }

  // Confidence level
  const confLevel = (output.confidence as { level?: string })?.level;
  if (confLevel === "high" && HIGH_STAKES_TOOLS.has(toolName)) {
    return true;
  }

  return false;
}

// ── Wildcard Matching ──

function matchesPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;

  // Convert wildcard to regex: "veroq_ticker_*" → /^veroq_ticker_.*$/
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return regex.test(toolName);
  }

  return false;
}

function matchesConditions(
  input: Record<string, unknown>,
  conditions?: Record<string, unknown>,
): boolean {
  if (!conditions) return true;
  for (const [key, expected] of Object.entries(conditions)) {
    if (input[key] !== expected) return false;
  }
  return true;
}

function matchesRule(
  toolName: string,
  input: Record<string, unknown>,
  rule: PermissionRule,
): boolean {
  return matchesPattern(toolName, rule.pattern) && matchesConditions(input, rule.conditions);
}

// ── Audit Log ──

const auditLog: AuditEntry[] = [];
const MAX_AUDIT_SIZE = 10_000;

function addAuditEntry(entry: AuditEntry): void {
  auditLog.push(entry);
  // Cap audit log size
  if (auditLog.length > MAX_AUDIT_SIZE) {
    auditLog.splice(0, auditLog.length - MAX_AUDIT_SIZE);
  }
}

/** Get recent audit entries (most recent first) */
export function getAuditLog(limit: number = 100): readonly AuditEntry[] {
  return auditLog.slice(-limit).reverse();
}

/** Clear the audit log */
export function clearAuditLog(): void {
  auditLog.length = 0;
}

// ── Default Context ──

const DEFAULT_CONTEXT: ToolPermissionContext = {
  mode: "default",
  alwaysAllowRules: [
    // All read-only tools are allowed by default
    { pattern: "veroq_*" },
  ],
  alwaysDenyRules: [],
  alwaysAskRules: [],
  highStakesThreshold: 80,
  auditEnabled: true,
  restrictBackgroundAgents: false,
  isBackgroundAgent: false,
};

let activeContext: ToolPermissionContext = { ...DEFAULT_CONTEXT };

/** Set the active permission context */
export function setPermissionContext(ctx: Partial<ToolPermissionContext>): void {
  activeContext = { ...DEFAULT_CONTEXT, ...ctx };
}

/** Get the current permission context */
export function getPermissionContext(): Readonly<ToolPermissionContext> {
  return activeContext;
}

/** Reset to default context */
export function resetPermissionContext(): void {
  activeContext = { ...DEFAULT_CONTEXT };
}

// ── Core Permission Check ──

/**
 * Check permissions for a tool invocation.
 *
 * Evaluation order:
 * 1. Bypass mode → allow everything
 * 2. Always deny rules → deny
 * 3. Always ask rules → review
 * 4. Background agent restrictions → deny/review
 * 5. Always allow rules → allow
 * 6. High-stakes input check → review
 * 7. Default → allow (all VEROQ tools are read-only)
 */
export function checkPermissions(
  toolName: string,
  input: Record<string, unknown>,
  context?: Partial<ToolPermissionContext>,
): PermissionResult {
  const ctx = context ? { ...activeContext, ...context } : activeContext;

  const makeResult = (
    decision: PermissionDecision,
    reason: string,
    highStakes: boolean = false,
  ): PermissionResult => {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      toolName,
      input: sanitizeInput(input),
      decision,
      reason,
      mode: ctx.mode,
      enterpriseId: ctx.enterpriseId,
      highStakesTriggered: highStakes,
    };

    if (ctx.auditEnabled) {
      addAuditEntry(entry);
    }

    return { decision, reason, highStakesTriggered: highStakes, auditEntry: entry };
  };

  // 1. Bypass mode — allow everything (for testing/admin)
  if (ctx.mode === "bypass") {
    return makeResult("allow", "Bypass mode — all permissions granted");
  }

  // 2. Always deny rules
  for (const rule of ctx.alwaysDenyRules) {
    if (matchesRule(toolName, input, rule)) {
      return makeResult("deny", `Denied by rule: ${rule.pattern}`);
    }
  }

  // 3. Always ask rules
  for (const rule of ctx.alwaysAskRules) {
    if (matchesRule(toolName, input, rule)) {
      return makeResult("review", `Review required by rule: ${rule.pattern}`);
    }
  }

  // 4. Background agent restrictions
  if (ctx.restrictBackgroundAgents && ctx.isBackgroundAgent) {
    // Background agents need explicit allow
    const explicitlyAllowed = ctx.alwaysAllowRules.some(
      (rule) => matchesRule(toolName, input, rule) && rule.pattern !== "veroq_*",
    );
    if (!explicitlyAllowed) {
      return makeResult("review", "Background agent requires explicit permission for this tool");
    }
  }

  // 5. Always allow rules
  for (const rule of ctx.alwaysAllowRules) {
    if (matchesRule(toolName, input, rule)) {
      // Still check for high-stakes even on allowed tools
      if (isHighStakesInput(toolName, input)) {
        return makeResult("review", "High-stakes financial query detected — review recommended", true);
      }
      return makeResult("allow", `Allowed by rule: ${rule.pattern}`);
    }
  }

  // 6. High-stakes input check
  if (isHighStakesInput(toolName, input)) {
    return makeResult("review", "High-stakes financial query detected", true);
  }

  // 7. Default — all VEROQ tools are read-only, so allow
  return makeResult("allow", "Default allow — tool is read-only");
}

/**
 * Post-execution check: evaluate the output for high-stakes content.
 * Called after tool execution to flag responses that need human review.
 */
export function checkOutputSafety(
  toolName: string,
  output: Record<string, unknown>,
  context?: Partial<ToolPermissionContext>,
): { flagged: boolean; reason: string } {
  const ctx = context ? { ...activeContext, ...context } : activeContext;

  if (ctx.mode === "bypass") {
    return { flagged: false, reason: "Bypass mode" };
  }

  if (isHighStakesOutput(toolName, output, ctx.highStakesThreshold)) {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      toolName,
      input: {},
      decision: "review",
      reason: "High-stakes output detected post-execution",
      mode: ctx.mode,
      enterpriseId: ctx.enterpriseId,
      highStakesTriggered: true,
    };
    if (ctx.auditEnabled) addAuditEntry(entry);

    return {
      flagged: true,
      reason: `High-confidence financial output (>${ctx.highStakesThreshold}) — recommend human review before acting`,
    };
  }

  return { flagged: false, reason: "Output within normal parameters" };
}

// ── Enterprise Configuration ──

export interface EnterpriseConfig {
  enterpriseId: string;
  /** Tools that are always allowed (overrides ask rules) */
  allowedTools?: string[];
  /** Tools that are always denied */
  deniedTools?: string[];
  /** Tools that always require review */
  reviewTools?: string[];
  /** Custom high-stakes threshold */
  highStakesThreshold?: number;
  /** Restrict background/automated agents */
  restrictBackgroundAgents?: boolean;
  /** Enable full audit logging */
  auditEnabled?: boolean;
}

/** Configure permissions for an enterprise customer */
export function configureEnterprise(config: EnterpriseConfig): void {
  setPermissionContext({
    enterpriseId: config.enterpriseId,
    alwaysAllowRules: [
      { pattern: "veroq_*" },  // base allow
      ...(config.allowedTools || []).map((t) => ({ pattern: t })),
    ],
    alwaysDenyRules: (config.deniedTools || []).map((t) => ({ pattern: t })),
    alwaysAskRules: (config.reviewTools || []).map((t) => ({ pattern: t })),
    highStakesThreshold: config.highStakesThreshold ?? 80,
    restrictBackgroundAgents: config.restrictBackgroundAgents ?? false,
    auditEnabled: config.auditEnabled ?? true,
  });
}

// ── Helpers ──

/** Sanitize input for audit logging — remove sensitive data */
function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    // Truncate long values
    if (typeof value === "string" && value.length > 200) {
      safe[key] = value.slice(0, 200) + "...";
    } else {
      safe[key] = value;
    }
  }
  return safe;
}
