// ============================================================
// External MCP Tests — registration, permissions, lineage,
// escalation, rate limiting, caching, observability, security.
// ============================================================

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ExternalMcpRegistry,
  resetExternalRegistry,
  registerExternalMcpServer,
  callExternalTool,
  getExternalRegistry,
  type ExternalServerConfig,
} from "../src/external/index.js";
import {
  resetPermissionContext,
  clearAuditLog,
  setPermissionContext,
  getAuditLog,
  checkPermissions,
} from "../src/safety/index.js";
import { resetMetrics, getMetricsSummary } from "../src/observability/index.js";

// Mock external call function
function mockCallFn(url: string, _options: { method: string; headers: Record<string, string>; body?: string }): Promise<Record<string, unknown>> {
  if (url.includes("error")) {
    return Promise.reject(new Error("Connection refused"));
  }
  const toolName = url.split("/tools/")[1] || "unknown";
  return Promise.resolve({
    status: "ok",
    tool: toolName,
    data: { price: 170.21, symbol: "NVDA" },
  });
}

// Standard test server config
function makeServer(overrides: Partial<ExternalServerConfig> = {}): ExternalServerConfig {
  return {
    serverId: "test-provider",
    name: "Test Market Data",
    serverUrl: "https://api.test-provider.com",
    auth: { type: "api-key", credential: "test-key-123" },
    allowedTools: ["get_quote", "get_history"],
    trustLevel: "read-only",
    creditsPerCall: 2,
    rateLimitPerMinute: 10,
    ...overrides,
  };
}

