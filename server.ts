#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer } from "http";

// --- Config ---

const VEROQ_API_KEY = process.env.VEROQ_API_KEY || process.env.POLARIS_API_KEY;
if (!VEROQ_API_KEY) {
  console.error(
    "VEROQ_API_KEY environment variable is required.\n" +
      "Get your key at https://veroq.ai/settings"
  );
  process.exit(1);
}

const BASE_URL =
  (process.env.VEROQ_BASE_URL || process.env.POLARIS_BASE_URL)?.replace(/\/+$/, "") ||
  "https://api.veroq.ai";

// --- API helper ---

async function api(
  method: "GET" | "POST",
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  body?: unknown
): Promise<unknown> {
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${VEROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg =
      (data as Record<string, unknown>)?.error || res.statusText;
    throw new Error(`VEROQ API ${res.status}: ${msg}`);
  }
  return data;
}

// --- Formatting helpers ---

interface Brief {
  id?: string;
  headline?: string;
  category?: string;
  summary?: string;
  body?: string;
  sources?: { name?: string; url?: string; trust_level?: string; verified?: boolean }[];
  entities?: string[];
  entities_enriched?: { name?: string; type?: string; ticker?: string }[];
  counter_argument?: string;
  provenance?: {
    confidence_score?: number;
    bias_score?: number;
    review_status?: string;
    ai_contribution_pct?: number;
    human_contribution_pct?: number;
  };
  published_at?: string;
  sentiment?: string;
  impact_score?: number;
  [key: string]: unknown;
}

function formatBriefShort(b: Brief): string {
  const parts = [`**${b.headline || "Untitled"}**`];
  if (b.provenance?.confidence_score != null) parts.push(`Confidence: ${b.provenance.confidence_score}%`);
  if (b.category) parts.push(`Category: ${b.category}`);
  if (b.summary) parts.push(b.summary);
  if (b.id) parts.push(`ID: ${b.id}`);
  return parts.join("\n");
}

function formatBriefFull(b: Brief): string {
  const parts = [`# ${b.headline || "Untitled"}`];
  if (b.published_at) parts.push(`Published: ${b.published_at}`);
  if (b.provenance?.confidence_score != null) parts.push(`Confidence: ${b.provenance.confidence_score}%`);
  if (b.provenance?.bias_score != null) parts.push(`Bias Score: ${b.provenance.bias_score}`);
  if (b.category) parts.push(`Category: ${b.category}`);
  if (b.summary) parts.push(`\n## Summary\n${b.summary}`);
  if (b.body) parts.push(`\n## Full Text\n${b.body}`);
  if (b.sources?.length) {
    parts.push("\n## Sources");
    for (const s of b.sources) {
      const trust = s.trust_level ? ` (${s.trust_level})` : "";
      parts.push(`- ${s.name || s.url}${trust}${s.url ? ` — ${s.url}` : ""}`);
    }
  }
  if (b.entities_enriched?.length) {
    parts.push("\n## Entities");
    parts.push(b.entities_enriched.map((e) => `- ${e.name} (${e.type})`).join("\n"));
  } else if (b.entities?.length) {
    parts.push("\n## Entities");
    parts.push(b.entities.map((e) => `- ${e}`).join("\n"));
  }
  if (b.counter_argument) parts.push(`\n## Counter-Argument\n${b.counter_argument}`);
  if (b.provenance) {
    const prov = [];
    if (b.provenance.review_status) prov.push(`Review: ${b.provenance.review_status}`);
    if (b.provenance.ai_contribution_pct != null) prov.push(`AI: ${b.provenance.ai_contribution_pct}% / Human: ${b.provenance.human_contribution_pct}%`);
    if (prov.length) parts.push(`\n## Provenance\n${prov.join("\n")}`);
  }
  return parts.join("\n");
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

// --- Server ---

const server = new McpServer({
  name: "veroq",
  version: "1.0.0",
});

// ── Hero Tools — Ask & Verify ──

// 1. veroq_ask
server.tool(
  "veroq_ask",
  `The most important tool — ask any question in natural language and get verified intelligence.

WHEN TO USE: This should be your DEFAULT tool for any financial, market, or economic question. It automatically detects 41 intents (price, technicals, earnings, sentiment, screener, backtest, competitors, insider, filings, analysts, congress, crypto, forex, economy, and more) and routes to the right data sources. Use this FIRST before reaching for specialized tools.

RETURNS: Structured data from all matched endpoints + LLM-generated natural language summary + composite trade signal (0-100) + confidence level (high/medium/low) + follow-up suggestions.

COST: 1-5 credits depending on endpoints hit. Responses cached 60s for ticker queries, 30s for general. Use fast=true to skip LLM summary and save ~2 seconds.

EXAMPLES:
  "What's happening with NVDA?" → full cross-reference (price, technicals, earnings, sentiment, news, insider, analysts)
  "Compare AAPL vs MSFT" → side-by-side comparison with correlation
  "Oversold semiconductor stocks" → NLP screener with results
  "How is the market doing?" → indices, movers, yields
  "Bitcoin price and DeFi overview" → crypto data
  "Verify: Tesla beat Q4 earnings" → fact-check with evidence chain

CONSTRAINTS: 1,061+ tickers with auto-discovery. Falls back to web search for non-financial queries.`,
  {
    question: z.string().describe("Natural-language question — be specific for best results (e.g. 'NVDA full analysis', 'oversold tech stocks', 'compare AAPL vs MSFT')"),
    fast: z.boolean().optional().describe("Skip LLM summary for faster response (~500ms vs ~3s). Data still returned, just no prose summary."),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ question, fast }) => {
    const data = (await api("POST", "/api/v1/ask", undefined, {
      question,
      ...(fast ? { fast: true } : {}),
    })) as Record<string, unknown>;

    if (data.status === "error") return text(`Failed: ${data.message || "Please try rephrasing your question."}`);

    const parts: string[] = [];

    // Summary
    const summary = data.summary as string;
    if (summary) parts.push(summary);

    // Trade signal
    const ts = data.trade_signal as { action?: string; score?: number; factors?: string[] } | undefined;
    if (ts?.action) {
      parts.push(`\nTrade Signal: ${ts.action.toUpperCase()} (${ts.score}/100)`);
      if (ts.factors?.length) {
        for (const f of ts.factors.slice(0, 4)) parts.push(`  • ${f}`);
      }
    }

    // Confidence
    const conf = data.confidence as { level?: string; reason?: string } | undefined;
    if (conf?.level) parts.push(`\nConfidence: ${conf.level} — ${conf.reason || ""}`);

    // Follow-ups
    const followUps = data.follow_ups as string[] | undefined;
    if (followUps?.length) {
      parts.push("\nFollow-up questions:");
      for (const f of followUps.slice(0, 3)) parts.push(`  → ${f}`);
    }

    // Credits + endpoints
    const credits = data.credits_used as number | undefined;
    const endpoints = data.endpoints_called as string[] | undefined;
    if (credits || endpoints) {
      parts.push(`\n_${credits || "?"} credits | ${endpoints?.length || "?"} endpoints | source: ${data.summary_source || "template"}_`);
    }

    return text(parts.join("\n") || "No answer returned.");
  }
);

// 2. veroq_verify
server.tool(
  "veroq_verify",
  `Fact-check any claim with full evidence chain, confidence breakdown, and source reliability scores.

WHEN TO USE: After any agent (including yourself) makes a factual claim about earnings, revenue, market movements, mergers, acquisitions, or any financial data. Also use proactively to verify assumptions before making recommendations. This is the TRUST tool — it proves claims with evidence.

RETURNS:
  • verdict: supported | contradicted | partially_supported | unverifiable
  • confidence: 0-1 with 4-factor breakdown (source_agreement, source_quality, recency, corroboration_depth)
  • evidence_chain: array of {source, snippet, url, position, reliability} — actual quotes from real sources
  • receipt: hashable verification proof (id, claim_hash, verdict_hash, sources_hash)
  • Checks 200+ verified sources first, falls back to live web search — NOTHING returns "unverifiable" for newsworthy claims

COST: 3 credits. Results cached 1 hour (corpus) or 15 min (web fallback).

EXAMPLES:
  "NVIDIA reported record Q4 2025 earnings" → SUPPORTED (85%) with Reuters, Bloomberg evidence
  "The Federal Reserve cut rates in March 2026" → CONTRADICTED (92%) — they held rates steady
  "Apple is partnering with OpenAI" → SUPPORTED with 5 source evidence chain

CONSTRAINTS: Claim must be 10-1000 characters. Be specific — include names, numbers, dates for best results.`,
  {
    claim: z.string().min(10).describe("The factual claim to verify (10-1000 chars). Be specific — 'NVIDIA beat Q4 earnings by 20%' not just 'NVIDIA did well'"),
    context: z.string().optional().describe("Category hint to narrow search: tech, markets, crypto, policy, health, energy"),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ claim, context }) => {
    const data = (await api("POST", "/api/v1/verify", undefined, {
      claim,
      context,
    })) as Record<string, unknown>;

    const verdict = data.verdict as string || "unknown";
    const confidence = data.confidence as number || 0;
    const confPct = Math.round(confidence * 100);
    const emoji = verdict === "supported" ? "✓" : verdict === "contradicted" ? "✗" : verdict === "partially_supported" ? "~" : "?";

    const parts = [`[${emoji} ${verdict.toUpperCase()}] Confidence: ${confPct}%`];
    parts.push(`\nClaim: "${claim}"`);

    // Summary
    if (data.summary) parts.push(`\n${data.summary}`);

    // Confidence breakdown
    const breakdown = data.confidence_breakdown as Record<string, number> | undefined;
    if (breakdown && Object.keys(breakdown).length > 0) {
      parts.push(`\nConfidence Breakdown:`);
      parts.push(`  Source Agreement:    ${Math.round((breakdown.source_agreement || 0) * 100)}%`);
      parts.push(`  Source Quality:      ${Math.round((breakdown.source_quality || 0) * 100)}%`);
      parts.push(`  Recency:            ${Math.round((breakdown.recency || 0) * 100)}%`);
      parts.push(`  Corroboration:      ${Math.round((breakdown.corroboration_depth || 0) * 100)}%`);
    }

    // Evidence chain
    const chain = data.evidence_chain as Array<Record<string, unknown>> | undefined;
    if (chain?.length) {
      parts.push(`\nEvidence Chain (${chain.length} sources):`);
      for (const e of chain.slice(0, 5)) {
        const pos = e.position ? `[${e.position}]` : "";
        const rel = e.reliability ? ` (${Math.round(Number(e.reliability) * 100)}% reliable)` : "";
        parts.push(`  ${pos} ${e.source}${rel}`);
        if (e.snippet) parts.push(`    "${String(e.snippet).slice(0, 100)}"`);
        if (e.url) parts.push(`    ${e.url}`);
      }
    }

    // Nuances
    if (data.nuances) parts.push(`\nNuances: ${data.nuances}`);

    // Receipt
    const receipt = data.receipt as Record<string, string> | undefined;
    if (receipt?.id) parts.push(`\nVerification Receipt: ${receipt.id}`);

    // Stats
    parts.push(`\n_${data.sources_analyzed} sources analyzed | ${data.briefs_matched} briefs matched | ${data.processing_time_ms}ms | ${data.credits_used} credits_`);

    return text(parts.join("\n"));
  }
);

// ── Search & Discovery ──

