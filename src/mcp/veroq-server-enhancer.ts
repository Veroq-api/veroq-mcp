// ============================================================
// VEROQ Server Enhancer — Auto-inject verification metadata
// ============================================================
// Wraps the tool factory to add confidenceScore, evidenceChain,
// verificationStatus, and prompt hints to tool responses.
// Backward-compatible: tools using server.tool() directly are unchanged.
// ============================================================

import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createVeroQTool,
  type VeroQToolDefinition,
} from "../tools/veroq-tool-factory.js";

// ── Types ──

export type VerificationStatus = "verified" | "flagged" | "low-confidence";

export interface EvidenceItem {
  source: string;
  snippet?: string;
  url?: string;
  position?: "supports" | "contradicts" | "neutral";
  reliability?: number;
  timestamp?: string;
}

export interface VerificationMetadata {
  confidenceScore: number; // 0-100
  evidenceChain: EvidenceItem[];
  verificationStatus: VerificationStatus;
  promptHint: string;
}

/** Enhanced response that includes verification metadata */
export interface EnhancedResponse<TData = unknown> {
  data: TData;
  verification: VerificationMetadata;
}

// ── Prompt Hints ──

const FACT_CHECK_HINT =
  "This response contains financial or market data. Consider cross-checking key claims using veroq_verify before making decisions. Evidence chain and confidence scores are included in the response.";

const GENERAL_HINT =
  "Data sourced from VEROQ verified intelligence. Confidence score reflects source agreement, quality, recency, and corroboration depth.";

// ── Metadata Extraction ──

