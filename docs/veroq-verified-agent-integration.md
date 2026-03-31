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
│              Verified Swarm                       │
│  createVerifiedSwarm() → multi-agent pipeline     │
│  planner → researcher → verifier → critic → synth │
│  Auto-verification, memory, credit budget         │
├──────────────────────────────────────────────────┤
│              Permission Engine                    │
│  checkPermissions() → allow / deny / review       │
│  checkOutputSafety() → flag high-stakes outputs   │
│  Audit log + enterprise config + escalation       │
├──────────────────────────────────────────────────┤
│              Tool Factory + Enhancer              │
│  createVeroQTool() → permissions, validation      │
│  createEnhancedVeroQTool() → verification metadata│
├──────────────────────────────────────────────────┤
│              Observability                        │
│  recordToolCall() → latency, errors, escalations  │
│  getMetricsSummary() → rates, breakdown           │
├──────────────────────────────────────────────────┤
│              59 MCP Tools                         │
│  veroq_ask, veroq_verify, veroq_run_verified_swarm│
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

## Observability

### MCP Metrics

All tool calls are automatically tracked:
- Calls per tool, error rate, average latency
- High-stakes trigger rate and escalation frequency
- Average confidence per tool

Access via: `import { getMetricsSummary } from "./src/observability/index.js"`

### Backend Admin Endpoints

Enterprise customers get admin observability at:
- `GET /admin/observability/dashboard` — aggregated metrics
- `GET /admin/observability/verification-stats` — verification success rate
- `GET /admin/observability/safety-triggers` — escalation frequency
- `GET /admin/observability/tool-usage` — calls per intent
- `GET /admin/observability/credit-consumption` — credit breakdown
- `GET /admin/observability/high-stakes` — high-stakes query rate

All endpoints accept `?period=24h|7d|30d` parameter.

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
| `src/observability/metrics.ts` | Lightweight metrics collector for tool calls |
| `src/observability/index.ts` | Observability module barrel export |
| `test/observability.test.ts` | 8 tests — metrics recording, summary, rates |
| `src/swarm/veroq-verified-swarm.ts` | Verified Swarm — multi-agent workflows with auto-verification |
| `src/swarm/index.ts` | Swarm module barrel export |
| `test/verified-swarm.test.ts` | 18 tests — creation, execution, verification, escalation, memory, budget |
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

### 5. Verified Swarm (`src/swarm/veroq-verified-swarm.ts`)

Multi-agent financial workflow primitive with automatic verification, safety, and decision lineage at every step.

**Pipeline:** planner → researcher → verifier → critic → synthesizer

Each step automatically gets:
- Permission checks (via permission engine)
- Verification metadata injection
- Escalation detection for high-stakes outputs
- Decision lineage capture
- Metrics recording via observability module
- Shared memory with pruning

**Cost control:** Set `creditBudget` to cap total spending. Swarm stops early if budget exhausted.

#### MCP Tool

Exposed as `veroq_run_verified_swarm` — available to any MCP client:

```
Tool: veroq_run_verified_swarm
Input: { "query": "Analyze NVDA for a long position", "escalationThreshold": 75 }
Cost: ~15-25 credits
```

#### SDK Usage (TypeScript)

```typescript
import { VeroqClient } from "veroq-sdk";

const client = new VeroqClient({ apiKey: "vq_live_..." });

const result = await client.createVerifiedSwarm("Analyze NVDA for a long position", {
  roles: ["planner", "researcher", "verifier", "critic", "synthesizer"],
  escalationThreshold: 75,
  creditBudget: 30,
});

console.log(result.synthesis.summary);
console.log(result.verificationSummary);
// { stepsVerified: 3, stepsTotal: 5, avgConfidence: 78, flaggedSteps: 0 }
```

#### SDK Usage (Python)

```python
from veroq import VeroqClient

client = VeroqClient(api_key="vq_live_...")

result = client.create_verified_swarm(
    "Analyze NVDA for a long position",
    roles=["planner", "researcher", "verifier", "critic", "synthesizer"],
    escalation_threshold=75,
    credit_budget=30,
)

print(result["synthesis"]["summary"])
print(result["verification_summary"])
```

#### Direct MCP Usage (Protected Core)

```typescript
import { createVerifiedSwarm } from "veroq-mcp";

const swarm = createVerifiedSwarm({
  sessionId: "analysis-001",
  enterpriseId: "acme-capital",
  roles: ["planner", "researcher", "verifier", "critic", "risk_assessor", "synthesizer"],
  enableAutoVerification: true,
  escalationThreshold: 75,
  creditBudget: 30,
  apiFn: myApiFunction,
});

const result = await swarm.run("Is now a good time to invest in semiconductors?");

// Result includes:
// - steps[]: per-agent output, verification, lineage, escalation status
// - synthesis: final aggregated output
// - verificationSummary: { stepsVerified, avgConfidence, flaggedSteps }
// - escalated: boolean + escalationNotices[]
// - totalCreditsUsed, totalDurationMs
```

#### When to use Verified Swarm vs single tools

| Scenario | Use |
|----------|-----|
| Quick price check | `veroq_analyze_ticker` |
| Fact-check a single claim | `veroq_verify_market_claim` |
| Multi-perspective analysis with verification | **Verified Swarm** |
| Enterprise audit trail for a complex decision | **Verified Swarm** with `enterpriseId` |
| Automated trading pipeline with safety gates | **Verified Swarm** with `escalationThreshold: 70` |

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
| Permission Engine | 43 | ✓ |
| Observability | 8 | ✓ |
| Integration | 10 | ✓ |
| High-Level Tools | 8 | ✓ |
| Verified Swarm | 18 | ✓ |
| Agent Coordinator | 22 | ✓ |
| Fact Checker | 16 | ✓ |
| **Total** | **103 (MCP) + 38 (demo)** | **All passing** |
