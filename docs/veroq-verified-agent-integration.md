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
│              61 MCP Tools                         │
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
| `test/verified-swarm.test.ts` | 22 tests — creation, execution, verification, escalation, memory, budget |
| `src/feedback/veroq-feedback-loop.ts` | Feedback loop — flagging, web search fallback, pipeline routing |
| `src/feedback/index.ts` | Feedback module barrel export |
| `test/feedback-loop.test.ts` | 17 tests — flagging, web search, pipeline, privacy, metrics |
| `src/runtime/veroq-agent-runtime.ts` | Verified Agent Runtime — domain-specific pipeline factory |
| `src/runtime/vertical-kits.ts` | Vertical kits — finance, legal, research, compliance, custom |
| `src/runtime/index.ts` | Runtime module barrel export |
| `test/agent-runtime.test.ts` | 22 tests — verticals, safety, execution, multi-kit, guidelines |
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

### 6. Self-Improvement Feedback Loop (`src/feedback/veroq-feedback-loop.ts`)

Closed-loop system that automatically flags low-quality outputs and enriches them via web search fallback and Polaris pipeline integration.

**Fully opt-in** (`enableSelfImprovement: false` by default). Never affects real-time performance — all feedback collection is non-blocking.

#### How it works

```
Swarm Run → Analyze Each Step → Flag Issues → Web Search Fallback → Pipeline Routing
     │                │                │               │                   │
     │         Low confidence?    ┌────┴────┐    Fresh sources?      logSearchGap()
     │         Contradicted?      │ Flagged │    Enrich entry        → pipeline cron
     │         Escalated?         │  Entry  │         │              → self-learn job
     │         Data gap?          └────┬────┘    ┌────┴────┐         → markGapCovered()
     │                                 │         │ Enriched │
     │                                 └─────────┴──────────┘
     └─── result.feedback: FeedbackEntry[]
```

**Flagging triggers:**
- Low confidence (<`feedbackThreshold`, default 70)
- Contradicted verification verdicts
- Escalated high-stakes outputs
- Data gap indicators ("no results found", "unverifiable", etc.)
- Low-confidence verification status

**Web search fallback:** When gaps are detected and `enableWebSearchFallback` is true, the loop performs a web search to gather fresh sources. Results are attached to the feedback entry and can be used for re-evaluation.

**Pipeline integration:** When `autoRouteToPipeline` is true, flagged entries (with web search enrichment if available) are routed to `logSearchGap()` → pipeline cron → `self_learn_jobs` → brief generation → `markGapCovered()`.

**Privacy:** All feedback entries are sanitized — SSN-like numbers, email addresses, and card numbers are replaced with `[REDACTED]`.

#### Enable in Swarm

```typescript
const swarm = createVerifiedSwarm({
  roles: ["planner", "researcher", "verifier", "critic", "synthesizer"],
  enableSelfImprovement: true,       // opt-in
  feedbackThreshold: 70,             // flag below this confidence
  enableWebSearchFallback: true,     // web search on data gaps
  autoRouteToPipeline: false,        // manual review before pipeline
  apiFn: myApiFunction,
});

const result = await swarm.run("Analyze NVDA");
console.log(result.feedback);       // FeedbackEntry[]
```

#### Enable via Enterprise Config

```typescript
configureEnterprise({
  enterpriseId: "acme-capital",
  enableSelfImprovement: true,
  feedbackThreshold: 65,
  autoRouteToPipeline: true,
  enableWebSearchFallback: true,
});
```

#### Manual Feedback (MCP Tool)

```
Tool: veroq_process_feedback
Input: { "action": "submit", "sessionId": "swarm_123", "query": "NVDA analysis", "reason": "data_gap", "detail": "Missing insider data" }
```

#### SDK Usage

```typescript
// TypeScript
await client.submitFeedback({
  sessionId: result.sessionId,
  query: "NVDA analysis",
  reason: "low_confidence",
  detail: "RSI data was stale",
});
```

```python
# Python
client.submit_feedback(
    session_id=result["session_id"],
    query="NVDA analysis",
    reason="low_confidence",
    detail="RSI data was stale",
)
```

#### Observability

Feedback metrics are exposed via `getFeedbackMetrics()`:
- `totalFeedback` — total entries collected
- `byReason` — breakdown by flag type
- `webSearchFallbacks` — how many gaps triggered web search
- `webSearchSuccessRate` — percentage that found fresh sources
- `pipelineRouted` — entries sent to enrichment pipeline
- `avgFlaggedConfidence` — average confidence of flagged outputs
- `pendingCount` / `resolvedCount` — queue status

#### Long-term Impact