// 3. veroq_search
server.tool(
  "veroq_search",
  `Search verified intelligence briefs by keyword or topic.

WHEN TO USE: When looking for specific news, events, or coverage on a topic. Use veroq_ask for natural-language questions instead.
RETURNS: Array of briefs with headline, confidence score, category, summary, and brief ID.
COST: 1 credit.
EXAMPLE: { "query": "NVIDIA earnings", "category": "Technology", "limit": 5 }`,
  {
    query: z.string().describe("Search query"),
    category: z.string().optional().describe("Filter by category"),
    depth: z.enum(["fast", "standard", "deep"]).optional().describe("Search depth — fast skips highlights, deep adds entity cross-refs"),
    include_sources: z.string().optional().describe("Comma-separated domains to include"),
    exclude_sources: z.string().optional().describe("Comma-separated domains to exclude"),
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async ({ query, category, depth, include_sources, exclude_sources, limit }) => {
    const data = (await api("GET", "/api/v1/search", {
      q: query,
      category,
      depth,
      include_sources,
      exclude_sources,
      per_page: limit,
    })) as { briefs?: Brief[] };
    const briefs = data.briefs || [];
    if (!briefs.length) return text("No results found.");
    return text(briefs.map(formatBriefShort).join("\n\n---\n\n"));
  }
);

// 2. veroq_feed
server.tool(
  "veroq_feed",
  `Get the latest verified intelligence briefs in reverse-chronological order.

WHEN TO USE: For browsing recent news without a specific search query. Use veroq_search when you have a topic in mind.
RETURNS: Array of briefs with headline, confidence score, category, and summary.
COST: 1 credit.
EXAMPLE: { "category": "Markets", "limit": 10 }`,
  {
    category: z.string().optional().describe("Filter by category"),
    limit: z.number().optional().describe("Max results (default 20)"),
    include_sources: z.string().optional().describe("Comma-separated domains to include"),
    exclude_sources: z.string().optional().describe("Comma-separated domains to exclude"),
  },
  async ({ category, limit, include_sources, exclude_sources }) => {
    const data = (await api("GET", "/api/v1/feed", {
      category,
      per_page: limit,
      include_sources,
      exclude_sources,
    })) as { briefs?: Brief[] };
    const briefs = data.briefs || [];
    if (!briefs.length) return text("No briefs in feed.");
    return text(briefs.map(formatBriefShort).join("\n\n---\n\n"));
  }
);

// 3. veroq_brief
server.tool(
  "veroq_brief",
  `Get full details for a specific intelligence brief by its ID.

WHEN TO USE: After finding a brief via search/feed, use this to read the full body, sources, entities, and counter-argument.
RETURNS: Full brief with body text, sources (with trust levels), entities, counter-argument, and provenance (confidence, bias, AI/human split).
COST: 1 credit.
EXAMPLE: { "brief_id": "PR-2026-0305-001" }`,
  {
    brief_id: z.string().describe("Brief ID"),
    include_full_text: z.boolean().optional().describe("Include full body text (default true)"),
  },
  async ({ brief_id, include_full_text }) => {
    const data = (await api("GET", `/api/v1/brief/${encodeURIComponent(brief_id)}`, {
      include_full_text: include_full_text ?? true,
    })) as { brief?: Brief };
    const brief = data.brief;
    if (!brief) return text("Brief not found.");
    return text(formatBriefFull(brief));
  }
);

// 4. veroq_extract
server.tool(
  "veroq_extract",
  `Extract article content from one or more URLs into clean text.

WHEN TO USE: When you need the full text of a news article or web page for analysis. Handles paywalls where possible.
RETURNS: Per-URL results with title, domain, word count, and extracted text (truncated at 2000 chars).
COST: 3 credits.
EXAMPLE: { "urls": "https://reuters.com/article/123,https://bloomberg.com/news/456" }
CONSTRAINTS: Max 5 URLs per request.`,
  {
    urls: z.string().describe("Comma-separated URLs to extract (max 5)"),
  },
  async ({ urls }) => {
    const urlList = urls.split(",").map((u) => u.trim()).filter(Boolean);
    const data = (await api("POST", "/api/v1/extract", undefined, {
      urls: urlList,
    })) as { results?: { url?: string; title?: string; domain?: string; word_count?: number; text?: string; error?: string }[] };
    const results = data.results || [];
    if (!results.length) return text("No extraction results.");
    const parts = results.map((r) => {
      if (r.error) return `**${r.url}** — Error: ${r.error}`;
      const lines = [`**${r.title || r.url}**`];
      if (r.domain) lines.push(`Domain: ${r.domain}`);
      if (r.word_count) lines.push(`Words: ${r.word_count}`);
      if (r.text) lines.push(r.text.length > 2000 ? r.text.slice(0, 2000) + "…" : r.text);
      return lines.join("\n");
    });
    return text(parts.join("\n\n---\n\n"));
  }
);

// 5. veroq_entities
server.tool(
  "veroq_entities",
  `Get all intelligence briefs mentioning a specific entity (person, company, location, etc.).

WHEN TO USE: When tracking coverage of a specific person, organization, or place across all briefs.
RETURNS: Array of briefs mentioning the entity, with headline, confidence, category, and summary.
COST: 1 credit.
EXAMPLE: { "name": "Elon Musk" }`,
  {
    name: z.string().describe("Entity name to look up"),
  },
  async ({ name }) => {
    const data = (await api("GET", `/api/v1/entities/${encodeURIComponent(name)}/briefs`)) as { briefs?: Brief[] };
    const briefs = data.briefs || [];
    if (!briefs.length) return text(`No briefs found mentioning "${name}".`);
    return text(briefs.map(formatBriefShort).join("\n\n---\n\n"));
  }
);

// 6. veroq_trending
server.tool(
  "veroq_trending",
  `Get trending entities — people, orgs, and topics with the most mentions in the last 24 hours.

WHEN TO USE: To discover what's dominating the news cycle right now. Good starting point for research.
RETURNS: Array of entities with name, type, ticker (if applicable), and 24h mention count.
COST: 1 credit.
EXAMPLE: { "limit": 10 }`,
  {
    limit: z.number().optional().describe("Max entities to return"),
  },
  async ({ limit }) => {
    const data = (await api("GET", "/api/v1/entities/trending", {
      limit,
    })) as { entities?: { name?: string; type?: string; ticker?: string | null; mentions_24h?: number }[] };
    const entities = data.entities || [];
    if (!entities.length) return text("No trending entities.");
    const lines = entities.map(
      (e) => `- **${e.name}** (${e.type})${e.ticker ? ` [${e.ticker}]` : ""} — ${e.mentions_24h} mentions (24h)`
    );
    return text(lines.join("\n"));
  }
);

// 7. veroq_compare
server.tool(
  "veroq_compare",
  `Compare how different news sources cover the same topic, with per-source bias analysis and synthesis.

WHEN TO USE: When you need to understand media bias or see how coverage of an event differs across outlets.
RETURNS: Topic headline, VEROQ confidence/bias scores, per-source analysis, and overall synthesis.
COST: 2 credits.
EXAMPLE: { "topic": "Federal Reserve rate decision" }`,
  {
    topic: z.string().describe("Topic to compare coverage on"),
  },
  async ({ topic }) => {
    // Find a relevant brief first
    const searchData = (await api("GET", "/api/v1/search", {
      q: topic,
      per_page: 1,
    })) as { briefs?: Brief[] };
    const brief = searchData.briefs?.[0];
    if (!brief?.id) return text(`No briefs found for topic "${topic}".`);

    const data = (await api("GET", "/api/v1/compare/sources", {
      brief_id: brief.id,
    })) as {
      topic?: string;
      polaris_brief?: { headline?: string; summary?: string; confidence?: number; bias_score?: number };
      source_analyses?: Record<string, unknown>[];
      polaris_analysis?: Record<string, unknown>;
      generated_at?: string;
    };
    const parts = [`# Source Comparison: ${data.topic || brief.headline}`];
    if (data.polaris_brief) {
      parts.push(`\nVEROQ confidence: ${data.polaris_brief.confidence}% | Bias score: ${data.polaris_brief.bias_score}`);
    }
    if (data.source_analyses?.length) {
      parts.push("\n## Per-Source Analysis");
      for (const s of data.source_analyses) {
        parts.push(`### ${(s as Record<string, string>).name || "Source"}`);
        parts.push(JSON.stringify(s, null, 2));
      }
    }
    if (data.polaris_analysis) {
      parts.push(`\n## VEROQ Analysis\n${JSON.stringify(data.polaris_analysis, null, 2)}`);
    }
    return text(parts.join("\n"));
  }
);

// 8. veroq_research
server.tool(
  "veroq_research",
  `Run deep multi-source research on a topic. Produces a structured report with key findings, entity map, and information gaps.

WHEN TO USE: For thorough investigation of a topic requiring analysis across many sources. Use veroq_search for quick lookups instead.
RETURNS: Summary, key findings, analysis, confidence assessment, entity map (with co-occurrences), information gaps, and sources used.
COST: 3 credits.
EXAMPLE: { "query": "impact of AI regulation on semiconductor stocks", "max_sources": 20 }`,
  {
    query: z.string().describe("Research query"),
    category: z.string().optional().describe("Filter by category"),
    max_sources: z.number().optional().describe("Maximum sources to analyze"),
  },
  async ({ query, category, max_sources }) => {
    const data = (await api("POST", "/api/v1/research", undefined, {
      query,
      category,
      max_sources,
    })) as {
      query?: string;
      report?: {
        summary?: string;
        key_findings?: string[];
        analysis?: string;
        confidence_assessment?: string;
        information_gaps?: string[];
      };
      sources_used?: { brief_id?: string; headline?: string; confidence?: number; category?: string }[];
      entity_map?: { name?: string; type?: string; mentions?: number; co_occurs_with?: { entity?: string; count?: number }[] }[];
      metadata?: { briefs_analyzed?: number; unique_sources?: number; processing_time_ms?: number };
    };
    const report = data.report;
    const parts = ["# Research Report"];
    if (report?.summary) parts.push(`\n## Summary\n${report.summary}`);
    if (report?.key_findings?.length) {
      parts.push("\n## Key Findings");
      parts.push(report.key_findings.map((f) => `- ${f}`).join("\n"));
    }
    if (report?.analysis) parts.push(`\n## Analysis\n${report.analysis}`);
    if (report?.confidence_assessment) parts.push(`\n## Confidence Assessment\n${report.confidence_assessment}`);
    if (data.entity_map?.length) {
      parts.push("\n## Entity Map");
      parts.push(
        data.entity_map
          .map((e) => {
            let line = `- **${e.name}** (${e.type}) — ${e.mentions} mentions`;
            if (e.co_occurs_with?.length) {
              line += ` | co-occurs with: ${e.co_occurs_with.map((c) => c.entity).join(", ")}`;
            }
            return line;
          })
          .join("\n")
      );
    }
    if (report?.information_gaps?.length) {
      parts.push("\n## Information Gaps");
      parts.push(report.information_gaps.map((g) => `- ${g}`).join("\n"));
    }
    if (data.sources_used?.length) {
      parts.push("\n## Sources Used");
      parts.push(data.sources_used.map((s) => `- ${s.headline} (${s.category}, confidence: ${s.confidence}%)`).join("\n"));
    }
    if (data.metadata) {
      parts.push(`\n_Analyzed ${data.metadata.briefs_analyzed} briefs from ${data.metadata.unique_sources} sources in ${data.metadata.processing_time_ms}ms_`);
    }
    return text(parts.join("\n"));
  }
);

// 10. veroq_timeline
server.tool(
  "veroq_timeline",
  `Get the story evolution timeline for a living brief — versioned updates, confidence changes, and new sources over time.

WHEN TO USE: To see how a story developed over time. Requires a brief ID from search/feed.
RETURNS: Array of timeline entries with version number, timestamp, summary, confidence score, changes, and new sources.
COST: 2 credits.
EXAMPLE: { "brief_id": "PR-2026-0305-001" }`,
  {
    brief_id: z.string().describe("Brief ID like PR-2026-0305-001"),
  },
  async ({ brief_id }) => {
    const data = (await api("GET", `/api/v1/brief/${encodeURIComponent(brief_id)}/timeline`)) as {
      brief_id?: string;
      headline?: string;
      timeline?: {
        version?: number;
        timestamp?: string;
        summary?: string;
        confidence_score?: number;
        sources_added?: string[];
        changes?: string[];
      }[];
    };
    if (!data.timeline?.length) return text("No timeline data available for this brief.");
    const parts = [`# Timeline: ${data.headline || data.brief_id || brief_id}`];
    for (const entry of data.timeline) {
      const header = `## v${entry.version ?? "?"}${entry.timestamp ? ` — ${entry.timestamp}` : ""}`;
      parts.push(header);
      if (entry.confidence_score != null) parts.push(`Confidence: ${entry.confidence_score}%`);
      if (entry.summary) parts.push(entry.summary);
      if (entry.changes?.length) {
        parts.push("Changes:");
        parts.push(entry.changes.map((c) => `- ${c}`).join("\n"));
      }
      if (entry.sources_added?.length) {
        parts.push("New sources:");
        parts.push(entry.sources_added.map((s) => `- ${s}`).join("\n"));
      }
    }
    return text(parts.join("\n\n"));
  }
);

// 11. veroq_forecast
server.tool(
  "veroq_forecast",
  `Generate a forward-looking forecast for a topic based on intelligence trends, momentum, and historical patterns.

WHEN TO USE: When you need predictive analysis — likely outcomes, scenarios, and risk factors for a topic.
RETURNS: Outlook, confidence, time horizon, key drivers, risks, probability-weighted scenarios, and supporting briefs.
COST: 2 credits.
EXAMPLE: { "topic": "US inflation trajectory", "depth": "deep" }`,
  {
    topic: z.string().describe("Topic to forecast future developments for"),
    depth: z.enum(["fast", "standard", "deep"]).optional().describe("Analysis depth"),
  },
  async ({ topic, depth }) => {
    const data = (await api("POST", "/api/v1/forecast", undefined, {
      topic,
      depth,
    })) as {
      topic?: string;
      forecast?: {
        outlook?: string;
        confidence?: number;
        time_horizon?: string;
        key_drivers?: string[];
        risks?: string[];
        scenarios?: { label?: string; probability?: number; description?: string }[];
      };
      supporting_briefs?: { id?: string; headline?: string; relevance?: number }[];
      generated_at?: string;
    };
    const f = data.forecast;
    const parts = [`# Forecast: ${data.topic || topic}`];
    if (f?.outlook) parts.push(`\n## Outlook\n${f.outlook}`);
    if (f?.confidence != null) parts.push(`Confidence: ${f.confidence}%`);
    if (f?.time_horizon) parts.push(`Time Horizon: ${f.time_horizon}`);
    if (f?.key_drivers?.length) {
      parts.push("\n## Key Drivers");
      parts.push(f.key_drivers.map((d) => `- ${d}`).join("\n"));
    }
    if (f?.risks?.length) {
      parts.push("\n## Risks");
      parts.push(f.risks.map((r) => `- ${r}`).join("\n"));
    }
    if (f?.scenarios?.length) {
      parts.push("\n## Scenarios");
      for (const s of f.scenarios) {
        parts.push(`- **${s.label}** (${s.probability}%): ${s.description}`);
      }
    }
    if (data.supporting_briefs?.length) {
      parts.push("\n## Supporting Briefs");
      parts.push(data.supporting_briefs.map((b) => `- ${b.headline} (${b.id})`).join("\n"));
    }
    return text(parts.join("\n"));
  }
);

// 12. veroq_contradictions
server.tool(
  "veroq_contradictions",
  `Find contradictions across intelligence briefs — stories where sources disagree on facts, framing, or conclusions.

WHEN TO USE: To identify conflicting narratives and disputed claims in the news. Useful for risk assessment and due diligence.
RETURNS: Array of contradictions with severity, topic, summary, and opposing brief positions (Side A vs Side B).
COST: 2 credits.
EXAMPLE: { "severity": "high" }`,
  {
    severity: z.string().optional().describe("Filter by severity level (e.g. high, medium, low)"),
  },
  async ({ severity }) => {
    const data = (await api("GET", "/api/v1/contradictions", {
      severity,
    })) as {
      contradictions?: {
        id?: string;
        severity?: string;
        topic?: string;
        summary?: string;
        brief_a?: { id?: string; headline?: string; position?: string };
        brief_b?: { id?: string; headline?: string; position?: string };
      }[];
      total?: number;
    };
    const items = data.contradictions || [];
    if (!items.length) return text("No contradictions found.");
    const parts = [`# Contradictions (${data.total ?? items.length} total)`];
    for (const c of items) {
      parts.push(`\n## ${c.topic || "Contradiction"} [${c.severity || "N/A"}]`);
      if (c.summary) parts.push(c.summary);
      if (c.brief_a) parts.push(`**Side A:** ${c.brief_a.headline} (${c.brief_a.id})\n${c.brief_a.position || ""}`);
      if (c.brief_b) parts.push(`**Side B:** ${c.brief_b.headline} (${c.brief_b.id})\n${c.brief_b.position || ""}`);
    }
    return text(parts.join("\n"));
  }
);

// 13. veroq_events
server.tool(
  "veroq_events",
  `Get notable events detected across intelligence briefs — significant developments, announcements, and inflection points.

WHEN TO USE: To discover major events like product launches, policy changes, or market-moving announcements. Filter by type or subject.
RETURNS: Array of events with type, subject, headline, summary, impact score, detected timestamp, and related brief IDs.
COST: 2 credits.
EXAMPLE: { "type": "earnings", "subject": "NVDA" }`,
  {
    type: z.string().optional().describe("Event type to filter by"),
    subject: z.string().optional().describe("Subject or entity to filter events for"),
  },
  async ({ type, subject }) => {
    const data = (await api("GET", "/api/v1/events", {
      type,
      subject,
    })) as {
      events?: {
        id?: string;
        type?: string;
        subject?: string;
        headline?: string;
        summary?: string;
        detected_at?: string;
        impact_score?: number;
        related_briefs?: string[];
      }[];
      total?: number;
    };
    const events = data.events || [];
    if (!events.length) return text("No events found.");
    const parts = [`# Events (${data.total ?? events.length} total)`];
    for (const e of events) {
      parts.push(`\n## ${e.headline || e.subject || "Event"}`);
      if (e.type) parts.push(`Type: ${e.type}`);
      if (e.detected_at) parts.push(`Detected: ${e.detected_at}`);
      if (e.impact_score != null) parts.push(`Impact: ${e.impact_score}`);
      if (e.summary) parts.push(e.summary);
      if (e.related_briefs?.length) parts.push(`Related briefs: ${e.related_briefs.join(", ")}`);
    }
    return text(parts.join("\n"));
  }
);

// 14. veroq_diff
server.tool(
  "veroq_diff",
  `Get a diff of changes to a living brief since a given time — additions, removals, and modifications between versions.

WHEN TO USE: To see exactly what changed in a brief since a specific timestamp. Requires a brief ID.
RETURNS: Version range, confidence change, field-level changes (old/new values), and newly added sources.
COST: 2 credits.
EXAMPLE: { "brief_id": "PR-2026-0305-001", "since": "2026-03-18T00:00:00Z" }`,
  {
    brief_id: z.string().describe("Brief ID like PR-2026-0305-001"),
    since: z.string().optional().describe("ISO timestamp to diff from (e.g. 2026-03-18T00:00:00Z)"),
  },
  async ({ brief_id, since }) => {
    const data = (await api("GET", `/api/v1/brief/${encodeURIComponent(brief_id)}/diff`, {
      since,
    })) as {
      brief_id?: string;
      headline?: string;
      from_version?: number;
      to_version?: number;
      changes?: {
        field?: string;
        type?: string;
        old_value?: string;
        new_value?: string;
      }[];
      new_sources?: string[];
      confidence_change?: { from?: number; to?: number };
      since?: string;
    };
    if (!data.changes?.length && !data.new_sources?.length && !data.confidence_change) {
      return text("No changes found for this brief since the specified time.");
    }
    const parts = [`# Diff: ${data.headline || data.brief_id || brief_id}`];
    if (data.from_version != null && data.to_version != null) {
      parts.push(`Versions: v${data.from_version} → v${data.to_version}`);
    }
    if (data.confidence_change) {
      parts.push(`\nConfidence: ${data.confidence_change.from}% → ${data.confidence_change.to}%`);
    }
    if (data.changes?.length) {
      parts.push("\n## Changes");
      for (const c of data.changes) {
        parts.push(`**${c.field}** (${c.type})`);
        if (c.old_value) parts.push(`- Old: ${c.old_value}`);
        if (c.new_value) parts.push(`+ New: ${c.new_value}`);
      }
    }
    if (data.new_sources?.length) {
      parts.push("\n## New Sources");
      parts.push(data.new_sources.map((s) => `- ${s}`).join("\n"));
    }
    return text(parts.join("\n"));
  }
);

// 15. veroq_web_search
server.tool(
  "veroq_web_search",
  `Search the live web with optional VEROQ trust scoring on results.

WHEN TO USE: When intelligence briefs don't cover a topic and you need live web results. Enable verify=true for trust scoring.
RETURNS: Web search results with titles, URLs, snippets, relevance scores, and optional verification scores.
COST: 3 credits.
EXAMPLE: { "query": "TSLA cybertruck delivery numbers 2026", "freshness": "week", "verify": true }`,
  {
    query: z.string().describe("Web search query"),
    limit: z.number().optional().describe("Max results (default 5)"),
    freshness: z.string().optional().describe("Freshness filter (e.g. 'day', 'week', 'month')"),
    region: z.string().optional().describe("Region code (e.g. 'us', 'eu')"),
    verify: z.boolean().optional().describe("Enable VEROQ trust scoring on results"),
  },
  async ({ query, limit, freshness, region, verify }) => {
    const data = await api("GET", "/api/v1/web-search", {
      q: query,
      limit,
      freshness,
      region,
      verify,
    });
    return text(JSON.stringify(data, null, 2));
  }
);

// 16. veroq_crawl
server.tool(
  "veroq_crawl",
  `Crawl a URL and extract structured content with optional link following.

WHEN TO USE: When you need to extract and analyze content from a specific webpage, or crawl a site's link structure.
RETURNS: Page content, metadata, and discovered links per page crawled.
COST: 3 credits.
EXAMPLE: { "url": "https://sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=AAPL", "depth": 1 }
CONSTRAINTS: Max depth 3, max 10 pages per crawl.`,
  {
    url: z.string().describe("URL to crawl and extract content from"),
    depth: z.number().optional().describe("Crawl depth (default 1)"),
    max_pages: z.number().optional().describe("Max pages to crawl (default 5)"),
    include_links: z.boolean().optional().describe("Include extracted links in response"),
  },
  async ({ url, depth, max_pages, include_links }) => {
    const data = await api("POST", "/api/v1/crawl", undefined, {
      url,
      depth: depth ?? 1,
      max_pages: max_pages ?? 5,
      include_links: include_links ?? true,
    });
    return text(JSON.stringify(data, null, 2));
  }
);

// ── Trading Tools ──

// 17. veroq_ticker_price
server.tool(
  "veroq_ticker_price",
  `Get the live market price for a stock or crypto ticker.

WHEN TO USE: For a quick price check on any ticker. This is free — use it freely. For full analysis, use veroq_full instead.
RETURNS: Current price, change, change percent, volume, currency, and market state (open/closed).
COST: Free (0 credits).
EXAMPLE: { "symbol": "AAPL" }`,
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, BTC)"),
  },
  async ({ symbol }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(symbol.toUpperCase())}/price`)) as {
      status?: string;
      ticker?: string;
      price?: number;
      change?: number;
      change_percent?: number;
      volume?: number;
      currency?: string;
      market_state?: string;
      fetched_at?: string;
      [key: string]: unknown;
    };
    if (!data.price && data.status === "error") return text(`Price not available for "${symbol}".`);
    const parts = [`**${data.ticker || symbol.toUpperCase()}** — $${data.price}`];
    if (data.change != null) parts.push(`Change: ${data.change >= 0 ? "+" : ""}${data.change} (${data.change_percent != null ? `${data.change_percent >= 0 ? "+" : ""}${data.change_percent.toFixed(2)}%` : "N/A"})`);
    if (data.volume) parts.push(`Volume: ${data.volume.toLocaleString()}`);
    if (data.currency) parts.push(`Currency: ${data.currency}`);
    if (data.market_state) parts.push(`Market: ${data.market_state}`);
    if (data.fetched_at) parts.push(`As of: ${data.fetched_at}`);
    return text(parts.join("\n"));
  }
);

// 18. veroq_ticker_score
server.tool(
  "veroq_ticker_score",
  `Get a composite trading signal score for a ticker based on sentiment, momentum, coverage volume, and event proximity.

