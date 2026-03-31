// ============================================================
// Feedback Loop Tests — flagging, web search fallback, pipeline
// routing, metrics, privacy, and swarm integration.
// ============================================================

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  collectSwarmFeedback,
  submitFeedback,
  getFeedbackQueue,
  resolveFeedback,
  getFeedbackMetrics,
  resetFeedback,
  type FeedbackConfig,
  type WebSearchFallbackResult,
} from "../src/feedback/index.js";
import {
  createVerifiedSwarm,
  type SwarmResult,
  type SwarmStepResult,
} from "../src/swarm/index.js";
import {
  resetPermissionContext,
  clearAuditLog,
} from "../src/safety/index.js";
import { resetMetrics } from "../src/observability/index.js";

// ── Helpers ──

function makeStep(overrides: Partial<SwarmStepResult> = {}): SwarmStepResult {
  return {
    agent: { role: "researcher", name: "Test Researcher" },
    input: { query: "test", context: {}, memory: { getAll: () => [], size: () => 0 } as any, previousSteps: [] },
    output: {
      data: {},
      summary: "Test output",
      confidence: 85,
      claims: ["NVDA trades at $170"],
    },
    permission: { decision: "allow", reason: "ok", highStakesTriggered: false, escalated: false, lineage: {} as any },
    escalated: false,
    durationMs: 100,
    creditsUsed: 3,
    ...overrides,
  } as SwarmStepResult;
}

function makeResult(steps: SwarmStepResult[], overrides: Partial<SwarmResult> = {}): SwarmResult {
  return {
    sessionId: "test-session",
    query: "Analyze NVDA",
    steps,
    synthesis: null,
    totalCreditsUsed: steps.reduce((s, st) => s + st.creditsUsed, 0),
    totalDurationMs: 1000,
    escalated: false,
    escalationNotices: [],
    verificationSummary: { stepsVerified: 0, stepsTotal: steps.length, avgConfidence: 70, flaggedSteps: 0 },
    feedback: [],
    ...overrides,
  };
}

function mockWebSearch(resultCount: number = 3): (q: string) => Promise<WebSearchFallbackResult> {
  return async (query: string) => ({
    query,
    resultCount,
    sources: Array.from({ length: resultCount }, (_, i) => ({
      title: `Source ${i + 1}`,
      url: `https://example.com/${i}`,
      snippet: `Relevant information about ${query}`,
    })),
    timestamp: new Date().toISOString(),
    latencyMs: 150,
  });
}

