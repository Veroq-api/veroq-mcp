import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { recordToolCall, getMetrics, getMetricsSummary, resetMetrics } from "../src/observability/index.js";

describe("observability", () => {
  beforeEach(() => resetMetrics());

  it("records tool calls", () => {
    recordToolCall("veroq_ask", 150, false, false, false, 0.85);
    const m = getMetrics();
    assert.equal(m.veroq_ask.calls, 1);
    assert.equal(m.veroq_ask.totalLatencyMs, 150);
  });

  it("tracks errors", () => {
    recordToolCall("veroq_ask", 50, true, false, false);
    assert.equal(getMetrics().veroq_ask.errors, 1);
  });

  it("tracks high-stakes and escalations", () => {
    recordToolCall("veroq_ask", 100, false, true, false);
    recordToolCall("veroq_ask", 200, false, true, true);
    const m = getMetrics().veroq_ask;
    assert.equal(m.highStakesTriggers, 2);
    assert.equal(m.escalations, 1);
  });

  it("computes summary", () => {
    recordToolCall("veroq_ask", 100, false, false, false);
    recordToolCall("veroq_verify", 200, false, true, false);
    recordToolCall("veroq_ask", 300, true, false, false);
    const s = getMetricsSummary();
    assert.equal(s.totalCalls, 3);
    assert.equal(s.totalErrors, 1);
    assert.equal(s.avgLatencyMs, 200);
    assert.equal(s.toolBreakdown.length, 2);
  });

  it("computes rates correctly", () => {
    for (let i = 0; i < 10; i++) recordToolCall("veroq_ask", 50, false, i < 3, i < 1);
    const s = getMetricsSummary();
    assert.equal(s.highStakesRate, 30);
    assert.equal(s.escalationRate, 10);
  });

  it("tracks average confidence", () => {
    recordToolCall("veroq_verify", 100, false, false, false, 0.8);
    recordToolCall("veroq_verify", 100, false, false, false, 0.9);
    const m = getMetrics().veroq_verify;
    assert.ok(Math.abs(m.avgConfidence - 0.85) < 0.01);
  });

  it("resets cleanly", () => {
    recordToolCall("veroq_ask", 100, false, false, false);
    resetMetrics();
    assert.equal(Object.keys(getMetrics()).length, 0);
  });

  it("summary with no data returns zeros", () => {
    const s = getMetricsSummary();
    assert.equal(s.totalCalls, 0);
    assert.equal(s.avgLatencyMs, 0);
  });
});