Over time, the feedback loop drives:
1. **Rising average confidence** — gaps get filled, brief coverage expands
2. **Fewer data gaps** — `search_gaps` table tracks demand, pipeline enriches
3. **Better source coverage** — web search fallback surfaces sources the pipeline missed
4. **Declining escalation rate** — enriched data reduces false positives
5. **Enterprise trust metrics** — audit trail shows improvement trajectory

### 7. General-Purpose Verified Agent Runtime (`src/runtime/`)

Transforms the Verified Swarm into a multi-domain runtime by loading "vertical kits" — pre-packaged configurations for specific domains.

#### Architecture

```
createRuntime({ vertical: "finance" })
        │
        ▼
  ┌─────────────┐      ┌────────────────────┐
  │ Vertical Kit │ ──→  │ Permission Engine   │ (domain deny/review rules)
  │ (finance)    │      └────────────────────┘
  │  roles       │      ┌────────────────────┐
  │  tools       │ ──→  │ Verified Swarm      │ (execution, caching, parallel)
  │  safety      │      └────────────────────┘
  │  thresholds  │      ┌────────────────────┐
  └─────────────┘ ──→  │ Feedback Loop       │ (self-improvement, web search)
                        └────────────────────┘
```

#### Built-in Verticals

| Vertical | Default Cost | Escalation | Denied Tools | Key Feature |
|----------|-------------|------------|--------------|-------------|
| **finance** | balanced | 80 | none | Full ticker/trade/verify pipeline |
| **legal** | premium | 70 | trading signal, ticker analysis | Citation verification, no financial tools |
| **research** | balanced | 85 | none | Multi-source fact-checking |
| **compliance** | premium | 60 | trading signal | Risk assessor role, low escalation |
| **custom** | balanced | 80 | none | User-defined everything |

#### Usage Examples

**Finance (default):**
```typescript
import { createRuntime } from "veroq-mcp";

const runtime = createRuntime({ vertical: "finance", enterpriseId: "acme" });
const result = await runtime.run("Analyze NVDA for a long position");
```

**Legal:**
```typescript
const runtime = createRuntime({
  vertical: "legal",
  costMode: "premium",
  enterpriseId: "law-firm-1",
});
const result = await runtime.run("Summarize GDPR data retention requirements");
// Trading tools are automatically denied
```

**Custom vertical:**
```typescript
import { registerVerticalKit, createRuntime } from "veroq-mcp";

registerVerticalKit({
  id: "healthcare",
  name: "Healthcare Research",
  defaultRoles: ["planner", "researcher", "verifier", "synthesizer"],
  defaultAgents: [
    { role: "planner", name: "Medical Planner", tool: "veroq_ask" },
    { role: "researcher", name: "Medical Researcher", tool: "veroq_ask" },
    { role: "verifier", name: "Clinical Verifier", tool: "veroq_verify" },
    { role: "synthesizer", name: "Medical Synthesizer" },
  ],
  coreTools: ["veroq_ask", "veroq_verify"],
  deniedTools: ["veroq_generate_trading_signal"],
  reviewTools: ["veroq_ask"],
  escalationThreshold: 65,
  defaultCostMode: "premium",
  defaultBudget: 30,
  highStakesPatterns: ["dosage", "drug interaction"],
  verificationGuidelines: "All medical claims require peer-reviewed sources.",
});

const runtime = createRuntime({ vertical: "healthcare" });
```

**MCP Tool:**
```
Tool: veroq_create_runtime
Input: { "vertical": "legal", "query": "GDPR data retention requirements", "costMode": "premium" }
```

**SDK:**
```typescript
// TypeScript
const result = await client.createRuntime("Analyze NVDA", { vertical: "finance" });

// Python
result = client.create_runtime("Analyze NVDA", vertical="finance")
```

#### How It Reuses the Existing Stack

| Component | How the runtime uses it |
|-----------|------------------------|
| **Vertical kits** | Provide roles, tools, safety rules, verification guidelines |
| **Verified Swarm** | Executes the pipeline with all existing features (budget, cache, parallel) |
| **Permission engine** | Auto-applies domain-specific deny/review rules from the kit |
| **Cost router** | Uses kit's `defaultCostMode` and `defaultBudget` |
| **Feedback loop** | Routes flagged items through self-improvement with web search fallback |
| **Observability** | All metrics flow through existing `recordToolCall()` |
| **Server enhancer** | Verification metadata injected on every tool call |

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
| Verified Swarm | 22 | ✓ |
| Cost Router | 20 | ✓ |
| Feedback Loop | 17 | ✓ |
| Agent Runtime | 23 | ✓ |
| Agent Coordinator | 22 | ✓ |
| Fact Checker | 16 | ✓ |
| **Total** | **167 (MCP) + 38 (demo)** | **All passing** |
