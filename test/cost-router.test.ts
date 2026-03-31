// ============================================================
// Cost Router Tests — model routing, budget, caching, parallelism
// ============================================================

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getModelTier,
  estimateStepCredits,
  estimatePipelineCost,
  BudgetTracker,
  StepCache,
  buildExecutionPlan,
} from "../src/swarm/cost-router.js";
import {
  createVerifiedSwarm,
} from "../src/swarm/index.js";
import {
  resetPermissionContext,
  clearAuditLog,
} from "../src/safety/index.js";
import { resetMetrics } from "../src/observability/index.js";

// Mock API
function mockApi(_method: string, _path: string, _params?: unknown, body?: unknown): Promise<unknown> {
  const b = body as Record<string, unknown> | undefined;
  const question = String(b?.question || b?.claim || "");
  if (_path === "/api/v1/verify") {
    return Promise.resolve({ verdict: "supported", confidence: 0.85, summary: `Verified: ${b?.claim}` });
  }
  return Promise.resolve({
    summary: `Result for: ${question}`,
    confidence: { level: "high" },
    trade_signal: { score: 55, action: "hold" },
  });
}

describe("cost-router", () => {
  beforeEach(() => {
    resetPermissionContext();
    clearAuditLog();
    resetMetrics();
  });

  // ── Model Tier Routing ──

  it("cheap mode routes all roles to fast tier", () => {
    assert.equal(getModelTier("planner", "cheap"), "fast");
    assert.equal(getModelTier("researcher", "cheap"), "fast");
    assert.equal(getModelTier("verifier", "cheap"), "fast");
    assert.equal(getModelTier("critic", "cheap"), "fast");
  });

  it("balanced mode routes planner/critic to fast, others to standard", () => {
    assert.equal(getModelTier("planner", "balanced"), "fast");
    assert.equal(getModelTier("researcher", "balanced"), "standard");
    assert.equal(getModelTier("verifier", "balanced"), "standard");
    assert.equal(getModelTier("critic", "balanced"), "fast");
    assert.equal(getModelTier("synthesizer", "balanced"), "fast");
  });

  it("premium mode routes researcher/verifier to premium", () => {
    assert.equal(getModelTier("researcher", "premium"), "premium");
    assert.equal(getModelTier("verifier", "premium"), "premium");
    assert.equal(getModelTier("risk_assessor", "premium"), "premium");
    assert.equal(getModelTier("planner", "premium"), "standard");
  });

  it("high-stakes upgrades verifier from fast to standard", () => {
    assert.equal(getModelTier("verifier", "cheap", false), "fast");
    assert.equal(getModelTier("verifier", "cheap", true), "standard");
    assert.equal(getModelTier("critic", "cheap", true), "standard");
    // Already standard or above — no change
    assert.equal(getModelTier("verifier", "balanced", true), "standard");
  });

  it("estimateStepCredits returns correct credits per tier", () => {
    const fast = estimateStepCredits("planner", "cheap");
    assert.equal(fast.estimatedCredits, 1);
    assert.equal(fast.modelTier, "fast");

    const std = estimateStepCredits("researcher", "balanced");
    assert.equal(std.estimatedCredits, 3);
    assert.equal(std.modelTier, "standard");

    const prem = estimateStepCredits("verifier", "premium");
    assert.equal(prem.estimatedCredits, 5);
    assert.equal(prem.modelTier, "premium");
  });

  it("estimatePipelineCost sums correctly", () => {
    const cost = estimatePipelineCost(
      ["planner", "researcher", "verifier", "critic", "synthesizer"],
      "balanced",
    );
    // fast(1) + standard(3) + standard(3) + fast(1) + fast(1) = 9
    assert.equal(cost.total, 9);
    assert.equal(cost.breakdown.length, 5);
  });

  // ── Budget Tracking ──

  it("budget tracker enforces limits", () => {
    const budget = new BudgetTracker(10);
    assert.equal(budget.canAfford(5), true);
    budget.recordSpend(5);
    assert.equal(budget.canAfford(5), true);
    budget.recordSpend(5);
    assert.equal(budget.canAfford(1), false);

    const status = budget.getStatus();
    assert.equal(status.spent, 10);
    assert.equal(status.remaining, 0);
    assert.equal(status.budgetExhausted, true);
    assert.equal(status.stepsCompleted, 2);
  });

  it("budget tracker records skips", () => {
    const budget = new BudgetTracker(3);
    budget.recordSpend(3);
    budget.recordSkip();
    budget.recordSkip();

    const status = budget.getStatus();
    assert.equal(status.stepsSkipped, 2);
    assert.equal(status.stepsCompleted, 1);
  });

  // ── Step Cache ──

  it("cache stores and retrieves entries", () => {
    const cache = new StepCache();
    const key = StepCache.buildKey("researcher", "Analyze NVDA");

    cache.set(key, { summary: "NVDA analysis" }, { confidence: 85 });
    const entry = cache.get(key);

    assert.ok(entry);
    assert.equal((entry.data as any).summary, "NVDA analysis");
    assert.equal(entry.confidence, 85);
  });

  it("cache expires after TTL", () => {
    const cache = new StepCache();
    const key = StepCache.buildKey("researcher", "AAPL price");

    cache.set(key, { price: 180 }, { ttlMs: 1 }); // 1ms TTL
    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    const entry = cache.get(key);
    assert.equal(entry, undefined);
  });

  it("cache tracks hit/miss rates", () => {
    const cache = new StepCache();
    const key = StepCache.buildKey("researcher", "test");

    cache.get(key); // miss
    cache.set(key, { x: 1 });
    cache.get(key); // hit
    cache.get(key); // hit

    const stats = cache.getStats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
    assert.equal(stats.hitRate, 67); // 2/3
  });

  it("cache key includes verification status", () => {
    const k1 = StepCache.buildKey("verifier", "test claim", false);
    const k2 = StepCache.buildKey("verifier", "test claim", true);
    assert.notEqual(k1, k2);
    assert.ok(k2.includes("v:"));
  });

  // ── Parallel Execution Plan ──

  it("sequential mode puts each agent in own group", () => {
    const agents = [
      { role: "planner" as const, name: "P" },
      { role: "researcher" as const, name: "R" },
      { role: "verifier" as const, name: "V" },
    ];
    const plan = buildExecutionPlan(agents, false);
    assert.equal(plan.length, 3);
    assert.equal(plan[0].length, 1);
    assert.equal(plan[1].length, 1);
    assert.equal(plan[2].length, 1);
  });

  it("parallel mode groups independent steps", () => {
    const agents = [
      { role: "planner" as const, name: "P" },
      { role: "researcher" as const, name: "R1" },
      { role: "risk_assessor" as const, name: "R2" },
      { role: "verifier" as const, name: "V" },
      { role: "critic" as const, name: "C" },
      { role: "synthesizer" as const, name: "S" },
    ];
    const plan = buildExecutionPlan(agents, true);

    // planner = sequential, researcher+risk_assessor = parallel, verifier/critic/synthesizer = sequential
    assert.equal(plan[0].length, 1); // planner sequential (sets context)
    assert.equal(plan[1].length, 2); // R1 + R2 parallel
    assert.equal(plan[2].length, 1); // verifier sequential
    assert.equal(plan[3].length, 1); // critic sequential
    assert.equal(plan[4].length, 1); // synthesizer sequential
  });

  // ── Swarm Integration ──

  it("swarm result includes budget status", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["planner", "researcher", "synthesizer"],
      creditBudget: 50,
      costMode: "balanced",
      apiFn: mockApi as any,
    });
    const result = await swarm.run("NVDA analysis");

    assert.ok(result.budget);
    assert.equal(result.budget.totalBudget, 50);
    assert.ok(result.budget.spent > 0);
    assert.ok(result.budget.remaining >= 0);
    assert.equal(result.budget.stepsCompleted, 3);
  });

  it("swarm result includes cost breakdown per step", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["planner", "researcher", "synthesizer"],
      costMode: "cheap",
      apiFn: mockApi as any,
    });
    const result = await swarm.run("AAPL outlook");

    assert.ok(result.costBreakdown.length >= 3);
    for (const cost of result.costBreakdown) {
      assert.ok(cost.role);
      assert.ok(cost.modelTier);
      assert.ok(cost.durationMs >= 0);
    }
  });

  it("cheap mode uses fewer credits than premium", async () => {
    const cheap = createVerifiedSwarm({
      roles: ["planner", "researcher", "verifier", "synthesizer"],
      costMode: "cheap",
      apiFn: mockApi as any,
    });
    const premium = createVerifiedSwarm({
      roles: ["planner", "researcher", "verifier", "synthesizer"],
      costMode: "premium",
      apiFn: mockApi as any,
    });

    const cheapResult = await cheap.run("Test cost");
    const premResult = await premium.run("Test cost");

    // Cheap: 1+1+1+1=4cr, Premium: 3+5+5+3=16cr (API returns creditsUsed:3 which overrides)
    assert.ok(cheapResult.totalCreditsUsed <= premResult.totalCreditsUsed,
      `Cheap (${cheapResult.totalCreditsUsed}) should be <= Premium (${premResult.totalCreditsUsed})`);
  });

  it("swarm cache hits on repeated query", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["researcher", "synthesizer"],
      apiFn: mockApi as any,
    });

    await swarm.run("Analyze NVDA");
    const result2 = await swarm.run("Analyze NVDA"); // second run, should hit cache

    assert.ok(result2.cacheStats.hits > 0, "Second run should have cache hits");
  });

  it("parallel execution completes all steps", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["planner", "researcher", "risk_assessor", "verifier", "critic", "synthesizer"],
      enableParallelSteps: true,
      apiFn: mockApi as any,
    });
    const result = await swarm.run("Parallel test");

    assert.equal(result.steps.length, 6);
    assert.ok(result.budget.stepsCompleted >= 6);
  });

  it("budget exhaustion reports remaining=0 and skips", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["planner", "researcher", "verifier", "critic", "synthesizer"],
      creditBudget: 2,
      costMode: "balanced",
      apiFn: mockApi as any,
    });
    const result = await swarm.run("Tight budget");

    assert.equal(result.budget.remaining, 0);
    assert.ok(result.budget.stepsSkipped > 0);
    assert.ok(result.steps.length < 5);
  });
});
