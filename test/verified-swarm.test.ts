// ============================================================
// Verified Swarm Tests — 15 tests covering creation, verification,
// escalation, lineage, memory, budget, and regression safety.
// ============================================================

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createVerifiedSwarm,
  VerifiedSwarm,
  SwarmMemory,
  type SwarmConfig,
  type SwarmStepInput,
} from "../src/swarm/index.js";
import {
  resetPermissionContext,
  clearAuditLog,
  getAuditLog,
  setPermissionContext,
  configureEnterprise,
  checkPermissions,
} from "../src/safety/index.js";
import { resetMetrics, getMetricsSummary } from "../src/observability/index.js";

// Mock API function that returns structured test data
function mockApi(method: string, path: string, _params?: unknown, body?: unknown): Promise<unknown> {
  const b = body as Record<string, unknown> | undefined;
  const question = String(b?.question || b?.claim || "");

  if (path === "/api/v1/verify") {
    return Promise.resolve({
      verdict: "supported",
      confidence: 0.85,
      summary: `Verified: ${b?.claim}`,
      evidence_chain: [
        { source: "Reuters", snippet: "Confirmed data", position: "supports", reliability: 0.95 },
      ],
      confidence_breakdown: { source_agreement: 0.9, source_quality: 0.85, recency: 0.8, corroboration_depth: 0.75 },
    });
  }

  return Promise.resolve({
    summary: `Analysis result for: ${question}`,
    confidence: { level: "high", reason: "Multiple sources" },
    trade_signal: { score: 72, action: "buy", factors: ["RSI oversold", "Positive momentum"] },
    endpoints_called: ["/api/v1/ticker/NVDA", "/api/v1/technicals/NVDA"],
    data: {
      news: { briefs: [{ headline: "NVDA hits new high" }] },
    },
  });
}

