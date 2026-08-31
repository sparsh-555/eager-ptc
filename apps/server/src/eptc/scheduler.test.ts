import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonStore } from "../store.js";
import { CORPUS } from "./fixtures/corpus.js";
import { PlanService } from "./plan-service.js";
import { argsHash, PromiseStore } from "./promise-store.js";
import { ToolRegistry } from "./tools.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function makeService(registry: ToolRegistry): Promise<PlanService> {
  const root = await mkdtemp(path.join(tmpdir(), "eptc-scheduler-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "eptc.json"));
  await store.initialize();
  return new PlanService(store, registry);
}

function addTool(registry: ToolRegistry, name: string, deterministic: boolean, handler: (args: unknown) => Promise<unknown>, speculatable = true): void {
  const paramNames: Record<string, string[]> = {
    agent: ["role", "prompt"], readFile: ["path"], grep: ["pattern", "path"], writeFile: ["path", "body"], notify: ["channel", "message"],
  };
  registry.register({ name, deterministic, speculatable, sideEffectFree: speculatable, paramNames: paramNames[name] ?? ["value"], argsSchema: z.unknown(), handler: async (args) => handler(args) });
}

function builtins(handler: (tool: string, args: unknown) => Promise<unknown> = async (tool, args) => ({ tool, args })): ToolRegistry {
  const registry = new ToolRegistry();
  addTool(registry, "readFile", true, (args) => handler("readFile", args));
  addTool(registry, "grep", true, (args) => handler("grep", args));
  addTool(registry, "writeFile", false, (args) => handler("writeFile", args), false);
  addTool(registry, "notify", false, (args) => handler("notify", args), false);
  addTool(registry, "agent", false, (args) => handler("agent", args));
  return registry;
}

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("PromiseStore", () => {
  it("shares deterministic keys and retries rejected work", async () => {
    const store = new PromiseStore();
    let runs = 0;
    const key = { tool: "readFile", argsHash: "same", occurrence: 0 };
    await expect(store.claim(key, async () => {
      runs += 1;
      throw new Error("first failure");
    })).rejects.toThrow("first failure");
    await expect(store.claim(key, async () => {
      runs += 1;
      return "retry";
    })).resolves.toBe("retry");
    await expect(store.claim(key, async () => {
      runs += 1;
      return "duplicate";
    })).resolves.toBe("retry");
    expect(runs).toBe(2);
    expect(store.stats()).toEqual({ hits: 1, misses: 2 });
  });

  it("hashes canonical object arguments identically regardless of key order", async () => {
    const store = new PromiseStore();
    let executions = 0;
    const run = async (): Promise<unknown> => ++executions;
    const first = argsHash({ path: "a", options: { caseSensitive: true, limit: 2 } });
    const second = argsHash({ options: { limit: 2, caseSensitive: true }, path: "a" });
    expect(first).toBe(second);
    await store.claim({ tool: "readFile", argsHash: first, occurrence: 0 }, run);
    await store.claim({ tool: "readFile", argsHash: second, occurrence: 0 }, run);
    expect(executions).toBe(1);
  });
});

describe("concurrent plan scheduling", () => {
  it("is equivalent to serial execution for the whole corpus across races", async () => {
    for (const fixture of CORPUS) {
      for (let run = 0; run < 3; run += 1) {
        const serial = await (await makeService(builtins())).execute({ agentId: "agent", source: fixture.source, mode: "serial" });
        const concurrent = await (await makeService(builtins())).execute({ agentId: "agent", source: fixture.source, mode: "concurrent" });
        expect(concurrent.calls.map(({ id, tool, outcome, result }) => ({ id, tool, outcome, result })), fixture.name)
          .toEqual(serial.calls.map(({ id, tool, outcome, result }) => ({ id, tool, outcome, result })));
      }
    }
  });

  it("keeps owner call spans within 50 ms of their recorded work across the corpus", async () => {
    for (const mode of ["serial", "concurrent"] as const) {
      for (const fixture of CORPUS) {
        const plan = await (await makeService(builtins(async (_tool, args) => {
          await pause(5);
          return args;
        }))).execute({ agentId: "agent", source: fixture.source, mode });
        for (const call of plan.calls.filter((item) => item.outcome === "used" && item.dedupedFrom === null)) {
          expect(Math.abs(Date.parse(call.endedAt ?? "") - Date.parse(call.startedAt ?? "" ) - call.workMs), fixture.name).toBeLessThanOrEqual(50);
        }
      }
    }
  });

  it("runs three independent calls concurrently", async () => {
    const registry = builtins(async (_tool, args) => { await pause(300); return args; });
    const started = Date.now();
    const plan = await (await makeService(registry)).execute({ agentId: "agent", source: 'await readFile("a"); await readFile("b"); await readFile("c");' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(plan.totals.maxConcurrent).toBe(3);
  });

  it("measures concurrent serial work from handler durations", async () => {
    const plan = await (await makeService(builtins(async (_tool, args) => { await pause(200); return args; }))).execute({
      agentId: "agent", source: 'await readFile("a"); await readFile("b"); await readFile("c");',
    });
    expect(plan.totals.serialMs).toBeGreaterThanOrEqual(550);
    expect(plan.totals.serialMs).toBeLessThan(750);
    expect(plan.totals.wallClockMs).toBeLessThan(350);
    expect(plan.totals.speedup).toBeGreaterThan(2);
    expect(plan.calls.map((call) => call.workMs)).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number), expect.any(Number)]));
  });

  it("waits for dependencies before starting a dependent call", async () => {
    const events: Record<string, number> = {};
    const registry = builtins(async (tool, args) => {
      const value = (args as { path?: string; pattern?: string }).path ?? (args as { pattern?: string }).pattern ?? "";
      events[tool + ":" + value + ":start"] = Date.now();
      await pause(value === "a" ? 40 : 1);
      events[tool + ":" + value + ":end"] = Date.now();
      return "result";
    });
    await (await makeService(registry)).execute({ agentId: "agent", source: 'const value = await readFile("a"); await grep(value, "b");' });
    expect(events["grep:b:start"]).toBeGreaterThanOrEqual(events["readFile:a:end"] ?? Infinity);
  });

  it("holds later work behind defer and refuse barriers", async () => {
    const starts: Record<string, number> = {};
    const ends: Record<string, number> = {};
    const registry = builtins(async (tool, args) => {
      const label = tool + ":" + JSON.stringify(args);
      starts[label] = Date.now(); await pause(tool === "writeFile" ? 35 : 1); ends[label] = Date.now(); return label;
    });
    await (await makeService(registry)).execute({ agentId: "agent", source: 'await readFile("a"); await writeFile("out", "x"); await readFile("later");' });
    const write = "writeFile:{\"path\":\"out\",\"body\":\"x\"}";
    const later = "readFile:{\"path\":\"later\"}";
    expect(starts[later]).toBeGreaterThanOrEqual(ends[write] ?? Infinity);

    const refuseStarts: number[] = [];
    const refuseEnds: number[] = [];
    const refusing = builtins(async (_tool, args) => { refuseStarts.push(Date.now()); await pause(20); refuseEnds.push(Date.now()); return args; });
    const refused = await (await makeService(refusing)).execute({ agentId: "agent", source: 'await readFile(process.env.PATH); await readFile("later");' });
    expect(refused.calls[0]?.decision).toBe("refuse");
    expect(refuseStarts[1]).toBeGreaterThanOrEqual(refuseEnds[0] ?? Infinity);
  });

  it("deduplicates deterministic calls but not non-deterministic calls", async () => {
    let reads = 0;
    let notifies = 0;
    const registry = builtins(async (tool, args) => {
      if (tool === "readFile") reads += 1;
      if (tool === "notify") notifies += 1;
      return args;
    });
    const service = await makeService(registry);
    const deterministic = await service.execute({ agentId: "agent", source: 'await readFile("same"); await readFile("same");' });
    const nondeterministic = await service.execute({ agentId: "agent", source: 'await notify("a", "same"); await notify("a", "same");' });
    expect(reads).toBe(1);
    expect(deterministic.totals.storeHits).toBe(1);
    expect(notifies).toBe(2);
    expect(nondeterministic.totals.storeHits).toBe(0);
  });

  it("counts deterministic deduplication work once and links duplicate records to its owner", async () => {
    const plan = await (await makeService(builtins(async (_tool, args) => { await pause(200); return args; }))).execute({
      agentId: "agent", source: 'await readFile("same"); await readFile("same"); await readFile("same");',
    });
    expect(plan.totals.serialMs).toBeGreaterThanOrEqual(180);
    expect(plan.totals.serialMs).toBeLessThan(300);
    expect(plan.calls[0]?.workMs).toBeGreaterThanOrEqual(180);
    expect(plan.calls.slice(1).map((call) => call.workMs)).toEqual([0, 0]);
    expect(plan.calls.slice(1).map((call) => call.dedupedFrom)).toEqual([plan.calls[0]?.id, plan.calls[0]?.id]);
    for (const duplicate of plan.calls.slice(1)) {
      const owner = plan.calls.find((call) => call.id === duplicate.dedupedFrom);
      expect(duplicate.startedAt).toBe(owner?.startedAt);
    }
  });

  it("stops future calls after failure while allowing its records to remain source ordered", async () => {
    const registry = builtins(async (tool, args) => {
      if (tool === "readFile" && (args as { path: string }).path === "broken") throw new Error("boom");
      return args;
    });
    const plan = await (await makeService(registry)).execute({ agentId: "agent", calls: [
      { tool: "readFile", args: { path: "ok" } }, { tool: "readFile", args: { path: "broken" } }, { tool: "readFile", args: { path: "later" } },
    ] });
    expect(plan.status).toBe("failed");
    expect(plan.calls.map((call) => call.outcome)).toEqual(["used", "failed", "not_run"]);
    expect(plan.calls.map((call) => call.id)).toHaveLength(3);
  });

  it("lets agent-shaped calls wait for a one-slot pool without throwing", async () => {
    let available = 1;
    const registry = builtins(async (tool, args) => {
      if (tool !== "agent") return args;
      while (available === 0) await pause(2);
      available -= 1;
      await pause(15);
      available += 1;
      return args;
    });
    const plan = await (await makeService(registry)).execute({ agentId: "agent", source: 'await agent("r", "1"); await agent("r", "2"); await agent("r", "3");' });
    expect(plan.status).toBe("completed");
    expect(plan.calls.every((call) => call.outcome === "used")).toBe(true);
  });

  it("reports timing totals from recorded call spans", async () => {
    const plan = await (await makeService(builtins(async (_tool, args) => { await pause(30); return args; }))).execute({
      agentId: "agent", source: 'await readFile("a"); await readFile("b"); await readFile("c");',
    });
    const spans = plan.calls.reduce((total, call) => total + (Date.parse(call.endedAt ?? "") - Date.parse(call.startedAt ?? "")), 0);
    expect(plan.totals.serialMs).toBeGreaterThanOrEqual(spans - 10);
    expect(plan.totals.executionOverlapMs).toBeGreaterThan(0);
    expect(plan.totals.speedup).toBeGreaterThan(1);
    expect(plan.totals.maxConcurrent).toBe(3);
  });

  it("preserves source order when completion order differs", async () => {
    const plan = await (await makeService(builtins(async (_tool, args) => {
      await pause((args as { path: string }).path === "slow" ? 40 : 1);
      return args;
    }))).execute({ agentId: "agent", source: 'await readFile("slow"); await readFile("fast");' });
    expect(plan.calls.map((call) => call.id)).toEqual(["c0", "c1"]);
    expect(Date.parse(plan.calls[1]?.endedAt ?? "")).toBeLessThan(Date.parse(plan.calls[0]?.endedAt ?? ""));
  });

  it("keeps serial mode at one active call and a 1.0 speedup", async () => {
    const plan = await (await makeService(builtins(async (_tool, args) => { await pause(10); return args; }))).execute({
      agentId: "agent", source: 'await readFile("a"); await readFile("b");', mode: "serial",
    });
    expect(plan.totals.maxConcurrent).toBe(1);
    expect(plan.totals.speedup).toBe(1);
    expect(plan.totals.executionOverlapMs).toBe(0);
  });

  it("never reports a concurrent corpus plan below a 1.0 speedup", async () => {
    for (const fixture of CORPUS) {
      const plan = await (await makeService(builtins(async (_tool, args) => { await pause(5); return args; }))).execute({
        agentId: "agent", source: fixture.source, mode: "concurrent",
      });
      expect(plan.totals.speedup, fixture.name).toBeGreaterThanOrEqual(1);
    }
  });
});
