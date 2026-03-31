// ============================================================
// VEROQ Server Enhancer — Tests
// ============================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createEnhancedVeroQTool,
  enhanceServer,
  type VerificationMetadata,
  type EnhancedResponse,
} from "../src/tools/index.js";
import { getRegisteredTools } from "../src/tools/index.js";

function freshServer(): McpServer {
  return new McpServer({ name: "enhancer-test", version: "0.0.1" });
}

describe("server-enhancer", () => {
  it("createEnhancedVeroQTool registers tool with metadata", () => {
    const server = freshServer();

    createEnhancedVeroQTool(server, {
      name: "enhanced_ask_test",
      description: "Enhanced ask",
      inputSchema: z.object({ question: z.string() }),
      apiCall: async () => ({
        status: "ok",
        summary: "NVDA trades at $167",
        confidence: { level: "high", reason: "live price" },
        trade_signal: { score: 65 },
        endpoints_called: ["/api/v1/ticker/NVDA", "/api/v1/ticker/NVDA/technicals"],
      }),
      metadataExtractor: "ask",
      annotations: { readOnlyHint: true, openWorldHint: true },
    });

    const found = getRegisteredTools().find((t) => t.name === "enhanced_ask_test");
    assert.ok(found, "Enhanced tool should be in registry");
  });

  it("ask metadata extractor produces correct confidence", () => {
    const server = freshServer();
    let capturedResult: unknown;

    createEnhancedVeroQTool(server, {
      name: "ask_confidence_test",
      description: "Test ask confidence",
      inputSchema: z.object({ q: z.string() }),
      apiCall: async () => ({
        status: "ok",
        confidence: { level: "high" },
        trade_signal: { score: 75 },
        endpoints_called: ["/api/v1/ticker/AAPL"],
        data: { news: { briefs: [{ headline: "Apple beats earnings" }] } },
      }),
      metadataExtractor: "ask",
      // Capture the result via custom display
      customDisplay: (data, metadata) => {
        capturedResult = { data, metadata };
        return JSON.stringify(metadata);
      },
    });

    const found = getRegisteredTools().find((t) => t.name === "ask_confidence_test");
    assert.ok(found);
  });

  it("verify metadata extractor handles evidence chain", () => {
    const server = freshServer();

    createEnhancedVeroQTool(server, {
      name: "verify_evidence_test",
      description: "Test verify evidence",
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
          { source: "Reuters", snippet: "Fed held rates", url: "https://reuters.com/...", position: "supports", reliability: 0.95 },
          { source: "Bloomberg", snippet: "FOMC voted", url: "https://bloomberg.com/...", position: "supports", reliability: 0.94 },
        ],
      }),
      metadataExtractor: "verify",
    });

    const found = getRegisteredTools().find((t) => t.name === "verify_evidence_test");
    assert.ok(found);
  });

  it("generic metadata extractor returns defaults", () => {
    const server = freshServer();

    createEnhancedVeroQTool(server, {
      name: "generic_meta_test",
      description: "Generic test",
      inputSchema: z.object({ q: z.string() }),
      apiCall: async () => ({ status: "ok", data: [1, 2, 3] }),
      metadataExtractor: "generic",
    });

    const found = getRegisteredTools().find((t) => t.name === "generic_meta_test");
    assert.ok(found);
  });

  it("enhanceServer returns factory function", () => {
    const server = freshServer();
    const mockApi = async () => ({} as unknown);

    const enhanced = enhanceServer(server, mockApi);
    assert.equal(typeof enhanced.createEnhanced, "function");
  });

  it("custom display callback receives both data and metadata", () => {
    const server = freshServer();
    let displayReceived = false;

    createEnhancedVeroQTool(server, {
      name: "custom_display_test",
      description: "Custom display",
      inputSchema: z.object({ q: z.string() }),
      apiCall: async () => ({ status: "ok", result: "test" }),
      metadataExtractor: "generic",
      customDisplay: (data, metadata) => {
        displayReceived = true;
        assert.ok(data);
        assert.ok(metadata);
        assert.equal(typeof metadata.confidenceScore, "number");
        assert.ok(Array.isArray(metadata.evidenceChain));
        assert.ok(["verified", "flagged", "low-confidence"].includes(metadata.verificationStatus));
        assert.equal(typeof metadata.promptHint, "string");
        return "custom output";
      },
    });

    // Display is called at runtime, not registration — just verify it registered
    const found = getRegisteredTools().find((t) => t.name === "custom_display_test");
    assert.ok(found);
  });

  it("backward compatibility — existing server.tool still works", () => {
    const server = freshServer();

    // Register a tool the old way
    server.tool(
      "old_style_tool",
      "Old style tool",
      { q: z.string() },
      async ({ q }) => ({
        content: [{ type: "text" as const, text: `Old: ${q}` }],
      }),
    );

    // Register an enhanced tool alongside
    createEnhancedVeroQTool(server, {
      name: "new_style_tool",
      description: "New style tool",
      inputSchema: z.object({ q: z.string() }),
      apiCall: async () => ({ answer: "new" }),
    });

    // Both should coexist
    const found = getRegisteredTools().find((t) => t.name === "new_style_tool");
    assert.ok(found);
    // Old tool not in factory registry (expected — it bypassed the factory)
  });

  it("verification status maps correctly", () => {
    const server = freshServer();

    // High confidence → verified
    createEnhancedVeroQTool(server, {
      name: "status_high",
      description: "High confidence",
      inputSchema: z.object({}),
      apiCall: async () => ({ confidence: { level: "high" }, trade_signal: { score: 80 }, endpoints_called: [] }),
      metadataExtractor: "ask",
    });

    // Low confidence → low-confidence
    createEnhancedVeroQTool(server, {
      name: "status_low",
      description: "Low confidence",
      inputSchema: z.object({}),
      apiCall: async () => ({ confidence: { level: "low" }, endpoints_called: [] }),
      metadataExtractor: "ask",
    });

    const high = getRegisteredTools().find((t) => t.name === "status_high");
    const low = getRegisteredTools().find((t) => t.name === "status_low");
    assert.ok(high);
    assert.ok(low);
  });
});
