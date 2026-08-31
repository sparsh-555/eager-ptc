export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  plans: PlanRecord[];
}

export interface CallRecord {
  id: string;
  tool: string;
  occurrence: number;
  decision: "speculate" | "defer" | "refuse";
  argClass: "literal" | "pure" | "tool" | "tainted";
  dependsOn: string[];
  sourceLoc: { line: number; column: number } | null;
  reason: string;
  startedAt: string | null;
  claimedAt: string | null;
  endedAt: string | null;
  workMs: number;
  attempts: number;
  retryReason: string | null;
  retryWaitMs: number;
  dedupedFrom: string | null;
  speculatedAtMs: number | null;
  outcome: "used" | "failed" | "not_run";
  workerAgentId: string | null;
  result: unknown | null;
  error: string | null;
}

export interface PlanRecord {
  id: string;
  agentId: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
  completedAt: string | null;
  calls: CallRecord[];
  error: string | null;
  request: {
    calls?: Array<{ tool: string; args: unknown }> | undefined;
    source?: string | undefined;
  };
  generation?: {
    source: string;
    rationale: string;
  } | undefined;
  totals: {
    callCount: number;
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
    retriedCalls: number;
    throttleEvents: number;
    minConcurrencyDuringRun: number;
    concurrencyEvents: Array<{ atMs: number; from: number; to: number; reason: string }>;
  };
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
