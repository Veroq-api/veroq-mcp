// Lightweight metrics collector for MCP tool calls

export interface ToolMetric {
  toolName: string;
  calls: number;
  errors: number;
  totalLatencyMs: number;
  lastCallAt: string;
  highStakesTriggers: number;
  escalations: number;
  avgConfidence: number;
  confidenceSum: number;
}

const metrics = new Map<string, ToolMetric>();

export function recordToolCall(
  toolName: string,
  latencyMs: number,
  error: boolean,
  highStakes: boolean,
  escalated: boolean,
  confidence?: number,
): void {
  const existing = metrics.get(toolName) || {
    toolName, calls: 0, errors: 0, totalLatencyMs: 0,
    lastCallAt: '', highStakesTriggers: 0, escalations: 0,
    avgConfidence: 0, confidenceSum: 0,
  };
  existing.calls++;
  if (error) existing.errors++;
  existing.totalLatencyMs += latencyMs;
  existing.lastCallAt = new Date().toISOString();
  if (highStakes) existing.highStakesTriggers++;
  if (escalated) existing.escalations++;
  if (confidence != null) {
    existing.confidenceSum += confidence;
    existing.avgConfidence = existing.confidenceSum / existing.calls;
  }
  metrics.set(toolName, existing);
}

export function getMetrics(): Record<string, ToolMetric> {
  return Object.fromEntries(metrics);
}

export function getMetricsSummary(): {
  totalCalls: number;
  totalErrors: number;
  avgLatencyMs: number;
  highStakesRate: number;
  escalationRate: number;
  toolBreakdown: ToolMetric[];
} {
  let totalCalls = 0, totalErrors = 0, totalLatency = 0, totalHS = 0, totalEsc = 0;
  const breakdown: ToolMetric[] = [];

  for (const m of metrics.values()) {
    totalCalls += m.calls;
    totalErrors += m.errors;
    totalLatency += m.totalLatencyMs;
    totalHS += m.highStakesTriggers;
    totalEsc += m.escalations;
    breakdown.push({ ...m, avgConfidence: m.calls > 0 ? m.confidenceSum / m.calls : 0 });
  }

  return {
    totalCalls,
    totalErrors,
    avgLatencyMs: totalCalls > 0 ? Math.round(totalLatency / totalCalls) : 0,
    highStakesRate: totalCalls > 0 ? Math.round((totalHS / totalCalls) * 100) : 0,
    escalationRate: totalCalls > 0 ? Math.round((totalEsc / totalCalls) * 100) : 0,
    toolBreakdown: breakdown.sort((a, b) => b.calls - a.calls),
  };
}

export function resetMetrics(): void {
  metrics.clear();
}
