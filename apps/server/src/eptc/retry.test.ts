import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonStore } from "../store.js";
import { CORPUS } from "./fixtures/corpus.js";
import { PlanGenerator } from "./plan-generator.js";
import { PlanService } from "./plan-service.js";
import { PromiseStore } from "./promise-store.js";
import { classifyError } from "./retry.js";
import { ToolRegistry } from "./tools.js";
import { WorkerPool } from "./worker-pool.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function service(handler: (args: { path: string }) => Promise<unknown>): Promise<PlanService> {
  const root = await mkdtemp(path.join(tmpdir(), "eptc-retry-test-"));
  directories.push(root);
  const store = new JsonStore(path.join(root, "eptc.json"));
  await store.initialize();
  const registry = new ToolRegistry();
  registry.register({
    name: "readFile", deterministic: true, speculatable: true, sideEffectFree: true,
    paramNames: ["path"], argsSchema: z.object({ path: z.string() }), handler: async (args) => handler(args as { path: string }),
  });
  return new PlanService(store, registry);
}

async function serviceWithRegistry(registry: ToolRegistry): Promise<PlanService> {
  const root = await mkdtemp(path.join(tmpdir(), "eptc-retry-test-"));
  directories.push(root);
  const store = new JsonStore(path.join(root, "eptc.json"));
  await store.initialize();
  return new PlanService(store, registry);
}

function corpusRegistry(handler: (tool: string, args: unknown, signal: AbortSignal) => Promise<unknown>): ToolRegistry {
  const registry = new ToolRegistry();
  const names: Record<string, string[]> = {
    readFile: ["path"], grep: ["pattern", "path"], writeFile: ["path", "body"], notify: ["channel", "message"], agent: ["role", "prompt"],
  };
  for (const [name, paramNames] of Object.entries(names)) {
    const sideEffectFree = !["writeFile", "notify"].includes(name);
    registry.register({
      name, paramNames, deterministic: name !== "agent", speculatable: sideEffectFree, sideEffectFree, argsSchema: z.unknown(),
      handler: async (args, context) => handler(name, args, context.signal),
    });
  }
  return registry;
}

const generatedStream = (document: string) => async function* () {
  yield { text: document, atMs: Date.now() };
};

async function executeGenerated(
  registry: ToolRegistry,
  generated: Awaited<ReturnType<PlanGenerator["generate"]>>,
  store: PromiseStore,
  options: Parameters<PlanService["execute"]>[1] & { mode?: "serial" | "concurrent" } = {},
) {
  const { mode, ...executionOptions } = options;
  return (await serviceWithRegistry(registry)).execute({ agentId: "agent", source: generated.source, mode }, {
    ...executionOptions,
    promiseStore: store,
    generation: generated,
    validationErrors: generated.errors,
    speculatedAtMsByCallId: new Map(generated.speculations.map((item) => [item.callId, item.launchedAtMs])),
  });
}

const source = (paths: string[]): string => paths.map((path, index) => `const v${index} = await readFile("${path}");`).join("\n") + "\nreturn [];";

function fakeClock() {
  let time = 1_000;
  const delays: number[] = [];
  return {
    now: () => time,
    delays,
    sleep: async (milliseconds: number) => { delays.push(milliseconds); time += milliseconds; },
  };
}

describe("classifyError", () => {
  it("classifies provider throttles, transient transport failures, and permanent local failures", () => {
    for (const error of [new Error("429 Too Many Requests"), new Error("SetLimitExceeded"), new Error("TooManyRequests")]) {
      expect(classifyError(error)).toBe("throttle");
    }
    for (const error of [new Error("503 unavailable"), new Error("ECONNRESET")]) expect(classifyError(error)).toBe("transient");
    expect(classifyError(new Error("[{ code: invalid_type, path: [value] }]"))).toBe("permanent");
    expect(classifyError(new Error("Path must stay inside the Agent workspace"))).toBe("permanent");
  });
});

