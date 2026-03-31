// ============================================================
// VEROQ Permission Engine — Centralized safety & permission control
// ============================================================
// Applies to all MCP tools via the tool factory. Handles:
// - Allow/deny/ask rules with wildcard support
// - High-stakes financial output flagging
// - Decision lineage (full rule evaluation trace)
// - Human-in-the-loop escalation
// - Audit logging with session tracking
// - Background agent restrictions
// - Enterprise configuration
// ============================================================

// ── Types ──

export type PermissionMode = "default" | "plan" | "bypass";

export type PermissionDecision = "allow" | "deny" | "review" | "escalate";

export interface PermissionRule {
  /** Tool name pattern — supports wildcards: "veroq_*", "veroq_ticker_*", exact "veroq_ask" */
  pattern: string;
  /** Optional input field conditions: { "ticker": "AAPL" } or { "fast": true } */
  conditions?: Record<string, unknown>;
}

/** Record of a single rule evaluation during a permission check */
export interface RuleEvaluation {
  ruleType: "deny" | "ask" | "allow" | "background" | "high-stakes-input" | "high-stakes-output" | "escalation";
  pattern: string;
  matched: boolean;
  result: PermissionDecision | "skipped";
}

/** Full decision lineage for a permission check */
export interface DecisionLineage {
  toolName: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  rulesEvaluated: RuleEvaluation[];
  confidenceFactors: Record<string, unknown>;
  finalDecision: PermissionDecision;
  finalReason: string;
  escalated: boolean;
  escalationReason?: string;
  sessionId?: string;
  timestamp: string;
  durationMs: number;
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
  /** Session ID for grouping related audit entries */
  sessionId?: string;
  /** Escalation threshold — trade signals or confidence above this trigger human-in-the-loop (default: 80) */
  escalationThreshold: number;
  /** Tools that always trigger escalation when they produce high-stakes output */
  escalationTools: string[];
  /** Whether to pause/flag the response on escalation (default: false — just append notice) */
  escalationPauses: boolean;
}

export interface AuditEntry {
  timestamp: string;
  toolName: string;
  input: Record<string, unknown>;
  decision: PermissionDecision;
  reason: string;
  mode: PermissionMode;
  enterpriseId?: string;
  sessionId?: string;
  highStakesTriggered: boolean;
  escalated: boolean;
  lineage?: DecisionLineage;
  executionTimeMs?: number;
}

export interface PermissionResult {
  decision: PermissionDecision;
  reason: string;
  highStakesTriggered: boolean;
  escalated: boolean;
  escalationNotice?: string;
  lineage: DecisionLineage;
  auditEntry?: AuditEntry;
}

// ── High-Stakes Detection ──

const HIGH_STAKES_TOOLS = new Set([
  "veroq_ask", "veroq_verify", "veroq_analyze_ticker",
  "veroq_verify_market_claim", "veroq_generate_trading_signal",
]);

function isHighStakesInput(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "veroq_ask" || toolName === "veroq_analyze_ticker") {
    const question = String(input.question || input.q || input.ticker || "").toLowerCase();
    return /\bshould\s+(i|we)\s+(buy|sell|trade|invest|short)\b/i.test(question) ||
           /\btrade\s+signal\b/i.test(question) ||
           /\bposition\s+size\b/i.test(question);
  }
  if (toolName === "veroq_verify" || toolName === "veroq_verify_market_claim") {
    const claim = String(input.claim || "").toLowerCase();
    return /\bearnings|revenue|acquisition|merger|bankrupt|fraud|sec\s+filing/i.test(claim);
  }
  if (toolName === "veroq_generate_trading_signal") return true;
  return false;
}

export function isHighStakesOutput(
  toolName: string,
  output: Record<string, unknown>,
  threshold: number = 80,
): boolean {
  const tradeSignal = output.trade_signal as { score?: number; action?: string } | undefined;
  if (tradeSignal?.score != null && tradeSignal.score > threshold) return true;
  const confidence = output.confidence as number | undefined;
  if (toolName.includes("verify") && confidence != null && confidence * 100 > threshold) return true;
  const confLevel = (output.confidence as { level?: string })?.level;
  if (confLevel === "high" && HIGH_STAKES_TOOLS.has(toolName)) return true;
  return false;
}

// ── Escalation Detection ──

