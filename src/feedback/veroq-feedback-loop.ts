// ============================================================
// VEROQ Feedback Loop — Self-improvement with web search fallback
// ============================================================
// Captures low-confidence outputs, contradictions, escalations,
// and data gaps. Routes flagged items to web search for
// enrichment, then to the Polaris pipeline for reprocessing.
// Fully opt-in, privacy-safe, non-blocking.
// ============================================================

import type { SwarmStepResult, SwarmResult, SwarmRole } from "../swarm/veroq-verified-swarm.js";
import type { DecisionLineage } from "../safety/veroq-permission-engine.js";

// ── Types ──

export type FeedbackReason =
  | "low_confidence"
  | "contradicted"
  | "escalated"
  | "data_gap"
  | "verification_failed"
  | "user_submitted"
  | "manual";

export interface FeedbackEntry {
  id: string;
  sessionId: string;
  enterpriseId?: string;
  timestamp: string;
  /** Original query that produced the flagged output */
  query: string;
  /** Which swarm step was flagged */
  stepRole: SwarmRole | string;
  stepAgent: string;
  /** Why this was flagged */
  reason: FeedbackReason;
  reasonDetail: string;
  /** Output confidence at time of flagging */
  confidence: number;
  /** Sanitized output summary (PII redacted) */
  outputSummary: string;
  /** Claims that were flagged */
  flaggedClaims: string[];
  /** Gaps identified (missing data categories) */
  gaps: string[];
  /** Decision lineage snapshot */
  lineage?: DecisionLineage;
  /** Web search results used for enrichment */
  webSearchResults?: WebSearchFallbackResult;
  /** Whether this was routed to the pipeline */
  routedToPipeline: boolean;
  /** Pipeline response (if routed) */
  pipelineResponse?: Record<string, unknown>;
  /** Resolution status */
  status: "pending" | "enriched" | "routed" | "resolved" | "dismissed";
}

export interface WebSearchFallbackResult {
  query: string;
  resultCount: number;
  sources: Array<{ title: string; url: string; snippet: string }>;
  timestamp: string;
  latencyMs: number;
}

export interface FeedbackConfig {
  /** Enable the self-improvement loop (default: false — opt-in) */
  enableSelfImprovement: boolean;
  /** Confidence threshold below which outputs are flagged (default: 70) */
  feedbackThreshold: number;
  /** Automatically route flagged items to the pipeline (default: false) */
  autoRouteToPipeline: boolean;
  /** Use web search as fallback when data gaps detected (default: true) */
  enableWebSearchFallback: boolean;
  /** Max feedback entries per session (default: 100) */
  maxEntriesPerSession: number;
  /** Enterprise ID for audit trail */
  enterpriseId?: string;
  /** Web search function (injected — keeps module testable without real HTTP) */
  webSearchFn?: (query: string) => Promise<WebSearchFallbackResult>;
  /** Pipeline routing function (injected) */
  pipelineRouteFn?: (entry: FeedbackEntry) => Promise<Record<string, unknown>>;
}

export interface FeedbackMetrics {
  totalFeedback: number;
  byReason: Record<FeedbackReason, number>;
  webSearchFallbacks: number;
  webSearchSuccessRate: number;
  pipelineRouted: number;
  avgFlaggedConfidence: number;
  resolvedCount: number;
  pendingCount: number;
}

// ── Constants ──

const DEFAULT_CONFIG: FeedbackConfig = {
  enableSelfImprovement: false,
  feedbackThreshold: 70,
  autoRouteToPipeline: false,
  enableWebSearchFallback: true,
  maxEntriesPerSession: 100,
};

// Patterns that indicate data gaps
const GAP_PATTERNS = [
  { pattern: /no\s+(data|information|results)\s+(available|found)/i, gap: "missing_data" },
  { pattern: /unverifiable/i, gap: "unverifiable_claim" },
  { pattern: /insufficient\s+(sources|evidence)/i, gap: "insufficient_evidence" },
  { pattern: /unable\s+to\s+(verify|confirm)/i, gap: "verification_failure" },
  { pattern: /no\s+briefs?\s+found/i, gap: "coverage_gap" },
  { pattern: /no\s+matching/i, gap: "no_matches" },
];

// Sensitive patterns to redact
const SENSITIVE_PATTERNS = [
  /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g,           // SSN-like
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,  // Email
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,  // Card numbers
];

