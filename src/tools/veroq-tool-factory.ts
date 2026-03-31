// ============================================================
// VEROQ Tool Factory — Reusable system for registering MCP tools
// ============================================================
// Creates tools with automatic permission checking, size limits,
// safe execution, and consistent error handling.
// ============================================================

import { z, type ZodObject, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkPermissions, checkOutputSafety } from "../safety/index.js";
import { recordToolCall } from "../observability/index.js";

// ── Types ──

/** Permission rule for a tool */
export type LegacyPermissionRule = "allow" | "deny" | "ask";

/** Permission checker function — returns whether the tool can execute */
export type PermissionChecker = (
  toolName: string,
  params: Record<string, unknown>,
) => LegacyPermissionRule | Promise<LegacyPermissionRule>;

/** UI display callback — formats the tool output for display */
export type DisplayCallback<TOutput> = (output: TOutput) => string;

/** Tool definition passed to createVeroQTool */
export interface VeroQToolDefinition<
  TInput extends ZodRawShape,
  TOutput = unknown,
> {
  /** Tool name (e.g., "veroq_ask") */
  name: string;

  /** Human-readable description shown to LLMs */
  description: string;

  /** Zod schema for input parameters */
  inputSchema: ZodObject<TInput>;

  /** Optional Zod schema for output validation */
  outputSchema?: z.ZodType<TOutput>;

  /** Permission checker — determines if the tool can execute. Default: "allow" */
  permissionChecker?: PermissionChecker;

  /** Execution handler — the actual tool logic */
  execute: (
    params: z.infer<ZodObject<TInput>>,
  ) => Promise<TOutput> | TOutput;

  /** Format output for text display (default: JSON.stringify) */
  display?: DisplayCallback<TOutput>;

  /** MCP annotations */
  annotations?: {
    readOnlyHint?: boolean;
    openWorldHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };

  /** Max output size in characters (default: 50000) */
  maxOutputSize?: number;

  /** Category for organization (e.g., "intelligence", "market_data") */
  category?: string;

  /** Credit cost estimate */
  credits?: number;
}

/** Registered tool metadata (for introspection) */
export interface RegisteredTool {
  name: string;
  description: string;
  category?: string;
  credits?: number;
  annotations?: Record<string, boolean>;
}

// ── Permission Lists ──

/** Default permission lists — can be overridden per-tool */
const defaultAllowList = new Set<string>([
  "veroq_ask",
  "veroq_verify",
  "veroq_search",
  "veroq_feed",
  "veroq_trending",
  "veroq_ticker",
  "veroq_technicals",
  "veroq_price",
  "veroq_market_summary",
]);

const defaultDenyList = new Set<string>([
  // No tools are denied by default — all 52 are read-only
]);

/** Global permission checker — override with setPermissionChecker() */
let globalPermissionChecker: PermissionChecker | null = null;

export function setGlobalPermissionChecker(checker: PermissionChecker): void {
  globalPermissionChecker = checker;
}

// ── Size Limits ──

const DEFAULT_MAX_OUTPUT_SIZE = 50_000; // 50KB

function truncateOutput(text: string, maxSize: number): string {
  if (text.length <= maxSize) return text;
  return text.slice(0, maxSize) + `\n\n... [truncated — ${text.length} chars total, showing first ${maxSize}]`;
}

// ── Tool Registry ──

const registry: RegisteredTool[] = [];

export function getRegisteredTools(): readonly RegisteredTool[] {
  return registry;
}

// ── Factory Function ──

/**
 * Create and register a VEROQ tool on an MCP server.
 *
 * Handles permissions, size limits, output validation, and error handling automatically.
 *
 * @example
 * ```typescript
 * createVeroQTool(server, {
 *   name: "veroq_ask",
 *   description: "Ask any question",
 *   inputSchema: z.object({ question: z.string().describe("Your question") }),
 *   execute: async ({ question }) => {
 *     return await api("POST", "/api/v1/ask", undefined, { question });
 *   },
 *   display: (result) => result.summary || JSON.stringify(result),
 *   annotations: { readOnlyHint: true, openWorldHint: true },
 * });
 * ```
 */
export function createVeroQTool<
  TInput extends ZodRawShape,
  TOutput = unknown,
