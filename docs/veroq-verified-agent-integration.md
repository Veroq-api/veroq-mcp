# VeroQ Verified Agent Integration Guide

**Internal reference for the VeroQ team.**

## Overview

VeroQ provides the verified truth layer for AI agents. This guide covers the three new systems built on top of the MCP server that turn any agent workflow into verified, safe financial intelligence.

**VeroQ is the core product.** TradingAgents-Pro is a showcase demo — it demonstrates what's possible but is not the product itself. The product is the trust protocol: `/ask`, `/verify`, evidence chains, confidence breakdowns, and the safety engine that wraps it all.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  AI Agent / Client                │
├──────────────────────────────────────────────────┤
│              Permission Engine                    │
│  checkPermissions() → allow / deny / review       │
│  checkOutputSafety() → flag high-stakes outputs   │
│  Audit log + enterprise config                    │
├──────────────────────────────────────────────────┤
│              Tool Factory                         │
│  createVeroQTool() → register with permissions,   │
│  size limits, error handling, Zod validation       │
├──────────────────────────────────────────────────┤
│              Server Enhancer                      │
│  createEnhancedVeroQTool() → auto-inject          │
│  confidenceScore, evidenceChain, verificationStatus│
├──────────────────────────────────────────────────┤
│              52 MCP Tools                         │
│  veroq_ask, veroq_verify, veroq_search, ...       │
├──────────────────────────────────────────────────┤
│              VeroQ API                            │
│  api.veroq.ai — 300+ endpoints                   │
└──────────────────────────────────────────────────┘
```

## New Capabilities

### 1. Tool Factory (`src/tools/veroq-tool-factory.ts`)

Reusable system for registering MCP tools with automatic:
- Zod input/output validation
- Permission checking (via engine)
- Size limits (50KB default)
- Error handling with clear messages
- MCP annotations (readOnlyHint, openWorldHint)
- Tool registry for introspection

```typescript
import { createVeroQTool } from "./src/tools/index.js";

createVeroQTool(server, {
  name: "veroq_ask",
  description: "Ask any question",
  inputSchema: z.object({ question: z.string() }),
  execute: async ({ question }) => api("POST", "/api/v1/ask", undefined, { question }),
  display: (result) => result.summary,
  annotations: { readOnlyHint: true, openWorldHint: true },
  category: "intelligence",
  credits: 3,
});
```

### 2. Server Enhancer (`src/mcp/veroq-server-enhancer.ts`)

Wraps the tool factory to auto-inject verification metadata into every response:

- **confidenceScore** (0-100) — derived from API confidence level + trade signal score
- **evidenceChain** — array of `{ source, snippet, url, position, reliability, timestamp }`
- **verificationStatus** — `"verified"` | `"flagged"` | `"low-confidence"`
- **promptHint** — fact-checking recommendation for the LLM

```typescript
import { createEnhancedVeroQTool } from "./src/tools/index.js";

createEnhancedVeroQTool(server, {
  name: "veroq_ask",
  description: "Ask any question with verification",
  inputSchema: z.object({ question: z.string() }),
  apiCall: async ({ question }) => api("POST", "/api/v1/ask", undefined, { question }),
  metadataExtractor: "ask",  // or "verify" or "generic"
});
```

Response format:
```
[✓ VERIFIED] Confidence: 85/100

NVDA trades at $167.46, down 2.21%...

Evidence:
  [supports] Reuters (95% reliable)
    "NVIDIA reports record Q4 revenue"
  [supports] Bloomberg (94% reliable)

💡 This response contains financial data. Consider cross-checking with veroq_verify.
```

### 3. Permission Engine (`src/safety/veroq-permission-engine.ts`)

Centralized safety and permission control for all MCP tools:

- **Allow/deny/ask rules** with wildcard patterns (`veroq_*`, `veroq_admin_*`)
- **High-stakes detection** — trade decision queries ("Should I buy NVDA?") trigger review
- **Post-execution safety** — high-confidence outputs (>80) get flagged
- **Audit logging** — every decision logged with timestamp, tool, input, reason
- **Background agent restrictions** — non-interactive runs require explicit allow
- **Enterprise configuration** — one-call setup per customer

```typescript
import { checkPermissions, configureEnterprise } from "./src/tools/index.js";

// Enterprise setup
configureEnterprise({
  enterpriseId: "hedge-fund-1",
  deniedTools: ["veroq_screener*"],
  reviewTools: ["veroq_ask"],
  highStakesThreshold: 60,
  auditEnabled: true,
});

