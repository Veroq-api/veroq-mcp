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

function createMcpServer(): McpServer {
  return new McpServer({ name: "veroq", version: "1.1.0" });
}

const server = createMcpServer();

// ── Hero Tools — Ask & Verify ──

// 1. veroq_ask
server.tool(
  "veroq_ask",
  "Ask VEROQ any natural-language question. This is the single most important tool — it routes your question to the best combination of data, analysis, and intelligence to give a comprehensive answer.",
  {
    question: z.string().describe("Natural-language question to ask VEROQ (e.g. 'What is happening with NVIDIA?' or 'Compare Tesla and BYD')"),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ question }) => {
    const data = (await api("POST", "/api/v1/ask", undefined, {
      question,
    })) as {
      status?: string;
      question?: string;
      answer?: string;
      sources?: { id?: string; headline?: string; type?: string }[];
      follow_ups?: string[];
      credits_used?: number;
      [key: string]: unknown;
    };
    if (data.status === "error") return text("Failed to get an answer. Please try rephrasing your question.");
    const parts: string[] = [];
    if (data.answer) parts.push(data.answer);
    if (data.sources?.length) {
      parts.push("\n## Sources");
      for (const s of data.sources) {
        parts.push(`- ${s.headline || s.id}${s.type ? ` (${s.type})` : ""}${s.id ? ` [${s.id}]` : ""}`);
      }
    }
    if (data.follow_ups?.length) {
      parts.push("\n## Follow-up Questions");
      parts.push(data.follow_ups.map((f) => `- ${f}`).join("\n"));
    }
    return text(parts.join("\n") || "No answer returned.");
  }
);

// 2. veroq_verify
server.tool(
  "veroq_verify",
  "Fact-check a claim against the VEROQ brief corpus. Returns a verdict (supported/contradicted/partially_supported/unverifiable) with confidence, sources, and nuances.",
  {
    claim: z.string().describe("The claim to fact-check (10-1000 characters)"),
    context: z.string().optional().describe("Category to narrow the search (e.g. 'tech', 'policy')"),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ claim, context }) => {
    const data = (await api("POST", "/api/v1/verify", undefined, {
      claim,
      context,
    })) as {
      claim?: string;
      verdict?: string;
      confidence?: number;
      summary?: string;
      supporting_briefs?: { id?: string; headline?: string; confidence?: number; relevance?: number }[];
      contradicting_briefs?: { id?: string; headline?: string; confidence?: number; relevance?: number }[];
      nuances?: string;
      sources_analyzed?: number;
      briefs_matched?: number;
      credits_used?: number;
      processing_time_ms?: number;
    };
    const parts = [`# Claim Verification: ${data.verdict?.toUpperCase()}`];
    parts.push(`\n**Claim:** ${data.claim}`);
    parts.push(`**Verdict:** ${data.verdict} (confidence: ${((data.confidence ?? 0) * 100).toFixed(0)}%)`);
    if (data.summary) parts.push(`\n## Summary\n${data.summary}`);
    if (data.supporting_briefs?.length) {
      parts.push("\n## Supporting Evidence");
      parts.push(data.supporting_briefs.map((b) => `- ${b.headline} (${b.id}, confidence: ${b.confidence})`).join("\n"));
    }
    if (data.contradicting_briefs?.length) {
      parts.push("\n## Contradicting Evidence");
      parts.push(data.contradicting_briefs.map((b) => `- ${b.headline} (${b.id}, confidence: ${b.confidence})`).join("\n"));
    }
    if (data.nuances) parts.push(`\n## Nuances\n${data.nuances}`);
    parts.push(`\n_Analyzed ${data.sources_analyzed} sources, matched ${data.briefs_matched} briefs in ${data.processing_time_ms}ms_`);
    return text(parts.join("\n"));
  }
);

// ── Search & Discovery ──