WHEN TO USE: For a quick bull/bear signal on a ticker. Use veroq_ticker_analysis for deeper context behind the signal.
RETURNS: Composite score, signal (strong_bullish to strong_bearish), and component breakdown (sentiment, momentum, volume, events with weights).
COST: 2 credits.
EXAMPLE: { "symbol": "NVDA" }`,
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  async ({ symbol }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(symbol.toUpperCase())}/score`)) as {
      status?: string;
      ticker?: string;
      entity_name?: string;
      sector?: string;
      composite_score?: number;
      signal?: string;
      components?: {
        sentiment?: { current_24h?: number | null; week_avg?: number | null; weight?: number };
        momentum?: { value?: number; direction?: string; weight?: number };
        volume?: { briefs_24h?: number; briefs_7d?: number; velocity_change_pct?: number; weight?: number };
        events?: { count_7d?: number; latest_type?: string | null; weight?: number };
      };
      updated_at?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(`Trading signal not available for "${symbol}".`);
    const parts = [`# Trading Signal: ${data.ticker || symbol.toUpperCase()}`];
    if (data.entity_name) parts.push(`Company: ${data.entity_name}`);
    if (data.sector) parts.push(`Sector: ${data.sector}`);
    parts.push(`\n**Signal: ${(data.signal || "unknown").toUpperCase()}** (score: ${data.composite_score})`);
    if (data.components) {
      const c = data.components;
      parts.push("\n## Components");
      if (c.sentiment) parts.push(`- Sentiment (${(c.sentiment.weight ?? 0) * 100}%): 24h=${c.sentiment.current_24h ?? "N/A"}, 7d avg=${c.sentiment.week_avg ?? "N/A"}`);
      if (c.momentum) parts.push(`- Momentum (${(c.momentum.weight ?? 0) * 100}%): ${c.momentum.direction} (${c.momentum.value})`);
      if (c.volume) parts.push(`- Volume (${(c.volume.weight ?? 0) * 100}%): ${c.volume.briefs_24h} briefs/24h, ${c.volume.briefs_7d} briefs/7d, velocity ${c.volume.velocity_change_pct}%`);
      if (c.events) parts.push(`- Events (${(c.events.weight ?? 0) * 100}%): ${c.events.count_7d} events/7d${c.events.latest_type ? `, latest: ${c.events.latest_type}` : ""}`);
    }
    if (data.updated_at) parts.push(`\n_Updated: ${data.updated_at}_`);
    return text(parts.join("\n"));
  }
);

// 19. veroq_portfolio_feed
server.tool(
  "veroq_portfolio_feed",
  `Get intelligence briefs ranked by relevance to your portfolio holdings.

WHEN TO USE: When monitoring news for a specific portfolio. Pass ticker/weight pairs to get impact-ranked coverage.
RETURNS: Holdings summary (briefs count, sentiment per ticker), portfolio-relevant briefs ranked by relevance score.
COST: 2 credits.
EXAMPLE: { "holdings": [{ "ticker": "AAPL", "weight": 0.3 }, { "ticker": "NVDA", "weight": 0.2 }], "days": 7 }`,
  {
    holdings: z.array(z.object({
      ticker: z.string().describe("Ticker symbol"),
      weight: z.number().describe("Portfolio weight 0-1 (e.g. 0.15 for 15%)"),
    })).describe("Array of portfolio holdings with weights"),
    days: z.number().optional().describe("Lookback period in days (default 7, max 30)"),
    limit: z.number().optional().describe("Max briefs to return (default 30)"),
  },
  async ({ holdings, days, limit }) => {
    const data = (await api("POST", "/api/v1/portfolio/feed", { days, limit }, { holdings })) as {
      status?: string;
      days?: number;
      holdings_resolved?: number;
      holdings_unresolved?: string[];
      portfolio_summary?: { ticker?: string; weight?: number; sector?: string | null; briefs_in_period?: number; avg_sentiment?: number | null }[];
      total_briefs?: number;
      briefs?: (Brief & { portfolio_relevance?: number; matching_tickers?: string[] })[];
      [key: string]: unknown;
    };
    if (data.status === "error") return text("Failed to fetch portfolio feed.");
    const parts = [`# Portfolio Feed (${data.days || 7} days)`];
    parts.push(`Holdings resolved: ${data.holdings_resolved} | Briefs found: ${data.total_briefs}`);
    if (data.holdings_unresolved?.length) parts.push(`Unresolved tickers: ${data.holdings_unresolved.join(", ")}`);
    if (data.portfolio_summary?.length) {
      parts.push("\n## Holdings Summary");
      for (const h of data.portfolio_summary) {
        parts.push(`- **${h.ticker}** (${(h.weight ?? 0) * 100}%${h.sector ? `, ${h.sector}` : ""}): ${h.briefs_in_period} briefs, sentiment=${h.avg_sentiment ?? "N/A"}`);
      }
    }
    const briefs = data.briefs || [];
    if (briefs.length) {
      parts.push("\n## Top Briefs");
      for (const b of briefs.slice(0, 20)) {
        parts.push(`\n**${b.headline || "Untitled"}** (relevance: ${b.portfolio_relevance})`);
        if (b.matching_tickers?.length) parts.push(`Tickers: ${b.matching_tickers.join(", ")}`);
        if (b.summary) parts.push(b.summary);
      }
    }
    return text(parts.join("\n"));
  }
);

// 20. veroq_sectors
server.tool(
  "veroq_sectors",
  `Get a sector overview with aggregate sentiment scores and brief counts across all market sectors.

WHEN TO USE: For a macro view of which sectors have the most bullish or bearish news coverage. Good for sector rotation analysis.
RETURNS: Per-sector data: ticker count, brief count, average sentiment, and top tickers with individual sentiment.
COST: 1 credit.
EXAMPLE: { "days": 7 }`,
  {
    days: z.number().optional().describe("Lookback period in days (default 7)"),
  },
  async ({ days }) => {
    const data = (await api("GET", "/api/v1/sectors", { days })) as {
      status?: string;
      days?: number;
      sectors?: {
        sector?: string;
        ticker_count?: number;
        briefs_in_period?: number;
        avg_sentiment?: number | null;
        top_tickers?: { ticker?: string; entity_name?: string; briefs?: number; avg_sentiment?: number | null }[];
      }[];
      [key: string]: unknown;
    };
    const sectors = data.sectors || [];
    if (!sectors.length) return text("No sector data available.");
    const parts = [`# Sector Overview (${data.days || 7} days)`];
    for (const s of sectors) {
      parts.push(`\n## ${s.sector || "Unknown"}`);
      parts.push(`Tickers: ${s.ticker_count} | Briefs: ${s.briefs_in_period} | Avg Sentiment: ${s.avg_sentiment ?? "N/A"}`);
      if (s.top_tickers?.length) {
        parts.push("Top tickers:");
        for (const t of s.top_tickers.slice(0, 5)) {
          parts.push(`  - ${t.ticker} (${t.entity_name}): ${t.briefs} briefs, sentiment=${t.avg_sentiment ?? "N/A"}`);
        }
      }
    }
    return text(parts.join("\n"));
  }
);

// ── AV Parity Tools ──

// 21. veroq_candles
server.tool(
  "veroq_candles",
  `Get OHLCV candlestick data for a stock ticker — open, high, low, close, and volume.

WHEN TO USE: For price chart analysis, pattern recognition, or feeding data into technical analysis. Use veroq_technicals for pre-computed indicators.
RETURNS: Array of candles with date, open, high, low, close, volume. Latest candle highlighted.
COST: 2 credits.
EXAMPLE: { "symbol": "AAPL", "interval": "1d", "range": "3mo" }`,
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, MSFT, GOOGL)"),
    interval: z.enum(["1d", "1wk", "1mo"]).optional().describe("Candle interval (default 1d)"),
    range: z.enum(["1mo", "3mo", "6mo", "1y", "2y", "5y"]).optional().describe("Date range (default 6mo)"),
  },
  async ({ symbol, interval, range }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(symbol.toUpperCase())}/candles`, {
      interval: interval || "1d",
      range: range || "6mo",
    })) as {
      status?: string;
      ticker?: string;
      interval?: string;
      range?: string;
      candles?: { date?: string; open?: number; high?: number; low?: number; close?: number; volume?: number }[];
      [key: string]: unknown;
    };
    const candles = data.candles || [];
    if (!candles.length) return text(`No candle data available for "${symbol}".`);
    const parts = [`# ${data.ticker || symbol.toUpperCase()} Candles (${data.interval}, ${data.range})`];
    parts.push(`Data points: ${candles.length}`);
    const latest = candles[candles.length - 1];
    if (latest) {
      parts.push(`\nLatest: ${latest.date} | O:${latest.open} H:${latest.high} L:${latest.low} C:${latest.close} V:${latest.volume?.toLocaleString()}`);
    }
    parts.push("\n## Recent Candles");
    parts.push("Date | Open | High | Low | Close | Volume");
    parts.push("--- | --- | --- | --- | --- | ---");
    for (const c of candles.slice(-10)) {
      parts.push(`${c.date} | ${c.open} | ${c.high} | ${c.low} | ${c.close} | ${c.volume?.toLocaleString()}`);
    }
    if (candles.length > 10) parts.push(`\n_Showing last 10 of ${candles.length} candles_`);
    return text(parts.join("\n"));
  }
);

// 22. veroq_technicals
server.tool(
  "veroq_technicals",
  `Get all major technical indicators for a ticker: RSI, MACD, Bollinger Bands, moving averages, and overall signal summary.

WHEN TO USE: For pre-computed technical analysis. Returns a bullish/bearish/neutral signal. Use veroq_candles for raw price data instead.
RETURNS: Signal summary (signal + bullish/bearish/neutral counts) and full indicator values (RSI, MACD, BBands, SMA, EMA).
COST: 2 credits.
EXAMPLE: { "symbol": "TSLA", "range": "6mo" }`,
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
    range: z.enum(["1mo", "3mo", "6mo", "1y", "2y", "5y"]).optional().describe("Date range for indicator calculation (default 6mo)"),
  },
  async ({ symbol, range }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(symbol.toUpperCase())}/technicals`, {
      range: range || "6mo",
    })) as {
      status?: string;
      ticker?: string;
      signal_summary?: { signal?: string; bullish?: number; bearish?: number; neutral?: number };
      indicators?: Record<string, unknown>;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(`Technical indicators not available for "${symbol}".`);
    const parts = [`# Technicals: ${data.ticker || symbol.toUpperCase()}`];
    if (data.signal_summary) {
      const s = data.signal_summary;
      parts.push(`\n**Overall Signal: ${(s.signal || "unknown").toUpperCase()}**`);
      parts.push(`Bullish: ${s.bullish} | Bearish: ${s.bearish} | Neutral: ${s.neutral}`);
    }
    if (data.indicators) {
      parts.push("\n## Indicators");
      parts.push(JSON.stringify(data.indicators, null, 2));
    }
    return text(parts.join("\n"));
  }
);

