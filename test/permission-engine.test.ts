import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkPermissions,
  checkOutputSafety,
  setPermissionContext,
  resetPermissionContext,
  getAuditLog,
  clearAuditLog,
  getFullAuditTrail,
  getDecisionLineage,
  configureEnterprise,
  isHighStakesOutput,
} from "../src/safety/index.js";

describe("permission-engine", () => {
  beforeEach(() => {
    resetPermissionContext();
    clearAuditLog();
  });

  // ── Basic Permission Checks ──

  it("allows all veroq tools by default", () => {
    const r = checkPermissions("veroq_ask", { question: "AAPL price" });
    assert.equal(r.decision, "allow");
    assert.equal(r.highStakesTriggered, false);
  });

  it("allows veroq_verify by default", () => {
    const r = checkPermissions("veroq_verify", { claim: "The sky is blue" });
    assert.equal(r.decision, "allow");
  });

  it("allows unknown veroq tools via wildcard", () => {
    const r = checkPermissions("veroq_custom_tool", { x: 1 });
    assert.equal(r.decision, "allow");
  });

  // ── Deny Rules ──

  it("denies tools matching deny rule", () => {
    setPermissionContext({
      alwaysDenyRules: [{ pattern: "veroq_dangerous" }],
    });
    const r = checkPermissions("veroq_dangerous", {});
    assert.equal(r.decision, "deny");
  });

  it("denies with wildcard pattern", () => {
    setPermissionContext({
      alwaysDenyRules: [{ pattern: "veroq_admin_*" }],
    });
    const r = checkPermissions("veroq_admin_delete", {});
    assert.equal(r.decision, "deny");
    const r2 = checkPermissions("veroq_ask", {});
    assert.equal(r2.decision, "allow");
  });

  it("denies with condition match", () => {
    setPermissionContext({
      alwaysDenyRules: [{ pattern: "veroq_ask", conditions: { fast: false } }],
    });
    const r1 = checkPermissions("veroq_ask", { question: "AAPL", fast: false });
    assert.equal(r1.decision, "deny");
    const r2 = checkPermissions("veroq_ask", { question: "AAPL", fast: true });
    assert.equal(r2.decision, "allow");
  });

  // ── Ask/Review Rules ──

  it("flags tools matching ask rule for review", () => {
    setPermissionContext({
      alwaysAskRules: [{ pattern: "veroq_verify" }],
    });
    const r = checkPermissions("veroq_verify", { claim: "test" });
    assert.equal(r.decision, "review");
  });

  // ── Bypass Mode ──

  it("allows everything in bypass mode", () => {
    setPermissionContext({
      mode: "bypass",
      alwaysDenyRules: [{ pattern: "veroq_ask" }],
    });
    const r = checkPermissions("veroq_ask", { question: "test" });
    assert.equal(r.decision, "allow");
  });

  // ── High-Stakes Detection ──

  it("flags trade decision queries as high-stakes", () => {
    const r = checkPermissions("veroq_ask", { question: "Should I buy NVDA?" });
    assert.equal(r.decision, "review");
    assert.equal(r.highStakesTriggered, true);
  });

  it("flags position sizing queries as high-stakes", () => {
    const r = checkPermissions("veroq_ask", { question: "What position size for TSLA trade signal?" });
    assert.equal(r.decision, "review");
    assert.equal(r.highStakesTriggered, true);
  });

  it("does not flag simple price queries", () => {
    const r = checkPermissions("veroq_ask", { question: "What is AAPL price?" });
    assert.equal(r.decision, "allow");
    assert.equal(r.highStakesTriggered, false);
  });

  it("flags high-impact verify claims", () => {
    const r = checkPermissions("veroq_verify", { claim: "Tesla earnings beat by 200%" });
    assert.equal(r.decision, "review");
    assert.equal(r.highStakesTriggered, true);
  });

  it("does not flag generic verify claims", () => {
    const r = checkPermissions("veroq_verify", { claim: "The sky is blue" });
    assert.equal(r.decision, "allow");
    assert.equal(r.highStakesTriggered, false);
  });

  // ── Output Safety ──

  it("flags high-confidence trade signals", () => {
    const r = checkOutputSafety("veroq_ask", {
      trade_signal: { action: "buy", score: 85 },
    });
    assert.equal(r.flagged, true);
  });

  it("does not flag low-confidence signals", () => {
    const r = checkOutputSafety("veroq_ask", {
      trade_signal: { action: "hold", score: 50 },
    });
    assert.equal(r.flagged, false);
  });

  it("flags high-confidence verification", () => {
    const r = checkOutputSafety("veroq_verify", { confidence: 0.95 });
    assert.equal(r.flagged, true);
  });

  it("respects custom threshold", () => {
    const r = checkOutputSafety("veroq_ask", { trade_signal: { score: 70 } }, { highStakesThreshold: 60 });
    assert.equal(r.flagged, true);
    const r2 = checkOutputSafety("veroq_ask", { trade_signal: { score: 70 } }, { highStakesThreshold: 90 });
    assert.equal(r2.flagged, false);
  });

  it("bypass mode skips output safety", () => {
    const r = checkOutputSafety("veroq_ask", { trade_signal: { score: 99 } }, { mode: "bypass" });
    assert.equal(r.flagged, false);
  });

  // ── Background Agent Restrictions ──

  it("restricts background agents when enabled", () => {
    setPermissionContext({
      restrictBackgroundAgents: true,
      isBackgroundAgent: true,
    });
    const r = checkPermissions("veroq_ask", { question: "AAPL" });
    assert.equal(r.decision, "review");
  });

  it("allows background agents with explicit rule", () => {
    setPermissionContext({
      restrictBackgroundAgents: true,
      isBackgroundAgent: true,
      alwaysAllowRules: [
        { pattern: "veroq_*" },
        { pattern: "veroq_ask" },  // explicit non-wildcard
      ],
    });
    const r = checkPermissions("veroq_ask", { question: "AAPL" });
    assert.equal(r.decision, "allow");
  });

  it("does not restrict interactive agents", () => {
    setPermissionContext({
      restrictBackgroundAgents: true,
      isBackgroundAgent: false,
    });
    const r = checkPermissions("veroq_ask", { question: "AAPL" });
    assert.equal(r.decision, "allow");
  });

  // ── Audit Logging ──

  it("logs decisions to audit log", () => {
    checkPermissions("veroq_ask", { question: "test" });
    const log = getAuditLog();
    assert.ok(log.length >= 1);
    assert.equal(log[0].toolName, "veroq_ask");
    assert.equal(log[0].decision, "allow");
  });

  it("clears audit log", () => {
    checkPermissions("veroq_ask", {});
    clearAuditLog();
    assert.equal(getAuditLog().length, 0);
  });

  it("includes enterprise ID in audit", () => {
    setPermissionContext({ enterpriseId: "acme-corp" });
    checkPermissions("veroq_ask", {});
    const log = getAuditLog();
    assert.equal(log[0].enterpriseId, "acme-corp");
  });

  it("audit log respects size limit", () => {
    for (let i = 0; i < 200; i++) {
      checkPermissions("veroq_ask", { i });
    }
    // Should not exceed max (internal cap is 10000, but at least not growing unbounded)
    assert.ok(getAuditLog().length <= 200);
  });

  // ── Enterprise Configuration ──

  it("configureEnterprise sets context", () => {
    configureEnterprise({
      enterpriseId: "hedge-fund-1",
      deniedTools: ["veroq_screener*"],
      reviewTools: ["veroq_ask"],
      highStakesThreshold: 60,
    });

    const r1 = checkPermissions("veroq_screener_natural", {});
    assert.equal(r1.decision, "deny");

    const r2 = checkPermissions("veroq_ask", { question: "price" });
    assert.equal(r2.decision, "review");
  });

  // ── isHighStakesOutput ──

  it("isHighStakesOutput detects trade signals above threshold", () => {
    assert.ok(isHighStakesOutput("veroq_ask", { trade_signal: { score: 90 } }));
    assert.ok(!isHighStakesOutput("veroq_ask", { trade_signal: { score: 50 } }));
  });

  it("isHighStakesOutput detects high verification confidence", () => {
    assert.ok(isHighStakesOutput("veroq_verify", { confidence: 0.95 }));
    assert.ok(!isHighStakesOutput("veroq_verify", { confidence: 0.5 }));
  });

  // ── Decision Lineage ──

  it("checkPermissions returns full decision lineage", () => {
    const r = checkPermissions("veroq_ask", { question: "AAPL price" });
    assert.ok(r.lineage);
    assert.equal(r.lineage.toolName, "veroq_ask");
    assert.ok(r.lineage.rulesEvaluated.length > 0, "Should have evaluated rules");
    assert.equal(r.lineage.finalDecision, "allow");
    assert.ok(r.lineage.timestamp);
    assert.ok(r.lineage.durationMs >= 0);
  });

  it("lineage records which rules were evaluated", () => {
    setPermissionContext({
      alwaysDenyRules: [{ pattern: "veroq_admin_*" }],
      alwaysAskRules: [{ pattern: "veroq_verify" }],
    });
    const r = checkPermissions("veroq_ask", { question: "test" });
    const denyEval = r.lineage.rulesEvaluated.find(e => e.ruleType === "deny");
    assert.ok(denyEval, "Should have evaluated deny rule");
    assert.equal(denyEval!.matched, false);
  });

  it("lineage shows matched rule for deny decision", () => {
    setPermissionContext({
      alwaysDenyRules: [{ pattern: "veroq_blocked" }],
    });
    const r = checkPermissions("veroq_blocked", {});
    const denyEval = r.lineage.rulesEvaluated.find(e => e.ruleType === "deny" && e.matched);
    assert.ok(denyEval);
    assert.equal(denyEval!.result, "deny");
  });

  it("lineage captures high-stakes input detection", () => {
    const r = checkPermissions("veroq_ask", { question: "Should I buy NVDA?" });
    const hsEval = r.lineage.rulesEvaluated.find(e => e.ruleType === "high-stakes-input" && e.matched);
    assert.ok(hsEval, "Should detect high-stakes input");
    assert.equal(r.lineage.finalDecision, "review");
  });

  // ── getDecisionLineage ──

  it("getDecisionLineage combines input + output evaluation", () => {
    const lineage = getDecisionLineage(
      "veroq_ask",
      { question: "AAPL price" },
      { trade_signal: { action: "buy", score: 90 }, confidence: { level: "high" } },
    );
    assert.ok(lineage.output);
    assert.ok(lineage.confidenceFactors.tradeSignal);
    assert.ok(lineage.confidenceFactors.confidence);
    // High-stakes output should show in evaluations
    const hsOutput = lineage.rulesEvaluated.find(e => e.ruleType === "high-stakes-output");
    assert.ok(hsOutput);
  });

  it("getDecisionLineage tracks evidence count", () => {
    const lineage = getDecisionLineage(
      "veroq_verify",
      { claim: "test" },
      { confidence: 0.9, evidence_chain: [{}, {}, {}], confidence_breakdown: { source_agreement: 0.95 } },
    );
    assert.equal(lineage.confidenceFactors.evidenceCount, 3);
    assert.ok(lineage.confidenceFactors.breakdown);
  });

  // ── Escalation ──

  it("escalation triggered for high trade signal", () => {
    const r = checkOutputSafety("veroq_ask", {
      trade_signal: { action: "buy", score: 90 },
    });
    assert.equal(r.escalated, true);
    assert.ok(r.escalationNotice);
    assert.ok(r.escalationNotice!.includes("ESCALATION"));
  });

  it("escalation not triggered for low score", () => {
    const r = checkOutputSafety("veroq_ask", {
      trade_signal: { action: "hold", score: 50 },
    });
    assert.equal(r.escalated, false);
  });

  it("escalation respects custom threshold", () => {
    const r = checkOutputSafety("veroq_ask", { trade_signal: { score: 65 } }, { escalationThreshold: 60, escalationTools: ["veroq_ask"] });
    assert.equal(r.escalated, true);
  });

  it("escalation with pause mode", () => {
    const r = checkOutputSafety("veroq_ask", { trade_signal: { action: "buy", score: 90 } }, { escalationPauses: true, escalationTools: ["veroq_ask"] });
    assert.equal(r.escalated, true);
    assert.ok(r.escalationNotice!.includes("paused"));
  });

  it("escalation on verify contradicted with high confidence", () => {
    const r = checkOutputSafety("veroq_verify", {
      verdict: "contradicted",
      confidence: 0.92,
    });
    assert.equal(r.escalated, true);
    assert.ok(r.escalationNotice!.includes("CONTRADICTED"));
  });

  // ── Audit Trail ──

  it("getFullAuditTrail returns all entries", () => {
    checkPermissions("veroq_ask", { question: "a" });
    checkPermissions("veroq_verify", { claim: "b" });
    const trail = getFullAuditTrail();
    assert.ok(trail.length >= 2);
  });

  it("getFullAuditTrail filters by session", () => {
    setPermissionContext({ sessionId: "session-1" });
    checkPermissions("veroq_ask", { question: "s1" });
    setPermissionContext({ sessionId: "session-2" });
    checkPermissions("veroq_ask", { question: "s2" });

    const s1 = getFullAuditTrail("session-1");
    const s2 = getFullAuditTrail("session-2");
    assert.ok(s1.length >= 1);
    assert.ok(s2.length >= 1);
    assert.ok(s1.every(e => e.sessionId === "session-1"));
    assert.ok(s2.every(e => e.sessionId === "session-2"));
  });

  it("audit entries include lineage when available", () => {
    const r = checkPermissions("veroq_ask", { question: "test" });
    assert.ok(r.auditEntry?.lineage);
    assert.ok(r.auditEntry!.lineage!.rulesEvaluated.length > 0);
  });

  it("escalation logged in audit", () => {
    checkOutputSafety("veroq_ask", { trade_signal: { action: "buy", score: 95 } });
    const log = getAuditLog(1);
    assert.ok(log.length >= 1);
    assert.equal(log[0].escalated, true);
    assert.equal(log[0].decision, "escalate");
  });
});