// 3. veroq_search
server.tool(
  "veroq_search",
  "Search verified intelligence briefs by topic. Returns headline, confidence score, category, and summary for each result.",
  {
    query: z.string().describe("Search query"),
    category: z.string().optional().describe("Filter by category"),
    depth: z.enum(["fast", "standard", "deep"]).optional().describe("Search depth — fast skips highlights, deep adds entity cross-refs"),
    include_sources: z.string().optional().describe("Comma-separated domains to include"),
    exclude_sources: z.string().optional().describe("Comma-separated domains to exclude"),
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get the latest verified intelligence briefs. Optionally filter by category or source domain.",
  {
    category: z.string().optional().describe("Filter by category"),
    limit: z.number().optional().describe("Max results (default 20)"),
    include_sources: z.string().optional().describe("Comma-separated domains to include"),
    exclude_sources: z.string().optional().describe("Comma-separated domains to exclude"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get full details for a specific brief by ID, including body, sources, entities, counter-argument, and provenance.",
  {
    brief_id: z.string().describe("Brief ID"),
    include_full_text: z.boolean().optional().describe("Include full body text (default true)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Extract article content from one or more URLs. Returns title, domain, word count, and text for each.",
  {
    urls: z.string().describe("Comma-separated URLs to extract (max 5)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get all briefs mentioning a specific entity (person, org, location, etc.).",
  {
    name: z.string().describe("Entity name to look up"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get trending entities — people, orgs, and topics with the most recent mentions.",
  {
    limit: z.number().optional().describe("Max entities to return"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Compare how different sources cover a topic. Finds a relevant brief, then analyzes per-source bias and generates a synthesis.",
  {
    topic: z.string().describe("Topic to compare coverage on"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Run deep research on a topic. Returns a comprehensive report with key findings, entity map, and information gaps.",
  {
    query: z.string().describe("Research query"),
    category: z.string().optional().describe("Filter by category"),
    max_sources: z.number().optional().describe("Maximum sources to analyze"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get the story evolution timeline for a living brief — shows how coverage developed over time with versioned updates, confidence changes, and new sources.",
  {
    brief_id: z.string().describe("Brief ID like PR-2026-0305-001"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Generate a forward-looking forecast for a topic based on current intelligence trends, momentum signals, and historical patterns.",
  {
    topic: z.string().describe("Topic to forecast future developments for"),
    depth: z.enum(["fast", "standard", "deep"]).optional().describe("Analysis depth"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Find contradictions across the intelligence brief network — stories where sources disagree on facts, framing, or conclusions.",
  {
    severity: z.string().optional().describe("Filter by severity level (e.g. high, medium, low)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get notable events detected across intelligence briefs — significant developments, announcements, and inflection points.",
  {
    type: z.string().optional().describe("Event type to filter by"),
    subject: z.string().optional().describe("Subject or entity to filter events for"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get a diff of changes to a living brief since a given time — shows what was added, removed, or changed between versions.",
  {
    brief_id: z.string().describe("Brief ID like PR-2026-0305-001"),
    since: z.string().optional().describe("ISO timestamp to diff from (e.g. 2026-03-18T00:00:00Z)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Search the web with optional VEROQ trust scoring. Returns web results with relevance and optional verification.",
  {
    query: z.string().describe("Web search query"),
    limit: z.number().optional().describe("Max results (default 5)"),
    freshness: z.string().optional().describe("Freshness filter (e.g. 'day', 'week', 'month')"),
    region: z.string().optional().describe("Region code (e.g. 'us', 'eu')"),
    verify: z.boolean().optional().describe("Enable VEROQ trust scoring on results"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Extract structured content from a URL with optional link following. Returns page content, metadata, and discovered links.",
  {
    url: z.string().describe("URL to crawl and extract content from"),
    depth: z.number().optional().describe("Crawl depth (default 1)"),
    max_pages: z.number().optional().describe("Max pages to crawl (default 5)"),
    include_links: z.boolean().optional().describe("Include extracted links in response"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get the live market price for a stock or crypto ticker. Returns current price, change, percent change, and volume.",
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, BTC)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get a composite trading signal score for a ticker based on news sentiment, momentum, coverage volume, and event proximity. Returns signal (strong_bullish to strong_bearish) with component breakdown.",
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get intelligence briefs ranked by relevance to your portfolio holdings. Pass an array of ticker/weight pairs to get portfolio-aware news ranked by impact.",
  {
    holdings: z.array(z.object({
      ticker: z.string().describe("Ticker symbol"),
      weight: z.number().describe("Portfolio weight 0-1 (e.g. 0.15 for 15%)"),
    })).describe("Array of portfolio holdings with weights"),
    days: z.number().optional().describe("Lookback period in days (default 7, max 30)"),
    limit: z.number().optional().describe("Max briefs to return (default 30)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get a sector overview with aggregate sentiment scores and brief counts. Shows which market sectors have the most positive or negative news coverage.",
  {
    days: z.number().optional().describe("Lookback period in days (default 7)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get OHLCV candlestick data for a stock ticker. Use for price chart analysis and technical trading.",
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, MSFT, GOOGL)"),
    interval: z.enum(["1d", "1wk", "1mo"]).optional().describe("Candle interval (default 1d)"),
    range: z.enum(["1mo", "3mo", "6mo", "1y", "2y", "5y"]).optional().describe("Date range (default 6mo)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get all major technical indicators for a ticker at once: RSI, MACD, Bollinger Bands, moving averages, and an overall signal summary (bullish/bearish/neutral).",
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
    range: z.enum(["1mo", "3mo", "6mo", "1y", "2y", "5y"]).optional().describe("Date range for indicator calculation (default 6mo)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get next earnings date, EPS estimates, and revenue estimates for a stock ticker.",
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, GOOGL)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get today's top market movers: biggest gainers, biggest losers, and most actively traded stocks.",
  {},
  { readOnlyHint: true, openWorldHint: true },
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
  "Get current values for major market indices: S&P 500, Nasdaq Composite, Dow Jones Industrial Average, and VIX volatility index.",
  {},
  { readOnlyHint: true, openWorldHint: true },
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
  "Get macroeconomic indicators from FRED (Federal Reserve). With no arguments returns a summary of all key indicators (GDP, CPI, unemployment, etc.). Pass a specific indicator slug for detailed history.",
  {
    indicator: z.string().optional().describe("Specific indicator slug (e.g. gdp, cpi, unemployment, fed_funds, retail_sales). Omit for summary of all."),
    limit: z.number().optional().describe("Number of historical observations to return (default 30, max 100)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get current foreign exchange rates. With no arguments returns all major forex pairs. Pass a specific pair (e.g. EURUSD) for a single rate.",
  {
    pair: z.string().optional().describe("Forex pair (e.g. EURUSD, GBPUSD, USDJPY). Omit for all major pairs."),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get commodity prices (gold, silver, oil, natural gas, etc.). With no arguments returns all tracked commodities. Pass a symbol for a specific commodity.",
  {
    symbol: z.string().optional().describe("Commodity slug (e.g. gold, silver, crude, natural_gas, copper, platinum). Omit for all."),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get cryptocurrency data. With no arguments returns market overview (total market cap, BTC dominance, 24h volume). Pass a symbol (e.g. BTC, ETH, SOL) for detailed token data including price, market cap, supply, and 24h stats.",
  {
    symbol: z.string().optional().describe("Crypto symbol (e.g. BTC, ETH, SOL, ADA). Omit for market overview."),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get a crypto token price chart with historical data points. Returns timestamped price data for charting or trend analysis.",
  {
    symbol: z.string().describe("Crypto symbol (e.g. BTC, ETH, SOL)"),
    days: z.number().optional().describe("Number of days of history (default 30, max 365)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get DeFi (Decentralized Finance) data. With no arguments returns TVL overview with top protocols and chain breakdown. Pass a protocol slug (e.g. aave, uniswap, lido) for detailed protocol TVL and history.",
  {
    protocol: z.string().optional().describe("Protocol slug (e.g. aave, uniswap, lido, makerdao). Omit for DeFi overview."),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Find stocks or crypto matching multiple criteria. Combine technical indicators (RSI, MACD, SMA), sentiment analysis, and fundamental filters in one query.",
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
  { readOnlyHint: true, openWorldHint: true },
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
  "List pre-built screening strategies or run a specific preset by ID.",
  {
    preset_id: z.string().optional().describe("Preset ID to run. Omit to list all available presets."),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Create, list, or check triggered price/sentiment alerts.",
  {
    action: z.string().describe('Action to perform: "create", "list", or "triggered"'),
    ticker: z.string().optional().describe("Ticker symbol (required for create)"),
    alert_type: z.string().optional().describe("Alert type: price_above, price_below, rsi_above, rsi_below, sentiment_flip, volume_spike (required for create)"),
    threshold: z.number().optional().describe("Alert threshold value (required for create — price level or sentiment delta)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get social media sentiment for a stock or crypto ticker. Returns Reddit and other platform mentions, sentiment scores, and trending discussion topics.",
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, TSLA, BTC)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get tickers and topics currently trending on social media. Shows the most discussed stocks and crypto across Reddit, Twitter, and other platforms.",
  {},
  { readOnlyHint: true, openWorldHint: true },
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
  "Get upcoming and recent IPOs from SEC EDGAR S-1 filings. Shows company name, ticker, filing date, and location.",
  {
    days: z.number().optional().describe("Lookback/forward window in days (default 30, max 90)"),
    limit: z.number().optional().describe("Max results (default 30, max 100)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get recent news headlines and briefs for a specific stock or crypto ticker. Returns the latest intelligence coverage mentioning this ticker.",
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, BTC)"),
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get a comprehensive analysis for a stock or crypto ticker combining news sentiment, technical indicators, recent events, and an overall outlook.",
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get search autocomplete suggestions. Returns matching headlines and entities as you type — useful for finding the right query before a full search.",
  {
    query: z.string().describe("Partial search query (minimum 2 characters)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get detailed DeFi protocol data including TVL, chain deployment, and recent performance changes. Use protocol slugs like aave, uniswap, lido, makerdao.",
  {
    protocol: z.string().describe("Protocol slug (e.g. aave, uniswap, lido, makerdao, curve)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get a specific economic indicator from FRED (Federal Reserve) with historical observations. Use indicator slugs like gdp, cpi, unemployment, fed_funds, retail_sales.",
  {
    indicator: z.string().describe("Indicator slug (e.g. gdp, cpi, unemployment, fed_funds, retail_sales, housing_starts)"),
    limit: z.number().optional().describe("Number of historical observations to return (default 30, max 100)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Generate an AI-powered research report for a ticker symbol. Returns a comprehensive analysis including fundamentals, technicals, and news sentiment.",
  {
    ticker: z.string().describe("Ticker symbol to generate a report for (e.g. AAPL, BTC)"),
    tier: z.string().optional().describe("Report tier — 'quick' for a fast summary or 'deep' for full analysis (default 'quick')"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Retrieve a previously generated report by its ID. Returns the full report content including all analysis sections.",
  {
    report_id: z.string().describe("The report ID to retrieve"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get the full profile for a stock or crypto ticker — price, fundamentals, technicals, news sentiment, and recent coverage all in one call.",
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, BTC)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get insider trading activity for a stock — recent buys and sells by company executives and directors from SEC filings.",
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get recent SEC filings for a stock — 10-K, 10-Q, 8-K, and other regulatory filings with links to source documents.",
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get Wall Street analyst ratings and price targets for a stock — consensus rating, target prices, and individual analyst recommendations.",
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get recent stock trades by members of U.S. Congress. Optionally filter by ticker symbol to see congressional activity on a specific stock.",
  {
    symbol: z.string().optional().describe("Ticker symbol to filter by (e.g. AAPL, NVDA). Omit for all recent congressional trades."),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Get institutional ownership data for a stock — top holders, ownership changes, and institutional buy/sell activity from 13F filings.",
  {
    ticker: z.string().describe("Ticker symbol (e.g. AAPL, NVDA, TSLA)"),
  },
  { readOnlyHint: true, openWorldHint: true },
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
  "Run a VEROQ AI agent by its slug. Agents are pre-built workflows that combine multiple data sources and analysis steps to accomplish complex tasks like portfolio reviews, due diligence, or market scans.",
  {
    slug: z.string().describe("Agent slug identifier (e.g. 'portfolio-review', 'due-diligence', 'market-scanner')"),
    inputs: z.record(z.unknown()).describe("Input parameters for the agent — varies by agent type (e.g. { ticker: 'AAPL' } or { tickers: ['AAPL', 'GOOGL'] })"),
  },
  { readOnlyHint: true, openWorldHint: true },
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


// ── Prompts ──

server.prompt(
  "financial_analysis",
  "Get a complete financial analysis of any ticker",
  { ticker: z.string().describe("Stock ticker symbol (e.g., NVDA)") },
  async ({ ticker }) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: `Use the veroq_ask tool to get a complete analysis of ${ticker}. Include price, technicals, earnings, sentiment, and trade signal. Then use veroq_full to get the full profile.` } }]
  })
);

server.prompt(
  "fact_check",
  "Verify a financial claim with evidence",
  { claim: z.string().describe("The claim to verify") },
  async ({ claim }) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: `Use the veroq_verify tool to fact-check this claim: "${claim}". Show the verdict, confidence breakdown, and evidence chain.` } }]
  })
);

server.prompt(
  "market_overview",
  "Get today's market overview with movers and trends",
  async () => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: "Use veroq_market_summary to get major indices, veroq_market_movers for top gainers/losers, and veroq_ask to summarize today's market trends." } }]
  })
);

// ── Resources ──

server.resource(
  "api-docs",
  "https://veroq.ai/api-reference",
  { mimeType: "text/html", description: "VEROQ API Reference — 300+ endpoints for financial intelligence" },
  async () => ({
    contents: [{ uri: "https://veroq.ai/api-reference", text: "VEROQ API Reference: https://veroq.ai/api-reference — 300+ endpoints covering ask, verify, search, price, technicals, screener, crypto, forex, commodities, economy, and more." }]
  })
);

server.resource(
  "pricing",
  "https://veroq.ai/pricing",
  { mimeType: "text/html", description: "VEROQ Pricing — Free tier: 1,000 credits/month" },
  async () => ({
    contents: [{ uri: "https://veroq.ai/pricing", text: "VEROQ Pricing: Free 1,000 credits/mo, Builder $24/mo (3K credits), Startup $79/mo (10K credits), Growth $179/mo (40K credits), Scale $399/mo (100K credits)." }]
  })
);

// --- Start ---

const mode = process.env.MCP_TRANSPORT || (process.argv.includes("--http") ? "http" : "stdio");

if (mode === "http") {
  const PORT = parseInt(process.env.PORT || "3100", 10);
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport }>();

  // Collect tool registrations so we can replay them on new server instances
  // The global `server` has all 52 tools — we use it for stdio mode
  // For HTTP, we create fresh instances per session

  const httpServer = createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // Smithery server card for discovery
    if (req.method === "GET" && req.url === "/.well-known/mcp/server-card.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        name: "veroq",
        description: "VEROQ — the trust protocol for agentic AI. 52 tools for verified financial intelligence: ask, verify, search, price, technicals, screener, and more. 1,061+ tickers.",
        version: "1.1.0",
        homepage: "https://veroq.ai",
        repository: "https://github.com/Veroq-api/veroq-mcp",
        tools: 52,
        capabilities: ["ask", "verify", "search", "price", "technicals", "earnings", "sentiment", "screener", "backtest", "full", "trending", "entities", "crypto", "forex", "commodities", "economy"],
        config: {
          VEROQ_API_KEY: { type: "string", required: true, description: "Your VEROQ API key. Get a free key at veroq.ai/pricing" }
        }
      }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Existing session — route to its transport
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    // New session — the global server can only connect once for stdio,
    // but for HTTP we need per-session handling. Use a single stateless approach:
    // create transport, connect server (closing previous if needed), handle request.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    // For simplicity, reuse the global server — close previous transport first
    try { await server.close(); } catch {}
    await server.connect(transport);
    await transport.handleRequest(req, res);

    // Track session for subsequent requests
    const sid = (transport as any).sessionId as string | undefined;
    if (sid) {
      sessions.set(sid, { transport });
      transport.onclose = () => sessions.delete(sid);
    }
  });

  // Clean stale sessions every 5 minutes
  setInterval(() => {
    if (sessions.size > 100) {
      const oldest = [...sessions.keys()].slice(0, sessions.size - 50);
      for (const sid of oldest) {
        sessions.get(sid)?.transport.close?.();
        sessions.delete(sid);
      }
    }
  }, 300_000);

  httpServer.listen(PORT, () => {
    console.error(`VEROQ MCP server (HTTP) listening on port ${PORT}`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