// 23. veroq_earnings
server.tool(
  "veroq_earnings",
  `Get next earnings date, EPS estimates, and revenue estimates for a stock ticker.

WHEN TO USE: To check when a company reports earnings and what the Street expects. Useful before earnings season.
RETURNS: Next earnings date, fiscal quarter, EPS estimate, and revenue estimate.
COST: 2 credits.
EXAMPLE: { "symbol": "NVDA" }`,
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, GOOGL)"),
  },
  async ({ symbol }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(symbol.toUpperCase())}/earnings`)) as {
      status?: string;
      ticker?: string;
      entity_name?: string;
      earnings_date?: string | null;
      eps_estimate?: number | null;
      revenue_estimate?: number | null;
      fiscal_quarter?: string | null;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(`Earnings data not available for "${symbol}".`);
    const parts = [`# Earnings: ${data.ticker || symbol.toUpperCase()}`];
    if (data.entity_name) parts.push(`Company: ${data.entity_name}`);
    parts.push(`Next Earnings Date: ${data.earnings_date || "Not available"}`);
    if (data.fiscal_quarter) parts.push(`Fiscal Quarter: ${data.fiscal_quarter}`);
    if (data.eps_estimate != null) parts.push(`EPS Estimate: $${data.eps_estimate}`);
    if (data.revenue_estimate != null) parts.push(`Revenue Estimate: $${data.revenue_estimate.toLocaleString()}`);
    return text(parts.join("\n"));
  }
);

// 24. veroq_market_movers
server.tool(
  "veroq_market_movers",
  `Get today's top market movers: biggest gainers, losers, and most actively traded stocks.

WHEN TO USE: For a quick snapshot of what's moving the market today. No parameters needed.
RETURNS: Top gainers (symbol, price, change%), top losers, and most active by volume.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = (await api("GET", "/api/v1/market/movers")) as {
      status?: string;
      gainers?: { symbol?: string; name?: string; price?: number; change_percent?: number }[];
      losers?: { symbol?: string; name?: string; price?: number; change_percent?: number }[];
      most_active?: { symbol?: string; name?: string; price?: number; volume?: number }[];
      fetched_at?: string;
      [key: string]: unknown;
    };
    const parts = ["# Market Movers"];
    if (data.gainers?.length) {
      parts.push("\n## Top Gainers");
      for (const g of data.gainers) {
        parts.push(`- **${g.symbol}** ${g.name || ""}: $${g.price} (+${g.change_percent?.toFixed(2)}%)`);
      }
    }
    if (data.losers?.length) {
      parts.push("\n## Top Losers");
      for (const l of data.losers) {
        parts.push(`- **${l.symbol}** ${l.name || ""}: $${l.price} (${l.change_percent?.toFixed(2)}%)`);
      }
    }
    if (data.most_active?.length) {
      parts.push("\n## Most Active");
      for (const a of data.most_active) {
        parts.push(`- **${a.symbol}** ${a.name || ""}: $${a.price} (vol: ${a.volume?.toLocaleString()})`);
      }
    }
    if (data.fetched_at) parts.push(`\n_As of: ${data.fetched_at}_`);
    return text(parts.join("\n"));
  }
);

// 25. veroq_market_summary
server.tool(
  "veroq_market_summary",
  `Get current values for major market indices: S&P 500, Nasdaq, Dow Jones, and VIX.

WHEN TO USE: For a quick check on how the overall market is doing. No parameters needed.
RETURNS: Each index with price, change, and change percent.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = (await api("GET", "/api/v1/market/summary")) as {
      status?: string;
      indices?: { symbol?: string; name?: string; price?: number; change?: number; change_percent?: number }[];
      fetched_at?: string;
      [key: string]: unknown;
    };
    const indices = data.indices || [];
    if (!indices.length) return text("Market summary not available.");
    const parts = ["# Market Summary"];
    for (const idx of indices) {
      const direction = (idx.change ?? 0) >= 0 ? "+" : "";
      parts.push(`- **${idx.name || idx.symbol}**: ${idx.price} (${direction}${idx.change} / ${direction}${idx.change_percent?.toFixed(2)}%)`);
    }
    if (data.fetched_at) parts.push(`\n_As of: ${data.fetched_at}_`);
    return text(parts.join("\n"));
  }
);

// 26. veroq_economy
server.tool(
  "veroq_economy",
  `Get macroeconomic indicators from FRED. No arguments returns a summary of all key indicators; pass a slug for detailed history.

WHEN TO USE: For macro data like GDP, CPI, unemployment, fed funds rate. Use veroq_economy_indicator for a single indicator with history.
RETURNS: Summary mode: all indicators with latest values. Detail mode: series info, latest value, and historical observations.
COST: 2 credits.
EXAMPLE: { "indicator": "cpi", "limit": 12 }`,
  {
    indicator: z.string().optional().describe("Specific indicator slug (e.g. gdp, cpi, unemployment, fed_funds, retail_sales). Omit for summary of all."),
    limit: z.number().optional().describe("Number of historical observations to return (default 30, max 100)"),
  },
  async ({ indicator, limit }) => {
    if (indicator) {
      const data = (await api("GET", `/api/v1/economy/${encodeURIComponent(indicator)}`, { limit })) as {
        status?: string;
        indicator?: string;
        name?: string;
        series_id?: string;
        frequency?: string;
        units?: string;
        latest?: { date?: string; value?: number };
        observation_count?: number;
        observations?: { date?: string; value?: number }[];
        fetched_at?: string;
        [key: string]: unknown;
      };
      if (data.status === "error") return text(`Economic indicator "${indicator}" not found.`);
      const parts = [`# ${data.name || indicator}`];
      if (data.series_id) parts.push(`Series: ${data.series_id}`);
      if (data.frequency) parts.push(`Frequency: ${data.frequency}`);
      if (data.units) parts.push(`Units: ${data.units}`);
      if (data.latest) parts.push(`\n**Latest:** ${data.latest.value} (${data.latest.date})`);
      if (data.observations?.length) {
        parts.push("\n## Recent Observations");
        for (const o of data.observations.slice(0, 10)) {
          parts.push(`- ${o.date}: ${o.value}`);
        }
        if (data.observations.length > 10) parts.push(`_Showing 10 of ${data.observations.length} observations_`);
      }
      return text(parts.join("\n"));
    } else {
      const data = (await api("GET", "/api/v1/economy")) as {
        status?: string;
        indicator_count?: number;
        indicators?: { slug?: string; name?: string; latest_value?: number | null; latest_date?: string; units?: string; frequency?: string }[];
        fetched_at?: string;
        [key: string]: unknown;
      };
      const indicators = data.indicators || [];
      if (!indicators.length) return text("No economic indicators available.");
      const parts = [`# Economic Indicators Summary (${data.indicator_count || indicators.length} indicators)`];
      for (const i of indicators) {
        parts.push(`- **${i.name || i.slug}**: ${i.latest_value ?? "N/A"}${i.units ? ` ${i.units}` : ""} (${i.latest_date || "N/A"})`);
      }
      if (data.fetched_at) parts.push(`\n_As of: ${data.fetched_at}_`);
      return text(parts.join("\n"));
    }
  }
);

// 27. veroq_forex
server.tool(
  "veroq_forex",
  `Get current foreign exchange rates. No arguments returns all major pairs; pass a pair code for a single rate.

WHEN TO USE: For currency exchange rates and FX market data.
RETURNS: Rate, change, change percent per pair. Single pair mode includes label and timestamp.
COST: 2 credits.
EXAMPLE: { "pair": "EURUSD" }`,
  {
    pair: z.string().optional().describe("Forex pair (e.g. EURUSD, GBPUSD, USDJPY). Omit for all major pairs."),
  },
  async ({ pair }) => {
    if (pair) {
      const data = (await api("GET", `/api/v1/forex/${encodeURIComponent(pair.toUpperCase())}`)) as {
        status?: string;
        pair?: string;
        label?: string;
        rate?: number;
        change?: number;
        change_percent?: number;
        fetched_at?: string;
        message?: string;
        [key: string]: unknown;
      };
      if (data.status === "error") return text(data.message || `Forex pair "${pair}" not found.`);
      const parts = [`**${data.pair || pair.toUpperCase()}** (${data.label || ""})`];
      parts.push(`Rate: ${data.rate}`);
      if (data.change != null) parts.push(`Change: ${data.change >= 0 ? "+" : ""}${data.change} (${data.change_percent != null ? `${data.change_percent >= 0 ? "+" : ""}${data.change_percent.toFixed(2)}%` : ""})`);
      if (data.fetched_at) parts.push(`As of: ${data.fetched_at}`);
      return text(parts.join("\n"));
    } else {
      const data = (await api("GET", "/api/v1/forex")) as {
        status?: string;
        pairs?: { pair?: string; label?: string; rate?: number; change?: number; change_percent?: number }[];
        fetched_at?: string;
        [key: string]: unknown;
      };
      const pairs = data.pairs || [];
      if (!pairs.length) return text("No forex data available.");
      const parts = ["# Forex Rates"];
      for (const p of pairs) {
        const dir = (p.change ?? 0) >= 0 ? "+" : "";
        parts.push(`- **${p.pair}** (${p.label}): ${p.rate} (${dir}${p.change_percent?.toFixed(2)}%)`);
      }
      if (data.fetched_at) parts.push(`\n_As of: ${data.fetched_at}_`);
      return text(parts.join("\n"));
    }
  }
);

// 28. veroq_commodities
server.tool(
  "veroq_commodities",
  `Get commodity prices (gold, silver, oil, natural gas, etc.). No arguments returns all; pass a slug for one commodity.

WHEN TO USE: For commodity market data. Covers precious metals, energy, and industrial commodities.
RETURNS: Price, change, change percent, and unit per commodity.
COST: 2 credits.
EXAMPLE: { "symbol": "gold" }`,
  {
    symbol: z.string().optional().describe("Commodity slug (e.g. gold, silver, crude, natural_gas, copper, platinum). Omit for all."),
  },
  async ({ symbol }) => {
    if (symbol) {
      const data = (await api("GET", `/api/v1/commodities/${encodeURIComponent(symbol.toLowerCase())}`)) as {
        status?: string;
        symbol?: string;
        name?: string;
        price?: number;
        change?: number;
        change_percent?: number;
        unit?: string;
        message?: string;
        [key: string]: unknown;
      };
      if (data.status === "error") return text(data.message || `Commodity "${symbol}" not found.`);
      const parts = [`**${data.name || symbol}** (${data.symbol || symbol})`];
      parts.push(`Price: $${data.price}${data.unit ? ` per ${data.unit}` : ""}`);
      if (data.change != null) parts.push(`Change: ${data.change >= 0 ? "+" : ""}${data.change} (${data.change_percent != null ? `${data.change_percent >= 0 ? "+" : ""}${data.change_percent.toFixed(2)}%` : ""})`);
      return text(parts.join("\n"));
    } else {
      const data = (await api("GET", "/api/v1/commodities")) as {
        status?: string;
        commodities?: { symbol?: string; name?: string; price?: number; change?: number; change_percent?: number; unit?: string }[];
        fetched_at?: string;
        [key: string]: unknown;
      };
      const commodities = data.commodities || [];
      if (!commodities.length) return text("No commodity data available.");
      const parts = ["# Commodity Prices"];
      for (const c of commodities) {
        const dir = (c.change ?? 0) >= 0 ? "+" : "";
        parts.push(`- **${c.name || c.symbol}**: $${c.price}${c.unit ? `/${c.unit}` : ""} (${dir}${c.change_percent?.toFixed(2)}%)`);
      }
      if (data.fetched_at) parts.push(`\n_As of: ${data.fetched_at}_`);
      return text(parts.join("\n"));
    }
  }
);

// ── Crypto Tools ──

// 29. veroq_crypto
server.tool(
  "veroq_crypto",
  `Get cryptocurrency data. No arguments returns market overview; pass a symbol for detailed token data.

WHEN TO USE: For crypto market cap overview or individual token data (price, supply, ATH). Use veroq_crypto_chart for price history.
RETURNS: Overview: total market cap, BTC dominance, 24h volume. Token: price, 24h/7d change, market cap, supply, ATH.
COST: 2 credits.
EXAMPLE: { "symbol": "ETH" }`,
  {
    symbol: z.string().optional().describe("Crypto symbol (e.g. BTC, ETH, SOL, ADA). Omit for market overview."),
  },
  async ({ symbol }) => {
    if (symbol) {
      const data = (await api("GET", `/api/v1/crypto/${encodeURIComponent(symbol.toUpperCase())}`)) as {
        status?: string;
        symbol?: string;
        name?: string;
        price?: number;
        market_cap?: number;
        volume_24h?: number;
        change_24h?: number;
        change_7d?: number;
        ath?: number;
        ath_date?: string;
        circulating_supply?: number;
        total_supply?: number;
        message?: string;
        [key: string]: unknown;
      };
      if (data.status === "error") return text(data.message || `Crypto token "${symbol}" not found.`);
      const parts = [`# ${data.name || symbol.toUpperCase()} (${data.symbol || symbol.toUpperCase()})`];
      if (data.price != null) parts.push(`Price: $${data.price}`);
      if (data.change_24h != null) parts.push(`24h Change: ${data.change_24h >= 0 ? "+" : ""}${data.change_24h.toFixed(2)}%`);
      if (data.change_7d != null) parts.push(`7d Change: ${data.change_7d >= 0 ? "+" : ""}${data.change_7d.toFixed(2)}%`);
      if (data.market_cap) parts.push(`Market Cap: $${(data.market_cap / 1e9).toFixed(2)}B`);
      if (data.volume_24h) parts.push(`24h Volume: $${(data.volume_24h / 1e9).toFixed(2)}B`);
      if (data.ath) parts.push(`ATH: $${data.ath}${data.ath_date ? ` (${data.ath_date})` : ""}`);
      if (data.circulating_supply) parts.push(`Circulating Supply: ${data.circulating_supply.toLocaleString()}`);
      if (data.total_supply) parts.push(`Total Supply: ${data.total_supply.toLocaleString()}`);
      return text(parts.join("\n"));
    } else {
      const data = (await api("GET", "/api/v1/crypto")) as {
        status?: string;
        total_market_cap?: number;
        btc_dominance?: number;
        total_volume_24h?: number;
        active_cryptocurrencies?: number;
        market_cap_change_24h?: number;
        [key: string]: unknown;
      };
      const parts = ["# Crypto Market Overview"];
      if (data.total_market_cap) parts.push(`Total Market Cap: $${(data.total_market_cap / 1e12).toFixed(2)}T`);
      if (data.btc_dominance != null) parts.push(`BTC Dominance: ${data.btc_dominance.toFixed(1)}%`);
      if (data.total_volume_24h) parts.push(`24h Volume: $${(data.total_volume_24h / 1e9).toFixed(2)}B`);
      if (data.market_cap_change_24h != null) parts.push(`24h Market Cap Change: ${data.market_cap_change_24h >= 0 ? "+" : ""}${data.market_cap_change_24h.toFixed(2)}%`);
      if (data.active_cryptocurrencies) parts.push(`Active Cryptocurrencies: ${data.active_cryptocurrencies.toLocaleString()}`);
      return text(parts.join("\n"));
    }
  }
);

