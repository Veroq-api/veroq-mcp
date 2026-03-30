# veroq-mcp

[![npm](https://img.shields.io/npm/v/veroq-mcp?color=2EE89A&label=npm)](https://www.npmjs.com/package/veroq-mcp)
[![Downloads](https://img.shields.io/npm/dm/veroq-mcp?color=2EE89A)](https://www.npmjs.com/package/veroq-mcp)
[![License](https://img.shields.io/badge/license-MIT-2EE89A)](LICENSE)

MCP server for [VEROQ](https://veroq.ai) — verified financial intelligence for AI agents.

## Install

```bash
npm install -g veroq-mcp
```

## Get an API Key

Sign up and grab your key at [veroq.ai/settings](https://veroq.ai/settings).

## Quick Start

Once installed, just ask or verify:

- *"What's happening with NVIDIA this week?"* -- `veroq_ask`
- *"Fact-check: Apple is acquiring Disney"* -- `veroq_verify`

These two tools handle most use cases. The 50+ other tools are available when you need granular data.

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "veroq": {
      "command": "veroq-mcp",
      "env": {
        "VEROQ_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Cursor

Open **Settings > MCP Servers > Add Server**:

- **Name**: veroq
- **Command**: `veroq-mcp`
- **Environment**: `VEROQ_API_KEY=your-api-key`

## Tools

### Primary

| Tool | Description | Key Params |
|------|-------------|------------|
| `veroq_ask` | Ask any question about markets, companies, or economics | `question` |
| `veroq_verify` | Fact-check a claim against the intelligence corpus | `claim`, `context` |

### Search & Discovery

| Tool | Description | Key Params |
|------|-------------|------------|
| `veroq_search` | Search verified intelligence briefs | `query`, `category`, `depth`, `limit` |
| `veroq_feed` | Latest briefs feed | `category`, `limit`, `include_sources` |
| `veroq_brief` | Full brief by ID | `brief_id` |
| `veroq_extract` | Extract article content from URLs | `urls` (comma-separated) |
| `veroq_entities` | Briefs mentioning an entity | `name` |
| `veroq_trending` | Trending entities | `limit` |
| `veroq_compare` | Cross-source bias comparison | `topic` |
| `veroq_research` | Deep research report | `query`, `category`, `max_sources` |
| `veroq_timeline` | Story evolution timeline | `brief_id` |
| `veroq_forecast` | Topic forecasts | `topic`, `depth` |
| `veroq_contradictions` | Find contradictions across intelligence | `severity` |
| `veroq_events` | Notable events from briefs | `type`, `subject` |
| `veroq_diff` | Brief version diffs | `brief_id`, `since` |
| `veroq_web_search` | Web search with trust scoring | `query`, `limit` |
| `veroq_crawl` | Extract content from URLs | `url`, `depth` |

### Market Data

| Tool | Description | Key Params |
|------|-------------|------------|
| `veroq_ticker_price` | Live market price | `symbol` |
| `veroq_ticker_score` | Composite trading signal | `symbol` |
| `veroq_full` | Full ticker profile | `ticker` |
| `veroq_candles` | OHLCV candlestick data | `symbol`, `interval`, `range` |
| `veroq_technicals` | Technical indicators | `symbol`, `range` |
| `veroq_earnings` | Earnings data | `symbol` |
| `veroq_market_movers` | Top gainers/losers/active | |
| `veroq_market_summary` | Major market indices | |
| `veroq_economy` | Macroeconomic indicators | `indicator`, `limit` |
| `veroq_forex` | Foreign exchange rates | `pair` |
| `veroq_commodities` | Commodity prices | `symbol` |
| `veroq_sectors` | Sector sentiment overview | `days` |
| `veroq_portfolio_feed` | Portfolio-aware news | `holdings` |
| `veroq_screener` | Multi-criteria stock screener | filters |
| `veroq_screener_presets` | Pre-built screening strategies | `preset_id` |
| `veroq_alerts` | Price/sentiment alerts | `action`, `ticker` |

### Crypto

| Tool | Description | Key Params |
|------|-------------|------------|
| `veroq_crypto` | Cryptocurrency data | `symbol` |
| `veroq_crypto_chart` | Crypto price chart | `symbol`, `days` |
| `veroq_defi` | DeFi TVL and protocols | `protocol` |
| `veroq_defi_protocol` | DeFi protocol details | `protocol` |

### Fundamentals

| Tool | Description | Key Params |
|------|-------------|------------|
| `veroq_insider` | Insider trading activity | `ticker` |
| `veroq_filings` | SEC filings | `ticker` |
| `veroq_analysts` | Analyst ratings and targets | `ticker` |
| `veroq_congress` | Congressional trades | `symbol` |
| `veroq_institutions` | Institutional ownership | `ticker` |

### Other

| Tool | Description | Key Params |
|------|-------------|------------|
| `veroq_ticker_news` | Ticker-specific news | `symbol`, `limit` |
| `veroq_ticker_analysis` | Comprehensive ticker analysis | `symbol` |
| `veroq_search_suggest` | Search autocomplete | `query` |
| `veroq_economy_indicator` | Specific economic indicator | `indicator` |
| `veroq_social_sentiment` | Social media sentiment | `symbol` |
| `veroq_social_trending` | Social media trending | |
| `veroq_ipo_calendar` | IPO calendar | `days`, `limit` |
| `veroq_generate_report` | AI research reports | `ticker`, `tier` |
| `veroq_get_report` | Retrieve generated reports | `report_id` |
| `veroq_run_agent` | Run AI agents | `slug`, `inputs` |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VEROQ_API_KEY` | Yes | Your VEROQ API key |
| `VEROQ_BASE_URL` | No | API base URL (default: `https://api.thepolarisreport.com`) |

Note: `POLARIS_API_KEY` and `POLARIS_BASE_URL` are also accepted for backward compatibility.

## Links

- [VEROQ](https://veroq.ai) — Interactive demos
- [API Reference](https://veroq.ai/api-reference) — 300+ endpoints
- [Python SDK](https://github.com/Veroq-api/veroq-python)
- [TypeScript SDK](https://github.com/Veroq-api/veroq-js)