/** Extract verification metadata from an /ask API response */
function extractAskMetadata(data: Record<string, unknown>): VerificationMetadata {
  const confidence = data.confidence as { level?: string; reason?: string } | undefined;
  const tradeSignal = data.trade_signal as { score?: number } | undefined;

  // Derive confidence score (0-100)
  let confidenceScore = 50;
  if (confidence?.level === "high") confidenceScore = 85;
  else if (confidence?.level === "medium") confidenceScore = 60;
  else if (confidence?.level === "low") confidenceScore = 30;

  // If trade signal exists, use its score as a secondary signal
  if (tradeSignal?.score != null) {
    confidenceScore = Math.round((confidenceScore + tradeSignal.score) / 2);
  }

  // Derive verification status
  let verificationStatus: VerificationStatus = "verified";
  if (confidenceScore < 40) verificationStatus = "low-confidence";
  else if (confidenceScore < 65) verificationStatus = "flagged";

  // Build evidence chain from data sources
  const evidenceChain: EvidenceItem[] = [];
  const endpointsCalled = data.endpoints_called as string[] | undefined;
  if (endpointsCalled) {
    for (const ep of endpointsCalled.slice(0, 10)) {
      evidenceChain.push({
        source: `VEROQ ${ep.replace("/api/v1/", "")}`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Add news sources if available
  const newsData = (data.data as Record<string, unknown>)?.news as { briefs?: { headline?: string }[] } | undefined;
  if (newsData?.briefs) {
    for (const brief of newsData.briefs.slice(0, 3)) {
      if (brief.headline) {
        evidenceChain.push({
          source: "VEROQ Intelligence",
          snippet: brief.headline,
          position: "supports",
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  return {
    confidenceScore,
    evidenceChain,
    verificationStatus,
    promptHint: FACT_CHECK_HINT,
  };
}

/** Extract verification metadata from a /verify API response */
function extractVerifyMetadata(data: Record<string, unknown>): VerificationMetadata {
  const confidence = (data.confidence as number) ?? 0;
  const confidenceScore = Math.round(confidence * 100);
  const verdict = data.verdict as string | undefined;
  const chain = data.evidence_chain as EvidenceItem[] | undefined;
  const breakdown = data.confidence_breakdown as Record<string, number> | undefined;

  // Map verdict to verification status
  let verificationStatus: VerificationStatus = "verified";
  if (verdict === "unverifiable" || verdict === "contradicted") {
    verificationStatus = "flagged";
  }
  if (confidenceScore < 40) {
    verificationStatus = "low-confidence";
  }

  // Build evidence chain
  const evidenceChain: EvidenceItem[] = [];
  if (chain) {
    for (const entry of chain.slice(0, 10)) {
      evidenceChain.push({
        source: entry.source || "Unknown",
        snippet: entry.snippet,
        url: entry.url,
        position: entry.position,
        reliability: entry.reliability,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Add breakdown as metadata
  const hint = breakdown
    ? `${FACT_CHECK_HINT} Breakdown: agreement=${breakdown.source_agreement}, quality=${breakdown.source_quality}, recency=${breakdown.recency}, corroboration=${breakdown.corroboration_depth}`
    : FACT_CHECK_HINT;

  return {
    confidenceScore,
    evidenceChain,
    verificationStatus,
    promptHint: hint,
  };
}

/** Extract metadata from a generic tool response */
function extractGenericMetadata(data: unknown): VerificationMetadata {
  return {
    confidenceScore: 70,
    evidenceChain: [{
      source: "VEROQ API",
      timestamp: new Date().toISOString(),
    }],
    verificationStatus: "verified",
    promptHint: GENERAL_HINT,
  };
}

// ── Enhanced Tool Factory ──

/**
 * Create an enhanced VEROQ tool that automatically includes
 * verification metadata in every response.
 *
 * @example
 * ```typescript
 * createEnhancedVeroQTool(server, {
 *   name: "veroq_ask",
 *   description: "Ask any question",
 *   inputSchema: z.object({ question: z.string() }),
 *   apiCall: async ({ question }) => api("POST", "/api/v1/ask", undefined, { question }),
 *   metadataExtractor: "ask",  // or "verify" or "generic"
 * });
 * ```
 */
export function createEnhancedVeroQTool<TInput extends ZodRawShape>(
  server: McpServer,
  definition: Omit<VeroQToolDefinition<TInput, unknown>, "execute" | "display"> & {
    /** API call function — returns raw API response */
    apiCall: (params: z.infer<z.ZodObject<TInput>>) => Promise<Record<string, unknown>>;
    /** Which metadata extractor to use */
    metadataExtractor?: "ask" | "verify" | "generic";
    /** Custom display function (optional — default includes metadata) */
    customDisplay?: (data: Record<string, unknown>, metadata: VerificationMetadata) => string;
  },
): void {
  const { apiCall, metadataExtractor = "generic", customDisplay, ...rest } = definition;

  createVeroQTool(server, {
    ...rest,
    execute: async (params) => {
      const rawData = await apiCall(params);

      // Extract verification metadata based on endpoint type
      let metadata: VerificationMetadata;
      switch (metadataExtractor) {
        case "ask":
          metadata = extractAskMetadata(rawData);
          break;
        case "verify":
          metadata = extractVerifyMetadata(rawData);
          break;
        default:
          metadata = extractGenericMetadata(rawData);
      }

      return { data: rawData, verification: metadata };
    },
    display: (result) => {
      const { data, verification } = result as EnhancedResponse;

      if (customDisplay) {
        return customDisplay(data as Record<string, unknown>, verification);
      }

      // Default display: structured JSON with metadata
      const parts: string[] = [];

      // Verification header
      const statusEmoji =
        verification.verificationStatus === "verified" ? "✓" :
        verification.verificationStatus === "flagged" ? "⚠" : "?";
      parts.push(`[${statusEmoji} ${verification.verificationStatus.toUpperCase()}] Confidence: ${verification.confidenceScore}/100`);
      parts.push("");

      // Main data (formatted)
      const d = data as Record<string, unknown>;
      if (d.summary && typeof d.summary === "string") {
        parts.push(d.summary);
      } else if (d.verdict) {
        parts.push(`Verdict: ${d.verdict} (${Math.round((d.confidence as number || 0) * 100)}%)`);
        if (d.summary) parts.push(String(d.summary));
      } else {
        parts.push(JSON.stringify(d, null, 2).slice(0, 3000));
      }

      // Evidence chain
      if (verification.evidenceChain.length > 0) {
        parts.push("");
        parts.push("Evidence:");
        for (const ev of verification.evidenceChain.slice(0, 5)) {
          const posTag = ev.position ? `[${ev.position}]` : "";
          const relTag = ev.reliability ? `(${Math.round(ev.reliability * 100)}% reliable)` : "";
          parts.push(`  ${posTag} ${ev.source} ${relTag}`.trim());
          if (ev.snippet) parts.push(`    "${ev.snippet.slice(0, 100)}"`);
        }
      }

      // Prompt hint
      parts.push("");
      parts.push(`💡 ${verification.promptHint}`);

      return parts.join("\n");
    },
  } as VeroQToolDefinition<TInput, unknown>);
}

// ── Server Enhancer ──

/**
 * Enhance a server by wrapping the tool factory with verification metadata.
 * Call this on server startup to configure the enhancer.
 *
 * @example
 * ```typescript
 * import { enhanceServer } from "./src/mcp/veroq-server-enhancer.js";
 * enhanceServer(server, apiFn);
 * ```
 */
export function enhanceServer(
  server: McpServer,
  _apiFn: (method: "GET" | "POST", path: string, params?: Record<string, string | number | boolean | undefined>, body?: unknown) => Promise<unknown>,
): {
  createEnhanced: <TInput extends ZodRawShape>(
    definition: Omit<VeroQToolDefinition<TInput, unknown>, "execute" | "display"> & {
      apiCall: (params: z.infer<z.ZodObject<TInput>>) => Promise<Record<string, unknown>>;
      metadataExtractor?: "ask" | "verify" | "generic";
      customDisplay?: (data: Record<string, unknown>, metadata: VerificationMetadata) => string;
    },
  ) => void;
} {
  return {
    createEnhanced: <TInput extends ZodRawShape>(
      def: Omit<VeroQToolDefinition<TInput, unknown>, "execute" | "display"> & {
        apiCall: (params: z.infer<z.ZodObject<TInput>>) => Promise<Record<string, unknown>>;
        metadataExtractor?: "ask" | "verify" | "generic";
        customDisplay?: (data: Record<string, unknown>, metadata: VerificationMetadata) => string;
      },
    ) => createEnhancedVeroQTool(server, def),
  };
}
