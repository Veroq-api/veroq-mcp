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
import { createRuntime, getAvailableVerticals, type VerticalId } from "../runtime/index.js";
import { submitFeedback, getFeedbackQueue, getFeedbackMetrics, type FeedbackReason } from "../feedback/index.js";
import { callExternalTool, getExternalRegistry } from "../external/index.js";

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

// ── Synonym map for tool search (hoisted to module scope for performance) ──
const SEARCH_SYNONYMS: Record<string, string[]> = {
  price: ["ticker_price", "candles", "market_summary"],
  verify: ["verify", "verify_market_claim", "contradictions"],
  analyze: ["analyze_ticker", "full", "ticker_analysis"],
  earnings: ["earnings", "filings", "analysts"],
  compare: ["compare", "compare_tickers", "correlation"],
  screen: ["screener", "screener_presets", "trading_signal"],
  insider: ["insider", "congress", "institutions"],
  crypto: ["crypto", "crypto_chart", "defi", "defi_protocol"],
  economy: ["economy", "economy_indicator", "forex", "commodities"],
  risk: ["risk_assessor", "alerts", "verified_swarm"],
  news: ["feed", "search", "ticker_news", "trending"],
};

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
    description: `Context-aware tool discovery — find the right VeroQ tool by describing what you need.

WHEN TO USE: When you're not sure which tool to use, or need to explore available capabilities for a specific domain. Filters by permissions, vertical, cost, and trust level. Returns only tools you're allowed to call.

RETURNS: Ranked list of matching tools with: name, category, cost, whenToUse snippet, returnsSnippet, isExternal flag, isHighLevel flag, permissionStatus, and relevance score.

COST: 0 credits (local search, no API call).

EXAMPLE: { "query": "analyze NVDA stock" }
EXAMPLE: { "query": "verify a claim", "vertical": "finance" }
EXAMPLE: { "query": "crypto prices", "maxCost": 2 }
EXAMPLE: { "query": "risk assessment", "category": "trading" }`,
    inputSchema: z.object({
      query: z.string().describe("Describe what you want to accomplish"),
      limit: z.number().optional().describe("Max results (default 5)"),
      vertical: z.string().optional().describe("Filter to tools relevant to a vertical: finance, legal, research, compliance"),
      category: z.string().optional().describe("Filter by tool category: intelligence, trading, verification, market_data, discovery, swarm, feedback, runtime, external"),
      maxCost: z.number().optional().describe("Max credit cost per call (e.g., 2 to only show cheap tools)"),
      includeExternal: z.boolean().optional().describe("Include registered external tools (default: true)"),
    }),
    execute: async ({ query, limit, vertical, category: catFilter, maxCost, includeExternal }) => {
      const { getRegisteredTools } = await import("./veroq-tool-factory.js");
      const { checkPermissions } = await import("../safety/index.js");
      const { getExternalRegistry } = await import("../external/index.js");

      const q = query.toLowerCase();
      const words = q.split(/\s+/).filter(w => w.length >= 2);
      const maxResults = limit || 5;

      // Synonym expansion (map is module-level constant, see SEARCH_SYNONYMS above)
      const expandedTerms = new Set(words);
      for (const w of words) {
        const syns = SEARCH_SYNONYMS[w];
        if (syns) syns.forEach(s => expandedTerms.add(s));
      }

      // ── Vertical kit awareness ──
      let verticalCoreTools: Set<string> | null = null;
      let verticalDeniedTools: Set<string> | null = null;
      if (vertical) {
        try {
          const { getVerticalKit } = await import("../runtime/vertical-kits.js");
          const kit = getVerticalKit(vertical as any);
          verticalCoreTools = new Set(kit.coreTools);
          verticalDeniedTools = new Set(kit.deniedTools);
        } catch { /* vertical not found, skip filtering */ }
      }

      // ── Score internal tools ──
      // Deduplicate by name (registry can accumulate duplicates across calls)
      const allRaw = getRegisteredTools();
      const seen = new Set<string>();
      const all = allRaw.filter(t => {
        if (seen.has(t.name)) return false;
        seen.add(t.name);
        return true;
      });

      type ScoredTool = {
        name: string; description: string; category: string; credits: number;
        score: number; whenToUse: string; returnsSnippet: string;
        isExternal: boolean; isHighLevel: boolean; permissionStatus: string;
        verificationSupport: boolean;
      };

      const scored: ScoredTool[] = [];

      for (const tool of all) {
        const desc = (tool.description || "").toLowerCase();
        const fullText = `${tool.name} ${desc} ${tool.category || ""}`;
        const toolCategory = tool.category || "general";

        // Category filter (treat undefined category as "general")
        if (catFilter && toolCategory !== catFilter) continue;
        // Cost filter
        if (maxCost != null && tool.credits != null && tool.credits > maxCost) continue;
        // Vertical denied filter
        if (verticalDeniedTools?.has(tool.name)) continue;

        // Score
        let score = 0;
        for (const w of expandedTerms) {
          if (fullText.includes(w)) score += 10;
          if (tool.name.includes(w)) score += 25;
        }

        // Boost high-level tools
        const isHL = ["analyze_ticker", "verify_market", "trading_signal", "comprehensive",
          "compare_tickers", "verified_swarm", "create_runtime"].some(k => tool.name.includes(k));
        if (isHL) score += 8;

        // Boost vertical core tools
        if (verticalCoreTools?.has(tool.name)) score += 12;

        // Boost verification-related tools
        const hasVerify = desc.includes("verify") || desc.includes("evidence") || desc.includes("fact-check");
        if (hasVerify && q.includes("verify")) score += 15;

        if (score <= 0) continue;

        // Extract WHEN TO USE and RETURNS snippets from standardized descriptions
        const rawDesc = tool.description || "";
        const whenMatch = rawDesc.match(/WHEN TO USE:\s*([\s\S]+?)(?=\nRETURNS|\nCOST|$)/);
        const returnsMatch = rawDesc.match(/RETURNS:\s*([\s\S]+?)(?=\nCOST|\nEXAMPLE|$)/);

        // Permission check (disable audit logging to avoid pollution)
        let permStatus = "allowed";
        try {
          const perm = checkPermissions(tool.name, {}, { auditEnabled: false });
          if (perm.decision === "deny") permStatus = "denied";
          else if (perm.decision === "review") permStatus = "review";
        } catch { /* ignore */ }

        // Skip denied tools unless explicitly searching
        if (permStatus === "denied" && !q.includes("denied")) continue;

        scored.push({
          name: tool.name,
          description: rawDesc.split("\n")[0] || rawDesc.slice(0, 120),
          category: tool.category || "general",
          credits: tool.credits ?? 0,
          score,
          whenToUse: whenMatch?.[1]?.trim().slice(0, 200) || "",
          returnsSnippet: returnsMatch?.[1]?.trim().slice(0, 200) || "",
          isExternal: false,
          isHighLevel: isHL,
          permissionStatus: permStatus,
          verificationSupport: hasVerify,
        });
      }

      // ── Score external tools ──
      if (includeExternal !== false) {
        try {
          const registry = getExternalRegistry();
          for (const ext of registry.getRegisteredTools()) {
            const extText = `${ext.prefixedName} ${ext.toolName} ${ext.serverId}`.toLowerCase();
            let extScore = 0;
            for (const w of expandedTerms) {
              if (extText.includes(w)) extScore += 10;
            }
            if (extScore > 0) {
              let permStatus = "allowed";
              try {
                const perm = checkPermissions(ext.prefixedName, {});
                if (perm.decision === "deny") permStatus = "denied";
                else if (perm.decision === "review") permStatus = "review";
              } catch { /* ignore */ }

              if (permStatus !== "denied") {
                scored.push({
                  name: ext.prefixedName,
                  description: `External tool: ${ext.toolName} from ${ext.serverId}`,
                  category: "external",
                  credits: 1,
                  score: extScore,
                  whenToUse: `Call ${ext.toolName} on external server ${ext.serverId} (trust: ${ext.trustLevel})`,
                  returnsSnippet: "External API response proxied through VeroQ security stack",
                  isExternal: true,
                  isHighLevel: false,
                  permissionStatus: permStatus,
                  verificationSupport: false,
                });
              }
            }
          }
        } catch { /* no external registry */ }
      }

      // If no keyword matches, return top high-level tools as fallback
      if (scored.length === 0) {
        const fallback = all
          .filter(t => {
            const isHL = ["analyze_ticker", "verify_market", "ask", "comprehensive", "verified_swarm"]
              .some(k => t.name.includes(k));
            return isHL;
          })
          .slice(0, maxResults)
          .map(t => {
            const rawDesc = t.description || "";
            const whenMatch = rawDesc.match(/WHEN TO USE:\s*([\s\S]+?)(?=\nRETURNS|\nCOST|$)/);
            return {
              name: t.name, description: rawDesc.split("\n")[0] || rawDesc.slice(0, 120),
              category: t.category || "general", credits: t.credits ?? 0,
              score: 1, whenToUse: whenMatch?.[1]?.trim().slice(0, 200) || "",
              returnsSnippet: "", isExternal: false,
              isHighLevel: true, permissionStatus: "allowed", verificationSupport: false,
            };
          });
        return fallback;
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, maxResults);
    },
    display: (result) => {
      const tools = result as Array<{
        name: string; description: string; category: string; credits: number;
        score: number; whenToUse: string; isExternal: boolean; isHighLevel: boolean;
        permissionStatus: string; verificationSupport: boolean;
      }>;
      if (!tools.length) return "No matching tools found. Try a different description or remove filters.";

      const parts = [`Found ${tools.length} matching tool(s):\n`];
      for (const t of tools) {
        const badges: string[] = [];
        if (t.isHighLevel) badges.push("high-level");
        if (t.isExternal) badges.push("external");
        if (t.verificationSupport) badges.push("verified");
        if (t.permissionStatus === "review") badges.push("needs-review");
        const badgeStr = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
        const costStr = t.credits === 0 ? "free" : `${t.credits}cr`;

        parts.push(`**${t.name}** (${t.category}, ${costStr})${badgeStr}`);
        if (t.whenToUse) parts.push(`  → ${t.whenToUse.slice(0, 150)}`);
        else if (t.description) parts.push(`  ${t.description.slice(0, 150)}`);
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
          status: status as "pending" | "enriched" | "routed" | "resolved" | "dismissed" | undefined,
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

  // ═══════════════════════════════════════════════════════════
  // 9. CREATE RUNTIME — domain-specific verified agent pipeline
  // ═══════════════════════════════════════════════════════════

  createVeroQTool(server, {
    name: "veroq_create_runtime",
    description: `Create and run a domain-specific verified agent pipeline.

WHEN TO USE: When you need a full multi-agent workflow tailored to a specific domain — finance, legal, research, or compliance. Each domain comes with pre-configured roles, tools, safety rules, and verification guidelines.

VERTICALS: finance (default, full-featured), legal, research, compliance, custom.

RETURNS: Same as veroq_run_verified_swarm but with domain-specific safety rules, tool restrictions, and verification applied automatically.

COST: ~10-25 credits depending on vertical and cost mode.

EXAMPLE: { "vertical": "finance", "query": "Analyze NVDA for a long position" }
EXAMPLE: { "vertical": "legal", "query": "Summarize GDPR data retention requirements", "costMode": "premium" }
EXAMPLE: { "vertical": "compliance", "query": "Check KYC requirements for crypto exchanges" }`,
    inputSchema: z.object({
      vertical: z.enum(["finance", "legal", "research", "compliance", "custom"]).optional()
        .describe("Domain vertical (default: finance)"),
      query: z.string().describe("The question or analysis request"),
      costMode: z.enum(["balanced", "cheap", "premium"]).optional()
        .describe("Cost mode (default: from vertical kit)"),
      creditBudget: z.number().optional().describe("Max credits (default: from vertical kit)"),
      escalationThreshold: z.number().optional().describe("Escalation threshold (default: from vertical kit)"),
      enableParallelSteps: z.boolean().optional().describe("Enable parallel execution (default: false)"),
      enterpriseId: z.string().optional().describe("Enterprise ID for audit"),
    }),
    execute: async ({ vertical, query, costMode, creditBudget, escalationThreshold, enableParallelSteps, enterpriseId }) => {
      const runtime = createRuntime({
        vertical: (vertical || "finance") as VerticalId,
        costMode: costMode as any,
        creditBudget,
        escalationThreshold,
        enableParallelSteps,
        enterpriseId,
        apiFn: api as (method: "GET" | "POST", path: string, params?: Record<string, unknown>, body?: unknown) => Promise<unknown>,
      });
      const result = await runtime.run(query);
      return { ...result, runtimeInfo: runtime.getInfo() } as unknown as Record<string, unknown>;
    },
    display: (result) => {
      const r = result as unknown as {
        runtimeInfo?: { vertical: string; costMode: string; creditBudget: number };
        synthesis?: { summary?: string };
        totalCreditsUsed: number;
        totalDurationMs: number;
        escalated: boolean;
        budget: { remaining: number };
        verificationSummary: { stepsVerified: number; stepsTotal: number; avgConfidence: number };
        steps: Array<{ agent: { name: string }; output: { summary?: string }; escalated: boolean }>;
      };

      const parts: string[] = [];
      const info = r.runtimeInfo;
      if (info) {
        parts.push(`Runtime: ${info.vertical} | ${info.costMode} mode | budget ${info.creditBudget}cr`);
      }

      const vs = r.verificationSummary;
      parts.push(`Verified: ${vs.stepsVerified}/${vs.stepsTotal} steps, avg confidence ${vs.avgConfidence}/100`);
      if (r.escalated) parts.push("⚠️ Escalated — review required");
      parts.push("");

      for (const step of r.steps || []) {
        const esc = step.escalated ? " ⚠️" : "";
        parts.push(`[${step.agent.name}${esc}] ${(step.output.summary || "").slice(0, 120)}`);
      }

      if (r.synthesis?.summary) {
        parts.push("\n─── Synthesis ───");
        parts.push(r.synthesis.summary.slice(0, 500));
      }

      parts.push(`\nCredits: ${r.totalCreditsUsed} (${r.budget.remaining} remaining) | ${Math.round(r.totalDurationMs / 1000)}s`);
      return parts.join("\n");
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    category: "runtime",
    credits: 10,
  });

  // ═══════════════════════════════════════════════════════════
  // 10. CALL EXTERNAL TOOL — secure proxy to external MCP servers
  // ═══════════════════════════════════════════════════════════

  createVeroQTool(server, {
    name: "veroq_call_external_tool",
    description: `Call an external MCP tool through VeroQ's secure proxy.

WHEN TO USE: When you need data from a registered external MCP server (e.g., market data providers, analytics APIs). Every call goes through permission checks, rate limiting, escalation, and audit logging.

REQUIRES: External server must be pre-registered via registerExternalMcpServer() or runtime config.

RETURNS: External tool response with permission result, decision lineage, escalation status, and cost info.

COST: Varies by server config (default: 1 credit per call).

EXAMPLE: { "serverId": "alphavantage", "toolName": "get_quote", "params": { "symbol": "NVDA" } }`,
    inputSchema: z.object({
      serverId: z.string().describe("ID of the registered external server"),
      toolName: z.string().describe("Tool name on the external server"),
      params: z.record(z.unknown()).optional().describe("Parameters to pass to the external tool"),
    }),
    execute: async ({ serverId, toolName, params }) => {
      const result = await callExternalTool(serverId, toolName, params || {});
      return result as unknown as Record<string, unknown>;
    },
    display: (result) => {
      const r = result as unknown as {
        serverId: string;
        toolName: string;
        data: Record<string, unknown>;
        escalated: boolean;
        escalationNotice?: string;
        cached: boolean;
        durationMs: number;
        creditsUsed: number;
        rateLimited: boolean;
        permission: { decision: string };
      };
      const parts: string[] = [];
      parts.push(`External: ${r.serverId}/${r.toolName}`);
      if (r.cached) parts.push(" (cached)");
      if (r.rateLimited) return `Rate limited: ${r.serverId} (try again later)`;
      if (r.permission?.decision === "deny") return `Denied: ${r.serverId}/${r.toolName}`;
      if (r.escalated) parts.push(`\n⚠️ ${r.escalationNotice}`);
      if (r.data?.error) parts.push(`\nError: ${r.data.error}`);
      else parts.push(`\n${JSON.stringify(r.data, null, 2).slice(0, 2000)}`);
      parts.push(`\n${r.creditsUsed}cr | ${r.durationMs}ms`);
      return parts.join("");
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
    category: "external",
    credits: 1,
  });
}