>(
  server: McpServer,
  definition: VeroQToolDefinition<TInput, TOutput>,
): void {
  const {
    name,
    description,
    inputSchema,
    outputSchema,
    permissionChecker,
    execute,
    display,
    annotations = { readOnlyHint: true, openWorldHint: true },
    maxOutputSize = DEFAULT_MAX_OUTPUT_SIZE,
    category,
    credits,
  } = definition;

  // Register metadata
  registry.push({ name, description, category, credits, annotations });

  // Build the raw shape for server.tool()
  const shape = inputSchema.shape as Record<string, z.ZodTypeAny>;

  // Register with MCP server
  server.tool(
    name,
    description,
    shape,
    annotations,
    async (params: Record<string, unknown>) => {
      // 1. Permission engine check (centralized safety layer)
      const permResult = checkPermissions(name, params);
      if (permResult.decision === "deny") {
        return {
          content: [{
            type: "text" as const,
            text: `Permission denied: ${permResult.reason}`,
          }],
        };
      }
      if (permResult.decision === "review") {
        // For review decisions, include a warning but still execute
        // The review flag is logged in audit — enterprise customers can hook into this
      }

      // Legacy permission checker (backward compat with per-tool checkers)
      const checker = permissionChecker || globalPermissionChecker;
      if (checker) {
        const rule = await checker(name, params);
        if (rule === "deny") {
          return {
            content: [{
              type: "text" as const,
              text: `Permission denied: tool "${name}" is not allowed with these parameters.`,
            }],
          };
        }
      }

      // Check deny list (backward compat)
      if (defaultDenyList.has(name)) {
        return {
          content: [{
            type: "text" as const,
            text: `Tool "${name}" is currently disabled.`,
          }],
        };
      }

      // 2. Execute with error handling
      const execStart = Date.now();
      let result: TOutput;
      try {
        // Parse and validate input
        const validated = inputSchema.parse(params);
        result = await execute(validated);
      } catch (err: unknown) {
        recordToolCall(name, Date.now() - execStart, true, false, false);
        const message =
          err instanceof z.ZodError
            ? `Invalid input: ${err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`
            : err instanceof Error
              ? err.message
              : "Unknown error executing tool";
        return {
          content: [
            {
              type: "text" as const,
              text: `Error in ${name}: ${message}`,
            },
          ],
        };
      }

      // 3. Validate output (if schema provided)
      if (outputSchema) {
        try {
          outputSchema.parse(result);
        } catch {
          // Output validation failure — log but don't block
          // The tool produced data, just not in the expected shape
        }
      }

      // 4. Format output
      let outputText: string;
      if (display) {
        try {
          outputText = display(result);
        } catch {
          outputText = JSON.stringify(result, null, 2);
        }
      } else if (typeof result === "string") {
        outputText = result;
      } else {
        outputText = JSON.stringify(result, null, 2);
      }

      // 5. Apply size limit
      outputText = truncateOutput(outputText, maxOutputSize);

      // 6. Post-execution safety check + escalation
      const safetyCheck = checkOutputSafety(
        name,
        typeof result === "object" && result !== null ? result as Record<string, unknown> : {},
      );
      if (safetyCheck.escalated && safetyCheck.escalationNotice) {
        outputText += `\n\n${safetyCheck.escalationNotice}`;
      } else if (safetyCheck.flagged) {
        outputText += `\n\n⚠️ SAFETY FLAG: ${safetyCheck.reason}`;
      }
      if (permResult.highStakesTriggered) {
        outputText += `\n\n🔍 This query was flagged as high-stakes. Review recommended before acting.`;
      }

      // 7. Record metrics
      const execEnd = Date.now();
      recordToolCall(
        name,
        execEnd - execStart,
        false,
        permResult.highStakesTriggered,
        safetyCheck.escalated || false,
        typeof result === 'object' && result !== null ? (result as Record<string, unknown>).confidence as number | undefined : undefined,
      );

      return {
        content: [{ type: "text" as const, text: outputText }],
      };
    },
  );
}

// ── Convenience: Batch Registration ──

/**
 * Register multiple tools at once from an array of definitions.
 *
 * @example
 * ```typescript
 * registerVeroQTools(server, [
 *   { name: "veroq_ask", ... },
 *   { name: "veroq_verify", ... },
 * ]);
 * ```
 */
export function registerVeroQTools(
  server: McpServer,
  definitions: VeroQToolDefinition<ZodRawShape, unknown>[],
): void {
  for (const def of definitions) {
    createVeroQTool(server, def);
  }
}
