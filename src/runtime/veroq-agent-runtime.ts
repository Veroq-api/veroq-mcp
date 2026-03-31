// ============================================================
// VEROQ Verified Agent Runtime — General-purpose multi-domain
// runtime that composes vertical kits with the swarm engine.
// ============================================================
// Creates domain-specific verified agent pipelines by combining:
// - Vertical kits (roles, tools, safety rules)
// - Swarm engine (execution, caching, parallelism)
// - Permission engine (allow/deny/escalation)
// - Feedback loop (self-improvement, web search fallback)
// - Cost router (model routing, budget tracking)
// ============================================================

import {
  createVerifiedSwarm,
  VerifiedSwarm,
  type SwarmConfig,
  type SwarmResult,
  type SwarmRole,
  type SwarmAgent,
} from "../swarm/index.js";
import type { CostMode } from "../swarm/cost-router.js";
import {
  configureEnterprise,
  setPermissionContext,
  type EnterpriseConfig,
} from "../safety/index.js";
import {
  getVerticalKit,
  getAvailableVerticals,
  registerVerticalKit,
  type VerticalId,
  type VerticalKit,
} from "./vertical-kits.js";
import type { FeedbackEntry } from "../feedback/index.js";
import type { WebSearchFallbackResult } from "../feedback/veroq-feedback-loop.js";

// ── Types ──

export interface RuntimeConfig {
  /** Which vertical to use (default: "finance") */
  vertical?: VerticalId;
  /** Additional kits to enable alongside the primary vertical */
  enabledKits?: VerticalId[];
  /** Enterprise ID for audit trail */
  enterpriseId?: string;
  /** Session ID */
  sessionId?: string;

  /** Override default cost mode from vertical kit */
  costMode?: CostMode;
  /** Override default credit budget from vertical kit */
  creditBudget?: number;
  /** Override default escalation threshold from vertical kit */
  escalationThreshold?: number;

  /** Override default roles from vertical kit */
  roles?: SwarmRole[];
  /** Additional custom agents (merged with vertical defaults) */
  customAgents?: SwarmAgent[];

  /** Enable self-improvement feedback loop (default: false) */
  enableSelfImprovement?: boolean;
  /** Enable web search fallback (default: true) */
  enableWebSearchFallback?: boolean;
  /** Enable parallel execution (default: false) */
  enableParallelSteps?: boolean;

  /** API function for making VeroQ API calls */
  apiFn?: SwarmConfig["apiFn"];
  /** Web search function (injected) */
  webSearchFn?: (query: string) => Promise<WebSearchFallbackResult>;
  /** Pipeline routing function (injected) */
  pipelineRouteFn?: (entry: FeedbackEntry) => Promise<Record<string, unknown>>;

  /** Custom vertical kit (for vertical="custom") */
  customKit?: Partial<VerticalKit>;
}

export interface RuntimeInfo {
  vertical: VerticalId;
  kit: VerticalKit;
  enabledKits: VerticalId[];
  sessionId: string;
  costMode: CostMode;
  creditBudget: number;
  escalationThreshold: number;
  roles: SwarmRole[];
  coreTools: string[];
  deniedTools: string[];
  reviewTools: string[];
  verificationGuidelines: string;
}

// ── Runtime Class ──

/**
 * Create a Verified Agent Runtime for a specific domain.
 *
 * The runtime assembles a vertical kit (roles, tools, safety rules)
 * and creates a configured swarm that enforces domain-specific
 * verification, permissions, and cost controls.
 *
 * @example
 * ```typescript
 * const runtime = createRuntime({ vertical: "finance", enterpriseId: "acme" });
 * const result = await runtime.run("Analyze NVDA for a long position");
 * ```
 */
export function createRuntime(config: RuntimeConfig = {}): VerifiedAgentRuntime {
  return new VerifiedAgentRuntime(config);
}

export class VerifiedAgentRuntime {
  readonly vertical: VerticalId;
  readonly kit: VerticalKit;
  readonly enabledKits: VerticalKit[];
  private mergedCoreTools: string[];
  private mergedDeniedTools: string[];
  private mergedReviewTools: string[];
  private swarmConfig: SwarmConfig;
  private swarm: VerifiedSwarm | null = null;