// 30. veroq_crypto_chart
server.tool(
  "veroq_crypto_chart",
  `Get historical price chart data for a crypto token — timestamped prices for trend analysis.

WHEN TO USE: For crypto price history and charting. Use veroq_crypto for current snapshot, this for historical trend.
RETURNS: Sampled price history with timestamp, price, volume, and market cap per data point. Includes period change %.
COST: 2 credits.
EXAMPLE: { "symbol": "BTC", "days": 90 }
CONSTRAINTS: Max 365 days of history.`,
  {
    symbol: z.string().describe("Crypto symbol (e.g. BTC, ETH, SOL)"),
    days: z.number().optional().describe("Number of days of history (default 30, max 365)"),
  },
  async ({ symbol, days }) => {
    const data = (await api("GET", `/api/v1/crypto/${encodeURIComponent(symbol.toUpperCase())}/chart`, {
      days: days || 30,
    })) as {
      status?: string;
      symbol?: string;
      coin_id?: string;
      days?: number;
      data_points?: number;
      chart?: { timestamp?: string; price?: number; volume?: number; market_cap?: number }[];
      message?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(data.message || `Chart not available for "${symbol}".`);
    const chart = data.chart || [];
    if (!chart.length) return text(`No chart data available for "${symbol}".`);
    const parts = [`# ${data.symbol || symbol.toUpperCase()} Price Chart (${data.days || 30} days)`];
    parts.push(`Data points: ${data.data_points || chart.length}`);
    const first = chart[0];
    const last = chart[chart.length - 1];
    if (first && last) {
      const change = ((last.price || 0) - (first.price || 0)) / (first.price || 1) * 100;
      parts.push(`Period: $${first.price?.toFixed(2)} → $${last.price?.toFixed(2)} (${change >= 0 ? "+" : ""}${change.toFixed(2)}%)`);
    }
    const step = Math.max(1, Math.floor(chart.length / 15));
    parts.push("\n## Price History (sampled)");
    parts.push("Date | Price | Volume");
    parts.push("--- | --- | ---");
    for (let i = 0; i < chart.length; i += step) {
      const c = chart[i];
      parts.push(`${c.timestamp} | $${c.price?.toFixed(2)} | ${c.volume ? `$${(c.volume / 1e6).toFixed(1)}M` : "N/A"}`);
    }
    if ((chart.length - 1) % step !== 0 && last) {
      parts.push(`${last.timestamp} | $${last.price?.toFixed(2)} | ${last.volume ? `$${(last.volume / 1e6).toFixed(1)}M` : "N/A"}`);
    }
    return text(parts.join("\n"));
  }
);

// 31. veroq_defi
server.tool(
  "veroq_defi",
  `Get DeFi data. No arguments returns TVL overview with top protocols and chain breakdown; pass a slug for one protocol.

WHEN TO USE: For DeFi TVL data across protocols and chains. Use veroq_defi_protocol for a single protocol deep dive.
RETURNS: Overview: total TVL, top protocols, chain TVL. Protocol: TVL, 1d/7d/30d changes, category, chains.
COST: 2 credits.
EXAMPLE: { "protocol": "aave" }`,
  {
    protocol: z.string().optional().describe("Protocol slug (e.g. aave, uniswap, lido, makerdao). Omit for DeFi overview."),
  },
  async ({ protocol }) => {
    if (protocol) {
      const data = (await api("GET", `/api/v1/crypto/defi/${encodeURIComponent(protocol.toLowerCase())}`)) as {
        status?: string;
        name?: string;
        slug?: string;
        tvl?: number;
        chains?: string[];
        change_1d?: number;
        change_7d?: number;
        change_30d?: number;
        category?: string;
        message?: string;
        [key: string]: unknown;
      };
      if (data.status === "error") return text(data.message || `Protocol "${protocol}" not found.`);
      const parts = [`# ${data.name || protocol}`];
      if (data.tvl) parts.push(`TVL: $${(data.tvl / 1e9).toFixed(2)}B`);
      if (data.change_1d != null) parts.push(`1d Change: ${data.change_1d >= 0 ? "+" : ""}${data.change_1d.toFixed(2)}%`);
      if (data.change_7d != null) parts.push(`7d Change: ${data.change_7d >= 0 ? "+" : ""}${data.change_7d.toFixed(2)}%`);
      if (data.change_30d != null) parts.push(`30d Change: ${data.change_30d >= 0 ? "+" : ""}${data.change_30d.toFixed(2)}%`);
      if (data.category) parts.push(`Category: ${data.category}`);
      if (data.chains?.length) parts.push(`Chains: ${data.chains.join(", ")}`);
      return text(parts.join("\n"));
    } else {
      const data = (await api("GET", "/api/v1/crypto/defi")) as {
        status?: string;
        total_tvl?: number;
        top_protocols?: { name?: string; slug?: string; tvl?: number; change_1d?: number }[];
        chain_tvl?: { chain?: string; tvl?: number }[];
        fetched_at?: string;
        [key: string]: unknown;
      };
      const parts = ["# DeFi Overview"];
      if (data.total_tvl) parts.push(`Total TVL: $${(data.total_tvl / 1e9).toFixed(2)}B`);
      if (data.top_protocols?.length) {
        parts.push("\n## Top Protocols");
        for (const p of data.top_protocols) {
          parts.push(`- **${p.name}**: $${((p.tvl || 0) / 1e9).toFixed(2)}B${p.change_1d != null ? ` (${p.change_1d >= 0 ? "+" : ""}${p.change_1d.toFixed(2)}% 1d)` : ""}`);
        }
      }
      if (data.chain_tvl?.length) {
        parts.push("\n## Chain TVL");
        for (const c of data.chain_tvl) {
          parts.push(`- **${c.chain}**: $${((c.tvl || 0) / 1e9).toFixed(2)}B`);
        }
      }
      if (data.fetched_at) parts.push(`\n_As of: ${data.fetched_at}_`);
      return text(parts.join("\n"));
    }
  }
);

// ── Screener & Alerts Tools ──

// 32. veroq_screener
server.tool(
  "veroq_screener",
  `Screen stocks or crypto by combining technical indicators, sentiment, and fundamental filters.

WHEN TO USE: To find assets matching specific criteria (e.g. oversold tech stocks, high-volume bearish crypto). Use veroq_screener_presets for pre-built strategies.
RETURNS: Matching assets with symbol, price, change%, RSI, MACD signal, sentiment, and volume.
COST: 5 credits.
EXAMPLE: { "sector": "Technology", "rsi_below": 30, "sentiment": "bearish", "limit": 10 }`,
  {
    asset_type: z.string().optional().describe("Asset type to screen (e.g. stock, crypto)"),
    sector: z.string().optional().describe("Sector filter (e.g. Technology, Healthcare, Energy)"),
    rsi_below: z.number().optional().describe("RSI upper bound (e.g. 30 for oversold)"),
    rsi_above: z.number().optional().describe("RSI lower bound (e.g. 70 for overbought)"),
    sentiment: z.string().optional().describe("Sentiment filter (e.g. bullish, bearish, neutral)"),
    macd_signal: z.string().optional().describe("MACD signal filter: buy or sell"),
    earnings_within_days: z.number().optional().describe("Only assets with earnings within N days"),
    price_min: z.number().optional().describe("Minimum price filter"),
    price_max: z.number().optional().describe("Maximum price filter"),
    min_volume: z.number().optional().describe("Minimum average daily volume"),
    sort: z.string().optional().describe("Sort field (e.g. rsi, sentiment, market_cap, volume)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ asset_type, sector, rsi_below, rsi_above, sentiment, macd_signal, earnings_within_days, price_min, price_max, min_volume, sort, limit }) => {
    const filters: Record<string, unknown> = {};
    if (rsi_below != null) filters.rsi_below = rsi_below;
    if (rsi_above != null) filters.rsi_above = rsi_above;
    if (sentiment) filters.sentiment = sentiment;
    if (macd_signal) filters.macd_signal = macd_signal;
    if (earnings_within_days != null) filters.earnings_within_days = earnings_within_days;
    if (price_min != null) filters.price_min = price_min;
    if (price_max != null) filters.price_max = price_max;
    if (min_volume != null) filters.min_volume = min_volume;

    const data = (await api("POST", "/api/v1/screener", undefined, {
      asset_type, sector, filters, sort, limit,
    })) as {
      status?: string;
      total?: number;
      results?: {
        symbol?: string;
        name?: string;
        sector?: string;
        price?: number;
        change_percent?: number;
        rsi?: number | null;
        macd_signal?: string | null;
        sentiment?: string | null;
        sentiment_score?: number | null;
        volume?: number;
        market_cap?: number;
        earnings_date?: string | null;
        [key: string]: unknown;
      }[];
      [key: string]: unknown;
    };
    const results = data.results || [];
    if (!results.length) return text("No assets match the given criteria.");
    const parts = [`# Screener Results (${data.total ?? results.length} matches)`];
    parts.push("\nSymbol | Name | Price | Chg% | RSI | MACD | Sentiment | Volume");
    parts.push("--- | --- | --- | --- | --- | --- | --- | ---");
    for (const r of results) {
      parts.push(
        `${r.symbol || "—"} | ${r.name || "—"} | $${r.price ?? "—"} | ${r.change_percent != null ? `${r.change_percent >= 0 ? "+" : ""}${r.change_percent.toFixed(2)}%` : "—"} | ${r.rsi ?? "—"} | ${r.macd_signal || "—"} | ${r.sentiment || "—"} | ${r.volume ? r.volume.toLocaleString() : "—"}`
      );
    }
    return text(parts.join("\n"));
  }
);

// 33. veroq_screener_presets
server.tool(
  "veroq_screener_presets",
  `List pre-built screening strategies or run a specific preset by ID.

WHEN TO USE: For quick screening without building filters manually. Omit preset_id to list all 12 presets; pass one to run it.
RETURNS: List mode: preset names, descriptions, and filters. Run mode: matching assets with price, RSI, sentiment, volume.
COST: 1 credit.
EXAMPLE: { "preset_id": "oversold_tech" }`,
  {
    preset_id: z.string().optional().describe("Preset ID to run. Omit to list all available presets."),
  },
  async ({ preset_id }) => {
    if (preset_id) {
      const data = (await api("GET", `/api/v1/screener/presets/${encodeURIComponent(preset_id)}`)) as {
        status?: string;
        preset?: { id?: string; name?: string; description?: string };
        total?: number;
        results?: {
          symbol?: string;
          name?: string;
          sector?: string;
          price?: number;
          change_percent?: number;
          rsi?: number | null;
          macd_signal?: string | null;
          sentiment?: string | null;
          volume?: number;
          [key: string]: unknown;
        }[];
        [key: string]: unknown;
      };
      if (data.status === "error") return text(`Preset "${preset_id}" not found.`);
      const parts = [`# Preset: ${data.preset?.name || preset_id}`];
      if (data.preset?.description) parts.push(data.preset.description);
      parts.push(`\nResults: ${data.total ?? (data.results || []).length}`);
      const results = data.results || [];
      if (results.length) {
        parts.push("\nSymbol | Name | Price | Chg% | RSI | Sentiment | Volume");
        parts.push("--- | --- | --- | --- | --- | --- | ---");
        for (const r of results) {
          parts.push(
            `${r.symbol || "—"} | ${r.name || "—"} | $${r.price ?? "—"} | ${r.change_percent != null ? `${r.change_percent >= 0 ? "+" : ""}${r.change_percent.toFixed(2)}%` : "—"} | ${r.rsi ?? "—"} | ${r.sentiment || "—"} | ${r.volume ? r.volume.toLocaleString() : "—"}`
          );
        }
      }
      return text(parts.join("\n"));
    } else {
      const data = (await api("GET", "/api/v1/screener/presets")) as {
        status?: string;
        presets?: { id?: string; name?: string; description?: string; asset_type?: string; filters_summary?: string }[];
        [key: string]: unknown;
      };
      const presets = data.presets || [];
      if (!presets.length) return text("No screener presets available.");
      const parts = [`# Screener Presets (${presets.length} available)`];
      for (const p of presets) {
        parts.push(`\n**${p.name || p.id}** (ID: ${p.id})`);
        if (p.description) parts.push(p.description);
        if (p.asset_type) parts.push(`Asset type: ${p.asset_type}`);
        if (p.filters_summary) parts.push(`Filters: ${p.filters_summary}`);
      }
      return text(parts.join("\n"));
    }
  }
);

// 34. veroq_alerts
server.tool(
  "veroq_alerts",
  `Create, list, or check triggered price/sentiment alerts.

WHEN TO USE: To set up automated monitoring. Actions: "create" a new alert, "list" existing alerts, or view "triggered" alerts.
RETURNS: Create: alert ID and details. List: all alerts with status. Triggered: fired alerts with current values.
COST: 3 credits.
EXAMPLE: { "action": "create", "ticker": "AAPL", "alert_type": "price_below", "threshold": 150 }
CONSTRAINTS: 6 alert types: price_above, price_below, rsi_above, rsi_below, sentiment_flip, volume_spike.`,
  {
    action: z.string().describe('Action to perform: "create", "list", or "triggered"'),
    ticker: z.string().optional().describe("Ticker symbol (required for create)"),
    alert_type: z.string().optional().describe("Alert type: price_above, price_below, rsi_above, rsi_below, sentiment_flip, volume_spike (required for create)"),
    threshold: z.number().optional().describe("Alert threshold value (required for create — price level or sentiment delta)"),
  },
  async ({ action, ticker, alert_type, threshold }) => {
    if (action === "create") {
      if (!ticker || !alert_type) return text('Error: ticker and alert_type are required to create an alert.');
      const data = (await api("POST", "/api/v1/alerts", undefined, {
        ticker, alert_type, threshold,
      })) as {
        status?: string;
        alert?: { id?: string; ticker?: string; alert_type?: string; threshold?: number; created_at?: string };
        message?: string;
        [key: string]: unknown;
      };
      if (data.status === "error") return text(data.message || "Failed to create alert.");
      const a = data.alert;
      return text(
        `Alert created successfully.\n\n**ID:** ${a?.id}\n**Ticker:** ${a?.ticker}\n**Type:** ${a?.alert_type}\n**Threshold:** ${a?.threshold}\n**Created:** ${a?.created_at}`
      );
    } else if (action === "list") {
      const data = (await api("GET", "/api/v1/alerts", {
        ...(ticker ? { ticker } : {}),
      })) as {
        status?: string;
        total?: number;
        alerts?: { id?: string; ticker?: string; alert_type?: string; threshold?: number; status?: string; created_at?: string }[];
        [key: string]: unknown;
      };
      const alerts = data.alerts || [];
      if (!alerts.length) return text("No alerts configured.");
      const parts = [`# Your Alerts (${data.total ?? alerts.length})`];
      parts.push("\nID | Ticker | Type | Threshold | Status");
      parts.push("--- | --- | --- | --- | ---");
      for (const a of alerts) {
        parts.push(`${a.id || "—"} | ${a.ticker || "—"} | ${a.alert_type || "—"} | ${a.threshold ?? "—"} | ${a.status || "—"}`);
      }
      return text(parts.join("\n"));
    } else if (action === "triggered") {
      const data = (await api("GET", "/api/v1/alerts/triggered", {
        ...(ticker ? { ticker } : {}),
      })) as {
        status?: string;
        total?: number;
        alerts?: { id?: string; ticker?: string; alert_type?: string; threshold?: number; triggered_at?: string; current_value?: number }[];
        [key: string]: unknown;
      };
      const alerts = data.alerts || [];
      if (!alerts.length) return text("No triggered alerts.");
      const parts = [`# Triggered Alerts (${data.total ?? alerts.length})`];
      parts.push("\nTicker | Type | Threshold | Current Value | Triggered At");
      parts.push("--- | --- | --- | --- | ---");
      for (const a of alerts) {
        parts.push(`${a.ticker || "—"} | ${a.alert_type || "—"} | ${a.threshold ?? "—"} | ${a.current_value ?? "—"} | ${a.triggered_at || "—"}`);
      }
      return text(parts.join("\n"));
    } else {
      return text('Invalid action. Use "create", "list", or "triggered".');
    }
  }
);

// ── Social & Discovery Tools ──

// 35. veroq_social_sentiment
server.tool(
  "veroq_social_sentiment",
  `Get social media sentiment for a stock or crypto ticker from Reddit, Twitter/X, and other platforms.

WHEN TO USE: To gauge retail investor sentiment and social buzz around a specific ticker.
RETURNS: Overall sentiment score, mention count, per-platform breakdown, trending topics, and top posts with URLs.
COST: 30 credits.
EXAMPLE: { "symbol": "TSLA" }`,
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, TSLA, BTC)"),
  },
  async ({ symbol }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(symbol.toUpperCase())}/social`)) as {
      status?: string;
      ticker?: string;
      entity_name?: string;
      social?: {
        overall_sentiment?: number;
        mention_count?: number;
        platforms?: { platform?: string; mentions?: number; sentiment?: number }[];
        trending_topics?: string[];
        top_posts?: { title?: string; score?: number; url?: string; platform?: string }[];
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    if (data.status === "error") return text(`Social sentiment not available for "${symbol}".`);
    const s = data.social;
    const parts = [`# Social Sentiment: ${data.ticker || symbol.toUpperCase()}`];
    if (data.entity_name) parts.push(`Company: ${data.entity_name}`);
    if (s?.overall_sentiment != null) parts.push(`Overall Sentiment: ${s.overall_sentiment}`);
    if (s?.mention_count != null) parts.push(`Total Mentions: ${s.mention_count}`);
    if (s?.platforms?.length) {
      parts.push("\n## Platforms");
      for (const p of s.platforms) {
        parts.push(`- **${p.platform}**: ${p.mentions} mentions, sentiment=${p.sentiment}`);
      }
    }
    if (s?.trending_topics?.length) {
      parts.push("\n## Trending Topics");
      parts.push(s.trending_topics.map((t) => `- ${t}`).join("\n"));
    }
    if (s?.top_posts?.length) {
      parts.push("\n## Top Posts");
      for (const p of s.top_posts) {
        parts.push(`- **${p.title}** (score: ${p.score}, ${p.platform})${p.url ? ` — ${p.url}` : ""}`);
      }
    }
    return text(parts.join("\n"));
  }
);