describe("scheduler retries", () => {
  it("retries throttles, records only successful work, and preserves the successful attempt span", async () => {
    let calls = 0;
    const clock = fakeClock();
    const plan = await (await service(async () => {
      calls += 1;
      if (calls < 3) throw new Error("429 SetLimitExceeded");
      return "ok";
    })).execute({ agentId: "a", source: source(["a"]) }, { ...clock, maxRetries: 3, random: () => 1 });
    const call = plan.calls[0]!;
    expect(plan.status).toBe("completed");
    expect(call).toMatchObject({ outcome: "used", attempts: 3, retryReason: "throttle" });
    expect(call.retryWaitMs).toBeGreaterThan(0);
    expect(Math.abs(Date.parse(call.endedAt!) - Date.parse(call.startedAt!) - call.workMs)).toBeLessThanOrEqual(1);
    expect(plan.totals).toMatchObject({ retriedCalls: 1, throttleEvents: 2, minConcurrencyDuringRun: 2 });
  });

  it("does not retry permanent failures", async () => {
    let calls = 0;
    const plan = await (await service(async () => { calls += 1; throw new Error("Path must stay inside the Agent workspace"); })).execute({
      agentId: "a", calls: [{ tool: "readFile", args: { path: "a" } }, { tool: "readFile", args: { path: "b" } }],
    }, { sleep: async () => undefined });
    expect(calls).toBe(1);
    expect(plan.status).toBe("failed");
    expect(plan.calls.map((call) => [call.outcome, call.attempts])).toEqual([["failed", 1], ["not_run", 0]]);
  });

  it("uses exponential jittered backoff bounded by 30 seconds and fails with the final error", async () => {
    const clock = fakeClock();
    const plan = await (await service(async () => { throw new Error("503 unavailable"); })).execute({ agentId: "a", source: source(["a"]) }, {
      ...clock, maxRetries: 5, random: () => 1.5,
    });
    expect(plan.status).toBe("failed");
    expect(plan.calls[0]).toMatchObject({ attempts: 5, error: "503 unavailable" });
    expect(clock.delays).toEqual([750, 1500, 3000, 6000]);
    expect(Math.max(...clock.delays)).toBeLessThanOrEqual(30_000);
  });

  it("halves live concurrency for every throttle and recovers additively after a quiet window", async () => {
    const byPath = new Map<string, number>();
    const clock = fakeClock();
    const plan = await (await service(async ({ path }) => {
      const count = (byPath.get(path) ?? 0) + 1;
      byPath.set(path, count);
      if (count === 1 && path !== "quiet") throw new Error("429 Too Many Requests");
      return path;
    })).execute({ agentId: "a", source: source(["a", "b", "quiet"]) }, {
      ...clock, maxConcurrency: 8, maxRetries: 2, recoveryMs: 10, random: () => 1,
    });
    expect(plan.status).toBe("completed");
    expect(plan.totals.concurrencyEvents.slice(0, 2)).toEqual([
      expect.objectContaining({ from: 8, to: 4, reason: "throttle" }),
      expect.objectContaining({ from: 4, to: 2, reason: "throttle" }),
    ]);
    expect(plan.totals.concurrencyEvents.some((event) => event.reason === "recovery" && event.from === 2 && event.to === 3)).toBe(true);
  });

  it("does not cancel in-flight calls when a throttle lowers the limit", async () => {
    let release!: () => void;
    const started: string[] = [];
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const planPromise = (await service(async ({ path }) => {
      started.push(path);
      if (path === "throttle") throw new Error("429");
      await gate;
      return path;
    })).execute({ agentId: "a", source: source(["slow-a", "slow-b", "throttle"]) }, { maxRetries: 1, sleep: async () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toEqual(expect.arrayContaining(["slow-a", "slow-b", "throttle"]));
    release();
    const plan = await planPromise;
    expect(plan.calls.filter((call) => call.outcome === "used")).toHaveLength(2);
  });

  it("falls through after a speculative call exhausts retries, discarding its rejected claim", async () => {
    let runs = 0;
    const store = new PromiseStore();
    const registry = corpusRegistry(async (_tool, args) => {
      runs += 1;
      if (runs <= 2) throw new Error("429 Too Many Requests");
      return args;
    });
    const generator = new PlanGenerator(registry, store, generatedStream(
      "PLAN_BEGIN\nconst a = await readFile(\"a\");\nreturn [a];\nPLAN_END\nrationale",
    ), { maxRetries: 2, sleep: async () => undefined, random: () => 1 });
    const generated = await generator.generate("goal", (callId) => ({ planId: "generated", callId, signal: new AbortController().signal }));
    const plan = await executeGenerated(registry, generated, store, { maxRetries: 2, sleep: async () => undefined });

    expect(plan.status).toBe("completed");
    expect(plan.calls[0]).toMatchObject({ outcome: "used", result: { path: "a" } });
    expect(plan.totals.speculationsDiscarded).toBe(1);
    expect(runs).toBe(3);
  });

  it("does not cache a rejected promise claim", async () => {
    const store = new PromiseStore();
    const key = { tool: "readFile", argsHash: "same", occurrence: 0 };
    let runs = 0;
    await expect(store.claim(key, async () => { runs += 1; throw new Error("429"); })).rejects.toThrow("429");
    await expect(store.claim(key, async () => { runs += 1; return "ok"; })).resolves.toBe("ok");
    expect(runs).toBe(2);
  });

  it("keeps owner work spans honest under deterministic throttling", async () => {
    for (const fixture of CORPUS) {
      const seen = new Set<string>();
      let seed = 0x5eed1234;
      const next = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const registry = corpusRegistry(async (tool, args) => {
        const key = tool + JSON.stringify(args);
        if (!seen.has(key)) {
          seen.add(key);
          if (next() < 0.3) throw new Error("429 Too Many Requests");
        }
        return { tool, args };
      });
      const clock = fakeClock();
      const plan = await (await serviceWithRegistry(registry)).execute({ agentId: "agent", source: fixture.source }, {
        ...clock, maxRetries: 3, random: () => 1,
      });
      for (const call of plan.calls.filter((item) => item.outcome === "used" && item.dedupedFrom === null)) {
        expect(Math.abs(Date.parse(call.endedAt ?? "") - Date.parse(call.startedAt ?? "") - call.workMs), fixture.name).toBeLessThanOrEqual(50);
        if (call.attempts > 1) expect(call.retryWaitMs, fixture.name).toBeGreaterThan(0);
      }
    }
  });

  it("preserves ordered results across scheduler modes and speculation under deterministic throttling", async () => {
    const documentFor = (source: string): string => "PLAN_BEGIN\n" + source + "\nPLAN_END\nrationale";
    const run = async (source: string, mode: "serial" | "concurrent", speculation: boolean) => {
      const seen = new Set<string>();
      let seed = 0x5eed1234;
      const next = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const registry = corpusRegistry(async (tool, args) => {
        const key = tool + JSON.stringify(args);
        if (!seen.has(key)) {
          seen.add(key);
          if (next() < 0.3) throw new Error("429 Too Many Requests");
        }
        return { tool, args };
      });
      const store = new PromiseStore();
      const generated = await new PlanGenerator(registry, store, generatedStream(documentFor(source)), { speculation })
        .generate("goal", (callId) => ({ planId: "generated", callId, signal: new AbortController().signal }));
      return executeGenerated(registry, generated, store, { mode, maxRetries: 3, sleep: async () => undefined, random: () => 1 });
    };

    for (const fixture of CORPUS) for (let repeat = 0; repeat < 3; repeat += 1) {
      const serial = await run(fixture.source, "serial", false);
      const concurrent = await run(fixture.source, "concurrent", false);
      const speculative = await run(fixture.source, "concurrent", true);
      const shape = (plan: Awaited<ReturnType<typeof run>>) => plan.calls.map(({ id, tool, outcome, result }) => ({ id, tool, outcome, result }));
      expect(shape(concurrent), fixture.name + " serial/concurrent repeat " + repeat).toEqual(shape(serial));
      expect(shape(speculative), fixture.name + " speculation repeat " + repeat).toEqual(shape(concurrent));
    }
  });

  it("releases an agent worker lease before retry backoff", async () => {
    const pool = new WorkerPool({
      listAgents: () => [],
      createAgent: async () => ({ id: "worker-1" }),
    } as never, 1);
    let firstAttempt = true;
    let backoffStarted!: () => void;
    const backoff = new Promise<void>((resolve) => { backoffStarted = resolve; });
    let releaseBackoff!: () => void;
    const waitForBackoff = new Promise<void>((resolve) => { releaseBackoff = resolve; });
    const started: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "agent", deterministic: false, speculatable: true, sideEffectFree: true, paramNames: ["role", "prompt"],
      argsSchema: z.object({ role: z.string(), prompt: z.string() }),
      handler: async (args) => {
        const lease = await pool.lease();
        try {
          const prompt = (args as { prompt: string }).prompt;
          started.push(prompt);
          if (firstAttempt) {
            firstAttempt = false;
            throw new Error("429 Too Many Requests");
          }
          return prompt;
        } finally {
          lease.release();
        }
      },
    });
    const planPromise = (await serviceWithRegistry(registry)).execute({
      agentId: "agent",
      source: 'const a = await agent("researcher", "first prompt with enough words to satisfy the test planner grammar safely here.");\nconst b = await agent("researcher", "second prompt with enough words to satisfy the test planner grammar safely here.");\nreturn [a, b];',
    }, {
      maxRetries: 2,
      sleep: async () => { backoffStarted(); await waitForBackoff; },
      random: () => 1,
    });

    await backoff;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toContain("second prompt with enough words to satisfy the test planner grammar safely here.");
    releaseBackoff();
    expect((await planPromise).status).toBe("completed");
  });

  it("fails generated empty plans and preserves discarded speculative work in totals", async () => {
    const store = new PromiseStore();
    const registry = corpusRegistry(async (_tool, args, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(args), { once: true });
    }));
    let attempts = 0;
    const generated = await new PlanGenerator(registry, store, async function* () {
      attempts += 1;
      yield {
        text: attempts === 1
          ? "PLAN_BEGIN\nconst a = await readFile(\"a\");\nagent: researcher, invalid format\nPLAN_END\nrationale"
          : "PLAN_BEGIN\nreturn [];\nPLAN_END\nrationale",
        atMs: Date.now(),
      };
    }).generate("goal", (callId) => ({ planId: "generated", callId, signal: new AbortController().signal }));
    const plan = await executeGenerated(registry, generated, store);

    expect(plan).toMatchObject({ status: "failed", error: "plan contained no executable tool calls" });
    expect(plan.totals.callCount).toBe(0);
    expect(plan.totals.speculationsDiscarded).toBeGreaterThanOrEqual(1);

    const direct = await (await serviceWithRegistry(registry)).execute({ agentId: "agent", source: "return [];" });
    expect(direct).toMatchObject({ status: "failed", error: "plan contained no executable tool calls" });
    expect(direct.totals.callCount).toBe(0);
  });
});