  constructor(config: RuntimeConfig = {}) {
    this.vertical = config.vertical ?? "finance";

    // Load primary kit
    let primaryKit = getVerticalKit(this.vertical);

    // Apply custom overrides for "custom" vertical
    if (this.vertical === "custom" && config.customKit) {
      primaryKit = { ...primaryKit, ...config.customKit, id: "custom" as VerticalId };
    }
    this.kit = primaryKit;

    // Load additional kits
    this.enabledKits = [primaryKit];
    if (config.enabledKits) {
      for (const kitId of config.enabledKits) {
        if (kitId !== this.vertical) {
          this.enabledKits.push(getVerticalKit(kitId));
        }
      }
    }

    // Merge tools from all enabled kits (store for getInfo)
    this.mergedCoreTools = [...new Set(this.enabledKits.flatMap(k => k.coreTools))];
    this.mergedDeniedTools = [...new Set(this.enabledKits.flatMap(k => k.deniedTools))];
    this.mergedReviewTools = [...new Set(this.enabledKits.flatMap(k => k.reviewTools))];
    const allDenied = this.mergedDeniedTools;
    const allReview = this.mergedReviewTools;

    // Resolve agents: start with primary kit defaults, overlay custom agents
    const agents = [...primaryKit.defaultAgents];
    if (config.customAgents) {
      for (const custom of config.customAgents) {
        const idx = agents.findIndex(a => a.role === custom.role);
        if (idx >= 0) {
          agents[idx] = custom;
        } else {
          agents.push(custom);
        }
      }
    }

    // Build swarm config from kit + overrides
    this.swarmConfig = {
      sessionId: config.sessionId,
      enterpriseId: config.enterpriseId,
      roles: config.roles ?? primaryKit.defaultRoles,
      agents,
      enableAutoVerification: true,
      escalationThreshold: config.escalationThreshold ?? primaryKit.escalationThreshold,
      costMode: config.costMode ?? primaryKit.defaultCostMode,
      creditBudget: config.creditBudget ?? primaryKit.defaultBudget,
      enableParallelSteps: config.enableParallelSteps ?? false,
      enableSelfImprovement: config.enableSelfImprovement ?? false,
      enableWebSearchFallback: config.enableWebSearchFallback ?? true,
      apiFn: config.apiFn,
      webSearchFn: config.webSearchFn,
      pipelineRouteFn: config.pipelineRouteFn,
    };

    // Apply domain-specific permission rules
    if (config.enterpriseId) {
      configureEnterprise({
        enterpriseId: config.enterpriseId,
        sessionId: config.sessionId,
        deniedTools: allDenied,
        reviewTools: allReview,
        escalationThreshold: this.swarmConfig.escalationThreshold,
        escalationPauses: true,
        auditEnabled: true,
      });
    } else if (allDenied.length > 0 || allReview.length > 0) {
      // Apply rules even without enterprise ID
      setPermissionContext({
        alwaysAllowRules: [{ pattern: "veroq_*" }],
        alwaysDenyRules: allDenied.map(t => ({ pattern: t })),
        alwaysAskRules: allReview.map(t => ({ pattern: t })),
        escalationThreshold: this.swarmConfig.escalationThreshold ?? 80,
      });
    }
  }

  /** Get runtime info for introspection */
  getInfo(): RuntimeInfo {
    return {
      vertical: this.vertical,
      kit: this.kit,
      enabledKits: this.enabledKits.map(k => k.id),
      sessionId: this.swarmConfig.sessionId || "",
      costMode: this.swarmConfig.costMode ?? "balanced",
      creditBudget: this.swarmConfig.creditBudget ?? 50,
      escalationThreshold: this.swarmConfig.escalationThreshold ?? 80,
      roles: this.swarmConfig.roles ?? [],
      coreTools: this.mergedCoreTools,
      deniedTools: this.mergedDeniedTools,
      reviewTools: this.mergedReviewTools,
      verificationGuidelines: this.kit.verificationGuidelines,
    };
  }

  /** Get the underlying swarm config */
  getSwarmConfig(): Readonly<SwarmConfig> {
    return this.swarmConfig;
  }

  /** Run a query through the runtime's verified agent pipeline */
  async run(query: string): Promise<SwarmResult> {
    this.swarm = createVerifiedSwarm(this.swarmConfig);
    return this.swarm.run(query);
  }

  /** Get the last swarm instance (for inspecting cache, memory, etc.) */
  getSwarm(): VerifiedSwarm | null {
    return this.swarm;
  }
}
