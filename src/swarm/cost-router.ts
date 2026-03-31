// ============================================================
// VEROQ Cost Router — Model selection, caching, parallel execution
// ============================================================
// Routes swarm steps to appropriate model tiers, manages a
// step-level cache, and identifies parallelizable steps.
// ============================================================

import type { SwarmRole, SwarmAgent } from "./veroq-verified-swarm.js";

// ── Types ──

export type CostMode = "balanced" | "cheap" | "premium";

export type ModelTier = "fast" | "standard" | "premium";

export interface CostEstimate {
  role: SwarmRole | string;
  modelTier: ModelTier;
  estimatedCredits: number;
  reason: string;
}

export interface StepCostRecord {
  role: SwarmRole | string;
  agent: string;
  modelTier: ModelTier;
  estimatedCredits: number;
  actualCredits: number;
  cached: boolean;
  durationMs: number;
}

export interface BudgetStatus {
  totalBudget: number;
  spent: number;
  remaining: number;
  stepsCompleted: number;
  stepsSkipped: number;
  budgetExhausted: boolean;
}

export interface CacheEntry {
  key: string;
  data: Record<string, unknown>;
  confidence?: number;
  verified: boolean;
  timestamp: number;
  ttlMs: number;
}

// ── Model Tier Routing ──

/** Credit costs per model tier */
const TIER_CREDITS: Record<ModelTier, number> = {
  fast: 1,
  standard: 3,
  premium: 5,
};

/** Map roles to their default model tier by cost mode */
const ROLE_TIERS: Record<CostMode, Record<string, ModelTier>> = {
  cheap: {
    planner: "fast",
    researcher: "fast",
    verifier: "fast",
    critic: "fast",
    risk_assessor: "fast",
    synthesizer: "fast",
    custom: "fast",
  },
  balanced: {
    planner: "fast",
    researcher: "standard",
    verifier: "standard",
    critic: "fast",
    risk_assessor: "standard",
    synthesizer: "fast",
    custom: "standard",
  },
  premium: {
    planner: "standard",
    researcher: "premium",
    verifier: "premium",
    critic: "standard",
    risk_assessor: "premium",
    synthesizer: "standard",
    custom: "premium",
  },
};

/**
 * Get the model tier for a given role and cost mode.
 * High-stakes queries always upgrade verifier/risk_assessor to at least standard.
 */
export function getModelTier(
  role: SwarmRole | string,
  costMode: CostMode,
  isHighStakes: boolean = false,
): ModelTier {
  const tier = ROLE_TIERS[costMode]?.[role] ?? ROLE_TIERS.balanced[role] ?? "standard";
  // High-stakes queries upgrade critical roles
  if (isHighStakes && (role === "verifier" || role === "risk_assessor" || role === "critic")) {
    if (tier === "fast") return "standard";
  }
  return tier;
}

/**
 * Estimate credits for a step based on role and cost mode.
 */
export function estimateStepCredits(
  role: SwarmRole | string,
  costMode: CostMode,
  isHighStakes: boolean = false,
): CostEstimate {
  const tier = getModelTier(role, costMode, isHighStakes);
  return {
    role,
    modelTier: tier,
    estimatedCredits: TIER_CREDITS[tier],
    reason: `${costMode} mode → ${tier} tier${isHighStakes ? " (high-stakes upgrade)" : ""}`,
  };
}

/**
 * Estimate total credits for a pipeline.
 */
export function estimatePipelineCost(
  roles: (SwarmRole | string)[],
  costMode: CostMode,
): { total: number; breakdown: CostEstimate[] } {
  const breakdown = roles.map(r => estimateStepCredits(r, costMode));
  return {
    total: breakdown.reduce((sum, e) => sum + e.estimatedCredits, 0),
    breakdown,
  };
}

// ── Budget Tracking ──

export class BudgetTracker {
  private totalBudget: number;
  private spent: number = 0;
  private stepsCompleted: number = 0;
  private stepsSkipped: number = 0;

  constructor(budget: number) {
    this.totalBudget = budget;
  }

  /** Check if there's enough budget for an estimated cost */
  canAfford(estimatedCredits: number): boolean {
    return this.spent + estimatedCredits <= this.totalBudget;
  }

  /** Record spending for a completed step */
  recordSpend(credits: number): void {
    this.spent += credits;
    this.stepsCompleted++;
  }

  /** Record a skipped step */
  recordSkip(): void {
    this.stepsSkipped++;
  }

  /** Get current budget status */
  getStatus(): BudgetStatus {
    return {
      totalBudget: this.totalBudget,
      spent: this.spent,
      remaining: Math.max(0, this.totalBudget - this.spent),
      stepsCompleted: this.stepsCompleted,
      stepsSkipped: this.stepsSkipped,
      budgetExhausted: this.spent >= this.totalBudget,
    };
  }
}

// ── Step Cache ──

const DEFAULT_CACHE_TTL = 60_000; // 60 seconds

export class StepCache {
  private store = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  /** Build a cache key from role + query + verification status */
  static buildKey(role: string, query: string, verified: boolean = false): string {
    const normalized = query.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 200);
    return `${role}:${verified ? "v:" : ""}${normalized}`;
  }

  /** Get a cached entry if it exists and hasn't expired */
  get(key: string): CacheEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry;
  }

  /** Store a result in cache */
  set(key: string, data: Record<string, unknown>, options: {
    confidence?: number;
    verified?: boolean;
    ttlMs?: number;
  } = {}): void {
    this.store.set(key, {
      key,
      data,
      confidence: options.confidence,
      verified: options.verified ?? false,
      timestamp: Date.now(),
      ttlMs: options.ttlMs ?? DEFAULT_CACHE_TTL,
    });
  }

  /** Get cache stats */
  getStats(): { hits: number; misses: number; hitRate: number; size: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 100) : 0,
      size: this.store.size,
    };
  }

  /** Clear cache */
  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

// ── Parallel Execution ──

/** Roles that MUST run sequentially (depend on prior step outputs) */
const SEQUENTIAL_ROLES = new Set<string>(["verifier", "critic", "synthesizer"]);

/**
 * Identify groups of steps that can run in parallel.
 * Returns arrays of agents: each inner array can run concurrently.
 */
export function buildExecutionPlan(
  agents: readonly SwarmAgent[],
  enableParallel: boolean,
): SwarmAgent[][] {
  if (!enableParallel) {
    // All sequential
    return agents.map(a => [a]);
  }

  const groups: SwarmAgent[][] = [];
  let currentParallel: SwarmAgent[] = [];

  for (const agent of agents) {
    if (SEQUENTIAL_ROLES.has(agent.role)) {
      // Flush any pending parallel group
      if (currentParallel.length > 0) {
        groups.push(currentParallel);
        currentParallel = [];
      }
      // Sequential step gets its own group
      groups.push([agent]);
    } else {
      // Can run in parallel with other non-sequential steps
      currentParallel.push(agent);
    }
  }

  // Flush remaining
  if (currentParallel.length > 0) {
    groups.push(currentParallel);
  }

  return groups;
}
