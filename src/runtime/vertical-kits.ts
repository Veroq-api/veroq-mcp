// ============================================================
// VEROQ Vertical Kits — Domain-specific configurations for the
// Verified Agent Runtime. Each kit bundles roles, tools, safety
// rules, and verification guidelines for a specific domain.
// ============================================================

import type { SwarmRole, SwarmAgent } from "../swarm/veroq-verified-swarm.js";
import type { CostMode } from "../swarm/cost-router.js";
import type { PermissionRule } from "../safety/veroq-permission-engine.js";

// ── Types ──

export type VerticalId = "finance" | "legal" | "research" | "compliance" | "custom";

export interface VerticalKit {
  /** Unique vertical identifier */
  id: VerticalId;
  /** Display name */
  name: string;
  /** Description of what this vertical covers */
  description: string;

  /** Default agent roles for this vertical's pipeline */
  defaultRoles: SwarmRole[];
  /** Default agent definitions with domain-specific tool mappings */
  defaultAgents: SwarmAgent[];

  /** Tools that are core to this vertical */
  coreTools: string[];

  /** Permission rules: tools that should always be denied */
  deniedTools: string[];
  /** Permission rules: tools that require review */
  reviewTools: string[];

  /** Default escalation threshold for this vertical */
  escalationThreshold: number;
  /** Default cost mode */
  defaultCostMode: CostMode;
  /** Default credit budget */
  defaultBudget: number;

  /** High-stakes input patterns (regex strings) */
  highStakesPatterns: string[];
  /** Verification guidelines for this domain */
  verificationGuidelines: string;
}

// ── Finance Kit (flagship) ──

const FINANCE_KIT: VerticalKit = {
  id: "finance",
  name: "Financial Intelligence",
  description: "Market analysis, ticker research, trade signals, earnings, and verified financial claims.",

  defaultRoles: ["planner", "researcher", "verifier", "critic", "synthesizer"],
  defaultAgents: [
    { role: "planner", name: "Market Planner", tool: "veroq_comprehensive_intelligence" },
    { role: "researcher", name: "Financial Researcher", tool: "veroq_analyze_ticker" },
    { role: "verifier", name: "Claim Verifier", tool: "veroq_verify_market_claim" },
    { role: "critic", name: "Devil's Advocate" },
    { role: "synthesizer", name: "Portfolio Synthesizer" },
    // risk_assessor available as opt-in role (not in defaultRoles)
    { role: "risk_assessor", name: "Risk Analyst", tool: "veroq_generate_trading_signal" },
  ],

  coreTools: [
    "veroq_analyze_ticker",
    "veroq_verify_market_claim",
    "veroq_generate_trading_signal",
    "veroq_comprehensive_intelligence",
    "veroq_compare_tickers",
    "veroq_ask",
    "veroq_verify",
  ],

  deniedTools: [],
  reviewTools: ["veroq_generate_trading_signal"],

  escalationThreshold: 80,
  defaultCostMode: "balanced",
  defaultBudget: 50,

  highStakesPatterns: [
    "should\\s+(i|we)\\s+(buy|sell|trade|invest|short)",
    "position\\s+size",
    "stop\\s+loss",
    "margin|leverage",
  ],

  verificationGuidelines: "All financial claims must be verified against real-time market data. " +
    "Earnings, revenue, and price claims require source-level evidence. " +
    "Trade signals above 80/100 require human review before execution.",
};

// ── Legal Kit ──

const LEGAL_KIT: VerticalKit = {
  id: "legal",
  name: "Legal Research",
  description: "Case law research, regulatory analysis, compliance checking, and contract review.",

  defaultRoles: ["planner", "researcher", "verifier", "critic", "synthesizer"],
  defaultAgents: [
    { role: "planner", name: "Legal Planner", tool: "veroq_ask" },
    { role: "researcher", name: "Legal Researcher", tool: "veroq_ask" },
    { role: "verifier", name: "Citation Verifier", tool: "veroq_verify" },
    { role: "critic", name: "Opposing Counsel" },
    { role: "synthesizer", name: "Legal Synthesizer" },
  ],

  coreTools: ["veroq_ask", "veroq_verify", "veroq_search"],

  deniedTools: ["veroq_generate_trading_signal", "veroq_analyze_ticker"],
  reviewTools: ["veroq_ask"],

  escalationThreshold: 70,
  defaultCostMode: "premium",
  defaultBudget: 30,

  highStakesPatterns: [
    "attorney-client\\s+privilege",
    "binding\\s+(opinion|agreement)",
    "compliance\\s+violation",
    "regulatory\\s+action",
  ],

  verificationGuidelines: "All legal citations must be verified against authoritative sources. " +
    "Never present analysis as legal advice. Flag jurisdictional limitations.",
};

// ── Research Kit ──

