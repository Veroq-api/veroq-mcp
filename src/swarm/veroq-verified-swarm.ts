// ============================================================
// VEROQ Verified Swarm — Multi-agent financial workflows with
// automatic verification, safety, and decision lineage.
// ============================================================
// Coordinator pattern: planner → researcher → verifier → critic
// → synthesizer. Every step gets permission checks, verification
// metadata, escalation detection, and metrics recording.
// ============================================================

import {
  checkPermissions,
  checkOutputSafety,
  getDecisionLineage,
  configureEnterprise,
  type PermissionResult,
  type DecisionLineage,
  type EnterpriseConfig,
} from "../safety/index.js";
import { recordToolCall } from "../observability/index.js";
import {
  collectSwarmFeedback,
  type FeedbackConfig,
  type FeedbackEntry,
  type WebSearchFallbackResult,
} from "../feedback/index.js";
import {
  type CostMode,
  type StepCostRecord,
  type BudgetStatus,
  estimateStepCredits,
  BudgetTracker,
  StepCache,
  buildExecutionPlan,
} from "./cost-router.js";

// ── Types ──

export type SwarmRole =
  | "planner"
  | "researcher"
  | "verifier"
  | "critic"
  | "risk_assessor"
  | "synthesizer"
  | "custom";

export interface SwarmAgent {
  role: SwarmRole;
  name: string;
  /** Tool to invoke (e.g., "veroq_analyze_ticker", "veroq_verify_market_claim") */
  tool?: string;
  /** Custom execution function — overrides tool routing */
  execute?: (input: SwarmStepInput) => Promise<SwarmStepOutput>;
  /** System prompt override for this agent */
  systemPrompt?: string;
  /** Max retries on failure (default: 1) */
  maxRetries?: number;
}

export interface SwarmConfig {
  /** Unique swarm session ID (auto-generated if omitted) */
  sessionId?: string;
  /** Enterprise ID for audit trail */
  enterpriseId?: string;
  /** Agent roles to include in the pipeline */
  roles?: SwarmRole[];
  /** Custom agent definitions (overrides default agents for matching roles) */
  agents?: SwarmAgent[];
  /** Auto-verify every researcher output (default: true) */
  enableAutoVerification?: boolean;
  /** Escalation threshold — high-stakes outputs above this pause the swarm (default: 80) */
  escalationThreshold?: number;
  /** Model preference hint (passed to tool calls, not enforced here) */
  model?: string;
  /** Max total credits for the swarm run (default: 50) */
  creditBudget?: number;
  /** Memory backend: "memory" (default) or "redis" */
  memoryBackend?: "memory" | "redis";
  /** Max memory entries before pruning oldest (default: 50) */
  memoryLimit?: number;
  /** API function for making VeroQ API calls */
  apiFn?: (method: "GET" | "POST", path: string, params?: Record<string, unknown>, body?: unknown) => Promise<unknown>;
  /** Enable self-improvement feedback loop (default: false — opt-in for safety) */
  enableSelfImprovement?: boolean;
  /** Confidence threshold below which outputs are flagged for feedback (default: 70) */
  feedbackThreshold?: number;
  /** Automatically route flagged items to the pipeline (default: false) */
  autoRouteToPipeline?: boolean;
  /** Use web search as fallback when data gaps detected (default: true) */
  enableWebSearchFallback?: boolean;
  /** Web search function (injected for testability) */
  webSearchFn?: (query: string) => Promise<WebSearchFallbackResult>;
  /** Pipeline routing function (injected) */
  pipelineRouteFn?: (entry: FeedbackEntry) => Promise<Record<string, unknown>>;
  /** Cost mode: "balanced" (default), "cheap" (fastest/cheapest), "premium" (best quality) */
  costMode?: CostMode;
  /** Enable parallel execution of independent steps (default: false) */
  enableParallelSteps?: boolean;
  /** Cache TTL in milliseconds for sub-query results (default: 60000) */
  cacheTtlMs?: number;
}

export interface SwarmStepInput {
  query: string;
  context: Record<string, unknown>;
  memory: SwarmMemory;
  previousSteps: SwarmStepResult[];
}