describe("feedback-loop", () => {
  beforeEach(() => {
    resetFeedback();
    resetPermissionContext();
    clearAuditLog();
    resetMetrics();
  });

  // ── Flagging Logic ──

  it("flags low-confidence outputs below threshold", async () => {
    const lowConfStep = makeStep({ output: { data: {}, summary: "Uncertain", confidence: 45, claims: [] } });
    const result = makeResult([lowConfStep]);

    const entries = await collectSwarmFeedback(result, {
      enableSelfImprovement: true,
      feedbackThreshold: 70,
    });

    assert.ok(entries.length >= 1);
    assert.equal(entries[0].reason, "low_confidence");
    assert.ok(entries[0].reasonDetail.includes("45"));
  });

  it("flags contradicted verifications", async () => {
    const contradicted = makeStep({
      output: { data: { verdict: "contradicted" }, summary: "Claim contradicted", confidence: 60 },
    });
    const result = makeResult([contradicted]);

    const entries = await collectSwarmFeedback(result, { enableSelfImprovement: true });

    const contradictedEntry = entries.find(e => e.reason === "contradicted");
    assert.ok(contradictedEntry, "Should flag contradicted verdict");
  });

  it("flags escalated high-stakes outputs", async () => {
    const escalated = makeStep({
      escalated: true,
      escalationNotice: "Trade signal BUY (92/100) exceeds threshold",
    });
    const result = makeResult([escalated]);

    const entries = await collectSwarmFeedback(result, { enableSelfImprovement: true });

    const escEntry = entries.find(e => e.reason === "escalated");
    assert.ok(escEntry);
    assert.ok(escEntry!.reasonDetail.length > 0, "Should have a reason detail");
  });

  it("flags data gaps when output indicates missing data", async () => {
    const gapStep = makeStep({
      output: { data: {}, summary: "No data available for this query", confidence: 50 },
    });
    const result = makeResult([gapStep]);

    const entries = await collectSwarmFeedback(result, { enableSelfImprovement: true });

    const gapEntry = entries.find(e => e.reason === "data_gap");
    assert.ok(gapEntry);
    assert.ok(gapEntry!.gaps.length > 0);
  });

  it("flags low-confidence verification status", async () => {
    const step = makeStep({
      verification: { confidenceScore: 25, verificationStatus: "low-confidence", evidenceCount: 0 },
    });
    const result = makeResult([step]);

    const entries = await collectSwarmFeedback(result, { enableSelfImprovement: true });

    const verEntry = entries.find(e => e.reason === "verification_failed");
    assert.ok(verEntry);
  });

  it("does not flag high-confidence outputs", async () => {
    const good = makeStep({ output: { data: { status: "ok" }, summary: "Strong analysis", confidence: 90 } });
    const result = makeResult([good]);

    const entries = await collectSwarmFeedback(result, { enableSelfImprovement: true });
    assert.equal(entries.length, 0);
  });

  it("does nothing when enableSelfImprovement is false", async () => {
    const low = makeStep({ output: { data: {}, summary: "Bad", confidence: 20 } });
    const result = makeResult([low]);

    const entries = await collectSwarmFeedback(result, { enableSelfImprovement: false });
    assert.equal(entries.length, 0);
  });

  // ── Web Search Fallback ──

  it("triggers web search fallback on data gaps", async () => {
    const gapStep = makeStep({
      output: { data: {}, summary: "No results found for this query", confidence: 40 },
    });
    const result = makeResult([gapStep]);

    const entries = await collectSwarmFeedback(result, {
      enableSelfImprovement: true,
      enableWebSearchFallback: true,
      webSearchFn: mockWebSearch(5),
    });

    const withSearch = entries.find(e => e.webSearchResults);
    assert.ok(withSearch, "Should have web search results");
    assert.equal(withSearch!.webSearchResults!.resultCount, 5);
    assert.equal(withSearch!.status, "enriched");
  });

  it("survives web search failure gracefully", async () => {
    const gapStep = makeStep({
      output: { data: {}, summary: "No data available", confidence: 40 },
    });
    const result = makeResult([gapStep]);

    const entries = await collectSwarmFeedback(result, {
      enableSelfImprovement: true,
      enableWebSearchFallback: true,
      webSearchFn: async () => { throw new Error("Search API down"); },
    });

    assert.ok(entries.length >= 1);
    assert.equal(entries[0].webSearchResults, undefined);
    assert.equal(entries[0].status, "pending");
  });

  // ── Pipeline Integration ──

  it("auto-routes to pipeline when configured", async () => {
    const low = makeStep({ output: { data: {}, summary: "Weak data", confidence: 30 } });
    const result = makeResult([low]);

    let routedEntry: any = null;
    const entries = await collectSwarmFeedback(result, {
      enableSelfImprovement: true,
      autoRouteToPipeline: true,
      pipelineRouteFn: async (entry) => {
        routedEntry = entry;
        return { status: "ok", jobId: "job-123" };
      },
    });

    assert.ok(routedEntry);
    assert.equal(entries[0].routedToPipeline, true);
    assert.equal(entries[0].status, "routed");
    assert.equal(entries[0].pipelineResponse?.status, "ok");
  });

  // ── Manual Feedback Submission ──

  it("accepts manual feedback submission", () => {
    const entry = submitFeedback({
      sessionId: "manual-session",
      query: "Is AAPL a good buy?",
      reason: "user_submitted",
      detail: "Analysis missed recent M&A news",
      claims: ["AAPL has no pending acquisitions"],
    });

    assert.ok(entry.id.startsWith("fb_"));
    assert.equal(entry.reason, "user_submitted");
    assert.equal(entry.stepAgent, "user");
    assert.equal(entry.status, "pending");
  });

  it("resolves and dismisses feedback entries", () => {
    const entry = submitFeedback({
      sessionId: "s1", query: "test", reason: "manual", detail: "test",
    });

    assert.equal(resolveFeedback(entry.id, "resolved"), true);
    assert.equal(getFeedbackQueue({ sessionId: "s1" })[0].status, "resolved");

    assert.equal(resolveFeedback("nonexistent", "dismissed"), false);
  });

  // ── Privacy ──

  it("redacts sensitive data from feedback entries", () => {
    const entry = submitFeedback({
      sessionId: "s1",
      query: "Contact me at john@example.com about SSN 123-45-6789",
      reason: "manual",
      detail: "Card 4111 1111 1111 1111 was charged",
      claims: ["Email john@test.com for details"],
    });

    assert.ok(!entry.query.includes("john@example.com"));
    assert.ok(entry.query.includes("[REDACTED]"));
    assert.ok(!entry.reasonDetail.includes("4111"));
    assert.ok(!entry.flaggedClaims[0].includes("john@test.com"));
  });

  // ── Metrics ──

  it("tracks feedback metrics accurately", async () => {
    const low = makeStep({ output: { data: {}, summary: "Weak", confidence: 40 } });
    const escalated = makeStep({ escalated: true, escalationNotice: "High stakes" });
    const result = makeResult([low, escalated]);

    await collectSwarmFeedback(result, {
      enableSelfImprovement: true,
      enableWebSearchFallback: true,
      webSearchFn: mockWebSearch(3),
    });

    const metrics = getFeedbackMetrics();
    assert.ok(metrics.totalFeedback >= 2);
    assert.ok(metrics.byReason.low_confidence >= 1 || metrics.byReason.data_gap >= 1);
    assert.ok(metrics.avgFlaggedConfidence >= 0);
  });

  it("tracks web search fallback rate in metrics", async () => {
    const gap1 = makeStep({ output: { data: {}, summary: "No results found", confidence: 30 } });
    const gap2 = makeStep({ output: { data: {}, summary: "No data available", confidence: 25 } });

    await collectSwarmFeedback(makeResult([gap1]), {
      enableSelfImprovement: true,
      enableWebSearchFallback: true,
      webSearchFn: mockWebSearch(3),
    });
    await collectSwarmFeedback(makeResult([gap2]), {
      enableSelfImprovement: true,
      enableWebSearchFallback: true,
      webSearchFn: async () => { throw new Error("fail"); },
    });

    const metrics = getFeedbackMetrics();
    assert.ok(metrics.webSearchFallbacks >= 1);
    assert.ok(metrics.webSearchSuccessRate >= 0);
    assert.ok(metrics.webSearchSuccessRate <= 100);
  });

  // ── Swarm Integration ──

  it("swarm run collects feedback when enabled", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["researcher", "synthesizer"],
      enableSelfImprovement: true,
      feedbackThreshold: 90, // High threshold — most outputs flagged
      apiFn: async () => ({
        summary: "Moderate analysis",
        confidence: { level: "medium" },
        trade_signal: { score: 50, action: "hold" },
      }),
    });
    const result = await swarm.run("Test feedback integration");

    // Feedback array should exist
    assert.ok(Array.isArray(result.feedback));
    // With threshold 90, medium-confidence (60) should be flagged
    assert.ok(result.feedback.length >= 1);
    assert.equal(result.feedback[0].reason, "low_confidence");
  });

  it("swarm run returns empty feedback when disabled", async () => {
    const swarm = createVerifiedSwarm({
      roles: ["researcher", "synthesizer"],
      enableSelfImprovement: false,
    });
    const result = await swarm.run("No feedback test");

    assert.ok(Array.isArray(result.feedback));
    assert.equal(result.feedback.length, 0);
  });
});
