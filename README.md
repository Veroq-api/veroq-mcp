# veroq-mcp

**Verified AI. One function call.** Stop shipping hallucinations.

62 MCP tools. `shield()` any LLM output. Evidence chains on every claim. Finance as flagship vertical, with legal, research, compliance, and custom domains built in.

[veroq.ai](https://veroq.ai) | [API Reference](https://veroq.ai/docs) | [Pricing](https://veroq.ai/pricing)

## Install

```bash
npm install -g veroq-mcp
```

Get your API key at [veroq.ai/settings](https://veroq.ai/settings).

## Quick Start

Once installed, two tools handle most use cases:

```
veroq_ask      "How is NVIDIA doing?"          → price, technicals, earnings, sentiment, news
veroq_verify   "Apple beat Q4 earnings by 20%"  → SUPPORTED (92%), 5 sources, evidence chain
```

For multi-agent workflows, use the Verified Swarm:

```
veroq_run_verified_swarm   { "query": "Analyze NVDA for a long position" }
→ 5 agents: planner → researcher → verifier → critic → synthesizer
→ Every step verified, escalation on high-stakes, full decision lineage
```

For domain-specific pipelines, use the Agent Runtime:

```
veroq_create_runtime   { "vertical": "finance", "query": "Analyze NVDA" }
veroq_create_runtime   { "vertical": "legal", "query": "GDPR data retention" }
```

## Why VeroQ?

| Capability | What you get |
|-----------|-------------|
| **Verified outputs** | Evidence chains, confidence breakdowns, source reliability scores on every response |
| **Enterprise safety** | Permission engine, decision lineage, human-in-the-loop escalation, full audit trails |
| **Multi-agent workflows** | Verified Swarm with 5-agent pipeline, budget control, parallel execution, caching |
| **Multi-domain runtime** | Finance (flagship), legal, research, compliance, custom verticals with domain-specific safety |
| **External MCP integration** | Securely proxy external APIs through VeroQ's permission engine, rate limiting, and audit |
| **Self-improvement** | Feedback loop flags low-confidence outputs, web search fallback fills data gaps |
| **Cost control** | 3 cost modes (cheap/balanced/premium), per-step budgets, credit transparency |
| **Observability** | Per-tool metrics, cache hit rates, escalation rates, feedback volume |

## IDE Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "veroq": {
      "command": "veroq-mcp",
      "env": { "VEROQ_API_KEY": "your-api-key" }
    }
  }
}
```

### Cursor

**Settings > MCP Servers > Add Server**: Name `veroq`, Command `veroq-mcp`, Env `VEROQ_API_KEY=your-api-key`.

## Tools (62)

### Hero Tools

| Tool | What it does | Cost |
|------|-------------|------|
| `veroq_ask` | Ask any financial question — routes to 41 intents automatically | 1-5cr |
| `veroq_verify` | Fact-check any claim with evidence chain + confidence breakdown | 3cr |

### High-Level Tools

| Tool | What it does | Cost |
|------|-------------|------|
| `veroq_analyze_ticker` | Complete ticker analysis (price, technicals, earnings, sentiment, news) | 3cr |
| `veroq_verify_market_claim` | Fact-check financial claims with evidence and source reliability | 3cr |
| `veroq_generate_trading_signal` | NLP screener + composite trade signal | 5cr |
| `veroq_comprehensive_intelligence` | Market briefing (indices, movers, trending, yields) | 3cr |
| `veroq_compare_tickers` | Side-by-side comparison with correlation matrix | 3cr |
| `veroq_tool_search` | Context-aware tool discovery with filtering | free |

### Swarm & Runtime

| Tool | What it does | Cost |
|------|-------------|------|
| `veroq_run_verified_swarm` | Multi-agent pipeline with verification at every step | 15-25cr |
| `veroq_create_runtime` | Domain-specific runtime (finance, legal, research, compliance) | 10-25cr |
| `veroq_process_feedback` | Submit or query the self-improvement feedback loop | free |
| `veroq_call_external_tool` | Securely call registered external MCP servers | 1-5cr |

### Market Data (16 tools)

`veroq_ticker_price` (free), `veroq_full`, `veroq_candles`, `veroq_technicals`, `veroq_earnings`, `veroq_market_movers`, `veroq_market_summary`, `veroq_economy`, `veroq_forex`, `veroq_commodities`, `veroq_sectors`, `veroq_portfolio_feed`, `veroq_screener`, `veroq_screener_presets`, `veroq_alerts`, `veroq_ticker_score`

### Crypto (4 tools)

`veroq_crypto`, `veroq_crypto_chart`, `veroq_defi`, `veroq_defi_protocol`

### Search & Intelligence (15 tools)

`veroq_search`, `veroq_feed`, `veroq_brief`, `veroq_extract`, `veroq_entities`, `veroq_trending`, `veroq_compare`, `veroq_research`, `veroq_timeline`, `veroq_forecast`, `veroq_contradictions`, `veroq_events`, `veroq_diff`, `veroq_web_search`, `veroq_crawl`

### Fundamentals (5 tools)

`veroq_insider`, `veroq_filings`, `veroq_analysts`, `veroq_congress`, `veroq_institutions`

### Other (7 tools)

`veroq_ticker_news`, `veroq_ticker_analysis`, `veroq_search_suggest`, `veroq_social_sentiment`, `veroq_social_trending`, `veroq_ipo_calendar`, `veroq_run_agent`

### Reports (2 tools)

`veroq_generate_report`, `veroq_get_report`

## Programmatic Usage

VeroQ is also available as a TypeScript/Python library:

```typescript
import { createRuntime, registerExternalMcpServer } from "veroq-mcp";