function shouldEscalate(
  toolName: string,
  output: Record<string, unknown>,
  ctx: ToolPermissionContext,
): { escalate: boolean; reason: string } {
  // Check if tool is in escalation list
  const inEscalationList = ctx.escalationTools.some(pattern => matchesPattern(toolName, pattern));

  // Check trade signal above escalation threshold
  const ts = output.trade_signal as { score?: number; action?: string } | undefined;
  if (ts?.score != null && ts.score > ctx.escalationThreshold) {
    const action = ts.action || "unknown";
    if (inEscalationList || ["buy", "sell", "strong_buy", "strong_sell"].includes(action)) {
      return {
        escalate: true,
        reason: `Trade signal ${action.toUpperCase()} (${ts.score}/100) exceeds escalation threshold (${ctx.escalationThreshold}). Human review recommended before executing.`,
      };
    }
  }

  // Check verification confidence above threshold
  const conf = output.confidence as number | undefined;
  if (toolName.includes("verify") && conf != null && conf * 100 > ctx.escalationThreshold) {
    const verdict = output.verdict as string;
    if (verdict === "contradicted" || verdict === "supported") {
      return {
        escalate: true,
        reason: `Verification ${verdict.toUpperCase()} with ${Math.round(conf * 100)}% confidence exceeds escalation threshold. Review evidence chain before acting.`,
      };
    }
  }

  // Explicit escalation tools
  if (inEscalationList && isHighStakesOutput(toolName, output, ctx.escalationThreshold)) {
    return {
      escalate: true,
      reason: `Tool "${toolName}" is in escalation list and produced high-stakes output.`,
    };
  }

  return { escalate: false, reason: "" };
}

// ── Wildcard Matching ──

function matchesPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;
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
  if (auditLog.length > MAX_AUDIT_SIZE) {
    auditLog.splice(0, auditLog.length - MAX_AUDIT_SIZE);
  }
}

export function getAuditLog(limit: number = 100): readonly AuditEntry[] {
  return auditLog.slice(-limit).reverse();
}

export function clearAuditLog(): void {
  auditLog.length = 0;
}

/** Get full audit trail filtered by session ID */
export function getFullAuditTrail(sessionId?: string): readonly AuditEntry[] {
  if (!sessionId) return [...auditLog].reverse();
  return auditLog.filter(e => e.sessionId === sessionId).reverse();
}

// ── Default Context ──

const DEFAULT_CONTEXT: ToolPermissionContext = {
  mode: "default",
  alwaysAllowRules: [{ pattern: "veroq_*" }],
  alwaysDenyRules: [],
  alwaysAskRules: [],
  highStakesThreshold: 80,
  auditEnabled: true,
  restrictBackgroundAgents: false,
  isBackgroundAgent: false,
  escalationThreshold: 80,
  escalationTools: ["veroq_ask", "veroq_verify", "veroq_generate_trading_signal"],
  escalationPauses: false,
};

let activeContext: ToolPermissionContext = { ...DEFAULT_CONTEXT };

export function setPermissionContext(ctx: Partial<ToolPermissionContext>): void {
  activeContext = { ...DEFAULT_CONTEXT, ...ctx };
}

export function getPermissionContext(): Readonly<ToolPermissionContext> {
  return activeContext;
}

export function resetPermissionContext(): void {
  activeContext = { ...DEFAULT_CONTEXT };
}

// ── Core Permission Check (with lineage) ──