// 36. veroq_social_trending
server.tool(
  "veroq_social_trending",
  `Get tickers and topics currently trending on social media across Reddit, Twitter/X, and other platforms.

WHEN TO USE: To discover what retail investors are buzzing about right now. No parameters needed.
RETURNS: Trending symbols with name, mention count, sentiment score, and 1-hour change in mentions.
COST: 20 credits.
EXAMPLE: {}`,
  {},
  async () => {
    const data = (await api("GET", "/api/v1/social/trending")) as {
      status?: string;
      trending?: {
        symbol?: string;
        name?: string;
        mentions?: number;
        sentiment?: number;
        change_1h?: number;
        [key: string]: unknown;
      }[];
      fetched_at?: string;
      [key: string]: unknown;
    };
    const trending = data.trending || [];
    if (!trending.length) return text("No trending social data available.");
    const parts = ["# Social Media Trending"];
    parts.push("\nSymbol | Name | Mentions | Sentiment | 1h Change");
    parts.push("--- | --- | --- | --- | ---");
    for (const t of trending) {
      parts.push(
        `${t.symbol || "—"} | ${t.name || "—"} | ${t.mentions ?? "—"} | ${t.sentiment ?? "—"} | ${t.change_1h != null ? `${t.change_1h >= 0 ? "+" : ""}${t.change_1h}%` : "—"}`
      );
    }
    if (data.fetched_at) parts.push(`\n_As of: ${data.fetched_at}_`);
    return text(parts.join("\n"));
  }
);

// 37. veroq_ipo_calendar
server.tool(
  "veroq_ipo_calendar",
  `Get upcoming and recent IPOs from SEC EDGAR S-1 filings.

WHEN TO USE: To track the IPO pipeline and recent public offerings.
RETURNS: IPO filings with company name, ticker (if assigned), filing date, form type, and location.
COST: 2 credits.
EXAMPLE: { "days": 30, "limit": 20 }
CONSTRAINTS: Max 90 days lookback, max 100 results.`,
  {
    days: z.number().optional().describe("Lookback/forward window in days (default 30, max 90)"),
    limit: z.number().optional().describe("Max results (default 30, max 100)"),
  },
  async ({ days, limit }) => {
    const data = (await api("GET", "/api/v1/market/ipos", {
      days,
      limit,
    })) as {
      status?: string;
      source?: string;
      days?: number;
      total_filings?: number;
      ipos_shown?: number;
      ipos?: {
        company?: string;
        symbol?: string | null;
        filing_date?: string | null;
        form?: string;
        location?: string | null;
        source?: string;
      }[];
      [key: string]: unknown;
    };
    const ipos = data.ipos || [];
    if (!ipos.length) return text("No IPO filings found for the given period.");
    const parts = [`# IPO Calendar (${data.days || 30} days)`];
    parts.push(`Source: ${data.source || "SEC EDGAR"} | Total filings: ${data.total_filings ?? "N/A"} | Showing: ${data.ipos_shown ?? ipos.length}`);
    parts.push("\nCompany | Symbol | Filing Date | Form | Location");
    parts.push("--- | --- | --- | --- | ---");
    for (const ipo of ipos) {
      parts.push(
        `${ipo.company || "—"} | ${ipo.symbol || "—"} | ${ipo.filing_date || "—"} | ${ipo.form || "—"} | ${ipo.location || "—"}`
      );
    }
    return text(parts.join("\n"));
  }
);

// 38. veroq_ticker_news
server.tool(
  "veroq_ticker_news",
  `Get recent news headlines and briefs for a specific stock or crypto ticker.

WHEN TO USE: For ticker-specific news. Use veroq_search for topic-based search, or veroq_feed for general news.
RETURNS: Array of briefs with headline, confidence, category, and summary. Includes total brief count.
COST: 1 credit.
EXAMPLE: { "symbol": "AAPL", "limit": 5 }`,
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, BTC)"),
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async ({ symbol, limit }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(symbol.toUpperCase())}/news`, {
      limit,
    })) as {
      status?: string;
      ticker?: string;
      entity_name?: string;
      briefs?: Brief[];
      total?: number;
      [key: string]: unknown;
    };
    const briefs = data.briefs || [];
    if (!briefs.length) return text(`No recent news found for "${symbol}".`);
    const parts = [`# News: ${data.ticker || symbol.toUpperCase()}${data.entity_name ? ` (${data.entity_name})` : ""}`];
    if (data.total != null) parts.push(`Total: ${data.total} briefs`);
    parts.push("");
    parts.push(briefs.map(formatBriefShort).join("\n\n---\n\n"));
    return text(parts.join("\n"));
  }
);

// 39. veroq_ticker_analysis
server.tool(
  "veroq_ticker_analysis",
  `Get a comprehensive analysis for a ticker combining news sentiment, technicals, events, and overall outlook.

WHEN TO USE: For a detailed single-ticker analysis with outlook, catalysts, and risks. Use veroq_full for raw data, this for interpreted analysis.
RETURNS: Outlook (bullish/bearish/neutral), summary, sentiment score, key factors, catalysts, risks, technicals, and recent coverage.
COST: 2 credits.
EXAMPLE: { "symbol": "NVDA" }`,
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  async ({ symbol }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(symbol.toUpperCase())}/analysis`)) as {
      status?: string;
      ticker?: string;
      entity_name?: string;
      sector?: string;
      analysis?: {
        outlook?: string;
        summary?: string;
        sentiment_score?: number;
        key_factors?: string[];
        risks?: string[];
        catalysts?: string[];
        [key: string]: unknown;
      };
      technicals?: Record<string, unknown>;
      recent_briefs?: Brief[];
      [key: string]: unknown;
    };
    if (data.status === "error") return text(`Analysis not available for "${symbol}".`);
    const a = data.analysis;
    const parts = [`# Analysis: ${data.ticker || symbol.toUpperCase()}`];
    if (data.entity_name) parts.push(`Company: ${data.entity_name}`);
    if (data.sector) parts.push(`Sector: ${data.sector}`);
    if (a?.outlook) parts.push(`\n**Outlook: ${a.outlook.toUpperCase()}**`);
    if (a?.sentiment_score != null) parts.push(`Sentiment Score: ${a.sentiment_score}`);
    if (a?.summary) parts.push(`\n## Summary\n${a.summary}`);
    if (a?.key_factors?.length) {
      parts.push("\n## Key Factors");
      parts.push(a.key_factors.map((f) => `- ${f}`).join("\n"));
    }
    if (a?.catalysts?.length) {
      parts.push("\n## Catalysts");
      parts.push(a.catalysts.map((c) => `- ${c}`).join("\n"));
    }
    if (a?.risks?.length) {
      parts.push("\n## Risks");
      parts.push(a.risks.map((r) => `- ${r}`).join("\n"));
    }
    if (data.technicals) {
      parts.push("\n## Technical Indicators");
      parts.push(JSON.stringify(data.technicals, null, 2));
    }
    if (data.recent_briefs?.length) {
      parts.push("\n## Recent Coverage");
      parts.push(data.recent_briefs.map(formatBriefShort).join("\n\n"));
    }
    return text(parts.join("\n"));
  }
);

// 40. veroq_search_suggest
server.tool(
  "veroq_search_suggest",
  `Get search autocomplete suggestions — matching headlines and entities for a partial query.

WHEN TO USE: To find the right search terms before running veroq_search. Helps discover entities and headlines.
RETURNS: Headline suggestions (with category and brief ID) and entity suggestions (with type and mention count).
COST: 1 credit.
EXAMPLE: { "query": "fed rate" }
CONSTRAINTS: Minimum 2 characters.`,
  {
    query: z.string().describe("Partial search query (minimum 2 characters)"),
  },
  async ({ query }) => {
    const data = (await api("GET", "/api/v1/search/suggest", {
      q: query,
    })) as {
      suggestions?: {
        type?: string;
        text?: string;
        brief_id?: string;
        category?: string;
        entity_type?: string;
        mention_count?: number;
      }[];
      [key: string]: unknown;
    };
    const suggestions = data.suggestions || [];
    if (!suggestions.length) return text(`No suggestions for "${query}".`);
    const parts = [`# Search Suggestions for "${query}"`];
    const headlines = suggestions.filter((s) => s.type === "headline");
    const entities = suggestions.filter((s) => s.type === "entity");
    if (headlines.length) {
      parts.push("\n## Headlines");
      for (const h of headlines) {
        parts.push(`- ${h.text}${h.category ? ` (${h.category})` : ""}${h.brief_id ? ` [${h.brief_id}]` : ""}`);
      }
    }
    if (entities.length) {
      parts.push("\n## Entities");
      for (const e of entities) {
        parts.push(`- **${e.text}** (${e.entity_type || "unknown"}) — ${e.mention_count} mentions`);
      }
    }
    return text(parts.join("\n"));
  }
);