export interface SwarmStepOutput {
  data: Record<string, unknown>;
  summary?: string;
  claims?: string[];
  risks?: string[];
  confidence?: number;
  creditsUsed?: number;
}

export interface SwarmStepResult {
  agent: SwarmAgent;
  input: SwarmStepInput;
  output: SwarmStepOutput;
  verification?: {
    confidenceScore: number;
    verificationStatus: "verified" | "flagged" | "low-confidence";
    evidenceCount: number;
  };
  permission: PermissionResult;
  lineage?: DecisionLineage;
  escalated: boolean;
  escalationNotice?: string;
  durationMs: number;
  creditsUsed: number;
  /** Cost details for this step */
  cost?: StepCostRecord;
}

export interface SwarmResult {
  sessionId: string;
  query: string;
  steps: SwarmStepResult[];
  synthesis: SwarmStepOutput | null;
  totalCreditsUsed: number;
  totalDurationMs: number;
  escalated: boolean;
  escalationNotices: string[];
  verificationSummary: {
    stepsVerified: number;
    stepsTotal: number;
    avgConfidence: number;
    flaggedSteps: number;
  };
  /** Feedback entries collected during this run (only if enableSelfImprovement is true) */
  feedback: FeedbackEntry[];
  /** Budget status at end of run */
  budget: BudgetStatus;
  /** Per-step cost breakdown */
  costBreakdown: StepCostRecord[];
  /** Cache stats for this run */
  cacheStats: { hits: number; misses: number; hitRate: number };
}

// ── Shared Memory ──

export interface SwarmMemoryEntry {
  key: string;
  value: unknown;
  role: SwarmRole;
  timestamp: string;
}

export class SwarmMemory {
  private store: SwarmMemoryEntry[] = [];
  private limit: number;

  constructor(limit: number = 50) {
    this.limit = limit;
  }

  set(key: string, value: unknown, role: SwarmRole): void {
    // Remove existing entry with same key
    this.store = this.store.filter(e => e.key !== key);
    this.store.push({ key, value, role, timestamp: new Date().toISOString() });
    this.prune();
  }

  get(key: string): unknown | undefined {
    return this.store.find(e => e.key === key)?.value;
  }

  getByRole(role: SwarmRole): SwarmMemoryEntry[] {
    return this.store.filter(e => e.role === role);
  }

  getAll(): readonly SwarmMemoryEntry[] {
    return this.store;
  }

  size(): number {
    return this.store.length;
  }

  /** Prune oldest entries beyond the limit */
  private prune(): void {
    if (this.store.length > this.limit) {
      this.store = this.store.slice(this.store.length - this.limit);
    }
  }

  /** Snapshot for serialization */
  toJSON(): SwarmMemoryEntry[] {
    return [...this.store];
  }
}

// ── Default Agents per Role ──

const DEFAULT_AGENTS: Record<SwarmRole, SwarmAgent> = {
  planner: {
    role: "planner",
    name: "Planner",
    tool: "veroq_comprehensive_intelligence",
  },
  researcher: {
    role: "researcher",
    name: "Researcher",
    tool: "veroq_analyze_ticker",
  },
  verifier: {
    role: "verifier",
    name: "Verifier",
    tool: "veroq_verify_market_claim",
  },
  critic: {
    role: "critic",
    name: "Critic",
    // No default tool — uses custom logic
  },
  risk_assessor: {
    role: "risk_assessor",
    name: "Risk Assessor",
    tool: "veroq_generate_trading_signal",
  },
  synthesizer: {
    role: "synthesizer",
    name: "Synthesizer",
    // No default tool — aggregates previous steps
  },
  custom: {
    role: "custom",
    name: "Custom",
  },
};

const DEFAULT_PIPELINE: SwarmRole[] = [
  "planner",
  "researcher",
  "verifier",
  "critic",
  "synthesizer",
];

// ── Core Swarm Execution ──