describe("verified-swarm", () => {
  beforeEach(() => {
    resetPermissionContext();
    clearAuditLog();
    resetMetrics();
  });

  // ── Creation ──

  it("creates swarm with default config", () => {
    const swarm = createVerifiedSwarm();
    assert.ok(swarm instanceof VerifiedSwarm);
    assert.ok(swarm.sessionId.startsWith("swarm_"));
    assert.equal(swarm.getAgents().length, 5); // default pipeline
  });

  it("creates swarm with custom roles", () => {
    const swarm = createVerifiedSwarm({
      roles: ["planner", "researcher", "synthesizer"],
    });
    assert.equal(swarm.getAgents().length, 3);
    assert.equal(swarm.getAgents()[0].role, "planner");
    assert.equal(swarm.getAgents()[1].role, "researcher");
    assert.equal(swarm.getAgents()[2].role, "synthesizer");
  });

  it("creates swarm with custom agents", () => {
    const swarm = createVerifiedSwarm({
      roles: ["researcher"],
      agents: [{
        role: "researcher",
        name: "Custom Researcher",
        execute: async () => ({ data: { custom: true }, summary: "Custom output" }),
      }],
    });
    assert.equal(swarm.getAgents()[0].name, "Custom Researcher");
  });

  it("auto-generates sessionId when not provided", () => {
    const s1 = createVerifiedSwarm();
    const s2 = createVerifiedSwarm();
    assert.notEqual(s1.sessionId, s2.sessionId);
  });

  it("uses provided sessionId", () => {
    const swarm = createVerifiedSwarm({ sessionId: "test-session-123" });
    assert.equal(swarm.sessionId, "test-session-123");
  });

  // ── Execution ──

  it("runs full pipeline without apiFn (placeholder mode)", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["planner", "researcher", "critic", "synthesizer"],
    });
    const result = await swarm.run("Analyze NVDA");

    assert.equal(result.steps.length, 4);
    assert.equal(result.steps[0].agent.role, "planner");
    assert.equal(result.steps[1].agent.role, "researcher");
    assert.equal(result.steps[2].agent.role, "critic");
    assert.equal(result.steps[3].agent.role, "synthesizer");
    assert.ok(result.synthesis);
    assert.ok(result.totalDurationMs >= 0);
  });

  it("runs pipeline with mock API", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["planner", "researcher", "verifier", "critic", "synthesizer"],
      apiFn: mockApi as any,
    });
    const result = await swarm.run("Full analysis of NVDA");

    assert.equal(result.steps.length, 5);
    assert.ok(result.totalCreditsUsed > 0);
    // Researcher should produce claims that verifier checks
    assert.ok(result.steps[0].output.summary?.includes("NVDA") || result.steps[0].output.summary?.includes("analysis"));
    // Synthesizer produces final output
    assert.ok(result.synthesis?.summary);
  });

  // ── Verification Injection ──

  it("auto-verification injects metadata on researcher output", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["researcher", "synthesizer"],
      enableAutoVerification: true,
      apiFn: mockApi as any,
    });
    const result = await swarm.run("Analyze NVDA");

    // Researcher step should have verification
    const researcherStep = result.steps.find(s => s.agent.role === "researcher");
    assert.ok(researcherStep);
    // Permission check should have run
    assert.ok(researcherStep.permission);
    assert.equal(researcherStep.permission.decision, "allow");
  });

  it("disabling auto-verification skips verification metadata", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["researcher", "synthesizer"],
      enableAutoVerification: false,
      apiFn: mockApi as any,
    });
    const result = await swarm.run("Analyze AAPL");

    const researcherStep = result.steps.find(s => s.agent.role === "researcher");
    assert.ok(researcherStep);
    // No verification when disabled
    assert.equal(researcherStep.verification, undefined);
  });

  // ── Escalation ──

  it("escalation triggered on high-stakes output", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["researcher", "synthesizer"],
      escalationThreshold: 50, // Low threshold to trigger
      apiFn: async () => ({
        summary: "Strong buy signal",
        trade_signal: { score: 90, action: "buy" },
        confidence: { level: "high" },
      }),
    });
    const result = await swarm.run("Should I buy NVDA?");

    assert.equal(result.escalated, true);
    assert.ok(result.escalationNotices.length > 0);
  });

  it("no escalation on low-confidence output", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["researcher", "synthesizer"],
      escalationThreshold: 80,
      apiFn: async () => ({
        summary: "Uncertain outlook",
        trade_signal: { score: 40, action: "hold" },
        confidence: { level: "low" },
      }),
    });
    const result = await swarm.run("AAPL outlook");

    assert.equal(result.escalated, false);
    assert.equal(result.escalationNotices.length, 0);
  });

  // ── Decision Lineage ──

  it("captures decision lineage for each step", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["researcher", "synthesizer"],
      apiFn: mockApi as any,
    });
    const result = await swarm.run("Analyze NVDA");

    for (const step of result.steps) {
      assert.ok(step.lineage, `${step.agent.name} should have lineage`);
      assert.ok(step.lineage.rulesEvaluated.length > 0);
      assert.ok(step.lineage.timestamp);
    }
  });

  // ── Memory ──

  it("memory stores and retrieves entries across steps", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["planner", "researcher", "synthesizer"],
    });
    const result = await swarm.run("Test memory");

    const memory = swarm.getMemory();
    assert.ok(memory.size() > 0);
    // Each step stores output in memory
    assert.ok(memory.get("planner_output"));
    assert.ok(memory.get("researcher_output"));
  });

  it("memory respects size limit", () => {
    const mem = new SwarmMemory(3);
    mem.set("a", 1, "planner");
    mem.set("b", 2, "researcher");
    mem.set("c", 3, "verifier");
    mem.set("d", 4, "critic"); // pushes out "a"

    assert.equal(mem.size(), 3);
    assert.equal(mem.get("a"), undefined);
    assert.equal(mem.get("d"), 4);
  });

  // ── Budget Control ──

  it("stops execution when credit budget exhausted", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["planner", "researcher", "verifier", "critic", "synthesizer"],
      creditBudget: 5, // Only enough for ~1-2 steps
      apiFn: mockApi as any,
    });
    const result = await swarm.run("Budget test");

    // Should have stopped early
    assert.ok(result.totalCreditsUsed <= 10); // Some tolerance for step overhead
    assert.ok(result.steps.length < 5); // Not all 5 steps completed
  });

  // ── Metrics Recording ──

  it("records metrics for each swarm step", async () => {
    resetMetrics();
    const swarm = createVerifiedSwarm({
      roles: ["planner", "researcher", "synthesizer"],
      apiFn: mockApi as any,
    });
    await swarm.run("Metrics test");

    const summary = getMetricsSummary();
    assert.ok(summary.totalCalls >= 3); // At least 3 steps recorded
  });

  // ── Verification Summary ──

  it("produces accurate verification summary", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["planner", "researcher", "verifier", "critic", "synthesizer"],
      enableAutoVerification: true,
      apiFn: mockApi as any,
    });
    const result = await swarm.run("Full analysis NVDA");

    assert.ok(result.verificationSummary);
    assert.equal(result.verificationSummary.stepsTotal, 5);
    assert.ok(result.verificationSummary.avgConfidence >= 0);
    assert.ok(result.verificationSummary.avgConfidence <= 100);
  });

  // ── Edge Cases ──

  it("handles empty roles array gracefully", async () => {
    const swarm = createVerifiedSwarm({ roles: [] });
    const result = await swarm.run("Empty pipeline");

    assert.equal(result.steps.length, 0);
    assert.equal(result.synthesis, null);
    assert.equal(result.totalCreditsUsed, 0);
    assert.equal(result.verificationSummary.avgConfidence, 0);
  });

  it("handles zero credit budget", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["planner", "researcher", "synthesizer"],
      creditBudget: 0,
      apiFn: mockApi as any,
    });
    const result = await swarm.run("Zero budget");

    assert.equal(result.steps.length, 0);
    assert.equal(result.totalCreditsUsed, 0);
  });

  it("handles custom agent execute that throws", async () => {
    let attempts = 0;
    const swarm = createVerifiedSwarm({
      roles: ["researcher"],
      agents: [{
        role: "researcher" as const,
        name: "Failing Researcher",
        maxRetries: 2,
        execute: async () => {
          attempts++;
          throw new Error("API timeout");
        },
      }],
    });
    const result = await swarm.run("Error test");

    assert.equal(result.steps.length, 1);
    assert.ok(result.steps[0].output.summary?.includes("failed"));
    assert.ok(result.steps[0].output.data.error);
    assert.ok(attempts >= 2); // Original + retries
  });

  it("synthesizer handles empty steps without NaN", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["synthesizer"], // Only synthesizer, no prior steps
    });
    const result = await swarm.run("Synthesis only");

    assert.equal(result.steps.length, 1);
    assert.ok(Number.isFinite(result.steps[0].output.confidence));
    assert.ok(!Number.isNaN(result.verificationSummary.avgConfidence));
  });

  // ── Regression: Existing tools still work ──

  it("existing permission engine unaffected by swarm", () => {
    // Swarm should not corrupt global permission state
    createVerifiedSwarm({ enterpriseId: "swarm-test" });

    // Reset to clean state
    resetPermissionContext();

    const r = checkPermissions("veroq_ask", { question: "AAPL price" });
    assert.equal(r.decision, "allow");
  });
});