// Permission check (automatic in tool factory)
const result = checkPermissions("veroq_ask", { question: "Should I buy NVDA?" });
// → { decision: "review", reason: "High-stakes financial query", highStakesTriggered: true }
```

### 4. TradingAgents-Pro Integration (Demo)

Lightweight coordinator and fact-checker in the open-source TradingAgents-Pro repo:

- **VeroQ Agent Coordinator** — `startVeroQTeam()` creates multi-agent teams with auto-verification
- **VeroQ Fact Checker** — monitors agent outputs, routes through `/verify`, formats with `[✓ VERIFIED]` badges
- Plan → Execute → Review workflow with standard trading roles

**This is a demo, not the product.** It shows how any agent framework can plug into VeroQ.

## Key Files

### veroq-mcp repo

| File | Purpose |
|------|---------|
| `src/tools/veroq-tool-factory.ts` | Core tool registration with permissions + validation |
| `src/tools/index.ts` | Barrel export for all tools, enhancer, safety |
| `src/mcp/veroq-server-enhancer.ts` | Auto-inject verification metadata into tool responses |
| `src/safety/veroq-permission-engine.ts` | Allow/deny/review rules, audit, enterprise config |
| `src/safety/index.ts` | Safety module barrel export |
| `test/tool-factory.test.ts` | 8 tests — tool registration, metadata, display |
| `test/server-enhancer.test.ts` | 8 tests — enhanced tools, metadata extraction |
| `test/permission-engine.test.ts` | 28 tests — rules, high-stakes, audit, enterprise |
| `server.ts` | Main MCP server with 52 tools (unchanged) |

### TradingAgents-Pro repo (demo)

| File | Purpose |
|------|---------|
| `tradingagents/coordinator/veroq_agent_coordinator.py` | Team coordination with auto-verification |
| `tradingagents/agents/veroq_fact_checker.py` | Automatic fact-checking layer |
| `tests/test_agent_coordinator.py` | 22 tests — team, tasks, messaging, workflow |
| `tests/test_fact_checker.py` | 16 tests — detection, formatting, integration |

## Usage Examples

### Enable Auto-Verification in Agent Workflows

```python
from tradingagents.coordinator import startVeroQTeam

team = startVeroQTeam({
    "agents": [
        {"name": "Bull", "role": "bull_analyst"},
        {"name": "Bear", "role": "bear_analyst"},
        {"name": "Risk", "role": "risk_manager"},
        {"name": "CIO", "role": "cio"},
    ],
    "enableAutoVerification": True,  # default
})

result = team.run("Analyze NVDA for a potential long position")

# Every agent output includes verification:
# {
#   "agent": "Bull",
#   "output": "NVDA trades at $167...",
#   "formatted": "[✓ VERIFIED] Confidence: 85/100\n\nNVDA trades at $167...\n\nEvidence: Reuters (supports)...",
#   "verification": {
#     "confidenceScore": 85,
#     "evidenceChain": [...],
#     "verificationStatus": "verified"
#   }
# }
```

### Enterprise Permissions

```typescript
import { configureEnterprise, checkPermissions } from "veroq-mcp";

// One-call setup for a hedge fund customer
configureEnterprise({
  enterpriseId: "acme-capital",
  reviewTools: ["veroq_ask"],           // All /ask queries go through review
  deniedTools: ["veroq_screener*"],     // No screener access
  highStakesThreshold: 60,              // Flag anything above 60% confidence
  restrictBackgroundAgents: true,        // Manual approval for automated runs
  auditEnabled: true,                    // Full audit trail
});

// Normal query — allowed
checkPermissions("veroq_ticker", { symbol: "AAPL" });
// → { decision: "allow" }

// Trade decision query — flagged for review
checkPermissions("veroq_ask", { question: "Should I buy NVDA?" });
// → { decision: "review", highStakesTriggered: true }

// Screener — denied
checkPermissions("veroq_screener_natural", { query: "oversold tech" });
// → { decision: "deny" }
```

## Customer-Facing Blurb

> **VeroQ turns any agent workflow into verified, safe financial intelligence.** Every claim is fact-checked with evidence chains. Every output includes confidence breakdowns and source reliability scores. Enterprise customers get safety rules, audit trails, and human-in-the-loop review triggers for high-stakes decisions.
>
> Try the open [TradingAgents-Pro](https://github.com/Veroq-api/TradingAgents-Pro) demo to see it in action, then upgrade for enterprise safety rules, higher limits, and dedicated support.
>
> [veroq.ai](https://veroq.ai) · [API Reference](https://veroq.ai/api-reference) · [Pricing](https://veroq.ai/pricing)

## Team Rollout Checklist

- [ ] Update SDK docs (Python, TypeScript) with verification metadata examples
- [ ] Update API reference with `receipt`, `confidence_breakdown`, `evidence_chain` fields
- [ ] Announce MCP improvements — Smithery listing updated (95/100 score)
- [ ] Update Cursor Directory listing with permission engine mention
- [ ] Blog post: "Introducing VeroQ Safety Engine — Enterprise-Grade Trust for AI Agents"
- [ ] Add permission engine to cookbook examples
- [ ] Update TradingAgents-Pro README with latest coordinator examples
- [ ] Add enterprise config example to veroq-cookbook
- [ ] Notify Glama founder about new capabilities
- [ ] Submit PR to awesome-mcp-servers with updated description
- [ ] Update OpenClaw skill description to mention safety engine
- [ ] Prepare enterprise pricing tier with audit + permissions features

## Test Coverage

| Suite | Tests | Status |
|-------|-------|--------|
| Tool Factory | 8 | ✓ |
| Server Enhancer | 8 | ✓ |
| Permission Engine | 28 | ✓ |
| Agent Coordinator | 22 | ✓ |
| Fact Checker | 16 | ✓ |
| **Total** | **82** | **All passing** |
