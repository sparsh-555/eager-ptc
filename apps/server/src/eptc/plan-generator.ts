import { analyzePlan, resolveAnalyzedCallArgs } from "./analyzer.js";
import type { StreamFn } from "./ark-stream.js";
import { argsHash, type StoreKey, PromiseStore } from "./promise-store.js";
import { classifyError } from "./retry.js";
import type { ToolCtx, ToolRegistry } from "./tools.js";

export interface GeneratedPlan {
  source: string;
  rationale: string;
  generationStartedAtMs: number;
  generationCompletedAtMs: number;
  firstCodeTokenAtMs: number | null;
  speculations: { callId: string; launchedAtMs: number; key: StoreKey }[];
  speculationsLaunched: number;
  speculationsDiscarded: number;
  attempts: number;
  errors: string[];
}

interface ActiveSpeculation {
  callId: string;
  key: StoreKey;
  controller: AbortController;
  launchedAtMs: number;
  attempt: number;
  discarded: boolean;
  settled: boolean;
}

export interface PlanGeneratorOptions {
  speculation?: boolean;
  maxSpeculations?: number;
  /** Test seams; production defaults mirror the scheduler's resilience settings. */
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
}

const maxRetries = (): number => {
  const configured = Number.parseInt(process.env.EPTC_MAX_RETRIES ?? "3", 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 3;
};
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function extractDocument(buffer: string): { source: string; rationale: string; complete: boolean } {
  const begin = buffer.lastIndexOf("PLAN_BEGIN");
  if (begin < 0) return { source: "", rationale: "", complete: false };
  const rest = buffer.slice(begin + "PLAN_BEGIN".length).replace(/^\r?\n/, "");
  const end = rest.indexOf("PLAN_END");
  if (end < 0) return { source: rest, rationale: "", complete: false };
  const source = rest.slice(0, end).replace(/\s+$/, "");
  const fenced = /^\s*```[^\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(source);
  return {
    source: (fenced?.[1] ?? source).replace(/\s+$/, ""),
    rationale: rest.slice(end + "PLAN_END".length).replace(/^\r?\n/, ""),
    complete: true,
  };
}

function completedSource(buffer: string): string {
  const { source } = extractDocument(buffer);
  const newline = Math.max(source.lastIndexOf("\n"), source.lastIndexOf("\r"));
  return newline < 0 ? "" : source.slice(0, newline + 1);
}

function generationPrompt(goal: string, registry: ToolRegistry): string {
  return [
    "Create an execution plan for this goal: " + goal,
    "Emit PLAN_BEGIN immediately, before any prose or explanation.",
    "Use this complete worked example exactly as the syntax model:",
    "PLAN_BEGIN",
    "const a = await agent(\"researcher\", \"A prompt of at least fifteen words describing what to research here.\");",
    "const b = await agent(\"researcher\", \"A second prompt of at least fifteen words about a different subtopic.\");",
    "const c = await grep(\"keyword\", \"notes.txt\");",
    "return [a, b, c];",
    "PLAN_END",
    "Rules:",
    "- Every call is JavaScript: const <name> = await <tool>(<arg>, <arg>);",
    "- Arguments are positional, double-quoted strings, in the order given in the tool signatures.",
    "- Use one call per line and a const binding on every call.",
    "- Put no prose, comments, markdown fences, or backticks between PLAN_BEGIN and PLAN_END.",
    "- End the plan with a return [...] of the bindings.",
    "- The rationale goes AFTER PLAN_END, never before or inside.",
    "Tool signatures:",
    ...registry.list().map((tool) => tool.name + "(" + tool.paramNames.join(", ") + ")" + (tool.sideEffectFree ? "" : "  // side-effecting")),
  ].join("\n");
}

function retryPrompt(goal: string, registry: ToolRegistry, source: string, grammarErrors: string[]): string {
  return [
    "The previous plan was rejected. Produce a corrected replacement.",
    "Previous invalid plan text:",
    "PLAN_BEGIN",
    source,
    "PLAN_END",
    "Exact grammar errors:",
    ...grammarErrors,
    generationPrompt(goal, registry),
  ].join("\n");
}

export class PlanGenerator {
  private readonly speculation: boolean;
  private readonly maxSpeculations: number;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly store: PromiseStore,
    private readonly streamFn: StreamFn,
    private readonly opts: PlanGeneratorOptions = {},
  ) {
    this.speculation = opts.speculation ?? true;
    this.maxSpeculations = opts.maxSpeculations ?? 8;
  }

  async generate(goal: string, ctxFactory: (callId: string) => ToolCtx): Promise<GeneratedPlan> {
    const started = Date.now();
    const speculations: ActiveSpeculation[] = [];
    let launched = new Set<string>();
    let results = new Map<string, unknown>();
    const errors: string[] = [];
    const streamErrors: string[] = [];
    let firstCodeTokenAtMs: number | null = null;
    let buffer = "";
    let finalized = false;
    let activeAttempt = 0;
    let attempts = 0;
    let discarded = 0;
    let prompt = generationPrompt(goal, this.registry);
    const retryLimit = Math.max(1, this.opts.maxRetries ?? maxRetries());
    const pause = this.opts.sleep ?? sleep;
    const random = this.opts.random ?? (() => 0.5 + Math.random());
    const backoff = (attempt: number): number => Math.min(30_000, 500 * (2 ** attempt) * random());

    const discardAttemptSpeculations = (attempt: number): void => {
      for (const active of speculations) {
        if (active.attempt !== attempt || active.discarded) continue;
        active.discarded = true;
        active.controller.abort();
        try { this.store.remove(active.key); } catch { /* removal only affects the optimization */ }
        discarded += 1;
      }
    };

    const activeSpeculationCount = (): number => speculations.filter(
      (active) => active.attempt === activeAttempt && !active.discarded && !active.settled,
    ).length;

    const launchReady = (): void => {
      if (finalized || !this.speculation || activeSpeculationCount() >= this.maxSpeculations) return;
      const source = completedSource(buffer);
      if (!source.trim()) return;
      const analysis = analyzePlan(source, this.registry);
      if (analysis.errors.length) return;
      for (const call of analysis.calls) {
        if (activeSpeculationCount() >= this.maxSpeculations) break;
        if (launched.has(call.id)) continue;
        const spec = this.registry.get(call.tool);
        if (!spec || call.decision !== "speculate" || !spec.sideEffectFree || !call.dependsOn.every((id) => results.has(id))) continue;
        let args: unknown;
        try { args = resolveAnalyzedCallArgs(analysis, call.id, results); } catch { continue; }
        const parsed = spec.argsSchema.safeParse(args);
        if (!parsed.success) continue;
        let key: StoreKey;
        try {
          key = { tool: call.tool, argsHash: argsHash(parsed.data), occurrence: spec.deterministic ? 0 : call.occurrence };
        } catch { continue; }
        const controller = new AbortController();
        const active: ActiveSpeculation = { callId: call.id, key, controller, launchedAtMs: 0, attempt: activeAttempt, discarded: false, settled: false };
        try {
          const claimed = this.store.claimWithTiming(key, async () => {
            for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
              try {
                return await spec.handler(parsed.data, { ...ctxFactory(call.id), signal: controller.signal });
              } catch (error) {
                if (classifyError(error) === "permanent" || attempt === retryLimit) throw error;
                await pause(backoff(attempt - 1));
              }
            }
            throw new Error("Retry limit exhausted");
          }, call.id);
          active.launchedAtMs = claimed.timing.startedAtMs;
          const promise = claimed.promise;
          launched.add(call.id);
          speculations.push(active);
          void promise.then((result) => {
            active.settled = true;
            if (active.attempt !== activeAttempt || active.discarded || finalized) return;
            results.set(call.id, result);
            launchReady();
          }, () => {
            active.settled = true;
            if (active.attempt === activeAttempt && !active.discarded) {
              active.discarded = true;
              try { this.store.remove(active.key); } catch { /* removal only affects the optimization */ }
              discarded += 1;
            }
            if (active.attempt === activeAttempt && !finalized) launchReady();
          });
        } catch {
          // A store failure only removes the optimization; normal scheduling still runs the call.
        }
      }
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      try {
        for await (const delta of this.streamFn(prompt, controller.signal)) {
          buffer += delta.text;
          if (firstCodeTokenAtMs === null && extractDocument(buffer).source.trim()) firstCodeTokenAtMs = delta.atMs;
          launchReady();
        }
      } catch (error) {
        streamErrors.push(error instanceof Error ? error.message : String(error));
      }
      attempts = attempt + 1;
      const document = extractDocument(buffer);
      const analysis = document.complete ? analyzePlan(document.source, this.registry) : null;
      if (document.complete && analysis?.errors.length === 0) break;
      if (attempt === 0) {
        discardAttemptSpeculations(activeAttempt);
        activeAttempt += 1;
        launched = new Set<string>();
        results = new Map<string, unknown>();
        prompt = analysis?.errors.length
          ? retryPrompt(goal, this.registry, document.source, analysis.errors)
          : generationPrompt(goal, this.registry);
        buffer = "";
      }
    }

    finalized = true;
    const document = extractDocument(buffer);
    const finalAnalysis = document.complete ? analyzePlan(document.source, this.registry) : null;
    if (!document.complete) errors.push(...streamErrors, "grammar error: missing PLAN_BEGIN or PLAN_END");
    if (finalAnalysis?.errors.length) errors.push(...finalAnalysis.errors);
    const finalKeys = new Set<string>();
    if (finalAnalysis && finalAnalysis.errors.length === 0) {
      for (const call of finalAnalysis.calls) {
        const spec = this.registry.get(call.tool);
        if (!spec) continue;
        try {
          const args = resolveAnalyzedCallArgs(finalAnalysis, call.id, results);
          finalKeys.add(JSON.stringify([call.tool, argsHash(args), spec.deterministic ? 0 : call.occurrence]));
        } catch { /* ordinary scheduling handles it */ }
      }
    }
    for (const active of speculations) {
      if (active.attempt !== activeAttempt || !finalKeys.has(JSON.stringify([active.key.tool, active.key.argsHash, active.key.occurrence]))) {
        if (active.discarded) continue;
        active.discarded = true;
        active.controller.abort();
        try { this.store.remove(active.key); } catch { /* removal only affects the optimization */ }
        discarded += 1;
      }
    }
    return {
      source: document.complete ? document.source : "",
      rationale: document.complete ? document.rationale : "",
      generationStartedAtMs: started,
      generationCompletedAtMs: Date.now(),
      firstCodeTokenAtMs,
      speculations: speculations.filter((item) => item.attempt === activeAttempt && !item.discarded && finalKeys.has(JSON.stringify([item.key.tool, item.key.argsHash, item.key.occurrence])))
        .map(({ callId, launchedAtMs, key }) => ({ callId, launchedAtMs, key })),
      speculationsDiscarded: discarded,
      speculationsLaunched: speculations.length,
      attempts,
      errors,
    };
  }
}