// ── Feedback Store ──

const feedbackStore: FeedbackEntry[] = [];
const MAX_STORE_SIZE = 10_000;
let webSearchAttempts = 0;
let webSearchSuccesses = 0;

function generateFeedbackId(): string {
  return `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function redactSensitive(text: string): string {
  let redacted = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

function detectGaps(output: Record<string, unknown>, summary: string): string[] {
  const gaps: string[] = [];
  const text = summary + " " + JSON.stringify(output).slice(0, 2000);
  for (const { pattern, gap } of GAP_PATTERNS) {
    if (pattern.test(text)) gaps.push(gap);
  }
  // Check for empty/missing data sections
  if (!output.summary && !output.data) gaps.push("empty_response");
  const data = output.data as Record<string, unknown> | undefined;
  if (data && Object.keys(data).length === 0) gaps.push("empty_data");
  return [...new Set(gaps)];
}

function addEntry(entry: FeedbackEntry): void {
  feedbackStore.push(entry);
  if (feedbackStore.length > MAX_STORE_SIZE) {
    feedbackStore.splice(0, feedbackStore.length - MAX_STORE_SIZE);
  }
}

// ── Core Feedback Collection ──

/**
 * Analyze a swarm result and collect feedback for any flagged steps.
 * Non-blocking — runs asynchronously, never throws.
 */
export async function collectSwarmFeedback(
  result: SwarmResult,
  config: Partial<FeedbackConfig> = {},
): Promise<FeedbackEntry[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enableSelfImprovement) return [];

  const entries: FeedbackEntry[] = [];
  let sessionCount = feedbackStore.filter(e => e.sessionId === result.sessionId).length;

  for (const step of result.steps) {
    if (sessionCount >= cfg.maxEntriesPerSession) break;

    const flags = analyzeStep(step, cfg.feedbackThreshold);
    if (flags.length === 0) continue;

    for (const flag of flags) {
      const gaps = detectGaps(step.output.data, step.output.summary || "");
      const entry: FeedbackEntry = {
        id: generateFeedbackId(),
        sessionId: result.sessionId,
        enterpriseId: cfg.enterpriseId,
        timestamp: new Date().toISOString(),
        query: result.query,
        stepRole: step.agent.role,
        stepAgent: step.agent.name,
        reason: flag.reason,
        reasonDetail: flag.detail,
        confidence: step.output.confidence ?? 0,
        outputSummary: redactSensitive((step.output.summary || "").slice(0, 500)),
        flaggedClaims: (step.output.claims || []).map(c => redactSensitive(c)),
        gaps,
        lineage: step.lineage,
        routedToPipeline: false,
        status: "pending",
      };

      // Web search fallback for data gaps
      if (cfg.enableWebSearchFallback && gaps.length > 0 && cfg.webSearchFn) {
        try {
          webSearchAttempts++;
          const searchResult = await cfg.webSearchFn(result.query);
          entry.webSearchResults = searchResult;
          if (searchResult.resultCount > 0) {
            webSearchSuccesses++;
            entry.status = "enriched";
          }
        } catch {
          // Non-blocking — web search failure is not critical
        }
      }

      // Auto-route to pipeline
      if (cfg.autoRouteToPipeline && cfg.pipelineRouteFn) {
        try {
          const pipelineResult = await cfg.pipelineRouteFn(entry);
          entry.pipelineResponse = pipelineResult;
          entry.routedToPipeline = true;
          entry.status = "routed";
        } catch {
          // Non-blocking
        }
      }

      addEntry(entry);
      entries.push(entry);
      sessionCount++;
    }
  }

  return entries;
}

/** Analyze a single step for flagging conditions */
function analyzeStep(
  step: SwarmStepResult,
  threshold: number,
): Array<{ reason: FeedbackReason; detail: string }> {
  const flags: Array<{ reason: FeedbackReason; detail: string }> = [];

  // 1. Low confidence
  const conf = step.output.confidence ?? 0;
  if (conf > 0 && conf < threshold) {
    flags.push({
      reason: "low_confidence",
      detail: `${step.agent.name} output confidence ${conf}/100 below threshold ${threshold}`,
    });
  }

  // 2. Contradicted verification
  const verdict = step.output.data?.verdict;
  if (verdict === "contradicted") {
    flags.push({
      reason: "contradicted",
      detail: `${step.agent.name} verification returned "contradicted"`,
    });
  }

  // 3. Escalated output
  if (step.escalated) {
    flags.push({
      reason: "escalated",
      detail: step.escalationNotice || `${step.agent.name} triggered escalation`,
    });
  }

  // 4. Verification failed / flagged
  if (step.verification?.verificationStatus === "low-confidence") {
    flags.push({
      reason: "verification_failed",
      detail: `${step.agent.name} verification status: low-confidence (${step.verification.confidenceScore}/100)`,
    });
  }

  // 5. Data gaps
  const summary = step.output.summary || "";
  const hasGap = GAP_PATTERNS.some(({ pattern }) => pattern.test(summary));
  if (hasGap) {
    flags.push({
      reason: "data_gap",
      detail: `${step.agent.name} output contains data gap indicators`,
    });
  }

  return flags;
}

// ── Manual Feedback Submission ──

/**
 * Submit feedback manually (from SDK or MCP tool).
 */
export function submitFeedback(feedback: {
  sessionId: string;
  enterpriseId?: string;
  query: string;
  reason: FeedbackReason;
  detail: string;
  claims?: string[];
  confidence?: number;
}): FeedbackEntry {
  const entry: FeedbackEntry = {
    id: generateFeedbackId(),
    sessionId: feedback.sessionId,
    enterpriseId: feedback.enterpriseId,
    timestamp: new Date().toISOString(),
    query: redactSensitive(feedback.query),
    stepRole: "custom",
    stepAgent: "user",
    reason: feedback.reason,
    reasonDetail: redactSensitive(feedback.detail),
    confidence: feedback.confidence ?? 0,
    outputSummary: "",
    flaggedClaims: (feedback.claims || []).map(c => redactSensitive(c)),
    gaps: [],
    routedToPipeline: false,
    status: "pending",
  };

  addEntry(entry);
  return entry;
}

// ── Query & Resolution ──

/** Get feedback entries, optionally filtered */
export function getFeedbackQueue(filters?: {
  sessionId?: string;
  enterpriseId?: string;
  status?: FeedbackEntry["status"];
  reason?: FeedbackReason;
  limit?: number;
}): readonly FeedbackEntry[] {
  let entries = [...feedbackStore];

  if (filters?.sessionId) entries = entries.filter(e => e.sessionId === filters.sessionId);
  if (filters?.enterpriseId) entries = entries.filter(e => e.enterpriseId === filters.enterpriseId);
  if (filters?.status) entries = entries.filter(e => e.status === filters.status);
  if (filters?.reason) entries = entries.filter(e => e.reason === filters.reason);

  const limit = filters?.limit ?? 100;
  return entries.slice(-limit).reverse();
}

/** Resolve a feedback entry */
export function resolveFeedback(id: string, resolution: "resolved" | "dismissed"): boolean {
  const entry = feedbackStore.find(e => e.id === id);
  if (!entry) return false;
  entry.status = resolution;
  return true;
}

// ── Metrics ──

/** Get feedback metrics for observability */
export function getFeedbackMetrics(): FeedbackMetrics {
  const byReason: Record<string, number> = {};
  let totalConf = 0;
  let confCount = 0;
  let resolved = 0;
  let pending = 0;
  let routed = 0;

  for (const entry of feedbackStore) {
    byReason[entry.reason] = (byReason[entry.reason] || 0) + 1;
    if (entry.confidence > 0) {
      totalConf += entry.confidence;
      confCount++;
    }
    if (entry.status === "resolved") resolved++;
    if (entry.status === "pending") pending++;
    if (entry.routedToPipeline) routed++;
  }

  return {
    totalFeedback: feedbackStore.length,
    byReason: byReason as Record<FeedbackReason, number>,
    webSearchFallbacks: webSearchAttempts,
    webSearchSuccessRate: webSearchAttempts > 0 ? Math.round((webSearchSuccesses / webSearchAttempts) * 100) : 0,
    pipelineRouted: routed,
    avgFlaggedConfidence: confCount > 0 ? Math.round(totalConf / confCount) : 0,
    resolvedCount: resolved,
    pendingCount: pending,
  };
}

// ── Reset (for testing) ──

export function resetFeedback(): void {
  feedbackStore.length = 0;
  webSearchAttempts = 0;
  webSearchSuccesses = 0;
}
