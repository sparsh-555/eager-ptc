import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { CallRecord, PlanRecord } from "../types.js";
import { JsonStore } from "../store.js";
import { analyzePlan, resolveAnalyzedCallArgs, type Decision } from "./analyzer.js";
import { argsHash, PromiseStore } from "./promise-store.js";
import { redactString, redactValue } from "./redact.js";
import { classifyError, type ErrorClass } from "./retry.js";
import type { ToolCtx, ToolRegistry } from "./tools.js";
import type { GeneratedPlan } from "./plan-generator.js";

export interface PlanCall { tool: string; args: unknown }

export interface PlanRequest {
  agentId: string;
  calls?: PlanCall[] | undefined;
  source?: string | undefined;
  mode?: "serial" | "concurrent" | undefined;
}

export interface PlanExecutionOptions {
  promiseStore?: PromiseStore;
  speculatedAtMsByCallId?: Map<string, number>;
  generation?: Pick<GeneratedPlan, "generationStartedAtMs" | "generationCompletedAtMs" | "rationale" | "speculations" | "speculationsLaunched" | "speculationsDiscarded">;
  validationErrors?: string[];
  /** Test seams; production defaults come from the EPTC environment variables. */
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  maxRetries?: number;
  maxConcurrency?: number;
  recoveryMs?: number;
}

interface InternalToolCtx extends ToolCtx { workerAgentId?: string }
interface ExecutionItem {
  id: string;
  tool: string;
  args: unknown;
  occurrence: number;
  decision: Decision;
  dependsOn: string[];
  call: CallRecord;
}
type CallState = "pending" | "running" | "used" | "failed" | "not_run";