const RESEARCH_KIT: VerticalKit = {
  id: "research",
  name: "General Research",
  description: "Multi-source research, fact-checking, evidence synthesis, and claim verification.",

  defaultRoles: ["planner", "researcher", "verifier", "critic", "synthesizer"],
  defaultAgents: [
    { role: "planner", name: "Research Planner", tool: "veroq_ask" },
    { role: "researcher", name: "Primary Researcher", tool: "veroq_ask" },
    { role: "verifier", name: "Fact Checker", tool: "veroq_verify" },
    { role: "critic", name: "Peer Reviewer" },
    { role: "synthesizer", name: "Research Synthesizer" },
  ],

  coreTools: ["veroq_ask", "veroq_verify", "veroq_search", "veroq_feed"],

  deniedTools: [],
  reviewTools: [],

  escalationThreshold: 85,
  defaultCostMode: "balanced",
  defaultBudget: 40,

  highStakesPatterns: [
    "medical\\s+(advice|diagnosis|treatment)",
    "life-threatening",
  ],

  verificationGuidelines: "Cross-reference claims across multiple sources. " +
    "Clearly distinguish verified facts from analysis or opinion. " +
    "Flag when source quality is low or evidence is insufficient.",
};

// ── Compliance Kit ──

const COMPLIANCE_KIT: VerticalKit = {
  id: "compliance",
  name: "Compliance & Risk",
  description: "Regulatory compliance monitoring, risk assessment, policy verification.",

  defaultRoles: ["planner", "researcher", "verifier", "risk_assessor", "critic", "synthesizer"],
  defaultAgents: [
    { role: "planner", name: "Compliance Planner", tool: "veroq_ask" },
    { role: "researcher", name: "Regulatory Researcher", tool: "veroq_ask" },
    { role: "verifier", name: "Policy Verifier", tool: "veroq_verify" },
    { role: "risk_assessor", name: "Risk Assessor", tool: "veroq_ask" },
    { role: "critic", name: "Audit Reviewer" },
    { role: "synthesizer", name: "Compliance Synthesizer" },
  ],

  coreTools: ["veroq_ask", "veroq_verify", "veroq_search"],

  deniedTools: ["veroq_generate_trading_signal"],
  reviewTools: ["veroq_ask", "veroq_verify"],

  escalationThreshold: 60,
  defaultCostMode: "premium",
  defaultBudget: 40,

  highStakesPatterns: [
    "sanctions?\\s+(violation|breach|screening)",
    "anti-money\\s+laundering|AML",
    "know\\s+your\\s+customer|KYC",
    "SEC\\s+(filing|violation|investigation)",
  ],

  verificationGuidelines: "All regulatory claims require authoritative sourcing. " +
    "Flag any potential compliance violations for human review. " +
    "Maintain full audit trail with decision lineage.",
};

// ── Kit Registry ──

const KITS: Record<VerticalId, VerticalKit> = {
  finance: FINANCE_KIT,
  legal: LEGAL_KIT,
  research: RESEARCH_KIT,
  compliance: COMPLIANCE_KIT,
  custom: {
    id: "custom",
    name: "Custom Vertical",
    description: "User-defined vertical with custom roles, tools, and safety rules.",
    defaultRoles: ["planner", "researcher", "verifier", "critic", "synthesizer"],
    defaultAgents: [
      { role: "planner", name: "Planner", tool: "veroq_ask" },
      { role: "researcher", name: "Researcher", tool: "veroq_ask" },
      { role: "verifier", name: "Verifier", tool: "veroq_verify" },
      { role: "critic", name: "Critic" },
      { role: "synthesizer", name: "Synthesizer" },
    ],
    coreTools: ["veroq_ask", "veroq_verify"],
    deniedTools: [],
    reviewTools: [],
    escalationThreshold: 80,
    defaultCostMode: "balanced",
    defaultBudget: 50,
    highStakesPatterns: [],
    verificationGuidelines: "Verify claims against available sources.",
  },
};

/** Get a vertical kit by ID */
export function getVerticalKit(id: VerticalId): VerticalKit {
  return KITS[id] || KITS.custom;
}

/** Get all available vertical IDs */
export function getAvailableVerticals(): VerticalId[] {
  return Object.keys(KITS) as VerticalId[];
}

/** Built-in kit IDs that cannot be overwritten */
const BUILT_IN_IDS = new Set<string>(["finance", "legal", "research", "compliance", "custom"]);

/** Register a custom vertical kit. Cannot overwrite built-in kits. */
export function registerVerticalKit(kit: VerticalKit): void {
  if (BUILT_IN_IDS.has(kit.id)) {
    throw new Error(`Cannot overwrite built-in vertical "${kit.id}". Use a unique ID.`);
  }
  KITS[kit.id as VerticalId] = kit;
}