// Finance runtime with external market data
const runtime = createRuntime({
  vertical: "finance",
  enterpriseId: "acme-capital",
  costMode: "balanced",
  enableSelfImprovement: true,
  externalServers: [{
    serverId: "bloomberg",
    serverUrl: "https://api.bloomberg.com",
    auth: { type: "bearer", credential: process.env.BLOOMBERG_TOKEN },
    allowedTools: ["get_security", "get_analytics"],
    trustLevel: "read-only",
  }],
});

const result = await runtime.run("Analyze NVDA for a long position");
console.log(result.synthesis.summary);
console.log(result.budget);           // { spent: 12, remaining: 38 }
console.log(result.verificationSummary); // { avgConfidence: 82, flaggedSteps: 0 }
```

### Verify Any LLM Output

```typescript
// Extract and verify every claim in arbitrary LLM text
const verified = await client.verifyOutput("NVIDIA's Q4 revenue exceeded $22B and margins expanded to 75%");
console.log(verified.claims);           // each claim with verdict, confidence, correction
console.log(verified.overall_confidence);
```

### Agent Memory

```typescript
// Store context tied to an agent
await client.memoryStore({ agent_id: "my-bot", key: "nvda-thesis", value: "bullish on AI capex" });

// Recall relevant context for a query
const context = await client.memoryRecall({ agent_id: "my-bot", query: "NVDA outlook" });

// List all stored memories
const memories = await client.memoryList({ agent_id: "my-bot" });
```

### Real-Time Verification Stream

```typescript
// Persistent SSE — pushes ticker_status, signal_change, confidence_change, claim_update
const stream = client.watch({ tickers: ["NVDA", "AAPL"], agent_id: "my-bot" });
stream.on("signal_change", (event) => console.log(event));
```

## Enterprise

Enterprise customers get:

- **Permission engine** — allow/deny/review rules with wildcard patterns
- **Decision lineage** — full rule evaluation trace for every tool call
- **Escalation** — high-stakes queries trigger human-in-the-loop review
- **Audit trails** — every decision logged with session tracking
- **External MCP** — securely proxy external APIs with trust levels and rate limits
- **Feedback loop** — self-improvement with web search fallback
- **Observability** — admin dashboard with verification stats, safety triggers, credit consumption

Contact [enterprise@veroq.ai](mailto:enterprise@veroq.ai) or visit [veroq.ai/pricing](https://veroq.ai/pricing).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VEROQ_API_KEY` | Yes | Your VEROQ API key |
| `VEROQ_BASE_URL` | No | API base URL (default: `https://api.veroq.ai`) |

`POLARIS_API_KEY` and `POLARIS_BASE_URL` accepted for backward compatibility.

## TradingAgents-Pro

[TradingAgents-Pro](https://github.com/Veroq-api/TradingAgents-Pro) is a demo showcasing what VeroQ can do — 15 agents running on the verified intelligence layer. **VeroQ is the product. TradingAgents-Pro is the showcase.**

## License

MIT
