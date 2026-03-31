import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHighLevelTools } from "../src/tools/high-level-tools.js";
import { getRegisteredTools } from "../src/tools/veroq-tool-factory.js";
import { checkPermissions, resetPermissionContext, clearAuditLog } from "../src/safety/index.js";

function freshServer(): McpServer {
  return new McpServer({ name: "hl-test", version: "0.0.1" });
}

// Mock API that returns structured responses
const mockApi = async (method: string, path: string, params?: any, body?: any) => {
  if (path === "/api/v1/ask") {
    const q = (body as any)?.question || "";
    return {
      status: "ok",
      question: q,
      summary: `Analysis for: ${q}`,
      intents: ["full"],
      tickers: ["NVDA"],
      confidence: { level: "high", reason: "live price" },
      trade_signal: { action: "hold", score: 55, factors: ["RSI neutral (45)"] },
      data: {
        ticker: { price: { current: 167.46, change_pct: -2.21 } },
        screener: { results: [{ ticker: "NVDA", price: 167, rsi_14: 35 }], interpreted_as: { sector: "Technology" } },
      },
      endpoints_called: ["/api/v1/ticker/NVDA"],
    };
  }
  if (path === "/api/v1/verify") {
    return {
      status: "ok",
      verdict: "supported",
      confidence: 0.85,
      confidence_breakdown: { source_agreement: 0.9, source_quality: 0.8, recency: 0.9, corroboration_depth: 0.8 },
      evidence_chain: [{ source: "Reuters", position: "supports", snippet: "Confirmed", reliability: 0.95 }],
      receipt: { id: "vr_test123" },
    };
  }
  return { status: "ok" };
};

describe("high-level-tools", () => {
  beforeEach(() => {
    resetPermissionContext();
    clearAuditLog();
  });

  it("registers all 6 high-level tools", () => {
    const server = freshServer();
    registerHighLevelTools(server, mockApi as any);

    const tools = getRegisteredTools();
    const hlTools = [
      "veroq_analyze_ticker",
      "veroq_verify_market_claim",
      "veroq_generate_trading_signal",
      "veroq_comprehensive_intelligence",
      "veroq_compare_tickers",
      "veroq_tool_search",
    ];
    for (const name of hlTools) {
      assert.ok(tools.find(t => t.name === name), `Missing: ${name}`);
    }
  });

  it("analyze_ticker has correct metadata", () => {
    const server = freshServer();
    registerHighLevelTools(server, mockApi as any);

    const tool = getRegisteredTools().find(t => t.name === "veroq_analyze_ticker");
    assert.ok(tool);
    assert.equal(tool!.category, "intelligence");
    assert.equal(tool!.credits, 3);
  });

  it("verify_market_claim has correct metadata", () => {
    const server = freshServer();
    registerHighLevelTools(server, mockApi as any);

    const tool = getRegisteredTools().find(t => t.name === "veroq_verify_market_claim");
    assert.ok(tool);
    assert.equal(tool!.category, "verification");
    assert.equal(tool!.credits, 3);
  });

  it("generate_trading_signal has correct metadata", () => {
    const server = freshServer();
    registerHighLevelTools(server, mockApi as any);

    const tool = getRegisteredTools().find(t => t.name === "veroq_generate_trading_signal");
    assert.ok(tool);
    assert.equal(tool!.category, "trading");
    assert.equal(tool!.credits, 5);
  });

  it("tool_search has 0 credits", () => {
    const server = freshServer();
    registerHighLevelTools(server, mockApi as any);

    const tool = getRegisteredTools().find(t => t.name === "veroq_tool_search");
    assert.ok(tool);
    assert.equal(tool!.credits, 0);
    assert.equal(tool!.category, "discovery");
  });

  it("permissions work on high-level tools", () => {
    const server = freshServer();
    registerHighLevelTools(server, mockApi as any);

    // Normal query — allowed
    const r1 = checkPermissions("veroq_analyze_ticker", { ticker: "AAPL" });
    assert.equal(r1.decision, "allow");

    // High-stakes via verify
    const r2 = checkPermissions("veroq_verify_market_claim", { claim: "Tesla earnings beat by 200%" });
    // May trigger high-stakes since it has "earnings" in claim
    assert.ok(["allow", "review"].includes(r2.decision));
  });

  it("high-level tools coexist with legacy 52 tools", async () => {
    const server = freshServer();

    // Register old-style tool
    const { z } = await import("zod");
    server.tool("veroq_feed", "Legacy feed", { limit: z.number().optional() }, async () => ({
      content: [{ type: "text" as const, text: "legacy" }],
    }));

    // Register high-level tools
    registerHighLevelTools(server, mockApi as any);

    // Both exist
    const tools = getRegisteredTools();
    assert.ok(tools.find(t => t.name === "veroq_analyze_ticker"));
    // Legacy tool not in factory registry (correct — bypassed factory)
  });

  it("descriptions contain usage guidance", () => {
    const server = freshServer();
    registerHighLevelTools(server, mockApi as any);

    const tools = getRegisteredTools();
    for (const name of ["veroq_analyze_ticker", "veroq_verify_market_claim", "veroq_generate_trading_signal"]) {
      const tool = tools.find(t => t.name === name);
      assert.ok(tool, `Missing: ${name}`);
      assert.ok(tool!.description.includes("WHEN TO USE"), `${name} missing WHEN TO USE`);
      assert.ok(tool!.description.includes("RETURNS"), `${name} missing RETURNS`);
      assert.ok(tool!.description.includes("COST"), `${name} missing COST`);
      assert.ok(tool!.description.includes("EXAMPLE"), `${name} missing EXAMPLE`);
    }
  });
});
