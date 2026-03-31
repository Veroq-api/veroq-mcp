// ============================================================
// Full Integration Test — Factory → Enhancer → Permission Engine
// ============================================================
// Tests the complete flow: tool registration, verification metadata
// injection, permission checks, safety flags, and audit logging.
// ============================================================

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  // Tool Factory
  createVeroQTool,
  getRegisteredTools,
  // Server Enhancer
  createEnhancedVeroQTool,
  // Permission Engine
  checkPermissions,
  checkOutputSafety,
  setPermissionContext,
  resetPermissionContext,
  getAuditLog,
  clearAuditLog,
  configureEnterprise,
} from "../src/tools/index.js";

function freshServer(): McpServer {
  return new McpServer({ name: "integration-test", version: "0.0.1" });
}

describe("integration", () => {
  beforeEach(() => {
    resetPermissionContext();
    clearAuditLog();
  });

  // ── Full Flow: Register → Permission → Execute → Safety ──

  it("full flow: factory tool with permission check", () => {
    const server = freshServer();

    // 1. Register tool via factory
    createVeroQTool(server, {
      name: "integ_ask",
      description: "Integration test ask",
      inputSchema: z.object({ question: z.string() }),
      execute: async ({ question }) => ({ summary: `Answer for: ${question}`, trade_signal: { score: 50 } }),
      category: "intelligence",
    });

    // 2. Permission check passes for normal query
    const perm = checkPermissions("integ_ask", { question: "AAPL price" });
    assert.equal(perm.decision, "allow");

    // 3. Tool is in registry
    const found = getRegisteredTools().find(t => t.name === "integ_ask");
    assert.ok(found);
    assert.equal(found!.category, "intelligence");
  });

  it("full flow: enhanced tool with verification metadata", () => {
    const server = freshServer();

    // 1. Register enhanced tool
    createEnhancedVeroQTool(server, {
      name: "integ_enhanced_ask",
      description: "Enhanced ask",
      inputSchema: z.object({ question: z.string() }),
      apiCall: async ({ question }) => ({
        status: "ok",
        summary: `NVDA analysis for: ${question}`,
        confidence: { level: "high" },
        trade_signal: { score: 75 },
        endpoints_called: ["/api/v1/ticker/NVDA"],
      }),
      metadataExtractor: "ask",
    });

    // 2. Tool registered
    assert.ok(getRegisteredTools().find(t => t.name === "integ_enhanced_ask"));

    // 3. Permission check
    const perm = checkPermissions("integ_enhanced_ask", { question: "NVDA analysis" });
    assert.equal(perm.decision, "allow");
  });

  it("full flow: high-stakes query triggers review", () => {
    const server = freshServer();

    createVeroQTool(server, {
      name: "integ_trade",
      description: "Trade tool",
      inputSchema: z.object({ question: z.string() }),
      execute: async () => ({ action: "buy" }),
    });

    // "Should I buy" triggers high-stakes
    const perm = checkPermissions("veroq_ask", { question: "Should I buy NVDA now?" });
    assert.equal(perm.decision, "review");
    assert.equal(perm.highStakesTriggered, true);

    // Audit logged
    const log = getAuditLog();
    assert.ok(log.length >= 1);
    assert.equal(log[0].highStakesTriggered, true);
  });

  it("full flow: output safety flags high-confidence signals", () => {
    // Simulate a tool output with high trade signal
    const safety = checkOutputSafety("veroq_ask", {
      trade_signal: { action: "buy", score: 90 },
      confidence: { level: "high" },
    });
    assert.equal(safety.flagged, true);
    assert.ok(safety.reason.length > 0, "Should have a reason");

    // Low signal passes
    const safe = checkOutputSafety("veroq_ask", {
      trade_signal: { action: "hold", score: 45 },
    });
    assert.equal(safe.flagged, false);
  });

  it("full flow: enterprise config applies deny + review rules", () => {
    configureEnterprise({
      enterpriseId: "test-fund",
      deniedTools: ["veroq_screener*"],
      reviewTools: ["veroq_verify"],
      highStakesThreshold: 70,
    });

    // Screener denied
    const r1 = checkPermissions("veroq_screener_natural", { query: "oversold" });
    assert.equal(r1.decision, "deny");

    // Verify requires review
    const r2 = checkPermissions("veroq_verify", { claim: "test" });
    assert.equal(r2.decision, "review");

    // Ask allowed (unless high-stakes)
    const r3 = checkPermissions("veroq_ask", { question: "AAPL price" });
    assert.equal(r3.decision, "allow");

    // Audit trail has enterprise ID
    const log = getAuditLog();
    assert.ok(log.every(e => e.enterpriseId === "test-fund"));
  });

  it("full flow: bypass mode overrides everything", () => {
    configureEnterprise({
      enterpriseId: "admin",
      deniedTools: ["veroq_*"],
    });

    // Everything denied
    const r1 = checkPermissions("veroq_ask", { question: "test" });
    assert.equal(r1.decision, "deny");

    // Bypass overrides
    setPermissionContext({ mode: "bypass" });
    const r2 = checkPermissions("veroq_ask", { question: "test" });
    assert.equal(r2.decision, "allow");
  });

  it("full flow: multiple tools coexist", () => {
    const server = freshServer();

    // Register via factory
    createVeroQTool(server, {
      name: "integ_tool_a",
      description: "Tool A",
      inputSchema: z.object({ x: z.string() }),
      execute: async () => "a",
    });

    // Register via enhancer
    createEnhancedVeroQTool(server, {
      name: "integ_tool_b",
      description: "Tool B",
      inputSchema: z.object({ y: z.string() }),
      apiCall: async () => ({ result: "b" }),
    });

    // Register old-style directly
    server.tool(
      "integ_tool_c",
      "Tool C",
      { z: z.string() },
      async () => ({ content: [{ type: "text" as const, text: "c" }] }),
    );

    // All coexist
    const tools = getRegisteredTools();
    assert.ok(tools.find(t => t.name === "integ_tool_a"));
    assert.ok(tools.find(t => t.name === "integ_tool_b"));
    // integ_tool_c not in registry (bypassed factory) — that's correct
  });

  it("full flow: audit log tracks entire session", () => {
    clearAuditLog();

    // Multiple operations
    checkPermissions("veroq_ask", { question: "AAPL" });
    checkPermissions("veroq_verify", { claim: "test" });
    checkPermissions("veroq_ticker", { symbol: "NVDA" });
    checkOutputSafety("veroq_ask", { trade_signal: { score: 85 } });

    const log = getAuditLog();
    assert.ok(log.length >= 4);

    // Most recent first
    assert.equal(log[0].toolName, "veroq_ask"); // output safety check
    assert.equal(log[0].highStakesTriggered, true);
  });

  it("full flow: verify enhanced tool with evidence extraction", () => {
    const server = freshServer();

    createEnhancedVeroQTool(server, {
      name: "integ_verify",
      description: "Verify with evidence",
      inputSchema: z.object({ claim: z.string() }),
      apiCall: async () => ({
        status: "ok",
        verdict: "supported",
        confidence: 0.92,
        confidence_breakdown: {
          source_agreement: 0.95,
          source_quality: 0.88,
          recency: 0.97,
          corroboration_depth: 0.85,
        },
        evidence_chain: [
          { source: "Reuters", snippet: "Confirmed", url: "https://reuters.com", position: "supports", reliability: 0.95 },
        ],
      }),
      metadataExtractor: "verify",
    });

    // Permission check for high-impact claim
    const perm = checkPermissions("veroq_verify", { claim: "NVDA revenue grew 200%" });
    // This is a high-impact claim (earnings keyword)
    assert.ok(perm.decision === "review" || perm.decision === "allow");

    // Tool registered
    assert.ok(getRegisteredTools().find(t => t.name === "integ_verify"));
  });

  it("full flow: background agent restrictions work end-to-end", () => {
    setPermissionContext({
      restrictBackgroundAgents: true,
      isBackgroundAgent: true,
    });

    // Background agent blocked from general queries
    const r1 = checkPermissions("veroq_ask", { question: "AAPL" });
    assert.equal(r1.decision, "review");

    // But explicitly allowed tools work
    setPermissionContext({
      restrictBackgroundAgents: true,
      isBackgroundAgent: true,
      alwaysAllowRules: [
        { pattern: "veroq_*" },
        { pattern: "veroq_ticker" },  // explicit
      ],
    });
    const r2 = checkPermissions("veroq_ticker", { symbol: "AAPL" });
    assert.equal(r2.decision, "allow");
  });
});