export function checkPermissions(
  toolName: string,
  input: Record<string, unknown>,
  context?: Partial<ToolPermissionContext>,
): PermissionResult {
  const startTime = Date.now();
  const ctx = context ? { ...activeContext, ...context } : activeContext;
  const rulesEvaluated: RuleEvaluation[] = [];

  const makeResult = (
    decision: PermissionDecision,
    reason: string,
    highStakes: boolean = false,
  ): PermissionResult => {
    const lineage: DecisionLineage = {
      toolName,
      input: sanitizeInput(input),
      rulesEvaluated,
      confidenceFactors: {},
      finalDecision: decision,
      finalReason: reason,
      escalated: false,
      sessionId: ctx.sessionId,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };

    const entry: AuditEntry = {
      timestamp: lineage.timestamp,
      toolName,
      input: lineage.input,
      decision,
      reason,
      mode: ctx.mode,
      enterpriseId: ctx.enterpriseId,
      sessionId: ctx.sessionId,
      highStakesTriggered: highStakes,
      escalated: false,
      lineage,
    };

    if (ctx.auditEnabled) addAuditEntry(entry);

    return { decision, reason, highStakesTriggered: highStakes, escalated: false, lineage, auditEntry: entry };
  };

  // 1. Bypass
  if (ctx.mode === "bypass") {
    rulesEvaluated.push({ ruleType: "deny", pattern: "*", matched: false, result: "skipped" });
    return makeResult("allow", "Bypass mode — all permissions granted");
  }

  // 2. Deny rules
  for (const rule of ctx.alwaysDenyRules) {
    const matched = matchesRule(toolName, input, rule);
    rulesEvaluated.push({ ruleType: "deny", pattern: rule.pattern, matched, result: matched ? "deny" : "skipped" });
    if (matched) return makeResult("deny", `Denied by rule: ${rule.pattern}`);
  }

  // 3. Ask rules
  for (const rule of ctx.alwaysAskRules) {
    const matched = matchesRule(toolName, input, rule);
    rulesEvaluated.push({ ruleType: "ask", pattern: rule.pattern, matched, result: matched ? "review" : "skipped" });
    if (matched) return makeResult("review", `Review required by rule: ${rule.pattern}`);
  }

  // 4. Background agent restrictions
  if (ctx.restrictBackgroundAgents && ctx.isBackgroundAgent) {
    const explicitlyAllowed = ctx.alwaysAllowRules.some(
      (rule) => matchesRule(toolName, input, rule) && rule.pattern !== "veroq_*",
    );
    rulesEvaluated.push({ ruleType: "background", pattern: "background-check", matched: !explicitlyAllowed, result: explicitlyAllowed ? "skipped" : "review" });
    if (!explicitlyAllowed) {
      return makeResult("review", "Background agent requires explicit permission for this tool");
    }
  }

  // 5. Allow rules
  for (const rule of ctx.alwaysAllowRules) {
    const matched = matchesRule(toolName, input, rule);
    rulesEvaluated.push({ ruleType: "allow", pattern: rule.pattern, matched, result: matched ? "allow" : "skipped" });
    if (matched) {
      // Still check high-stakes
      const isHS = isHighStakesInput(toolName, input);
      rulesEvaluated.push({ ruleType: "high-stakes-input", pattern: toolName, matched: isHS, result: isHS ? "review" : "skipped" });
      if (isHS) {
        return makeResult("review", "High-stakes financial query detected — review recommended", true);
      }
      return makeResult("allow", `Allowed by rule: ${rule.pattern}`);
    }
  }

  // 6. High-stakes
  const isHS = isHighStakesInput(toolName, input);
  rulesEvaluated.push({ ruleType: "high-stakes-input", pattern: toolName, matched: isHS, result: isHS ? "review" : "skipped" });
  if (isHS) return makeResult("review", "High-stakes financial query detected", true);

  // 7. Default
  return makeResult("allow", "Default allow — tool is read-only");
}

// ── Post-Execution Check (with escalation) ──

export function checkOutputSafety(
  toolName: string,
  output: Record<string, unknown>,
  context?: Partial<ToolPermissionContext>,
): { flagged: boolean; reason: string; escalated: boolean; escalationNotice?: string } {
  const ctx = context ? { ...activeContext, ...context } : activeContext;

  if (ctx.mode === "bypass") {
    return { flagged: false, reason: "Bypass mode", escalated: false };
  }

  const isHS = isHighStakesOutput(toolName, output, ctx.highStakesThreshold);
  const esc = shouldEscalate(toolName, output, ctx);

  if (esc.escalate) {
    const notice = ctx.escalationPauses
      ? `🛑 ESCALATION REQUIRED: ${esc.reason} This response has been paused pending human review.`
      : `⚠️ ESCALATION NOTICE: ${esc.reason}`;

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      toolName,
      input: {},
      decision: "escalate",
      reason: esc.reason,
      mode: ctx.mode,
      enterpriseId: ctx.enterpriseId,
      sessionId: ctx.sessionId,
      highStakesTriggered: true,
      escalated: true,
    };
    if (ctx.auditEnabled) addAuditEntry(entry);

    return { flagged: true, reason: esc.reason, escalated: true, escalationNotice: notice };
  }

  if (isHS) {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      toolName,
      input: {},
      decision: "review",
      reason: "High-stakes output detected post-execution",
      mode: ctx.mode,
      enterpriseId: ctx.enterpriseId,
      sessionId: ctx.sessionId,
      highStakesTriggered: true,
      escalated: false,
    };
    if (ctx.auditEnabled) addAuditEntry(entry);

    return {
      flagged: true,
      reason: `High-confidence financial output (>${ctx.highStakesThreshold}) — recommend human review before acting`,
      escalated: false,
    };
  }

  return { flagged: false, reason: "Output within normal parameters", escalated: false };
}

