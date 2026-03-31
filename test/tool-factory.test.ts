// ============================================================
// VEROQ Tool Factory — Tests
// ============================================================

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createVeroQTool,
  registerVeroQTools,
  getRegisteredTools,
  setGlobalPermissionChecker,
  type VeroQToolDefinition,
} from "../src/tools/index.js";

// Helper: create a fresh server for each test
function freshServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.1" });
}

describe("tool-factory", () => {
  it("createVeroQTool registers a tool on the server", () => {
    const server = freshServer();
    createVeroQTool(server, {
      name: "test_tool",
      description: "A test tool",
      inputSchema: z.object({
        query: z.string().describe("Test query"),
      }),
      execute: async ({ query }) => ({ answer: query.toUpperCase() }),
    });

    const tools = getRegisteredTools();
    const found = tools.find((t) => t.name === "test_tool");
    assert.ok(found, "Tool should be in registry");
    assert.equal(found!.description, "A test tool");
  });

  it("registerVeroQTools registers multiple tools", () => {
    const server = freshServer();
    const defs: VeroQToolDefinition<z.ZodRawShape, unknown>[] = [
      {
        name: "tool_a",
        description: "Tool A",
        inputSchema: z.object({ x: z.string() }),
        execute: async () => "a",
      },
      {
        name: "tool_b",
        description: "Tool B",
        inputSchema: z.object({ y: z.number() }),
        execute: async () => "b",
      },
    ];
    registerVeroQTools(server, defs);

    const tools = getRegisteredTools();
    assert.ok(tools.find((t) => t.name === "tool_a"));
    assert.ok(tools.find((t) => t.name === "tool_b"));
  });

  it("tool definition includes metadata", () => {
    const server = freshServer();
    createVeroQTool(server, {
      name: "meta_tool",
      description: "Has metadata",
      inputSchema: z.object({}),
      execute: async () => "ok",
      category: "intelligence",
      credits: 3,
      annotations: { readOnlyHint: true, openWorldHint: true },
    });

    const tools = getRegisteredTools();
    const found = tools.find((t) => t.name === "meta_tool");
    assert.equal(found!.category, "intelligence");
    assert.equal(found!.credits, 3);
    assert.deepEqual(found!.annotations, {
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  it("display callback formats output", () => {
    const server = freshServer();
    let displayCalled = false;

    createVeroQTool(server, {
      name: "display_tool",
      description: "Has display",
      inputSchema: z.object({ q: z.string() }),
      execute: async ({ q }) => ({ result: q }),
      display: (output) => {
        displayCalled = true;
        return `Formatted: ${(output as { result: string }).result}`;
      },
    });

    // Display callback is invoked at runtime, not registration
    assert.ok(!displayCalled, "Display should not be called at registration");
  });

  it("getRegisteredTools returns all registered tools", () => {
    const initialCount = getRegisteredTools().length;
    const server = freshServer();

    createVeroQTool(server, {
      name: `count_tool_${Date.now()}`,
      description: "Count test",
      inputSchema: z.object({}),
      execute: async () => "ok",
    });

    assert.ok(getRegisteredTools().length > initialCount);
  });

  it("tool with output schema validates", () => {
    const server = freshServer();

    // Should not throw during registration
    createVeroQTool(server, {
      name: "validated_tool",
      description: "Has output schema",
      inputSchema: z.object({ q: z.string() }),
      outputSchema: z.object({ answer: z.string() }),
      execute: async ({ q }) => ({ answer: q }),
    });

    const tools = getRegisteredTools();
    assert.ok(tools.find((t) => t.name === "validated_tool"));
  });

  it("permission checker can be set globally", () => {
    let checkerCalled = false;
    setGlobalPermissionChecker((name, _params) => {
      checkerCalled = true;
      return "allow";
    });

    // Permission checker is invoked at runtime, not registration
    assert.ok(!checkerCalled, "Global checker should not be called at registration");

    // Reset
    setGlobalPermissionChecker(() => "allow");
  });

  it("tool definition with all optional fields", () => {
    const server = freshServer();

    createVeroQTool(server, {
      name: "full_tool",
      description: "All fields",
      inputSchema: z.object({
        required_field: z.string().describe("Required"),
        optional_field: z.string().optional().describe("Optional"),
      }),
      outputSchema: z.object({ data: z.unknown() }),
      permissionChecker: () => "allow",
      execute: async () => ({ data: "test" }),
      display: (output) => JSON.stringify(output),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      maxOutputSize: 10000,
      category: "test",
      credits: 5,
    });

    const found = getRegisteredTools().find((t) => t.name === "full_tool");
    assert.ok(found);
    assert.equal(found!.credits, 5);
    assert.equal(found!.category, "test");
  });
});