const now = (): string => new Date().toISOString();
const maxConcurrency = (): number => {
  const configured = Number.parseInt(process.env.EPTC_MAX_CONCURRENCY ?? "8", 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 8;
};
const maxRetries = (): number => {
  const configured = Number.parseInt(process.env.EPTC_MAX_RETRIES ?? "3", 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 3;
};
const recoveryMs = (): number => {
  const configured = Number.parseInt(process.env.EPTC_RECOVERY_MS ?? "10000", 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 10_000;
};
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class PlanService {
  constructor(
    private readonly store: JsonStore,
    private readonly registry: ToolRegistry,
    private readonly onPlanCreated?: (plan: PlanRecord) => void,
  ) {}

  async execute(request: PlanRequest, options: PlanExecutionOptions = {}): Promise<PlanRecord> {
    const hasCalls = request.calls !== undefined;
    const hasSource = request.source !== undefined;
    if (hasCalls === hasSource) throw new HttpError(400, "Exactly one of calls or source is required");
    const mode = request.mode ?? "concurrent";
    const startedAt = Date.now();
    const analysis = hasSource ? analyzePlan(request.source ?? "", this.registry) : null;
    const occurrences = new Map<string, number>();
    const calls: CallRecord[] = hasSource ? (analysis?.calls ?? []).map((item) => ({
      id: item.id, tool: redactString(item.tool), occurrence: item.occurrence, decision: item.decision,
      argClass: item.argClass, dependsOn: item.dependsOn, sourceLoc: item.sourceLoc,
      reason: redactString(item.reason), startedAt: null, claimedAt: null, endedAt: null, workMs: 0, dedupedFrom: null,
      attempts: 0, retryReason: null, retryWaitMs: 0,
      speculatedAtMs: options.speculatedAtMsByCallId?.get(item.id) ?? null, outcome: "not_run",
      workerAgentId: null, result: null, error: null,
    })) : (request.calls ?? []).map((item) => {
      const occurrence = occurrences.get(item.tool) ?? 0;
      occurrences.set(item.tool, occurrence + 1);
      return {
        id: randomUUID(), tool: redactString(item.tool), occurrence, decision: "defer" as const,
        argClass: "literal" as const, dependsOn: [], sourceLoc: null, reason: "serial execution (step 1)",
        startedAt: null, claimedAt: null, endedAt: null, workMs: 0, dedupedFrom: null, speculatedAtMs: null,
        attempts: 0, retryReason: null, retryWaitMs: 0,
        outcome: "not_run" as const, workerAgentId: null, result: null, error: null,
      };
    });
    const plan: PlanRecord = {
      id: randomUUID(), agentId: request.agentId, status: "running", createdAt: now(), completedAt: null,
      calls, error: null,
      request: hasSource ? { source: redactString(request.source ?? "") } : { calls: structuredClone(request.calls ?? []) },
      generation: options.generation && hasSource ? {
        source: redactString(request.source ?? ""),
        rationale: redactString(options.generation.rationale),
      } : undefined,
      totals: this.totals(0, startedAt, mode, 0, options.promiseStore ?? new PromiseStore(), options.generation, undefined, calls.length),
    };
    await this.safeMutate((database) => database.plans.push(structuredClone(plan)));
    this.onPlanCreated?.(structuredClone(plan));

    const validationErrors = calls.length === 0
      ? ["plan contained no executable tool calls"]
      : [...(options.validationErrors ?? []), ...(analysis?.errors ?? [])];
    if (validationErrors.length > 0) {
      plan.status = "failed";
      plan.completedAt = now();
      plan.error = redactString(validationErrors.join("\n"));
      await this.persistProgress(plan, 0, startedAt, mode, 0, options.promiseStore ?? new PromiseStore(), options.generation);
      return structuredClone(plan);
    }

    const sourceById = new Map((analysis?.calls ?? []).map((call) => [call.id, call]));
    const order = hasSource ? analysis?.order ?? [] : plan.calls.map((call) => call.id);
    const items = order.flatMap((id) => {
      const index = plan.calls.findIndex((call) => call.id === id);
      const call = plan.calls[index];
      if (!call) return [];
      const analyzed = sourceById.get(id);
      return [{
        id,
        tool: analyzed?.tool ?? request.calls?.[index]?.tool ?? call.tool,
        args: analyzed?.args ?? request.calls?.[index]?.args,
        occurrence: analyzed?.occurrence ?? call.occurrence,
        decision: analyzed?.decision ?? call.decision,
        dependsOn: analyzed?.dependsOn ?? call.dependsOn,
        call,
      }];
    });
    await this.run(plan, items, analysis, startedAt, mode, options.promiseStore, options.generation, options);
    return structuredClone(plan);
  }

  async replay(id: string, mode: "serial" | "concurrent"): Promise<PlanRecord> {
    const plan = this.get(id);
    if (!plan) throw new HttpError(404, "Plan not found");
    return this.execute({ agentId: plan.agentId, ...structuredClone(plan.request), mode });
  }

  list(agentId?: string): PlanRecord[] {
    return this.store.snapshot().plans.filter((plan) => !agentId || plan.agentId === agentId)
      .map((plan, index) => ({ plan, index }))
      .sort((left, right) => right.plan.createdAt.localeCompare(left.plan.createdAt) || right.index - left.index)
      .map(({ plan }) => plan);
  }

  get(id: string): PlanRecord | undefined {
    return this.store.snapshot().plans.find((plan) => plan.id === id);
  }

  private async run(
    plan: PlanRecord,
    items: ExecutionItem[],
    analysis: ReturnType<typeof analyzePlan> | null,
    planStarted: number,
    mode: "serial" | "concurrent",
    sharedPromises?: PromiseStore,
    generation?: PlanExecutionOptions["generation"],
    executionOptions: PlanExecutionOptions = {},
  ): Promise<void> {
    const states = new Map(items.map((item) => [item.id, "pending" as CallState]));
    const results = new Map<string, unknown>();
    const promises = sharedPromises ?? new PromiseStore();
    const running = new Set<Promise<void>>();
    let active = 0;
    let maxActive = 0;
    let failed = false;
    const configuredConcurrency = Math.max(1, executionOptions.maxConcurrency ?? maxConcurrency());
    const retryLimit = Math.max(1, executionOptions.maxRetries ?? maxRetries());
    const recoveryWindow = Math.max(1, executionOptions.recoveryMs ?? recoveryMs());
    const clock = executionOptions.now ?? Date.now;
    const pause = executionOptions.sleep ?? sleep;
    const random = executionOptions.random ?? (() => 0.5 + Math.random());
    let liveConcurrency = configuredConcurrency;
    let minConcurrency = configuredConcurrency;
    let throttleEvents = 0;
    let lastThrottleAt: number | null = null;
    const concurrencyEvents: PlanRecord["totals"]["concurrencyEvents"] = [];
    const discardedSpeculationIds = new Set<string>();

    const recoverConcurrency = (): void => {
      if (lastThrottleAt === null) return;
      while (liveConcurrency < configuredConcurrency && clock() - lastThrottleAt >= recoveryWindow) {
        const from = liveConcurrency;
        liveConcurrency += 1;
        lastThrottleAt += recoveryWindow;
        concurrencyEvents.push({ atMs: Math.max(0, clock() - planStarted), from, to: liveConcurrency, reason: "recovery" });
      }
    };
    const recordThrottle = (): void => {
      throttleEvents += 1;
      const from = liveConcurrency;
      const to = Math.max(1, Math.floor(from / 2));
      liveConcurrency = to;
      minConcurrency = Math.min(minConcurrency, to);
      lastThrottleAt = clock();
      if (from !== to) concurrencyEvents.push({ atMs: Math.max(0, clock() - planStarted), from, to, reason: "throttle" });
    };
    const backoff = (attempt: number): number => Math.min(30_000, 500 * (2 ** attempt) * random());
    const discardSpeculation = (callId: string): void => {
      if (!generation?.speculations.some((item) => item.callId === callId) || discardedSpeculationIds.has(callId)) return;
      discardedSpeculationIds.add(callId);
      generation.speculationsDiscarded += 1;
    };

    const executeItem = async (item: ExecutionItem): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      states.set(item.id, "running");
      try {
        const spec = this.registry.get(item.tool);
        if (!spec) throw new Error("Unknown tool: " + item.call.tool);
        const resolved = analysis ? resolveAnalyzedCallArgs(analysis, item.id, results) : item.args;
        const parsed = spec.argsSchema.safeParse(resolved);
        if (!parsed.success) throw new Error(parsed.error.message);
        const context: InternalToolCtx = { planId: plan.id, callId: item.call.id, signal: new AbortController().signal };
        const direct = (): Promise<unknown> => spec.handler(parsed.data, context);
        const runWithRetries = async (initialAttempts = 0, fallThroughSpeculation = false): Promise<unknown> => {
          for (let attempts = initialAttempts + 1; attempts <= retryLimit; attempts += 1) {
            const workStarted = Date.now();
            item.call.claimedAt ??= new Date(workStarted).toISOString();
            item.call.attempts = attempts;
            try {
              const result = await direct();
              const workEnded = Date.now();
              item.call.startedAt = new Date(workStarted).toISOString();
              item.call.endedAt = new Date(workEnded).toISOString();
              item.call.workMs = Math.max(0, workEnded - workStarted);
              return result;
            } catch (error) {
              const workEnded = Date.now();
              const errorClass = classifyError(error);
              const failedAttemptMs = Math.max(0, workEnded - workStarted);
              if (errorClass === "throttle") recordThrottle();
              if (errorClass === "permanent") {
                item.call.retryWaitMs += failedAttemptMs;
                item.call.startedAt = new Date(workStarted).toISOString();
                item.call.endedAt = new Date(workEnded).toISOString();
                item.call.workMs = 0;
                throw error;
              }
              if (attempts === retryLimit) {
                item.call.retryWaitMs += failedAttemptMs;
                if (fallThroughSpeculation) {
                  discardSpeculation(item.id);
                  return runWithRetries(0, false);
                }
                item.call.startedAt = new Date(workStarted).toISOString();
                item.call.endedAt = new Date(workEnded).toISOString();
                item.call.workMs = 0;
                throw error;
              }
              item.call.retryReason = errorClass;
              item.call.retryWaitMs += failedAttemptMs;
              const delay = backoff(attempts - 1);
              item.call.retryWaitMs += delay;
              await pause(delay);
            }
          }
          throw new Error("Retry limit exhausted");
        };
        let result: unknown;
        const claim = async (key: { tool: string; argsHash: string; occurrence: number }): Promise<unknown> => {
          const claimed = promises.claimWithTiming(key, runWithRetries, item.call.id);
          if (claimed.created
            && generation?.speculations.some((speculation) => speculation.callId === item.id)
            && promises.workTimings(key).length > 1) {
            discardSpeculation(item.id);
          }
          item.call.claimedAt ??= now();
          try {
            return await claimed.promise;
          } catch (error) {
            const owner = claimed.ownerCallId ? items.find((candidate) => candidate.call.id === claimed.ownerCallId) : undefined;
            if (claimed.created || (owner && owner.call.id !== item.call.id)) throw error;
            const errorClass = classifyError(error);
            item.call.attempts = 1;
            item.call.retryWaitMs += claimed.timing.workMs;
            item.call.retryReason = errorClass === "permanent" ? null : errorClass;
            discardSpeculation(item.id);
            if (errorClass === "throttle") recordThrottle();
            if (errorClass === "permanent" || retryLimit === 1) throw error;
            const delay = backoff(0);
            item.call.retryWaitMs += delay;
            await pause(delay);
            return runWithRetries(1, true);
          } finally {
            const owner = claimed.ownerCallId ? items.find((candidate) => candidate.call.id === claimed.ownerCallId) : undefined;
            if (!claimed.created && owner && owner.call.id !== item.call.id && owner.call.startedAt !== null) {
              item.call.workMs = 0;
              item.call.dedupedFrom = claimed.ownerCallId;
              item.call.startedAt = owner.call.startedAt;
              item.call.endedAt = owner.call.endedAt;
              item.call.attempts = owner.call.attempts;
              item.call.retryReason = owner.call.retryReason;
            } else if (!claimed.created && item.call.startedAt === null) {
              item.call.startedAt = new Date(claimed.timing.startedAtMs).toISOString();
              item.call.workMs = claimed.timing.workMs;
              if (claimed.timing.endedAtMs !== null) item.call.endedAt = new Date(claimed.timing.endedAtMs).toISOString();
            }
          }
        };
        if (spec.deterministic) {
          try {
            result = await claim({ tool: item.tool, argsHash: argsHash(parsed.data), occurrence: 0 });
          } catch (error) {
            if (error instanceof Error && error.message === "Arguments are not JSON serializable") result = await runWithRetries();
            else throw error;
          }
        } else {
          try {
            result = await claim({ tool: item.tool, argsHash: argsHash(parsed.data), occurrence: item.occurrence });
          } catch (error) {
            if (error instanceof Error && error.message === "Arguments are not JSON serializable") result = await runWithRetries();
            else throw error;
          }
        }
        results.set(item.id, result);
        item.call.result = redactValue(result);
        item.call.workerAgentId = context.workerAgentId ?? null;
        item.call.outcome = "used";
        states.set(item.id, "used");
      } catch (error) {
        item.call.outcome = "failed";
        item.call.error = redactString(error instanceof Error ? error.message : String(error));
        plan.error ??= item.call.error;
        states.set(item.id, "failed");
        failed = true;
      } finally {
        item.call.endedAt ??= now();
        active -= 1;
      }
    };
    const start = (item: ExecutionItem): void => {
      const task = executeItem(item).finally(() => running.delete(task));
      running.add(task);
    };
    const priorBarriersComplete = (index: number): boolean => items.slice(0, index)
      .filter((item) => item.decision !== "speculate")
      .every((item) => states.get(item.id) === "used");
    const canStart = (item: ExecutionItem, index: number): boolean => {
      if (states.get(item.id) !== "pending" || failed) return false;
      if (item.dependsOn.some((dependency) => ["failed", "not_run"].includes(states.get(dependency) ?? "not_run"))) {
        states.set(item.id, "not_run");
        return false;
      }
      if (!item.dependsOn.every((dependency) => states.get(dependency) === "used")) return false;
      if (!priorBarriersComplete(index)) return false;
      return item.decision === "speculate" || items.slice(0, index).every((prior) => states.get(prior.id) === "used");
    };

    if (mode === "serial") {
      for (const item of items) {
        if (failed) break;
        if (item.dependsOn.some((dependency) => states.get(dependency) !== "used")) {
          states.set(item.id, "not_run");
          failed = true;
          break;
        }
        await executeItem(item);
      }
    } else {
      while (!failed && (running.size > 0 || [...states.values()].includes("pending"))) {
        let started = false;
        recoverConcurrency();
        while (!failed && active < liveConcurrency) {
          const next = items.find((item, index) => canStart(item, index));
          if (!next) break;
          start(next);
          started = true;
        }
        if (running.size > 0) {
          await Promise.race(running);
          continue;
        }
        if (!started) {
          const fallback = items.find((item) => states.get(item.id) === "pending");
          if (!fallback) break;
          await executeItem(fallback);
        }
      }
      await Promise.allSettled(running);
    }
    recoverConcurrency();
    plan.status = failed || [...states.values()].includes("failed") ? "failed" : "completed";
    plan.error ??= plan.status === "failed" ? "Plan execution failed" : null;
    plan.completedAt = now();
    const serialMs = plan.calls.reduce((total, call) => total + call.workMs, 0);
    await this.persistProgress(plan, serialMs, planStarted, mode, maxActive, promises, generation, {
      retriedCalls: plan.calls.filter((call) => call.attempts > 1).length,
      throttleEvents,
      minConcurrencyDuringRun: minConcurrency,
      concurrencyEvents,
    });
  }

  private totals(
    serialMs: number,
    started: number,
    mode: "serial" | "concurrent",
    maxConcurrent: number,
    store: PromiseStore,
    generation?: PlanExecutionOptions["generation"],
    resilience: Pick<PlanRecord["totals"], "retriedCalls" | "throttleEvents" | "minConcurrencyDuringRun" | "concurrencyEvents"> = {
      retriedCalls: 0, throttleEvents: 0, minConcurrencyDuringRun: maxConcurrency(), concurrencyEvents: [],
    },
    callCount = 0,
  ): PlanRecord["totals"] {
    const wallClockMs = Math.max(1, Date.now() - started);
    const storeStats = store.stats();
    const countedSpeculations = new Set<string>();
    const speculativeWorkDuringGenMs = generation ? generation.speculations.reduce((total, item) => {
      const key = JSON.stringify([item.key.tool, item.key.argsHash, item.key.occurrence]);
      if (countedSpeculations.has(key)) return total;
      countedSpeculations.add(key);
      return total + store.workTimings(item.key).reduce((work, timing) => {
        if (!timing.endedAtMs) return work;
        return work + Math.max(0, Math.min(timing.endedAtMs, generation.generationCompletedAtMs) - timing.startedAtMs);
      }, 0);
    }, 0) : 0;
    return {
      callCount,
      wallClockMs, serialMs, speedup: mode === "serial" || maxConcurrent <= 1 || serialMs === 0 ? 1 : Math.max(1, serialMs / wallClockMs),
      executionOverlapMs: mode === "serial" || maxConcurrent <= 1 ? 0 : Math.max(0, serialMs - wallClockMs),
      maxConcurrent, storeHits: storeStats.hits, storeMisses: storeStats.misses,
      generationMs: generation ? Math.max(0, generation.generationCompletedAtMs - generation.generationStartedAtMs) : 0,
      generationOverlapMs: generation && generation.speculations.length > 0
        ? Math.max(0, generation.generationCompletedAtMs - Math.max(...generation.speculations.map((item) => item.launchedAtMs))) : 0,
      speculativeWorkDuringGenMs,
      speculationsLaunched: generation?.speculationsLaunched ?? 0,
      speculationsDiscarded: generation?.speculationsDiscarded ?? 0,
      ...resilience,
    };
  }

  private async persistProgress(
    plan: PlanRecord,
    serialMs: number,
    started: number,
    mode: "serial" | "concurrent",
    maxConcurrent: number,
    store: PromiseStore,
    generation?: PlanExecutionOptions["generation"],
    resilience?: Pick<PlanRecord["totals"], "retriedCalls" | "throttleEvents" | "minConcurrencyDuringRun" | "concurrencyEvents">,
  ): Promise<void> {
    plan.totals = this.totals(serialMs, started, mode, maxConcurrent, store, generation, resilience, plan.calls.length);
    await this.safeMutate((database) => {
      const index = database.plans.findIndex((item) => item.id === plan.id);
      if (index >= 0) database.plans[index] = structuredClone(plan);
    });
  }

  private async safeMutate(mutator: (database: { plans: PlanRecord[] }) => void): Promise<void> {
    try { await this.store.mutate(mutator); } catch { /* persistence must not alter execution */ }
  }
}