// 41. veroq_defi_protocol
server.tool(
  "veroq_defi_protocol",
  `Get detailed DeFi protocol data including TVL, chain deployment, and performance changes.

WHEN TO USE: For a deep dive into a single DeFi protocol. Use veroq_defi (no args) for the full DeFi market overview.
RETURNS: Protocol TVL, 1d/7d/30d change percentages, category, and deployed chains.
COST: 2 credits.
EXAMPLE: { "protocol": "uniswap" }`,
  {
    protocol: z.string().describe("Protocol slug (e.g. aave, uniswap, lido, makerdao, curve)"),
  },
  async ({ protocol }) => {
    const data = (await api("GET", `/api/v1/crypto/defi/${encodeURIComponent(protocol.toLowerCase())}`)) as {
      status?: string;
      name?: string;
      slug?: string;
      tvl?: number;
      chains?: string[];
      change_1d?: number;
      change_7d?: number;
      change_30d?: number;
      category?: string;
      message?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(data.message || `Protocol "${protocol}" not found.`);
    const parts = [`# ${data.name || protocol}`];
    if (data.tvl) parts.push(`TVL: $${(data.tvl / 1e9).toFixed(2)}B`);
    if (data.change_1d != null) parts.push(`1d Change: ${data.change_1d >= 0 ? "+" : ""}${data.change_1d.toFixed(2)}%`);
    if (data.change_7d != null) parts.push(`7d Change: ${data.change_7d >= 0 ? "+" : ""}${data.change_7d.toFixed(2)}%`);
    if (data.change_30d != null) parts.push(`30d Change: ${data.change_30d >= 0 ? "+" : ""}${data.change_30d.toFixed(2)}%`);
    if (data.category) parts.push(`Category: ${data.category}`);
    if (data.chains?.length) parts.push(`Chains: ${data.chains.join(", ")}`);
    return text(parts.join("\n"));
  }
);

// 42. veroq_economy_indicator
server.tool(
  "veroq_economy_indicator",
  `Get a specific FRED economic indicator with historical observations.

WHEN TO USE: For detailed history of one indicator. Use veroq_economy (no args) for a summary of all indicators.
RETURNS: Series info (ID, frequency, units), latest value, and historical observations array.
COST: 2 credits.
EXAMPLE: { "indicator": "fed_funds", "limit": 24 }
CONSTRAINTS: Max 100 observations.`,
  {
    indicator: z.string().describe("Indicator slug (e.g. gdp, cpi, unemployment, fed_funds, retail_sales, housing_starts)"),
    limit: z.number().optional().describe("Number of historical observations to return (default 30, max 100)"),
  },
  async ({ indicator, limit }) => {
    const data = (await api("GET", `/api/v1/economy/${encodeURIComponent(indicator)}`, { limit })) as {
      status?: string;
      indicator?: string;
      name?: string;
      series_id?: string;
      frequency?: string;
      units?: string;
      latest?: { date?: string; value?: number };
      observation_count?: number;
      observations?: { date?: string; value?: number }[];
      fetched_at?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(`Economic indicator "${indicator}" not found.`);
    const parts = [`# ${data.name || indicator}`];
    if (data.series_id) parts.push(`Series: ${data.series_id}`);
    if (data.frequency) parts.push(`Frequency: ${data.frequency}`);
    if (data.units) parts.push(`Units: ${data.units}`);
    if (data.latest) parts.push(`\n**Latest:** ${data.latest.value} (${data.latest.date})`);
    if (data.observations?.length) {
      parts.push("\n## Recent Observations");
      for (const o of data.observations.slice(0, 10)) {
        parts.push(`- ${o.date}: ${o.value}`);
      }
      if (data.observations.length > 10) parts.push(`_Showing 10 of ${data.observations.length} observations_`);
    }
    return text(parts.join("\n"));
  }
);

// 43. veroq_generate_report
server.tool(
  "veroq_generate_report",
  `Generate an AI-powered research report for a ticker. Kicks off async generation — use veroq_get_report to retrieve the result.

WHEN TO USE: For a polished, shareable research report. Use veroq_ticker_analysis for instant inline analysis instead.
RETURNS: Report ID, ticker, tier, and status message. Use the report_id with veroq_get_report to fetch the full report.
COST: 5 credits (quick tier). Deep tier requires a paid plan.
EXAMPLE: { "ticker": "AAPL", "tier": "quick" }`,
  {
    ticker: z.string().describe("Ticker symbol to generate a report for (e.g. AAPL, BTC)"),
    tier: z.string().optional().describe("Report tier — 'quick' for a fast summary or 'deep' for full analysis (default 'quick')"),
  },
  async ({ ticker, tier }) => {
    const data = (await api("POST", "/api/v1/reports/generate", undefined, {
      ticker,
      ...(tier ? { tier } : {}),
    })) as {
      status?: string;
      report_id?: string;
      ticker?: string;
      tier?: string;
      message?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(data.message || `Failed to generate report for "${ticker}".`);
    const parts = [`# Report Generated`];
    if (data.report_id) parts.push(`Report ID: ${data.report_id}`);
    if (data.ticker) parts.push(`Ticker: ${data.ticker}`);
    if (data.tier) parts.push(`Tier: ${data.tier}`);
    if (data.message) parts.push(`\n${data.message}`);
    return text(parts.join("\n"));
  }
);

// 44. veroq_get_report
server.tool(
  "veroq_get_report",
  `Retrieve a previously generated report by its ID.

WHEN TO USE: After calling veroq_generate_report, use this to fetch the completed report content.
RETURNS: Full report with title, ticker, tier, creation date, and markdown content (or structured sections).
COST: 1 credit.
EXAMPLE: { "report_id": "rpt_abc123" }`,
  {
    report_id: z.string().describe("The report ID to retrieve"),
  },
  async ({ report_id }) => {
    const data = (await api("GET", `/api/v1/reports/${encodeURIComponent(report_id)}`)) as {
      status?: string;
      report_id?: string;
      ticker?: string;
      tier?: string;
      title?: string;
      markdown?: string;
      sections?: Record<string, unknown>;
      created_at?: string;
      message?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(data.message || `Report "${report_id}" not found.`);
    const parts: string[] = [];
    if (data.title) parts.push(`# ${data.title}`);
    else parts.push(`# Report ${data.report_id || report_id}`);
    if (data.ticker) parts.push(`Ticker: ${data.ticker}`);
    if (data.tier) parts.push(`Tier: ${data.tier}`);
    if (data.created_at) parts.push(`Generated: ${data.created_at}`);
    if (data.markdown) {
      parts.push("\n---\n");
      parts.push(data.markdown);
    } else if (data.sections) {
      parts.push("\n" + JSON.stringify(data.sections, null, 2));
    }
    return text(parts.join("\n"));
  }
);

// ── Full Profile & Fundamental Tools ──

// 46. veroq_full
server.tool(
  "veroq_full",
  `Get the full profile for a ticker — price, fundamentals, technicals, sentiment, and recent news in one call.

WHEN TO USE: For a complete data dump on a single ticker. 9 sources in parallel. Use veroq_ticker_analysis for an interpreted analysis instead.
RETURNS: Price data, fundamentals, technical indicators, sentiment scores, and recent news briefs.
COST: 2 credits.
EXAMPLE: { "ticker": "NVDA" }`,
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, BTC)"),
  },
  async ({ ticker }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(ticker.toUpperCase())}/full`)) as {
      status?: string;
      ticker?: string;
      entity_name?: string;
      sector?: string;
      price?: Record<string, unknown>;
      fundamentals?: Record<string, unknown>;
      technicals?: Record<string, unknown>;
      sentiment?: Record<string, unknown>;
      recent_news?: Brief[];
      message?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(data.message || `Full profile not available for "${ticker}".`);
    const parts = [`# ${data.entity_name || data.ticker || ticker.toUpperCase()} — Full Profile`];
    if (data.sector) parts.push(`Sector: ${data.sector}`);
    if (data.price) {
      parts.push("\n## Price");
      parts.push(JSON.stringify(data.price, null, 2));
    }
    if (data.fundamentals) {
      parts.push("\n## Fundamentals");
      parts.push(JSON.stringify(data.fundamentals, null, 2));
    }
    if (data.technicals) {
      parts.push("\n## Technicals");
      parts.push(JSON.stringify(data.technicals, null, 2));
    }
    if (data.sentiment) {
      parts.push("\n## Sentiment");
      parts.push(JSON.stringify(data.sentiment, null, 2));
    }
    if (data.recent_news?.length) {
      parts.push("\n## Recent News");
      parts.push(data.recent_news.map(formatBriefShort).join("\n\n"));
    }
    return text(parts.join("\n"));
  }
);

// 47. veroq_insider
server.tool(
  "veroq_insider",
  `Get insider trading activity for a stock — executive and director buys/sells from SEC Form 4 filings.

WHEN TO USE: To check if insiders are buying or selling a stock. Key signal for institutional-grade analysis.
RETURNS: Transaction list with insider name, title, type (buy/sell), shares, price, value, and date. Plus summary stats.
COST: 2 credits.
EXAMPLE: { "ticker": "AAPL" }`,
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  async ({ ticker }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(ticker.toUpperCase())}/insider`)) as {
      status?: string;
      ticker?: string;
      entity_name?: string;
      transactions?: {
        name?: string;
        title?: string;
        transaction_type?: string;
        shares?: number;
        price?: number;
        value?: number;
        date?: string;
        [key: string]: unknown;
      }[];
      summary?: Record<string, unknown>;
      message?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(data.message || `Insider data not available for "${ticker}".`);
    const txns = data.transactions || [];
    const parts = [`# Insider Trading: ${data.entity_name || data.ticker || ticker.toUpperCase()}`];
    if (data.summary) {
      parts.push("\n## Summary");
      parts.push(JSON.stringify(data.summary, null, 2));
    }
    if (txns.length) {
      parts.push("\n## Recent Transactions");
      parts.push("Name | Title | Type | Shares | Price | Value | Date");
      parts.push("--- | --- | --- | --- | --- | --- | ---");
      for (const t of txns) {
        parts.push(
          `${t.name || "—"} | ${t.title || "—"} | ${t.transaction_type || "—"} | ${t.shares?.toLocaleString() ?? "—"} | ${t.price != null ? `$${t.price}` : "—"} | ${t.value != null ? `$${t.value.toLocaleString()}` : "—"} | ${t.date || "—"}`
        );
      }
    } else {
      parts.push("\nNo recent insider transactions found.");
    }
    return text(parts.join("\n"));
  }
);

// 48. veroq_filings
server.tool(
  "veroq_filings",
  `Get recent SEC filings for a stock — 10-K, 10-Q, 8-K, and other regulatory filings with source links.

WHEN TO USE: For regulatory filing history and due diligence. Links directly to SEC EDGAR source documents.
RETURNS: Filing list with form type, title, filing date, reporting period, and URL.
COST: 2 credits.
EXAMPLE: { "ticker": "TSLA" }`,
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  async ({ ticker }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(ticker.toUpperCase())}/filings`)) as {
      status?: string;
      ticker?: string;
      entity_name?: string;
      filings?: {
        form?: string;
        title?: string;
        filed_date?: string;
        period?: string;
        url?: string;
        [key: string]: unknown;
      }[];
      total?: number;
      message?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(data.message || `Filings not available for "${ticker}".`);
    const filings = data.filings || [];
    const parts = [`# SEC Filings: ${data.entity_name || data.ticker || ticker.toUpperCase()}`];
    if (data.total != null) parts.push(`Total: ${data.total} filings`);
    if (filings.length) {
      parts.push("\n## Recent Filings");
      parts.push("Form | Title | Filed | Period | Link");
      parts.push("--- | --- | --- | --- | ---");
      for (const f of filings) {
        parts.push(
          `${f.form || "—"} | ${f.title || "—"} | ${f.filed_date || "—"} | ${f.period || "—"} | ${f.url || "—"}`
        );
      }
    } else {
      parts.push("\nNo recent filings found.");
    }
    return text(parts.join("\n"));
  }
);

// 49. veroq_analysts
server.tool(
  "veroq_analysts",
  `Get Wall Street analyst ratings and price targets for a stock.

WHEN TO USE: To see consensus analyst opinion and price target range for a stock.
RETURNS: Consensus rating, mean/high/low price targets, analyst count, and individual ratings with firm, target, and date.
COST: 2 credits.
EXAMPLE: { "ticker": "NVDA" }`,
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  async ({ ticker }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(ticker.toUpperCase())}/analysts`)) as {
      status?: string;
      ticker?: string;
      entity_name?: string;
      consensus?: { rating?: string; target_high?: number; target_low?: number; target_mean?: number; total_analysts?: number };
      ratings?: {
        analyst?: string;
        firm?: string;
        rating?: string;
        target?: number;
        date?: string;
        [key: string]: unknown;
      }[];
      message?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(data.message || `Analyst data not available for "${ticker}".`);
    const parts = [`# Analyst Ratings: ${data.entity_name || data.ticker || ticker.toUpperCase()}`];
    if (data.consensus) {
      const c = data.consensus;
      parts.push(`\n**Consensus: ${(c.rating || "N/A").toUpperCase()}**`);
      if (c.total_analysts) parts.push(`Analysts: ${c.total_analysts}`);
      if (c.target_mean != null) parts.push(`Target (mean): $${c.target_mean}`);
      if (c.target_high != null && c.target_low != null) parts.push(`Range: $${c.target_low} — $${c.target_high}`);
    }
    const ratings = data.ratings || [];
    if (ratings.length) {
      parts.push("\n## Individual Ratings");
      parts.push("Analyst | Firm | Rating | Target | Date");
      parts.push("--- | --- | --- | --- | ---");
      for (const r of ratings) {
        parts.push(
          `${r.analyst || "—"} | ${r.firm || "—"} | ${r.rating || "—"} | ${r.target != null ? `$${r.target}` : "—"} | ${r.date || "—"}`
        );
      }
    }
    return text(parts.join("\n"));
  }
);

// 50. veroq_congress
server.tool(
  "veroq_congress",
  `Get recent stock trades by members of U.S. Congress from public disclosure filings.

WHEN TO USE: To track congressional trading activity — politically-informed trading signals. Filter by ticker for specific stocks.
RETURNS: Trades with member name, party, state, chamber, ticker, transaction type, amount range, and date.
COST: 2 credits.
EXAMPLE: { "symbol": "NVDA" }`,
  {
    symbol: z.string().optional().describe("Ticker symbol to filter by (e.g. AAPL, NVDA). Omit for all recent congressional trades."),
  },
  async ({ symbol }) => {
    const data = (await api("GET", "/api/v1/congress/trades", {
      ...(symbol ? { symbol: symbol.toUpperCase() } : {}),
    })) as {
      status?: string;
      trades?: {
        member?: string;
        party?: string;
        state?: string;
        chamber?: string;
        ticker?: string;
        asset?: string;
        transaction_type?: string;
        amount_range?: string;
        date?: string;
        [key: string]: unknown;
      }[];
      total?: number;
      message?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(data.message || "Congressional trades data not available.");
    const trades = data.trades || [];
    if (!trades.length) return text(symbol ? `No congressional trades found for "${symbol}".` : "No recent congressional trades found.");
    const parts = [`# Congressional Trades${symbol ? ` — ${symbol.toUpperCase()}` : ""}`];
    if (data.total != null) parts.push(`Total: ${data.total} trades`);
    parts.push("\nMember | Party | Ticker | Asset | Type | Amount | Date");
    parts.push("--- | --- | --- | --- | --- | --- | ---");
    for (const t of trades) {
      parts.push(
        `${t.member || "—"} | ${t.party || "—"} (${t.state || "—"}) | ${t.ticker || "—"} | ${t.asset || "—"} | ${t.transaction_type || "—"} | ${t.amount_range || "—"} | ${t.date || "—"}`
      );
    }
    return text(parts.join("\n"));
  }
);

// 51. veroq_institutions
server.tool(
  "veroq_institutions",
  `Get institutional ownership data for a stock — top holders and ownership changes from 13F filings.

WHEN TO USE: To see which institutions own a stock and whether they're increasing or decreasing positions.
RETURNS: Total institutional ownership %, summary stats, and top holders with shares, value, percent held, change, and filing date.
COST: 2 credits.
EXAMPLE: { "ticker": "AAPL" }`,
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  async ({ ticker }) => {
    const data = (await api("GET", `/api/v1/ticker/${encodeURIComponent(ticker.toUpperCase())}/institutions`)) as {
      status?: string;
      ticker?: string;
      entity_name?: string;
      institutional_ownership?: number;
      holders?: {
        institution?: string;
        shares?: number;
        value?: number;
        percent?: number;
        change?: number;
        change_percent?: number;
        filing_date?: string;
        [key: string]: unknown;
      }[];
      summary?: Record<string, unknown>;
      message?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(data.message || `Institutional data not available for "${ticker}".`);
    const parts = [`# Institutional Ownership: ${data.entity_name || data.ticker || ticker.toUpperCase()}`];
    if (data.institutional_ownership != null) parts.push(`Total Institutional Ownership: ${data.institutional_ownership}%`);
    if (data.summary) {
      parts.push("\n## Summary");
      parts.push(JSON.stringify(data.summary, null, 2));
    }
    const holders = data.holders || [];
    if (holders.length) {
      parts.push("\n## Top Holders");
      parts.push("Institution | Shares | Value | % Held | Change | Filing Date");
      parts.push("--- | --- | --- | --- | --- | ---");
      for (const h of holders) {
        parts.push(
          `${h.institution || "—"} | ${h.shares?.toLocaleString() ?? "—"} | ${h.value != null ? `$${(h.value / 1e6).toFixed(1)}M` : "—"} | ${h.percent != null ? `${h.percent.toFixed(2)}%` : "—"} | ${h.change_percent != null ? `${h.change_percent >= 0 ? "+" : ""}${h.change_percent.toFixed(2)}%` : "—"} | ${h.filing_date || "—"}`
        );
      }
    } else {
      parts.push("\nNo institutional holder data available.");
    }
    return text(parts.join("\n"));
  }
);

// 52. veroq_run_agent
server.tool(
  "veroq_run_agent",
  `Run a VEROQ AI agent by its slug — pre-built workflows combining multiple data sources and analysis steps.

WHEN TO USE: For complex multi-step analysis tasks like portfolio reviews, due diligence, or market scans. Agents automate what would take many individual tool calls.
RETURNS: Agent name, execution steps (with status/summary per step), final output or structured result, and credits used.
COST: 5-100 credits (varies by agent complexity).
EXAMPLE: { "slug": "due-diligence", "inputs": { "ticker": "AAPL" } }`,
  {
    slug: z.string().describe("Agent slug identifier (e.g. 'portfolio-review', 'due-diligence', 'market-scanner')"),
    inputs: z.record(z.unknown()).describe("Input parameters for the agent — varies by agent type (e.g. { ticker: 'AAPL' } or { tickers: ['AAPL', 'GOOGL'] })"),
  },
  async ({ slug, inputs }) => {
    const data = (await api("POST", `/api/v1/agents/run/${encodeURIComponent(slug)}`, undefined, inputs)) as {
      status?: string;
      agent?: string;
      result?: unknown;
      output?: string;
      steps?: { step?: string; status?: string; summary?: string }[];
      credits_used?: number;
      message?: string;
      [key: string]: unknown;
    };
    if (data.status === "error") return text(data.message || `Agent "${slug}" failed to run.`);
    const parts = [`# Agent: ${data.agent || slug}`];
    if (data.steps?.length) {
      parts.push("\n## Steps");
      for (const s of data.steps) {
        parts.push(`- **${s.step}** [${s.status}]${s.summary ? `: ${s.summary}` : ""}`);
      }
    }
    if (data.output) {
      parts.push("\n## Output");
      parts.push(data.output);
    } else if (data.result) {
      parts.push("\n## Result");
      parts.push(typeof data.result === "string" ? data.result : JSON.stringify(data.result, null, 2));
    }
    if (data.credits_used != null) parts.push(`\n_Credits used: ${data.credits_used}_`);
    return text(parts.join("\n"));
  }
);

// ── Fast Tier ──

// 53. veroq_fast_signals
server.tool(
  "veroq_fast_signals",
  `Pre-computed buy/sell signals across 78 tickers — refreshed every cycle.

WHEN TO USE: For a quick overview of all active signals without running individual ticker analyses. Good for scanning opportunities.
RETURNS: Array of tickers with signal direction (buy/sell/hold), score, and contributing factors.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/fast/signals");
    return text(JSON.stringify(data, null, 2));
  }
);

// 54. veroq_fast_macro
server.tool(
  "veroq_fast_macro",
  `Macro dashboard: yields, CFTC positioning, jobs, energy — all pre-computed.

WHEN TO USE: For a single-call macro snapshot combining treasury yields, CFTC Commitment of Traders, employment data, and energy prices.
RETURNS: Structured macro data across multiple categories.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/fast/macro");
    return text(JSON.stringify(data, null, 2));
  }
);

// 55. veroq_fast_snapshot
server.tool(
  "veroq_fast_snapshot",
  `Pre-computed signal for one ticker — fast lookup without running full analysis.

WHEN TO USE: When you need the signal for a specific ticker quickly. Faster than veroq_ticker_score because it reads pre-computed data.
RETURNS: Ticker signal with score, direction, and factors.
COST: 1 credit.
EXAMPLE: { "ticker": "NVDA" }`,
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  async ({ ticker }) => {
    const data = await api("GET", `/api/v1/fast/snapshot/${encodeURIComponent(ticker.toUpperCase())}`);
    return text(JSON.stringify(data, null, 2));
  }
);

// 56. veroq_fast_movers
server.tool(
  "veroq_fast_movers",
  `Biggest signal changes in the last cycle — tickers where the signal moved most.

WHEN TO USE: To identify which tickers had the biggest change in buy/sell signals recently. Good for momentum or reversal detection.
RETURNS: Array of tickers with previous and current signal scores and the delta.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/fast/movers");
    return text(JSON.stringify(data, null, 2));
  }
);

// 57. veroq_fast_heatmap
server.tool(
  "veroq_fast_heatmap",
  `All 78 tickers with signal scores — heatmap-style overview.

WHEN TO USE: For a complete view of all tracked tickers and their current signal scores. Good for building visual dashboards or scanning all at once.
RETURNS: Array of all tickers with signal scores.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/fast/heatmap");
    return text(JSON.stringify(data, null, 2));
  }
);

