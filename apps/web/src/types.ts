export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

export type EptcDecision = "speculate" | "defer" | "refuse";
export type EptcOutcome = "used" | "failed" | "not_run";
export type EptcReplayMode = "serial" | "concurrent";

export interface EptcCall {
  id: string;
  tool: string;
  decision: EptcDecision;
  argClass: "literal" | "pure" | "tool" | "tainted";
  reason: string;
  dependsOn: string[];
  outcome: EptcOutcome;
  startedAt: string | number | null;
  claimedAt: string | number | null;
  endedAt: string | number | null;
  workMs: number;
  speculatedAtMs: number | null;
  dedupedFrom: string | null;
  sourceLoc: { line: number; column: number } | null;
  workerAgentId: string | null;
}

export interface EptcPlan {
  id: string;
  agentId: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
  completedAt: string | null;
  calls: EptcCall[];
  error: string | null;
  totals: {
    wallClockMs: number;
    serialMs: number;
    speedup: number;
    executionOverlapMs: number;
    maxConcurrent: number;
    storeHits: number;
    storeMisses: number;
    generationMs: number;
    generationOverlapMs: number;
    speculativeWorkDuringGenMs: number;
    speculationsLaunched: number;
    speculationsDiscarded: number;
  };
}
