// ============================================================
// VEROQ High-Level Tools — Outcome-oriented consolidations
// ============================================================
// Consolidates commonly chained low-level tools into 5 powerful
// high-level tools. All legacy tools remain unchanged via aliases.
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createVeroQTool } from "./veroq-tool-factory.js";
import { createVerifiedSwarm, type SwarmRole } from "../swarm/index.js";
import { submitFeedback, getFeedbackQueue, getFeedbackMetrics, type FeedbackReason } from "../feedback/index.js";

type ApiFn = (
  method: "GET" | "POST",
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  body?: unknown,
) => Promise<unknown>;

// ── Helper ──

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// ── Tool Definitions ──

export function registerHighLevelTools(server: McpServer, api: ApiFn): void {

  // ═══════════════════════════════════════════════════════════
  // 1. ANALYZE TICKER — replaces chaining: ticker + price +
  //    technicals + sentiment + earnings + news + insider + analysts
  // ═══════════════════════════════════════════════════════════

  createVeroQTool(server, {
    name: "veroq_analyze_ticker",
    description: `Complete analysis of any stock, ETF, or crypto ticker in one call.

WHEN TO USE: When you need a comprehensive view of a ticker — price, technicals, earnings, sentiment, insider activity, analyst ratings, and recent news. This replaces chaining veroq_ticker_price → veroq_technicals → veroq_earnings → veroq_ticker_news.

RETURNS: Price with change %, 20 technical indicators with buy/sell signal, next earnings date, sentiment direction, insider transactions, analyst consensus, and top 5 headlines.

COST: ~3 credits (one /ask call internally). Use fast=true to skip LLM summary and save ~2 seconds.

EXAMPLE: { "ticker": "NVDA", "fast": true }`,
    inputSchema: z.object({
      ticker: z.string().describe("Ticker symbol (e.g., NVDA, AAPL, BTC, ETH). Supports 1,061+ tickers with auto-discovery."),
      fast: z.boolean().optional().describe("Skip LLM summary for faster response (default: false)"),
      include_news: z.boolean().optional().describe("Include recent headlines (default: true)"),
    }),
    execute: async ({ ticker, fast, include_news }) => {
      const question = include_news === false
        ? `${ticker} price technicals earnings sentiment insider analysts`
        : `Full analysis of ${ticker}`;
      const data = await api("POST", "/api/v1/ask", undefined, {
        question,
        fast: fast ?? false,
      }) as Record<string, unknown>;
      return data;
    },
    display: (result) => {
      const d = result as Record<string, unknown>;
      const parts: string[] = [];

      if (d.summary) parts.push(String(d.summary));

      const ts = d.trade_signal as { action?: string; score?: number; factors?: string[] } | undefined;
      if (ts?.action) {
        parts.push(`\nTrade Signal: ${ts.action.toUpperCase()} (${ts.score}/100)`);
        if (ts.factors?.length) {
          for (const f of ts.factors.slice(0, 4)) parts.push(`  • ${f}`);
        }
      }

      const conf = d.confidence as { level?: string; reason?: string } | undefined;
      if (conf?.level) parts.push(`\nConfidence: ${conf.level} — ${conf.reason || ""}`);

      return parts.join("\n") || JSON.stringify(d, null, 2).slice(0, 3000);
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    category: "intelligence",
    credits: 3,
  });

  // ═══════════════════════════════════════════════════════════
  // 2. VERIFY MARKET CLAIM — replaces: verify + evidence search
  //    Returns verdict + evidence chain + confidence breakdown
  // ═══════════════════════════════════════════════════════════

  createVeroQTool(server, {
    name: "veroq_verify_market_claim",
    description: `Fact-check any financial or market claim with full evidence chain.

WHEN TO USE: When an agent makes a claim about earnings, revenue, market movements, mergers, or any verifiable financial fact. Returns evidence from 200+ sources with source-level reliability scores.

RETURNS: Verdict (supported/contradicted/partially_supported/unverifiable), confidence score with 4-factor breakdown (source_agreement, source_quality, recency, corroboration_depth), evidence chain with source names, direct quotes, and URLs, plus a verification receipt.

COST: 3 credits. Checks corpus first, falls back to live web search — nothing returns "unverifiable" for newsworthy claims.

EXAMPLE: { "claim": "NVIDIA reported record Q4 2025 earnings beating analyst expectations" }`,
    inputSchema: z.object({
      claim: z.string().min(10).describe("The claim to verify (min 10 chars). Be specific — include numbers, dates, and entity names for best results."),
      context: z.string().optional().describe("Optional category hint (tech, markets, crypto, policy) to narrow search"),
    }),
    execute: async ({ claim, context }) => {
      const body: Record<string, unknown> = { claim };
      if (context) body.context = context;
      return await api("POST", "/api/v1/verify", undefined, body) as Record<string, unknown>;
    },
    display: (result) => {
      const d = result as Record<string, unknown>;
      const verdict = d.verdict as string || "unknown";
      const confidence = d.confidence as number || 0;
      const chain = d.evidence_chain as Array<Record<string, unknown>> || [];
      const breakdown = d.confidence_breakdown as Record<string, number> || {};
      const receipt = d.receipt as Record<string, string> | undefined;

      const parts: string[] = [];
      const emoji = verdict === "supported" ? "✓" : verdict === "contradicted" ? "✗" : "?";
      parts.push(`[${emoji} ${verdict.toUpperCase()}] Confidence: ${Math.round(confidence * 100)}%`);

      if (Object.keys(breakdown).length > 0) {
        parts.push(`\nBreakdown: agreement=${breakdown.source_agreement}, quality=${breakdown.source_quality}, recency=${breakdown.recency}, corroboration=${breakdown.corroboration_depth}`);
      }

      if (d.summary) parts.push(`\n${d.summary}`);

      if (chain.length > 0) {
        parts.push(`\nEvidence (${chain.length} sources):`);
        for (const e of chain.slice(0, 5)) {
          const pos = e.position ? `[${e.position}]` : "";
          const rel = e.reliability ? ` (${Math.round(Number(e.reliability) * 100)}% reliable)` : "";
          parts.push(`  ${pos} ${e.source}${rel}`);
          if (e.snippet) parts.push(`    "${String(e.snippet).slice(0, 100)}"`);
        }
      }

      if (receipt?.id) parts.push(`\nReceipt: ${receipt.id}`);

      return parts.join("\n");
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    category: "verification",
    credits: 3,
  });

  // ═══════════════════════════════════════════════════════════
  // 3. GENERATE TRADING SIGNAL — replaces: screener + technicals
  //    + sentiment + correlation for actionable trade ideas
  // ═══════════════════════════════════════════════════════════

  createVeroQTool(server, {
    name: "veroq_generate_trading_signal",
    description: `Generate actionable trading signals by screening stocks and analyzing technicals.

WHEN TO USE: When you need to find trading opportunities. Describe what you're looking for in natural language — the NLP screener translates it into filters (sector, RSI, sentiment, volume).

RETURNS: Matched tickers with price, RSI, sentiment score, and a composite trade signal (0-100) combining RSI (30%), sentiment (25%), VIX (20%), technicals (15%), and earnings proximity (10%).

COST: ~5-8 credits (screener + analysis). Results cached for 60 seconds.

CONSTRAINTS: Max 50 results. Screener evaluates 1,061+ tickers. Use specific criteria for better matches.

EXAMPLE: { "criteria": "oversold semiconductor stocks with improving sentiment" }
EXAMPLE: { "criteria": "high momentum crypto tokens", "limit": 10 }`,
    inputSchema: z.object({
      criteria: z.string().describe("Natural language description of what you're looking for (e.g., 'oversold tech stocks', 'high volume gainers', 'bearish reversals in healthcare')"),
      limit: z.number().optional().describe("Max results (1-50, default 20)"),
    }),
    execute: async ({ criteria, limit }) => {
      return await api("POST", "/api/v1/ask", undefined, {
        question: `Screen for: ${criteria}`,
        fast: true,
      }) as Record<string, unknown>;
    },
    display: (result) => {
      const d = result as Record<string, unknown>;
      const data = d.data as Record<string, unknown> || {};
      const screener = data.screener as Record<string, unknown> | undefined;

      const parts: string[] = [];

      if (screener?.interpreted_as) {
        parts.push(`Interpreted as: ${JSON.stringify(screener.interpreted_as)}`);
      }

      const results = (screener?.results || []) as Array<Record<string, unknown>>;
      if (results.length > 0) {
        parts.push(`\nFound ${results.length} matches:\n`);
        parts.push("| Ticker | Price | RSI | Sentiment | Signal |");
        parts.push("|--------|-------|-----|-----------|--------|");
        for (const r of results.slice(0, 15)) {
          parts.push(`| ${r.ticker} | $${Number(r.price || 0).toFixed(2)} | ${Number(r.rsi_14 || 0).toFixed(1)} | ${Number(r.sentiment_score || 0).toFixed(2)} | ${r.signal || "-"} |`);
        }
      }

      if (d.summary) parts.push(`\n${d.summary}`);

      return parts.join("\n") || "No matches found for the given criteria.";
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    category: "trading",
    credits: 5,
  });

  // ═══════════════════════════════════════════════════════════
  // 4. GET COMPREHENSIVE INTELLIGENCE — replaces: feed + trending
  //    + entities + market_summary + economy for broad market view
  // ═══════════════════════════════════════════════════════════

  createVeroQTool(server, {
    name: "veroq_comprehensive_intelligence",
    description: `Get a broad market intelligence briefing — indices, movers, trending stories, key entities, and economic data.

WHEN TO USE: When you need a market overview or morning briefing. Covers major indices, top movers, trending stories, key entities, and yield curve — all in one call.

RETURNS: S&P 500/Nasdaq/Dow values, top gainers/losers, trending intelligence briefs, most-mentioned entities, and treasury yields.

COST: ~3 credits. Data refreshes every 30 minutes.

EXAMPLE: { "focus": "market overview" }
EXAMPLE: { "focus": "what's moving today" }`,
    inputSchema: z.object({
      focus: z.string().optional().describe("Optional focus area: 'market overview', 'trending stories', 'economic data', 'what's moving today' (default: broad overview)"),
    }),
    execute: async ({ focus }) => {
      return await api("POST", "/api/v1/ask", undefined, {
        question: focus || "Market overview with indices, movers, trending stories, and yields",
        fast: true,
      }) as Record<string, unknown>;
    },
    display: (result) => {
      const d = result as Record<string, unknown>;
      return String(d.summary || JSON.stringify(d, null, 2).slice(0, 3000));
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    category: "intelligence",
    credits: 3,
  });

  // ═══════════════════════════════════════════════════════════
  // 5. COMPARE TICKERS — replaces: multiple ticker calls +
  //    correlation + technicals chaining
  // ═══════════════════════════════════════════════════════════

  createVeroQTool(server, {
    name: "veroq_compare_tickers",
    description: `Compare 2-5 tickers side by side — price, technicals, sentiment, and correlation.

WHEN TO USE: When comparing investment options or analyzing portfolio relationships. Provides price comparison, technical indicator comparison, sentiment comparison, and Pearson correlation matrix.

RETURNS: Per-ticker data (price, change%, RSI, signal, sentiment) plus correlation matrix and comparative summary.

COST: ~3 credits for 2 tickers, ~5 for 5 tickers.

EXAMPLE: { "tickers": "AAPL vs MSFT" }
EXAMPLE: { "tickers": "NVDA, AMD, INTC" }`,
    inputSchema: z.object({
      tickers: z.string().describe("Tickers to compare — 'AAPL vs MSFT' or 'NVDA, AMD, INTC' (2-5 tickers)"),
    }),
    execute: async ({ tickers }) => {
      return await api("POST", "/api/v1/ask", undefined, {
        question: `Compare ${tickers}`,
        fast: false,
      }) as Record<string, unknown>;
    },
    display: (result) => {
      const d = result as Record<string, unknown>;
      return String(d.summary || JSON.stringify(d, null, 2).slice(0, 3000));
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    category: "intelligence",
    credits: 3,
  });

  // ═══════════════════════════════════════════════════════════
  // 6. TOOL SEARCH — dynamic tool discovery
  // ═══════════════════════════════════════════════════════════

  createVeroQTool(server, {
    name: "veroq_tool_search",
    description: `Search for the right VEROQ tool by describing what you need. Returns matching tools with usage guidance.

WHEN TO USE: When you're not sure which tool to use. Describe what you want to accomplish and this returns the best-matching tools with descriptions, cost, and examples.

RETURNS: List of matching tools sorted by relevance with name, description, category, cost, and when-to-use guidance.

COST: 0 credits (local search, no API call).

EXAMPLE: { "query": "I need to check if a claim about earnings is true" }
EXAMPLE: { "query": "find oversold stocks" }
EXAMPLE: { "query": "crypto prices" }`,
    inputSchema: z.object({
      query: z.string().describe("Describe what you want to accomplish"),
      limit: z.number().optional().describe("Max results (default 5)"),
    }),
    execute: async ({ query, limit }) => {
      const { getRegisteredTools } = await import("./veroq-tool-factory.js");
      const all = getRegisteredTools();
      const q = query.toLowerCase();
      const maxResults = limit || 5;

      // Score each tool by keyword match
      const scored = all.map(tool => {
        let score = 0;
        const text = `${tool.name} ${tool.description || ""} ${tool.category || ""}`.toLowerCase();
        for (const word of q.split(/\s+/)) {
          if (word.length < 2) continue;
          if (text.includes(word)) score += 10;
          if (tool.name.includes(word)) score += 20;
        }
        // Boost high-level tools
        if (tool.name.includes("analyze_ticker") || tool.name.includes("verify_market") ||
            tool.name.includes("trading_signal") || tool.name.includes("comprehensive") ||
            tool.name.includes("compare_tickers")) {
          score += 5;
        }
        return { ...tool, score };
      }).filter(t => t.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

      return scored;
    },
    display: (result) => {
      const tools = result as Array<{ name: string; description?: string; category?: string; credits?: number }>;
      if (!tools.length) return "No matching tools found. Try a different description.";

      const parts = [`Found ${tools.length} matching tool(s):\n`];
      for (const t of tools) {
        parts.push(`**${t.name}** (${t.category || "general"}${t.credits ? `, ${t.credits}cr` : ""})`);
        if (t.description) parts.push(`  ${t.description.slice(0, 150)}`);
        parts.push("");
      }
      return parts.join("\n");
    },
    annotations: { readOnlyHint: true },
    category: "discovery",
    credits: 0,
  });

  // ═══════════════════════════════════════════════════════════
  // 7. VERIFIED SWARM — multi-agent financial workflow with
  //    automatic verification, safety, and decision lineage
  // ═══════════════════════════════════════════════════════════

  createVeroQTool(server, {
    name: "veroq_run_verified_swarm",
    description: `Run a multi-agent verified financial analysis workflow.

WHEN TO USE: When you need a comprehensive, multi-perspective analysis — not just a single data point. The swarm coordinates 5 agents (planner, researcher, verifier, critic, synthesizer) that each contribute a different angle, then auto-verifies claims and synthesizes the result.

RETURNS: Step-by-step results from each agent with verification metadata, escalation notices, decision lineage, and a final synthesis. Includes verification summary (steps verified, avg confidence, flagged steps).

COST: ~15-25 credits depending on pipeline depth. Set creditBudget to cap spending.

PIPELINE: planner (market overview) → researcher (deep analysis) → verifier (fact-check claims) → critic (devil's advocate) → synthesizer (final output with risks).

EXAMPLE: { "query": "Analyze NVDA for a long position", "roles": ["planner", "researcher", "verifier", "critic", "synthesizer"] }
EXAMPLE: { "query": "Is now a good time to invest in semiconductors?", "escalationThreshold": 70 }`,
    inputSchema: z.object({
      query: z.string().describe("The financial question or analysis request"),
      roles: z.array(z.enum(["planner", "researcher", "verifier", "critic", "risk_assessor", "synthesizer"])).optional()
        .describe("Agent roles to include (default: planner, researcher, verifier, critic, synthesizer)"),
      enableAutoVerification: z.boolean().optional().describe("Auto-verify researcher outputs (default: true)"),
      escalationThreshold: z.number().optional().describe("Confidence threshold for escalation (default: 80)"),
      creditBudget: z.number().optional().describe("Max credits to spend (default: 50)"),
      enterpriseId: z.string().optional().describe("Enterprise ID for audit trail"),
    }),
    execute: async ({ query, roles, enableAutoVerification, escalationThreshold, creditBudget, enterpriseId }) => {
      const swarm = createVerifiedSwarm({
        roles: (roles || undefined) as SwarmRole[] | undefined,
        enableAutoVerification,
        escalationThreshold,
        creditBudget,
        enterpriseId,
        apiFn: api as (method: "GET" | "POST", path: string, params?: Record<string, unknown>, body?: unknown) => Promise<unknown>,
      });
      const result = await swarm.run(query);
      return result as unknown as Record<string, unknown>;
    },
    display: (result) => {
      const r = result as unknown as {
        synthesis?: { summary?: string };
        totalCreditsUsed: number;
        totalDurationMs: number;
        escalated: boolean;
        escalationNotices: string[];
        verificationSummary: { stepsVerified: number; stepsTotal: number; avgConfidence: number; flaggedSteps: number };
        steps: Array<{ agent: { name: string }; output: { summary?: string }; escalated: boolean }>;
      };

      const parts: string[] = [];

      // Header
      const vSum = r.verificationSummary;
      parts.push(`Verified Swarm — ${vSum.stepsVerified}/${vSum.stepsTotal} steps verified, avg confidence ${vSum.avgConfidence}/100`);
      if (vSum.flaggedSteps > 0) parts.push(`⚠️ ${vSum.flaggedSteps} step(s) flagged`);
      if (r.escalated) parts.push(`🛑 Escalated: ${r.escalationNotices.join("; ")}`);
      parts.push("");

      // Step summaries
      for (const step of r.steps || []) {
        const esc = step.escalated ? " ⚠️" : "";
        parts.push(`[${step.agent.name}${esc}] ${step.output.summary || "(no summary)"}`);
      }

      // Synthesis
      if (r.synthesis?.summary) {
        parts.push("");
        parts.push("─── Synthesis ───");
        parts.push(r.synthesis.summary);
      }

      parts.push("");
      parts.push(`Credits: ${r.totalCreditsUsed} | Duration: ${Math.round(r.totalDurationMs / 1000)}s`);

      return parts.join("\n");
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    category: "swarm",
    credits: 15,
  });

  // ═══════════════════════════════════════════════════════════
  // 8. PROCESS FEEDBACK — submit or query the feedback loop
  // ═══════════════════════════════════════════════════════════

  createVeroQTool(server, {
    name: "veroq_process_feedback",
    description: `Submit feedback or query the self-improvement feedback queue.

WHEN TO USE: After a swarm run, submit corrections, flag inaccuracies, or query pending feedback. Also used to check feedback metrics (web search fallback rate, pipeline routing stats).

ACTIONS:
- "submit": Submit new feedback about a query or claim
- "query": Get pending feedback entries
- "metrics": Get feedback loop metrics

COST: 0 credits (local operation).

EXAMPLE: { "action": "submit", "sessionId": "swarm_123", "query": "NVDA analysis", "reason": "low_confidence", "detail": "Missing insider data" }
EXAMPLE: { "action": "metrics" }`,
    inputSchema: z.object({
      action: z.enum(["submit", "query", "metrics"]).describe("Action: submit, query, or metrics"),
      sessionId: z.string().optional().describe("Session ID (required for submit)"),
      query: z.string().optional().describe("Original query (for submit)"),
      reason: z.enum(["low_confidence", "contradicted", "escalated", "data_gap", "verification_failed", "user_submitted", "manual"]).optional()
        .describe("Feedback reason (for submit)"),
      detail: z.string().optional().describe("Detail description (for submit)"),
      claims: z.array(z.string()).optional().describe("Flagged claims (for submit)"),
      status: z.enum(["pending", "enriched", "routed", "resolved", "dismissed"]).optional().describe("Filter by status (for query)"),
      limit: z.number().optional().describe("Max results (for query, default 20)"),
    }),
    execute: async ({ action, sessionId, query: feedbackQuery, reason, detail, claims, status, limit }) => {
      if (action === "submit") {
        if (!sessionId || !feedbackQuery || !reason || !detail) {
          return { error: "submit requires sessionId, query, reason, and detail" };
        }
        const entry = submitFeedback({
          sessionId,
          query: feedbackQuery,
          reason: reason as FeedbackReason,
          detail,
          claims,
        });
        return { status: "ok", feedbackId: entry.id, entry };
      }
      if (action === "query") {
        const entries = getFeedbackQueue({
          sessionId,
          status: status as any,
          limit: limit || 20,
        });
        return { status: "ok", count: entries.length, entries };
      }
      if (action === "metrics") {
        return { status: "ok", metrics: getFeedbackMetrics() };
      }
      return { error: `Unknown action: ${action}` };
    },
    display: (result) => {
      const d = result as Record<string, unknown>;
      if (d.error) return `Error: ${d.error}`;
      if (d.metrics) {
        const m = d.metrics as Record<string, unknown>;
        return `Feedback Metrics:\n  Total: ${m.totalFeedback}\n  Web search fallbacks: ${m.webSearchFallbacks} (${m.webSearchSuccessRate}% success)\n  Pipeline routed: ${m.pipelineRouted}\n  Avg flagged confidence: ${m.avgFlaggedConfidence}\n  Pending: ${m.pendingCount} | Resolved: ${m.resolvedCount}`;
      }
      if (d.feedbackId) return `Feedback submitted: ${d.feedbackId}`;
      if (d.count != null) return `${d.count} feedback entries found`;
      return JSON.stringify(d, null, 2);
    },
    annotations: { readOnlyHint: false },
    category: "feedback",
    credits: 0,
  });
}
