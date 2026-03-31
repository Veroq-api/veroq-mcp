// ============================================================
// VEROQ MCP Tools — Barrel Export
// ============================================================

export {
  createVeroQTool,
  registerVeroQTools,
  setGlobalPermissionChecker,
  getRegisteredTools,
  type VeroQToolDefinition,
  type PermissionChecker,
  type LegacyPermissionRule,
  type DisplayCallback,
  type RegisteredTool,
} from "./veroq-tool-factory.js";

export {
  createEnhancedVeroQTool,
  enhanceServer,
  type VerificationStatus,
  type EvidenceItem,
  type VerificationMetadata,
  type EnhancedResponse,
} from "../mcp/veroq-server-enhancer.js";

export { registerHighLevelTools } from "./high-level-tools.js";

export {
  checkPermissions,
  checkOutputSafety,
  setPermissionContext,
  getPermissionContext,
  resetPermissionContext,
  getAuditLog,
  clearAuditLog,
  getFullAuditTrail,
  getDecisionLineage,
  configureEnterprise,
  type ToolPermissionContext,
  type PermissionMode,
  type PermissionDecision,
  type PermissionRule,
  type PermissionResult,
  type AuditEntry,
  type DecisionLineage,
  type RuleEvaluation,
  type EnterpriseConfig,
} from "../safety/index.js";

export {
  createVerifiedSwarm,
  VerifiedSwarm,
  SwarmMemory,
  type SwarmConfig,
  type SwarmRole,
  type SwarmAgent,
  type SwarmStepInput,
  type SwarmStepOutput,
  type SwarmStepResult,
  type SwarmResult,
  type SwarmMemoryEntry,
  type CostMode,
  type ModelTier,
  type StepCostRecord,
  type BudgetStatus,
  estimateStepCredits,
  estimatePipelineCost,
  BudgetTracker,
  StepCache,
  buildExecutionPlan,
  getModelTier,
} from "../swarm/index.js";

export {
  collectSwarmFeedback,
  submitFeedback,
  getFeedbackQueue,
  resolveFeedback,
  getFeedbackMetrics,
  resetFeedback,
  type FeedbackEntry,
  type FeedbackConfig,
  type FeedbackReason,
  type FeedbackMetrics,
  type WebSearchFallbackResult,
} from "../feedback/index.js";

export {
  createRuntime,
  VerifiedAgentRuntime,
  getVerticalKit,
  getAvailableVerticals,
  registerVerticalKit,
  type RuntimeConfig,
  type RuntimeInfo,
  type VerticalId,
  type VerticalKit,
} from "../runtime/index.js";