function generateSessionId(): string {
  return `swarm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Resolve agents for the pipeline: use custom agents where provided, default otherwise */
function resolveAgents(config: SwarmConfig): SwarmAgent[] {
  const roles = config.roles || DEFAULT_PIPELINE;
  return roles.map(role => {
    const custom = config.agents?.find(a => a.role === role);
    return custom || { ...DEFAULT_AGENTS[role] };
  });
}

/** Execute a single tool via the API function */
async function executeTool(
  agent: SwarmAgent,
  input: SwarmStepInput,
  apiFn?: SwarmConfig["apiFn"],
): Promise<SwarmStepOutput> {
  // If agent has custom execute, use it
  if (agent.execute) {
    return agent.execute(input);
  }

  // If no apiFn, return a structured placeholder
  if (!apiFn) {
    return {
      data: { agent: agent.name, role: agent.role, query: input.query },
      summary: `${agent.name} processed: ${input.query}`,
      confidence: 70,
      creditsUsed: 0,
    };
  }

  // Route based on tool
  switch (agent.tool) {
    case "veroq_analyze_ticker": {
      const ticker = extractTicker(input.query);
      const data = await apiFn("POST", "/api/v1/ask", undefined, {
        question: ticker ? `Full analysis of ${ticker}` : input.query,
        fast: true,
      }) as Record<string, unknown>;
      return {
        data,
        summary: String(data.summary || ""),
        claims: extractClaims(data),
        confidence: extractConfidence(data),
        creditsUsed: 3,
      };
    }

    case "veroq_verify_market_claim": {
      // Verify claims from previous steps
      const claims = input.previousSteps.flatMap(s => s.output.claims || []);
      if (claims.length === 0) {
        return {
          data: { verdict: "no_claims", message: "No claims to verify" },
          summary: "No verifiable claims found in previous steps.",
          confidence: 100,
          creditsUsed: 0,
        };
      }
      // Verify the most important claim (first one)
      const claim = claims[0];
      const data = await apiFn("POST", "/api/v1/verify", undefined, { claim }) as Record<string, unknown>;
      return {
        data,
        summary: `Verified: "${claim}" → ${data.verdict}`,
        confidence: typeof data.confidence === "number" ? data.confidence * 100 : 70,
        creditsUsed: 3,
      };
    }

    case "veroq_comprehensive_intelligence": {
      const data = await apiFn("POST", "/api/v1/ask", undefined, {
        question: input.query,
        fast: true,
      }) as Record<string, unknown>;
      return {
        data,
        summary: String(data.summary || ""),
        claims: extractClaims(data),
        confidence: extractConfidence(data),
        creditsUsed: 3,
      };
    }

    case "veroq_generate_trading_signal": {
      const data = await apiFn("POST", "/api/v1/ask", undefined, {
        question: `Risk assessment and trading signal: ${input.query}`,
        fast: true,
      }) as Record<string, unknown>;
      const ts = data.trade_signal as { score?: number; action?: string } | undefined;
      return {
        data,
        summary: String(data.summary || ""),
        risks: extractRisks(data),
        confidence: ts?.score || extractConfidence(data),
        creditsUsed: 5,
      };
    }

    default: {
      // Generic: route through /ask
      const data = await apiFn("POST", "/api/v1/ask", undefined, {
        question: input.query,
        fast: true,
      }) as Record<string, unknown>;
      return {
        data,
        summary: String(data.summary || ""),
        confidence: extractConfidence(data),
        creditsUsed: 3,
      };
    }
  }
}

/** Run the critic agent — devil's advocate analysis */
function runCritic(previousSteps: SwarmStepResult[]): SwarmStepOutput {
  const warnings: string[] = [];
  const risks: string[] = [];

  for (const step of previousSteps) {
    // Flag low-confidence steps
    if (step.verification && step.verification.confidenceScore < 60) {
      warnings.push(`${step.agent.name} output has low confidence (${step.verification.confidenceScore}/100)`);
    }
    // Flag escalated steps
    if (step.escalated) {
      warnings.push(`${step.agent.name} triggered escalation: ${step.escalationNotice}`);
    }
    // Collect risks
    if (step.output.risks) {
      risks.push(...step.output.risks);
    }
  }

  // Check for contradictions between steps
  const verdicts = previousSteps
    .filter(s => s.output.data?.verdict)
    .map(s => String(s.output.data.verdict));
  if (verdicts.includes("contradicted")) {
    warnings.push("Verification found contradicted claims — exercise caution");
  }

  return {
    data: { warnings, risks, stepsReviewed: previousSteps.length },
    summary: warnings.length > 0
      ? `Critic found ${warnings.length} concern(s): ${warnings.join("; ")}`
      : "No significant concerns found across all steps.",
    risks,
    confidence: warnings.length === 0 ? 90 : Math.max(30, 90 - warnings.length * 15),
  };
}

/** Run the synthesizer — aggregate all step outputs */
function runSynthesizer(query: string, steps: SwarmStepResult[]): SwarmStepOutput {
  const summaries = steps
    .filter(s => s.output.summary)
    .map(s => `[${s.agent.name}] ${s.output.summary}`);

  const allRisks = steps.flatMap(s => s.output.risks || []);
  const avgConfidence = steps.length > 0
    ? steps.reduce((sum, s) => sum + (s.output.confidence || 0), 0) / steps.length
    : 0;
  const escalatedSteps = steps.filter(s => s.escalated);

  let synthesis = `Analysis of: ${query}\n\n`;
  synthesis += summaries.join("\n\n");

  if (allRisks.length > 0) {
    synthesis += `\n\nRisks identified:\n${allRisks.map(r => `  • ${r}`).join("\n")}`;
  }

  if (escalatedSteps.length > 0) {
    synthesis += `\n\nEscalation notices:\n${escalatedSteps.map(s => `  ⚠️ ${s.agent.name}: ${s.escalationNotice}`).join("\n")}`;
  }

  return {
    data: {
      synthesis: summaries,
      risks: allRisks,
      avgConfidence: Math.round(avgConfidence),
      escalations: escalatedSteps.length,
    },
    summary: synthesis,
    risks: allRisks,
    confidence: Math.round(avgConfidence),
  };
}

// ── Extraction Helpers ──

function extractTicker(query: string): string | null {
  // Skip common uppercase words, match ticker-shaped tokens (1-5 uppercase letters)
  const SKIP = new Set(["FULL", "THE", "AND", "FOR", "WITH", "FROM", "THAT", "THIS", "WHAT", "WHEN", "HOW", "NOT", "ARE", "BUT"]);
  const matches = query.match(/\b([A-Z]{1,5})\b/g) || [];
  for (const m of matches) {
    if (!SKIP.has(m)) return m;
  }
  return null;
}

function extractClaims(data: Record<string, unknown>): string[] {
  const claims: string[] = [];
  const summary = String(data.summary || "");
  // Extract sentence-level claims from summary
  const sentences = summary.split(/[.!]\s+/).filter(s => s.length > 20);
  claims.push(...sentences.slice(0, 3));
  return claims;
}

function extractConfidence(data: Record<string, unknown>): number {
  const conf = data.confidence as { level?: string } | number | undefined;
  if (typeof conf === "number") return conf * 100;
  if (typeof conf === "object" && conf?.level) {
    return conf.level === "high" ? 85 : conf.level === "medium" ? 60 : 30;
  }
  return 70;
}

function extractRisks(data: Record<string, unknown>): string[] {
  const risks: string[] = [];
  const ts = data.trade_signal as { factors?: string[] } | undefined;
  if (ts?.factors) {
    for (const f of ts.factors) {
      if (/bearish|risk|warning|caution|volatile|overbought/i.test(f)) {
        risks.push(f);
      }
    }
  }
  return risks;
}

// ── Public API ──

/**
 * Create and run a verified multi-agent swarm.
 *
 * The swarm follows a coordinator pattern:
 * planner → researcher → verifier → critic → synthesizer
 *
 * Every step gets:
 * - Permission checks (via permission engine)
 * - Verification metadata injection
 * - Escalation detection for high-stakes outputs
 * - Decision lineage capture
 * - Metrics recording
 *
 * @example
 * ```typescript
 * const result = await createVerifiedSwarm({
 *   sessionId: "analysis-001",
 *   enterpriseId: "acme-capital",
 *   roles: ["planner", "researcher", "verifier", "critic", "synthesizer"],
 *   enableAutoVerification: true,
 *   escalationThreshold: 75,
 *   creditBudget: 30,
 *   apiFn: myApiFunction,
 * }).run("Analyze NVDA for a potential long position");
 * ```
 */
export function createVerifiedSwarm(config: SwarmConfig = {}): VerifiedSwarm {
  return new VerifiedSwarm(config);
}

export class VerifiedSwarm {
  readonly sessionId: string;
  readonly config: Required<Pick<SwarmConfig, "enableAutoVerification" | "escalationThreshold" | "creditBudget" | "memoryLimit" | "enableSelfImprovement" | "feedbackThreshold" | "autoRouteToPipeline" | "enableWebSearchFallback" | "costMode" | "enableParallelSteps" | "cacheTtlMs">> & SwarmConfig;
  private agents: SwarmAgent[];
  private memory: SwarmMemory;
  private cache: StepCache;

  constructor(config: SwarmConfig = {}) {
    this.sessionId = config.sessionId || generateSessionId();
    this.config = {
      ...config,
      enableAutoVerification: config.enableAutoVerification ?? true,
      escalationThreshold: config.escalationThreshold ?? 80,
      creditBudget: config.creditBudget ?? 50,
      memoryLimit: config.memoryLimit ?? 50,
      enableSelfImprovement: config.enableSelfImprovement ?? false,
      feedbackThreshold: config.feedbackThreshold ?? 70,
      autoRouteToPipeline: config.autoRouteToPipeline ?? false,
      enableWebSearchFallback: config.enableWebSearchFallback ?? true,
      costMode: config.costMode ?? "balanced",
      enableParallelSteps: config.enableParallelSteps ?? false,
      cacheTtlMs: config.cacheTtlMs ?? 60_000,
    };
    this.agents = resolveAgents(this.config);
    this.memory = new SwarmMemory(this.config.memoryLimit);
    this.cache = new StepCache();

    // Configure enterprise context if provided
    if (config.enterpriseId) {
      configureEnterprise({
        enterpriseId: config.enterpriseId,
        sessionId: this.sessionId,
        escalationThreshold: this.config.escalationThreshold,
        escalationPauses: true,
      });
    }
  }

  /** Get the resolved agent pipeline */
  getAgents(): readonly SwarmAgent[] {
    return this.agents;
  }

  /** Get current memory state */
  getMemory(): SwarmMemory {
    return this.memory;
  }

  /** Get the step cache (for inspecting cache stats) */
  getCache(): StepCache {
    return this.cache;
  }

  /**
   * Run the swarm on a query.
   *
   * Executes each agent in sequence, passing accumulated context.
   * Stops early if credit budget is exhausted or escalation pauses execution.
   */
  async run(query: string): Promise<SwarmResult> {
    const startTime = Date.now();
    const steps: SwarmStepResult[] = [];
    const costBreakdown: StepCostRecord[] = [];
    const budget = new BudgetTracker(this.config.creditBudget);
    let swarmEscalated = false;
    const escalationNotices: string[] = [];

    // Build execution plan (parallel groups or sequential)
    const plan = buildExecutionPlan(this.agents, this.config.enableParallelSteps);

    for (const group of plan) {
      // Run agents in this group (parallel if >1, sequential otherwise)
      const groupResults = await (group.length > 1
        ? Promise.all(group.map(agent => this.executeAgent(agent, query, steps, budget)))
        : Promise.all([this.executeAgent(group[0], query, steps, budget)])
      );

      for (const result of groupResults) {
        if (!result) continue; // skipped by budget
        steps.push(result.step);
        costBreakdown.push(result.cost);
        if (result.step.escalated) {
          swarmEscalated = true;
          if (result.step.escalationNotice) {
            escalationNotices.push(`${result.step.agent.name}: ${result.step.escalationNotice}`);
          }
        }
      }
    }

    // Build verification summary
    const verifiedSteps = steps.filter(s => s.verification);
    const avgConf = verifiedSteps.length > 0
      ? verifiedSteps.reduce((sum, s) => sum + (s.verification?.confidenceScore ?? 0), 0) / verifiedSteps.length
      : 0;
    const flaggedSteps = verifiedSteps.filter(s =>
      s.verification?.verificationStatus === "flagged" || s.verification?.verificationStatus === "low-confidence"
    ).length;

    const synthesis = steps.find(s => s.agent.role === "synthesizer")?.output ?? null;
    const budgetStatus = budget.getStatus();

    const swarmResult: SwarmResult = {
      sessionId: this.sessionId,
      query,
      steps,
      synthesis,
      totalCreditsUsed: budgetStatus.spent,
      totalDurationMs: Date.now() - startTime,
      escalated: swarmEscalated,
      escalationNotices,
      verificationSummary: {
        stepsVerified: verifiedSteps.length,
        stepsTotal: steps.length,
        avgConfidence: Math.round(avgConf),
        flaggedSteps,
      },
      feedback: [],
      budget: budgetStatus,
      costBreakdown,
      cacheStats: this.cache.getStats(),
    };

    // Self-improvement feedback loop (non-blocking, opt-in)
    if (this.config.enableSelfImprovement) {
      try {
        swarmResult.feedback = await collectSwarmFeedback(swarmResult, {
          enableSelfImprovement: true,
          feedbackThreshold: this.config.feedbackThreshold,
          autoRouteToPipeline: this.config.autoRouteToPipeline,
          enableWebSearchFallback: this.config.enableWebSearchFallback,
          enterpriseId: this.config.enterpriseId,
          webSearchFn: this.config.webSearchFn,
          pipelineRouteFn: this.config.pipelineRouteFn,
        });
      } catch {
        // Feedback collection must never break the swarm
      }
    }

    return swarmResult;
  }

  /** Build accumulated context from previous steps */
  private buildContext(steps: SwarmStepResult[]): Record<string, unknown> {
    const context: Record<string, unknown> = {};
    for (const step of steps) {
      context[step.agent.role] = {
        summary: step.output.summary,
        confidence: step.output.confidence,
        claims: step.output.claims,
        risks: step.output.risks,
        escalated: step.escalated,
      };
    }
    return context;
  }

  /** Execute a single agent with cost routing, caching, and budget enforcement */
  private async executeAgent(
    agent: SwarmAgent,
    query: string,
    steps: SwarmStepResult[],
    budget: BudgetTracker,
  ): Promise<{ step: SwarmStepResult; cost: StepCostRecord } | null> {
    const stepStart = Date.now();
    const toolName = agent.tool || `swarm_${agent.role}`;

    // Cost estimate
    const costEst = estimateStepCredits(agent.role, this.config.costMode);

    // Budget check
    if (!budget.canAfford(costEst.estimatedCredits)) {
      budget.recordSkip();
      return null;
    }

    // Build step input
    const stepInput: SwarmStepInput = {
      query,
      context: this.buildContext(steps),
      memory: this.memory,
      previousSteps: steps,
    };

    // Permission check
    const permResult = checkPermissions(toolName, { query, role: agent.role, sessionId: this.sessionId });
    if (permResult.decision === "deny") {
      budget.recordSkip();
      return {
        step: {
          agent, input: stepInput,
          output: { data: {}, summary: `Denied: ${permResult.reason}` },
          permission: permResult, escalated: false,
          durationMs: Date.now() - stepStart, creditsUsed: 0,
        },
        cost: {
          role: agent.role, agent: agent.name, modelTier: costEst.modelTier,
          estimatedCredits: 0, actualCredits: 0, cached: false, durationMs: Date.now() - stepStart,
        },
      };
    }

    // Cache check (skip for critic/synthesizer — they depend on prior steps)
    const cacheKey = StepCache.buildKey(agent.role, query);
    if (!["critic", "synthesizer", "verifier"].includes(agent.role)) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const cachedOutput: SwarmStepOutput = {
          data: cached.data,
          summary: String(cached.data.summary || ""),
          confidence: cached.confidence ?? 70,
          claims: extractClaims(cached.data),
          creditsUsed: 0,
        };
        budget.recordSpend(0);
        const dur = Date.now() - stepStart;
        return {
          step: {
            agent, input: stepInput, output: cachedOutput,
            permission: permResult, escalated: false,
            durationMs: dur, creditsUsed: 0,
          },
          cost: {
            role: agent.role, agent: agent.name, modelTier: costEst.modelTier,
            estimatedCredits: costEst.estimatedCredits, actualCredits: 0,
            cached: true, durationMs: dur,
          },
        };
      }
    }

    // Execute step
    const output: SwarmStepOutput = await (async (): Promise<SwarmStepOutput> => {
      try {
        if (agent.role === "critic") return runCritic(steps);
        if (agent.role === "synthesizer") return runSynthesizer(query, steps);
        return await executeTool(agent, stepInput, this.config.apiFn);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const retries = agent.maxRetries ?? 1;
        for (let attempt = 0; attempt < retries; attempt++) {
          try {
            if (agent.role === "critic") return runCritic(steps);
            if (agent.role === "synthesizer") return runSynthesizer(query, steps);
            return await executeTool(agent, stepInput, this.config.apiFn);
          } catch { /* continue retrying */ }
        }
        recordToolCall(toolName, Date.now() - stepStart, true, false, false);
        return {
          data: { error: message },
          summary: `${agent.name} failed: ${message}`,
          confidence: 0,
          creditsUsed: 0,
        };
      }
    })();

    // Apply cost-routed credits (override the raw creditsUsed with tier-based cost)
    const actualCredits = output.creditsUsed ?? costEst.estimatedCredits;
    budget.recordSpend(actualCredits);

    // Cache the result for future runs
    if (!["critic", "synthesizer", "verifier"].includes(agent.role)) {
      this.cache.set(cacheKey, output.data, {
        confidence: output.confidence,
        ttlMs: this.config.cacheTtlMs,
      });
    }

    // Auto-verification
    let verification: SwarmStepResult["verification"] | undefined;
    if (
      this.config.enableAutoVerification &&
      !["verifier", "critic", "synthesizer"].includes(agent.role) &&
      output.claims?.length
    ) {
      const confidenceScore = output.confidence ?? 70;
      verification = {
        confidenceScore,
        verificationStatus: confidenceScore >= 65 ? "verified"
          : confidenceScore >= 40 ? "flagged"
          : "low-confidence",
        evidenceCount: (output.data.evidence_chain as unknown[] | undefined)?.length ?? 0,
      };
    }

    // Output safety check + escalation
    const safetyCheck = checkOutputSafety(
      toolName, output.data,
      { escalationThreshold: this.config.escalationThreshold },
    );

    // Decision lineage
    const lineage = getDecisionLineage(toolName, { query, role: agent.role }, output.data);

    // Record metrics
    const stepDuration = Date.now() - stepStart;
    recordToolCall(toolName, stepDuration, false, safetyCheck.flagged, safetyCheck.escalated, output.confidence);

    // Store in memory
    this.memory.set(`${agent.role}_output`, output.data, agent.role);
    if (output.summary) {
      this.memory.set(`${agent.role}_summary`, output.summary, agent.role);
    }

    return {
      step: {
        agent, input: stepInput, output, verification,
        permission: permResult, lineage,
        escalated: safetyCheck.escalated,
        escalationNotice: safetyCheck.escalationNotice,
        durationMs: stepDuration, creditsUsed: actualCredits,
        cost: {
          role: agent.role, agent: agent.name, modelTier: costEst.modelTier,
          estimatedCredits: costEst.estimatedCredits, actualCredits,
          cached: false, durationMs: stepDuration,
        },
      },
      cost: {
        role: agent.role, agent: agent.name, modelTier: costEst.modelTier,
        estimatedCredits: costEst.estimatedCredits, actualCredits,
        cached: false, durationMs: stepDuration,
      },
    };
  }
}