// ── Travel Intelligence ──

// 58. veroq_travel_overview
server.tool(
  "veroq_travel_overview",
  `Travel disruption score combining TSA volumes, FAA delays, and border wait times.

WHEN TO USE: For a quick snapshot of US travel conditions — airport delays, passenger throughput, and border crossing waits.
RETURNS: Composite disruption score, TSA passenger counts, FAA ground stops, and border wait times.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/travel/overview");
    return text(JSON.stringify(data, null, 2));
  }
);

// 59. veroq_travel_tsa
server.tool(
  "veroq_travel_tsa",
  `TSA daily passenger volumes — throughput data from US airport checkpoints.

WHEN TO USE: To track airport passenger volumes and compare to historical levels. Useful for travel industry analysis and consumer spending indicators.
RETURNS: Daily passenger counts, year-over-year comparison, and trend data.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/travel/tsa");
    return text(JSON.stringify(data, null, 2));
  }
);

// 60. veroq_travel_faa
server.tool(
  "veroq_travel_faa",
  `FAA ground stops and airport delays — live data from the FAA.

WHEN TO USE: To check for current airport delays, ground stops, or airspace disruptions in the US.
RETURNS: Active ground stops, ground delay programs, airport closures, and general delay information.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/travel/faa");
    return text(JSON.stringify(data, null, 2));
  }
);

// ── SEC EDGAR ──

// 61. veroq_edgar_filings
server.tool(
  "veroq_edgar_filings",
  `Recent SEC filings (10-K, 10-Q, 8-K) for a company from EDGAR.

WHEN TO USE: To see a company's recent regulatory filings — annual reports, quarterly reports, and current event disclosures.
RETURNS: List of filings with type, date, description, and EDGAR URL.
COST: 1 credit.
EXAMPLE: { "ticker": "AAPL" }`,
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  async ({ ticker }) => {
    const data = await api("GET", `/api/v1/edgar/filings/${encodeURIComponent(ticker.toUpperCase())}`);
    return text(JSON.stringify(data, null, 2));
  }
);

// 62. veroq_edgar_insider
server.tool(
  "veroq_edgar_insider",
  `Form 4 insider trades for a company from SEC EDGAR.

WHEN TO USE: To see insider buying and selling activity — who traded, how many shares, and at what price. Complements veroq_insider which uses a different data source.
RETURNS: List of insider transactions with name, title, date, shares, price, and transaction type.
COST: 1 credit.
EXAMPLE: { "ticker": "TSLA" }`,
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  async ({ ticker }) => {
    const data = await api("GET", `/api/v1/edgar/insider/${encodeURIComponent(ticker.toUpperCase())}`);
    return text(JSON.stringify(data, null, 2));
  }
);

// 63. veroq_edgar_financials
server.tool(
  "veroq_edgar_financials",
  `XBRL financial data for a company from SEC EDGAR.

WHEN TO USE: To get structured financial statements (income statement, balance sheet, cash flow) directly from SEC filings.
RETURNS: Financial data extracted from XBRL filings including revenue, net income, assets, liabilities, and cash flows.
COST: 1 credit.
EXAMPLE: { "ticker": "MSFT" }`,
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  async ({ ticker }) => {
    const data = await api("GET", `/api/v1/edgar/financials/${encodeURIComponent(ticker.toUpperCase())}`);
    return text(JSON.stringify(data, null, 2));
  }
);

// ── Energy ──

// 64. veroq_energy_overview
server.tool(
  "veroq_energy_overview",
  `Oil prices, petroleum inventory, and natural gas data.

WHEN TO USE: For a snapshot of the energy market — crude oil (WTI/Brent) prices, EIA petroleum inventories, and natural gas spot prices.
RETURNS: Current prices, inventory levels, and recent changes.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/energy/overview");
    return text(JSON.stringify(data, null, 2));
  }
);

// ── Alternative Data ──

// 65. veroq_alt_yields
server.tool(
  "veroq_alt_yields",
  `Treasury yield curve with inversion detection.

WHEN TO USE: To check the current US Treasury yield curve across maturities (1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y, 30Y) and detect inversions that may signal recession.
RETURNS: Yield values per maturity, spread calculations, and inversion flags.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/alt/yields");
    return text(JSON.stringify(data, null, 2));
  }
);

// 66. veroq_alt_cot
server.tool(
  "veroq_alt_cot",
  `CFTC Commitment of Traders positioning for a commodity.

WHEN TO USE: To see how commercial hedgers, large speculators, and small traders are positioned in futures markets. A contrarian indicator — extreme positioning often precedes reversals.
RETURNS: Net positions by trader category, open interest, and changes from prior week.
COST: 1 credit.
EXAMPLE: { "commodity": "gold" }`,
  {
    commodity: z.string().describe("Commodity name (e.g. gold, silver, crude-oil, natural-gas, corn, soybeans, wheat, copper, sp500)"),
  },
  async ({ commodity }) => {
    const data = await api("GET", `/api/v1/alt/cot/${encodeURIComponent(commodity.toLowerCase())}`);
    return text(JSON.stringify(data, null, 2));
  }
);

// 67. veroq_alt_attention
server.tool(
  "veroq_alt_attention",
  `Wikipedia attention score for an entity — pageview-based interest signal.

WHEN TO USE: To gauge public interest in a company, person, or topic based on Wikipedia traffic. Spikes in attention often precede or accompany market moves.
RETURNS: Pageview counts, trend direction, and percentile ranking.
COST: 1 credit.
EXAMPLE: { "entity": "NVIDIA" }`,
  {
    entity: z.string().describe("Entity name — company, person, or topic (e.g. NVIDIA, Elon Musk, Bitcoin)"),
  },
  async ({ entity }) => {
    const data = await api("GET", `/api/v1/alt/attention/${encodeURIComponent(entity)}`);
    return text(JSON.stringify(data, null, 2));
  }
);

// ── Research ──

// 68. veroq_research_papers
server.tool(
  "veroq_research_papers",
  `Latest arXiv AI/ML research papers.

WHEN TO USE: To discover recent academic research in artificial intelligence and machine learning. Good for tracking cutting-edge developments.
RETURNS: List of papers with title, authors, abstract, categories, and arXiv URL.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/research/papers");
    return text(JSON.stringify(data, null, 2));
  }
);

// 69. veroq_research_github
server.tool(
  "veroq_research_github",
  `Trending GitHub repos with AI detection — what developers are building now.

WHEN TO USE: To see which GitHub repositories are trending, with automatic detection of AI/ML-related projects. Good for tech trend analysis.
RETURNS: List of trending repos with stars, forks, language, description, and AI classification.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/research/github-trending");
    return text(JSON.stringify(data, null, 2));
  }
);

// 70. veroq_research_fda
server.tool(
  "veroq_research_fda",
  `FDA drug approvals and recalls — recent regulatory actions.

WHEN TO USE: To track FDA drug approvals, rejections, and recalls. Important for biotech/pharma stock analysis.
RETURNS: List of recent FDA actions with drug name, company, action type, date, and details.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/research/fda");
    return text(JSON.stringify(data, null, 2));
  }
);

// 71. veroq_research_bills
server.tool(
  "veroq_research_bills",
  `Recent Congressional bills — legislation that may affect markets.

WHEN TO USE: To track new legislation in the US Congress that could impact industries or markets. Good for policy risk analysis.
RETURNS: List of bills with title, sponsor, status, introduced date, and summary.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/research/bills");
    return text(JSON.stringify(data, null, 2));
  }
);

// 72. veroq_research_regulations
server.tool(
  "veroq_research_regulations",
  `New Federal Register regulations — proposed and final rules.

WHEN TO USE: To track new federal regulations that could affect specific industries. Good for compliance and regulatory risk analysis.
RETURNS: List of regulations with title, agency, type (proposed/final), publication date, and summary.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/research/regulations");
    return text(JSON.stringify(data, null, 2));
  }
);

// ── World Data ──

// 73. veroq_world_hackernews
server.tool(
  "veroq_world_hackernews",
  `Hacker News top stories — what the tech community is discussing.

WHEN TO USE: To see what's trending on Hacker News. Good for tracking tech industry sentiment and emerging topics.
RETURNS: List of top stories with title, score, comment count, author, and URL.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/world/hackernews");
    return text(JSON.stringify(data, null, 2));
  }
);

// 74. veroq_world_jobs
server.tool(
  "veroq_world_jobs",
  `BLS employment data — nonfarm payrolls, unemployment rate, and labor market indicators.

WHEN TO USE: For US employment data from the Bureau of Labor Statistics. Key economic indicator for market analysis and Fed policy expectations.
RETURNS: Latest employment figures, historical comparison, and labor market metrics.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/world/jobs");
    return text(JSON.stringify(data, null, 2));
  }
);

// 75. veroq_world_gdp
server.tool(
  "veroq_world_gdp",
  `US GDP data from the World Bank — gross domestic product and growth rates.

WHEN TO USE: For GDP data and economic growth analysis. Useful for macro context and long-term trend analysis.
RETURNS: GDP values, growth rates, and historical comparison.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/world/gdp");
    return text(JSON.stringify(data, null, 2));
  }
);

// ── Context & Intelligence ──

// 76. veroq_context
server.tool(
  "veroq_context",
  `Full background research on a topic — aggregates briefs, entities, timeline, and related data.

WHEN TO USE: When you need comprehensive background on a topic before answering a complex question. Broader than veroq_ask — returns raw context rather than a synthesized answer.
RETURNS: Aggregated briefs, entity profiles, timeline of events, and related topics.
COST: 3 credits.
EXAMPLE: { "topic": "semiconductor export controls" }`,
  {
    topic: z.string().describe("Topic to research (e.g. 'semiconductor export controls', 'NVIDIA earnings', 'Fed rate decision')"),
  },
  async ({ topic }) => {
    const data = await api("GET", "/api/v1/context", { topic });
    return text(JSON.stringify(data, null, 2));
  }
);

// 77. veroq_intelligence
server.tool(
  "veroq_intelligence",
  `Cross-category impact analysis — how a topic affects multiple sectors and asset classes.

WHEN TO USE: For understanding second-order effects of events. E.g., how a Fed rate decision impacts tech stocks, bonds, crypto, and real estate simultaneously.
RETURNS: Impact scores across categories, affected tickers, transmission channels, and risk assessment.
COST: 5 credits.
EXAMPLE: { "topic": "Fed rate cut" }`,
  {
    topic: z.string().describe("Topic or event to analyze for cross-category impact (e.g. 'Fed rate cut', 'China tariffs', 'oil supply disruption')"),
  },
  async ({ topic }) => {
    const data = await api("GET", "/api/v1/intelligence", { topic });
    return text(JSON.stringify(data, null, 2));
  }
);

// ── Agent ──

// 78. veroq_agent_packs
server.tool(
  "veroq_agent_packs",
  `List available vertical agent packs — pre-built agent configurations for specific domains.

WHEN TO USE: To discover which agent packs are available before calling veroq_run_agent. Each pack is a curated workflow for a specific use case.
RETURNS: List of agent packs with slug, name, description, required inputs, and credit cost.
COST: 1 credit.
EXAMPLE: {}`,
  {},
  async () => {
    const data = await api("GET", "/api/v1/agents/packs");
    return text(JSON.stringify(data, null, 2));
  }
);

// --- Start ---

const mode = process.env.MCP_TRANSPORT || (process.argv.includes("--http") ? "http" : "stdio");

if (mode === "http") {
  const PORT = parseInt(process.env.PORT || "3100", 10);
  const httpServer = createServer(async (req, res) => {
    // CORS for browser-based MCP clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  httpServer.listen(PORT, () => {
    console.error(`VEROQ MCP server (HTTP) listening on port ${PORT}`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