// ── Decision Lineage ──

/**
 * Get the full decision lineage for a tool invocation.
 * Runs the permission check and optionally evaluates output safety.
 */
export function getDecisionLineage(
  toolName: string,
  input: Record<string, unknown>,
  output?: Record<string, unknown>,
): DecisionLineage {
  const permResult = checkPermissions(toolName, input);
  const lineage = { ...permResult.lineage };

  if (output) {
    lineage.output = sanitizeInput(output);

    // Add output safety evaluation
    const safety = checkOutputSafety(toolName, output);
    if (safety.flagged) {
      lineage.rulesEvaluated.push({
        ruleType: "high-stakes-output",
        pattern: toolName,
        matched: true,
        result: safety.escalated ? "escalate" : "review",
      });
    }
    if (safety.escalated) {
      lineage.escalated = true;
      lineage.escalationReason = safety.reason;
    }

    // Extract confidence factors from output
    const ts = output.trade_signal as { score?: number; action?: string } | undefined;
    if (ts) lineage.confidenceFactors.tradeSignal = ts;
    const conf = output.confidence;
    if (conf) lineage.confidenceFactors.confidence = conf;
    const cb = output.confidence_breakdown;
    if (cb) lineage.confidenceFactors.breakdown = cb;
    const chain = output.evidence_chain;
    if (chain) lineage.confidenceFactors.evidenceCount = (chain as unknown[]).length;
  }

  return lineage;
}

// ── Enterprise Configuration ──

export interface EnterpriseConfig {
  enterpriseId: string;
  allowedTools?: string[];
  deniedTools?: string[];
  reviewTools?: string[];
  highStakesThreshold?: number;
  restrictBackgroundAgents?: boolean;
  auditEnabled?: boolean;
  /** Escalation threshold for human-in-the-loop (default: 80) */
  escalationThreshold?: number;
  /** Tools that trigger escalation on high-stakes output */
  escalationTools?: string[];
  /** Whether escalation pauses the response (default: false) */
  escalationPauses?: boolean;
  /** Session ID for grouping audit entries */
  sessionId?: string;
  /** Enable self-improvement feedback loop for swarms (default: false) */
  enableSelfImprovement?: boolean;
  /** Confidence threshold for flagging feedback (default: 70) */
  feedbackThreshold?: number;
  /** Auto-route flagged items to pipeline (default: false) */
  autoRouteToPipeline?: boolean;
  /** Enable web search fallback for data gaps (default: true) */
  enableWebSearchFallback?: boolean;
}

export function configureEnterprise(config: EnterpriseConfig): void {
  setPermissionContext({
    enterpriseId: config.enterpriseId,
    sessionId: config.sessionId,
    alwaysAllowRules: [
      { pattern: "veroq_*" },
      ...(config.allowedTools || []).map((t) => ({ pattern: t })),
    ],
    alwaysDenyRules: (config.deniedTools || []).map((t) => ({ pattern: t })),
    alwaysAskRules: (config.reviewTools || []).map((t) => ({ pattern: t })),
    highStakesThreshold: config.highStakesThreshold ?? 80,
    restrictBackgroundAgents: config.restrictBackgroundAgents ?? false,
    auditEnabled: config.auditEnabled ?? true,
    escalationThreshold: config.escalationThreshold ?? 80,
    escalationTools: config.escalationTools ?? ["veroq_ask", "veroq_verify", "veroq_generate_trading_signal"],
    escalationPauses: config.escalationPauses ?? false,
  });
}

// ── Helpers ──

function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 200) {
      safe[key] = value.slice(0, 200) + "...";
    } else {
      safe[key] = value;
    }
  }
  return safe;
}