describe("external-mcp", () => {
  beforeEach(() => {
    resetExternalRegistry();
    resetPermissionContext();
    clearAuditLog();
    resetMetrics();
  });

  // ── Registration ──

  it("registers external server", () => {
    const registry = new ExternalMcpRegistry();
    registry.registerServer(makeServer());

    assert.ok(registry.getServer("test-provider"));
    assert.equal(registry.getServerIds().length, 1);
  });

  it("rejects registration without serverId", () => {
    const registry = new ExternalMcpRegistry();
    assert.throws(() => {
      registry.registerServer(makeServer({ serverId: "" }));
    }, /serverId and serverUrl are required/);
  });

  it("rejects registration with empty allowed tools", () => {
    const registry = new ExternalMcpRegistry();
    assert.throws(() => {
      registry.registerServer(makeServer({ allowedTools: [] }));
    }, /At least one allowed tool is required/);
  });

  it("lists registered tools with prefixes", () => {
    const registry = new ExternalMcpRegistry();
    registry.registerServer(makeServer());

    const tools = registry.getRegisteredTools();
    assert.equal(tools.length, 2);
    assert.ok(tools[0].prefixedName.startsWith("external_"));
    assert.equal(tools[0].trustLevel, "read-only");
  });

  it("unregisters server", () => {
    const registry = new ExternalMcpRegistry();
    registry.registerServer(makeServer());
    assert.equal(registry.unregisterServer("test-provider"), true);
    assert.equal(registry.getServerIds().length, 0);
    assert.equal(registry.unregisterServer("nonexistent"), false);
  });

  // ── Permission Enforcement ──

  it("denies tools not in allowed list", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer());

    const result = await registry.callTool("test-provider", "not_allowed_tool", {});
    assert.ok(result.data.error);
    assert.ok(String(result.data.error).includes("not in the allowed list"));
    assert.equal(result.creditsUsed, 0);
  });

  it("allows tools in the allowed list", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer());

    const result = await registry.callTool("test-provider", "get_quote", { symbol: "NVDA" });
    assert.equal(result.data.status, "ok");
    assert.equal(result.creditsUsed, 2);
    assert.equal(result.cached, false);
  });

  it("respects permission engine deny rules on external tools", async () => {
    setPermissionContext({
      alwaysAllowRules: [{ pattern: "veroq_*" }],
      alwaysDenyRules: [{ pattern: "external_test-provider_*" }],
    });

    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer());

    const result = await registry.callTool("test-provider", "get_quote", { symbol: "NVDA" });
    assert.equal(result.permission.decision, "deny");
    assert.equal(result.creditsUsed, 0);
  });

  it("supports wildcard patterns in allowed tools", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer({ allowedTools: ["get_*"] }));

    const result = await registry.callTool("test-provider", "get_quote", {});
    assert.equal(result.data.status, "ok");
  });

  // ── Escalation ──

  it("escalates high-risk trust level", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer({ trustLevel: "high-risk" }));

    const result = await registry.callTool("test-provider", "get_quote", {});
    assert.equal(result.escalated, true);
    assert.ok(result.escalationNotice?.includes("high-risk"));
  });

  it("does not escalate read-only trust level", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer({ trustLevel: "read-only" }));

    const result = await registry.callTool("test-provider", "get_quote", {});
    assert.equal(result.escalated, false);
  });

  // ── Decision Lineage ──

  it("captures decision lineage for external calls", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer());

    const result = await registry.callTool("test-provider", "get_quote", { symbol: "AAPL" });
    assert.ok(result.lineage);
    assert.ok(result.lineage.toolName.startsWith("external_"));
    assert.ok(result.lineage.rulesEvaluated.length > 0);
  });

  // ── Rate Limiting ──

  it("enforces rate limits per server", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer({ rateLimitPerMinute: 3 }));

    await registry.callTool("test-provider", "get_quote", {});
    await registry.callTool("test-provider", "get_quote", {});
    await registry.callTool("test-provider", "get_quote", {});
    const result = await registry.callTool("test-provider", "get_quote", {});

    assert.equal(result.rateLimited, true);
    assert.ok(String(result.data.error).includes("Rate limit exceeded"));
  });

  // ── Caching ──

  it("caches responses when cache policy enabled", async () => {
    let callCount = 0;
    const countingCallFn = async (url: string, opts: any) => {
      callCount++;
      return mockCallFn(url, opts);
    };

    const registry = new ExternalMcpRegistry(countingCallFn);
    registry.registerServer(makeServer({
      cachePolicy: { enabled: true, ttlMs: 60_000 },
    }));

    await registry.callTool("test-provider", "get_quote", { symbol: "NVDA" });
    const result2 = await registry.callTool("test-provider", "get_quote", { symbol: "NVDA" });

    assert.equal(callCount, 1); // Only 1 actual call
    assert.equal(result2.cached, true);
    assert.equal(result2.creditsUsed, 0); // Cached = free
  });

  it("does not cache when policy disabled", async () => {
    let callCount = 0;
    const countingCallFn = async (url: string, opts: any) => {
      callCount++;
      return mockCallFn(url, opts);
    };

    const registry = new ExternalMcpRegistry(countingCallFn);
    registry.registerServer(makeServer({ cachePolicy: { enabled: false, ttlMs: 0 } }));

    await registry.callTool("test-provider", "get_quote", {});
    await registry.callTool("test-provider", "get_quote", {});

    assert.equal(callCount, 2);
  });

  // ── Observability ──

  it("records metrics for external tool calls", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer());

    await registry.callTool("test-provider", "get_quote", {});
    await registry.callTool("test-provider", "get_history", {});

    const summary = getMetricsSummary();
    assert.ok(summary.totalCalls >= 2);

    const info = registry.getServerInfo("test-provider");
    assert.ok(info);
    assert.equal(info!.totalCalls, 2);
    assert.ok(info!.avgLatencyMs >= 0);
  });

  // ── Error Handling ──

  it("handles external call failures gracefully", async () => {
    const failCallFn = async () => { throw new Error("Connection refused"); };
    const registry = new ExternalMcpRegistry(failCallFn);
    registry.registerServer(makeServer());

    const result = await registry.callTool("test-provider", "get_quote", {});
    assert.ok(result.data.error);
    assert.ok(String(result.data.error).includes("Connection refused"));
    assert.equal(result.creditsUsed, 0);
  });

  it("throws for unregistered server", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    await assert.rejects(
      () => registry.callTool("nonexistent", "tool", {}),
      /not registered/,
    );
  });

  // ── Security ──

  it("sanitizes input in audit trail", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer());

    await registry.callTool("test-provider", "get_quote", {
      email: "john@example.com",
      ssn: "123-45-6789",
    });

    const audit = getAuditLog(1);
    assert.ok(audit.length >= 1);
    // The permission engine's audit should have sanitized input
    const inputStr = JSON.stringify(audit[0].input);
    assert.ok(!inputStr.includes("john@example.com") || inputStr.includes("[REDACTED]"));
  });

  it("does not pass credentials to audit or lineage", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer({
      auth: { type: "api-key", credential: "secret-api-key-12345" },
    }));

    const result = await registry.callTool("test-provider", "get_quote", {});
    const lineageStr = JSON.stringify(result.lineage);
    assert.ok(!lineageStr.includes("secret-api-key-12345"));
  });

  it("getServer redacts credentials", () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer({
      auth: { type: "api-key", credential: "super-secret-key" },
    }));

    const server = registry.getServer("test-provider");
    assert.ok(server);
    assert.equal(server!.auth.credential, "***");
  });

  it("rejects tool names with path traversal characters", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer({ allowedTools: ["*"] }));

    const result = await registry.callTool("test-provider", "../../admin/delete", {});
    assert.ok(String(result.data.error).includes("Invalid tool name"));
  });

  it("denied-tools result has valid lineage with rulesEvaluated", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer());

    const result = await registry.callTool("test-provider", "not_allowed", {});
    assert.ok(result.lineage.rulesEvaluated);
    assert.ok(Array.isArray(result.lineage.rulesEvaluated));
    assert.equal(result.lineage.finalDecision, "deny");
  });

  // ── Module-Level API ──

  it("module-level registerExternalMcpServer works", async () => {
    registerExternalMcpServer(makeServer({ serverId: "global-test" }));
    const registry = getExternalRegistry();
    assert.ok(registry.getServer("global-test"));
  });

  // ── Runtime Integration ──

  it("runtime registers external servers from config", async () => {
    resetExternalRegistry();
    const { createRuntime } = await import("../src/runtime/index.js");

    createRuntime({
      vertical: "finance",
      externalServers: [makeServer({ serverId: "runtime-provider" })],
    });

    const registry = getExternalRegistry();
    assert.ok(registry.getServer("runtime-provider"));
  });

  // ── Trust-Level Defaults ──

  it("read-only server gets permissive defaults", async () => {
    const { applyExternalDefaults } = await import("../src/external/index.js");
    const config = applyExternalDefaults(makeServer({ trustLevel: "read-only" }));

    assert.equal(config.rateLimitPerMinute, 10); // explicit value kept (not overwritten)
    assert.equal(config.creditsPerCall, 2); // explicit value kept
    assert.ok(config.cachePolicy?.enabled); // default applied
    assert.equal(config.permissionRules?.review?.length, 0); // no review patterns for read-only
    assert.equal(config.permissionRules?.denied?.length, 0); // no deny patterns for read-only
  });

  it("write server gets stricter defaults with review patterns", async () => {
    const { applyExternalDefaults } = await import("../src/external/index.js");
    const config = applyExternalDefaults(makeServer({
      trustLevel: "write",
      rateLimitPerMinute: undefined,
      creditsPerCall: undefined,
      cachePolicy: undefined,
    }));

    assert.equal(config.rateLimitPerMinute, 20);
    assert.equal(config.creditsPerCall, 3);
    assert.equal(config.cachePolicy, undefined); // write = no cache
    // Should have finance-dangerous patterns in review
    const reviewPatterns = config.permissionRules?.review || [];
    assert.ok(reviewPatterns.length > 0, "Write server should have review patterns");
    assert.ok(reviewPatterns.some(p => p.includes("trade")), "Should review *trade* tools");
    assert.ok(reviewPatterns.some(p => p.includes("order")), "Should review *order* tools");
    assert.ok(reviewPatterns.some(p => p.includes("buy")), "Should review *buy* tools");
  });

  it("high-risk server gets strictest defaults with deny patterns", async () => {
    const { applyExternalDefaults } = await import("../src/external/index.js");
    const config = applyExternalDefaults(makeServer({
      trustLevel: "high-risk",
      rateLimitPerMinute: undefined,
      creditsPerCall: undefined,
    }));

    assert.equal(config.rateLimitPerMinute, 5); // strict rate limit
    assert.equal(config.creditsPerCall, 5); // expensive
    const denyPatterns = config.permissionRules?.denied || [];
    assert.ok(denyPatterns.length > 0, "High-risk should have deny patterns");
    assert.ok(denyPatterns.some(p => p.includes("execute")), "Should deny *execute* tools");
    assert.ok(denyPatterns.some(p => p.includes("sell")), "Should deny *sell* tools");
  });

  it("explicit config values are preserved over defaults", async () => {
    const { applyExternalDefaults } = await import("../src/external/index.js");
    const config = applyExternalDefaults(makeServer({
      trustLevel: "write",
      rateLimitPerMinute: 100, // explicit override
      creditsPerCall: 1, // explicit override
      cachePolicy: { enabled: true, ttlMs: 30_000 }, // explicit override
    }));

    assert.equal(config.rateLimitPerMinute, 100); // kept
    assert.equal(config.creditsPerCall, 1); // kept
    assert.equal(config.cachePolicy?.enabled, true); // kept
    assert.equal(config.cachePolicy?.ttlMs, 30_000); // kept
  });

  it("registration auto-applies defaults", () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer({
      serverId: "write-broker",
      trustLevel: "write",
      rateLimitPerMinute: undefined,
      creditsPerCall: undefined,
      cachePolicy: undefined,
    }));

    const server = registry.getServer("write-broker");
    assert.ok(server);
    assert.equal(server!.rateLimitPerMinute, 20); // default applied
    assert.equal(server!.creditsPerCall, 3); // default applied
    // Permission rules applied
    const review = server!.permissionRules?.review || [];
    assert.ok(review.length > 0, "Registration should apply default review patterns");
  });

  it("defaults include prefixed patterns for the specific server", async () => {
    const { applyExternalDefaults } = await import("../src/external/index.js");
    const config = applyExternalDefaults(makeServer({
      serverId: "my-broker",
      trustLevel: "high-risk",
    }));

    const denyPatterns = config.permissionRules?.denied || [];
    // Patterns should be prefixed with external_my-broker_
    assert.ok(denyPatterns.some(p => p.startsWith("external_my-broker_")),
      "Deny patterns should be server-prefixed");
  });

  // ── Enforcement Tests (verify rules actually block calls) ──

  it("high-risk server actually denies dangerous tool calls", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer({
      serverId: "risk-broker",
      trustLevel: "high-risk",
      allowedTools: ["get_positions", "execute_trade", "submit_order"],
    }));

    // execute_trade matches *execute* deny pattern → should be denied
    const result = await registry.callTool("risk-broker", "execute_trade", {});
    assert.equal(result.permission.decision, "deny", "execute_trade should be denied on high-risk server");
    assert.equal(result.creditsUsed, 0);
  });

  it("write server flags dangerous tools for review", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer({
      serverId: "write-api",
      trustLevel: "write",
      allowedTools: ["get_data", "submit_order"],
    }));

    // submit_order matches *order* review pattern → should be review
    const result = await registry.callTool("write-api", "submit_order", {});
    assert.equal(result.permission.decision, "review", "submit_order should need review on write server");
    // But the call still executes (review = warning, not block)
    assert.ok(result.data.status === "ok" || result.data.tool === "submit_order");
  });

  it("read-only server allows all tools without restrictions", async () => {
    const registry = new ExternalMcpRegistry(mockCallFn);
    registry.registerServer(makeServer({
      serverId: "market-data",
      trustLevel: "read-only",
      allowedTools: ["get_quote", "get_trade_history"],
    }));

    // get_trade_history contains "trade" but read-only has no dangerous patterns
    const result = await registry.callTool("market-data", "get_trade_history", {});
    assert.equal(result.permission.decision, "allow");
    assert.equal(result.data.status, "ok");
  });
});
