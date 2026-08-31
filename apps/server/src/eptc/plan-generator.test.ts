import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonStore } from "../store.js";
import { loadConfig } from "../config.js";
import { createArkStream } from "./ark-stream.js";
import { CORPUS } from "./fixtures/corpus.js";
import { PlanGenerator } from "./plan-generator.js";
import { PlanService } from "./plan-service.js";
import { PromiseStore } from "./promise-store.js";
import type { StreamFn } from "./ark-stream.js";
import { ToolRegistry } from "./tools.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function stream(...parts: Array<[string, number?]>): StreamFn {
  return async function* () {
    for (const [text, wait = 0] of parts) {
      if (wait) await pause(wait);
      yield { text, atMs: Date.now() };
    }
  };
}

function registry(handler: (tool: string, args: unknown, signal: AbortSignal) => Promise<unknown> = async (tool, args) => ({ tool, args })): ToolRegistry {
  const tools = new ToolRegistry();
  const names: Record<string, string[]> = { readFile: ["path"], grep: ["pattern", "path"], writeFile: ["path", "body"], notify: ["channel", "message"], agent: ["role", "prompt"] };
  for (const name of Object.keys(names)) {
    const sideEffectFree = !["writeFile", "notify"].includes(name);
    tools.register({
      name, paramNames: names[name] ?? [], deterministic: name !== "agent", speculatable: sideEffectFree,
      sideEffectFree, argsSchema: z.unknown(), handler: async (args, ctx) => handler(name, args, ctx.signal),
    });
  }
  return tools;
}

async function service(tools: ToolRegistry): Promise<PlanService> {
  const root = await mkdtemp(path.join(tmpdir(), "eptc-generator-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "eptc.json"));
  await store.initialize();
  return new PlanService(store, tools);
}

async function executeGenerated(tools: ToolRegistry, source: string, generated: Awaited<ReturnType<PlanGenerator["generate"]>>, store: PromiseStore) {
  return (await service(tools)).execute({ agentId: "agent", source }, {
    promiseStore: store,
    speculatedAtMsByCallId: new Map(generated.speculations.map((item) => [item.callId, item.launchedAtMs])),
    generation: generated,
    validationErrors: generated.errors,
  });
}

const fourIndependentAgentCalls = ["a", "b", "c", "d"]
  .map((name) => `const ${name} = await agent("researcher", "Research ${name} with independent literal arguments and return a concise useful result.");`)
  .join("\n");
const fourIndependentReturn = "return [a, b, c, d];\nPLAN_END\nrationale";

describe("PlanGenerator", () => {
  it("teaches the model the accepted JavaScript syntax and registry signatures", async () => {
    const prompts: string[] = [];
    const capturePrompt: StreamFn = async function* (prompt) {
      prompts.push(prompt);
      yield { text: "PLAN_BEGIN\nreturn [];\nPLAN_END\nrationale", atMs: Date.now() };
    };

    await new PlanGenerator(registry(), new PromiseStore(), capturePrompt).generate("goal", (callId) => ({
      planId: "g", callId, signal: new AbortController().signal,
    }));

    expect(prompts[0]).toContain("PLAN_BEGIN");
    expect(prompts[0]).toContain("const a = await agent(");
    for (const tool of registry().list()) {
      const signature = tool.name + "(" + tool.paramNames.join(", ") + ")" + (tool.sideEffectFree ? "" : "  // side-effecting");
      expect(prompts[0]).toContain(signature);
    }
    expect(prompts[0]).toContain("writeFile(path, body)  // side-effecting");
    expect(prompts[0]).toContain("notify(channel, message)  // side-effecting");
  });

  it("retries once with grammar errors after an invented plan format", async () => {
    const prompts: string[] = [];
    const generated = await new PlanGenerator(registry(), new PromiseStore(), async function* (prompt) {
      prompts.push(prompt);
      const text = prompts.length === 1
        ? "PLAN_BEGIN\nagent: Battery Chemistry Researcher, Conduct a deep dive into battery chemistries. Reply in one short sentence.\nPLAN_END\nrationale"
        : "PLAN_BEGIN\nconst a = await agent(\"researcher\", \"Research battery chemistry tradeoffs, safety, costs, lifecycle, supply constraints, and performance metrics for small electric motors.\");\nreturn [a];\nPLAN_END\nrationale";
      yield { text, atMs: Date.now() };
    }).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("agent: Battery Chemistry Researcher");
    expect(prompts[1]).toContain("grammar error at line 1:");
    expect(prompts[1]).toContain("const a = await agent(");
    expect(generated.attempts).toBe(2);
    expect(generated.errors).toEqual([]);
  });

  it("strips markdown fences around a generated plan before analysis", async () => {
    const generated = await new PlanGenerator(registry(), new PromiseStore(), stream([
      "PLAN_BEGIN\n```js\nconst a = await readFile(\"notes.txt\");\nreturn [a];\n```\nPLAN_END\nrationale",
    ])).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));

    expect(generated.errors).toEqual([]);
    expect(generated.source).toBe("const a = await readFile(\"notes.txt\");\nreturn [a];");
  });

  it("returns grammar errors after a failed retry without throwing", async () => {
    const generated = await new PlanGenerator(registry(), new PromiseStore(), async function* () {
      yield { text: "PLAN_BEGIN\nagent: researcher, invalid format\nPLAN_END\nrationale", atMs: Date.now() };
    }).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    const failed = await executeGenerated(registry(), generated.source, generated, new PromiseStore());

    expect(generated.attempts).toBe(2);
    expect(generated.errors).toContainEqual(expect.stringContaining("grammar error"));
    expect(failed.status).toBe("failed");
  });

  it("aborts and counts speculations from a discarded retry attempt", async () => {
    let aborted = false;
    const tools = registry(async (_tool, _args, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve("aborted"); }, { once: true });
    }));
    let streamCount = 0;
    const generated = await new PlanGenerator(tools, new PromiseStore(), async function* () {
      streamCount += 1;
      const text = streamCount === 1
        ? "PLAN_BEGIN\nconst a = await readFile(\"discarded.txt\");\nagent: researcher, invalid format\nPLAN_END\nrationale"
        : "PLAN_BEGIN\nreturn [];\nPLAN_END\nrationale";
      yield { text, atMs: Date.now() };
    }).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));

    await pause(1);
    expect(aborted).toBe(true);
    expect(generated.speculationsDiscarded).toBe(1);
    expect(generated.speculations).toHaveLength(0);
  });

  it("uses the scheduler StoreKey so a speculative call is claimed exactly once", async () => {
    let runs = 0;
    const tools = registry(async () => { runs += 1; await pause(20); return "a"; });
    const store = new PromiseStore();
    const generator = new PlanGenerator(tools, store, stream(["PLAN_BEGIN\nawait readFile(\"a\");\n", 0], ["PLAN_END\nrationale\n", 30]));
    const generated = await generator.generate("read a file", (callId) => ({ planId: "generated", callId, signal: new AbortController().signal }));
    const plan = await executeGenerated(tools, generated.source, generated, store);
    expect(plan.totals.storeHits).toBeGreaterThanOrEqual(1);
    expect(runs).toBe(1);
  });

  it("records speculative handler time separately from the later scheduler claim", async () => {
    const tools = registry(async (_tool, args) => { await pause(80); return args; });
    const store = new PromiseStore();
    const generated = await new PlanGenerator(tools, store, stream(
      ["PLAN_BEGIN\nawait readFile(\"a\");\n"],
      ["PLAN_END\nrationale", 20],
    )).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    const plan = await executeGenerated(tools, generated.source, generated, store);
    const call = plan.calls[0];

    expect(call?.startedAt).toBe(new Date(call?.speculatedAtMs ?? 0).toISOString());
    expect(Date.parse((call as { claimedAt: string | null } | undefined)?.claimedAt ?? "")).toBeGreaterThan(Date.parse(call?.startedAt ?? ""));
  });

  it("keeps serial work and speedup honest when every call is pre-launched", async () => {
    const source = ["a", "b", "c"].map((name) => `const ${name} = await readFile("${name}");`).join("\n") + "\nreturn [a, b, c];";
    const documentStart = "PLAN_BEGIN\n" + source + "\n";
    const documentEnd = "PLAN_END\nrationale";
    const speculativeTools = registry(async (_tool, args) => { await pause(200); return args; });
    const controlTools = registry(async (_tool, args) => { await pause(200); return args; });
    const speculativeStore = new PromiseStore();
    const speculative = await new PlanGenerator(speculativeTools, speculativeStore, stream([documentStart], [documentEnd, 300]))
      .generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    const control = await new PlanGenerator(controlTools, new PromiseStore(), stream([documentStart], [documentEnd, 300]), { speculation: false })
      .generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    const speculativePlan = await executeGenerated(speculativeTools, speculative.source, speculative, speculativeStore);
    const controlPlan = await executeGenerated(controlTools, control.source, control, new PromiseStore());

    expect(speculative.speculationsLaunched).toBe(3);
    expect(speculativePlan.totals.storeHits).toBe(3);
    expect(speculativePlan.totals.serialMs).toBeGreaterThanOrEqual(550);
    expect(speculativePlan.totals.serialMs).toBeLessThan(750);
    expect(speculativePlan.totals.speedup).toBeGreaterThanOrEqual(controlPlan.totals.speedup);
    expect(speculativePlan.totals.speculativeWorkDuringGenMs).toBeGreaterThanOrEqual(550);
    expect(controlPlan.totals.speculativeWorkDuringGenMs).toBe(0);
    expect(speculativePlan.calls.map((call) => call.workMs)).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number), expect.any(Number)]));
  });

  it("launches every independent completed call from one burst delta", async () => {
    const tools = registry(async (_tool, args) => args);
    const store = new PromiseStore();
    const generated = await new PlanGenerator(tools, store, stream(
      ["PLAN_BEGIN\n" + fourIndependentAgentCalls + "\n"],
      [fourIndependentReturn, 300],
    )).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    const plan = await executeGenerated(tools, generated.source, generated, store);

    expect(generated.speculationsLaunched).toBe(4);
    expect(plan.totals.storeHits).toBe(4);
  });

  it("launches every independent completed call as calls drip into the stream", async () => {
    const tools = registry(async (_tool, args) => args);
    const store = new PromiseStore();
    const lines = fourIndependentAgentCalls.split("\n");
    const generated = await new PlanGenerator(tools, store, stream(
      ["PLAN_BEGIN\n" + lines[0] + "\n"],
      [lines[1] + "\n", 50],
      [lines[2] + "\n", 50],
      [lines[3] + "\n", 50],
      [fourIndependentReturn, 50],
    )).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    const plan = await executeGenerated(tools, generated.source, generated, store);

    expect(generated.speculationsLaunched).toBe(4);
    expect(plan.totals.storeHits).toBe(4);
  });

  it("launches a dependent call when its dependency resolves during generation", async () => {
    const tools = registry(async (tool, args) => {
      if (tool === "readFile") await pause(20);
      return tool === "readFile" ? "needle" : args;
    });
    const generated = await new PlanGenerator(tools, new PromiseStore(), stream(
      ["PLAN_BEGIN\nconst a = await readFile(\"x\");\n"],
      ["const b = await grep(a, \"x\");\nreturn [a, b];\nPLAN_END\nrationale", 50],
    )).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));

    expect(generated.speculationsLaunched).toBe(2);
  });

  it("does not launch calls twice while re-analyzing an unchanged partial buffer", async () => {
    let runs = 0;
    const tools = registry(async (_tool, args) => { runs += 1; return args; });
    const generated = await new PlanGenerator(tools, new PromiseStore(), stream(
      ["PLAN_BEGIN\n" + fourIndependentAgentCalls + "\n// partial"],
      [" buffer"],
      [" repeated"],
      ["\n" + fourIndependentReturn, 20],
    )).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));

    expect(generated.speculationsLaunched).toBe(4);
    expect(runs).toBe(4);
  });

  it("refills the in-flight speculation cap as earlier calls settle", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tools = registry(async (_tool, args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await pause(25);
      inFlight -= 1;
      return args;
    });
    const store = new PromiseStore();
    const generated = await new PlanGenerator(tools, store, stream(
      ["PLAN_BEGIN\n" + fourIndependentAgentCalls + "\n"],
      [fourIndependentReturn, 120],
    ), { maxSpeculations: 2 }).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    const plan = await executeGenerated(tools, generated.source, generated, store);

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(generated.speculationsLaunched).toBe(4);
    expect(plan.status).toBe("completed");
    expect(plan.calls.map((call) => call.outcome)).toEqual(["used", "used", "used", "used"]);
  });

  it("keeps consuming stream deltas while speculative handlers are running", async () => {
    let deltasRead = 0;
    const tools = registry(async (_tool, args) => { await pause(200); return args; });
    const nonBlockingStream: StreamFn = async function* () {
      for (const text of [
        "PLAN_BEGIN\nconst a = await readFile(\"a\");\n",
        "const b = await readFile(\"b\");\n",
        "const c = await readFile(\"c\");\n",
        "const d = await readFile(\"d\");\n",
        "return [a, b, c, d];\nPLAN_END\nrationale",
      ]) {
        await pause(10);
        deltasRead += 1;
        yield { text, atMs: Date.now() };
      }
    };
    const started = Date.now();
    await new PlanGenerator(tools, new PromiseStore(), nonBlockingStream).generate("goal", (callId) => ({
      planId: "g", callId, signal: new AbortController().signal,
    }));

    expect(deltasRead).toBe(5);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("is equivalent with and without speculation for the corpus across races", async () => {
    for (const fixture of CORPUS) for (let run = 0; run < 3; run += 1) {
      const document = "PLAN_BEGIN\n" + fixture.source + "\nPLAN_END\n" + "rationale ".repeat(100);
      const speculativeTools = registry();
      const controlTools = registry();
      const speculativeStore = new PromiseStore();
      const speculative = await new PlanGenerator(speculativeTools, speculativeStore, stream([document])).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
      const control = await new PlanGenerator(controlTools, new PromiseStore(), stream([document]), { speculation: false }).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
      const a = await executeGenerated(speculativeTools, speculative.source, speculative, speculativeStore);
      const b = await executeGenerated(controlTools, control.source, control, new PromiseStore());
      expect(a.calls.map(({ id, tool, outcome, result }) => ({ id, tool, outcome, result })), fixture.name)
        .toEqual(b.calls.map(({ id, tool, outcome, result }) => ({ id, tool, outcome, result })));
      for (const call of a.calls.filter((item) => item.outcome === "used" && item.dedupedFrom === null)) {
        expect(Math.abs(Date.parse(call.endedAt ?? "") - Date.parse(call.startedAt ?? "") - call.workMs), fixture.name).toBeLessThanOrEqual(50);
      }
      expect(a.totals.speedup, fixture.name).toBeGreaterThanOrEqual(1);
      expect(b.totals.speedup, fixture.name).toBeGreaterThanOrEqual(1);
    }
  });

  it("records a generation overlap window when calls arrive before prose", async () => {
    const tools = registry(async (_tool, args) => { await pause(20); return args; });
    const store = new PromiseStore();
    const generated = await new PlanGenerator(tools, store, stream(["PLAN_BEGIN\nawait readFile(\"a\");\n"], ["PLAN_END\n" + "rationale ".repeat(100), 500]))
      .generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    const plan = await executeGenerated(tools, generated.source, generated, store);
    expect(plan.totals.generationOverlapMs).toBeGreaterThan(400);
    expect(plan.totals.generationOverlapMs).toBe(Math.max(0, generated.generationCompletedAtMs - Math.max(...generated.speculations.map((item) => item.launchedAtMs))));
    expect(plan.totals.speculativeWorkDuringGenMs).toBeGreaterThan(0);
  });

  it("has a small overlap when prose arrives before calls and still executes", async () => {
    const tools = registry();
    const store = new PromiseStore();
    const generated = await new PlanGenerator(tools, store, stream(["PLAN_BEGIN\n// prose first\n", 500], ["await readFile(\"a\");\nPLAN_END\nrationale"]))
      .generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    const plan = await executeGenerated(tools, generated.source, generated, store);
    expect(plan.status).toBe("completed");
    expect(plan.totals.generationOverlapMs).toBeLessThan(100);
    expect(plan.totals.speculativeWorkDuringGenMs).toBe(0);
  });

  it("aborts and removes a phantom speculation when a later plan replaces it", async () => {
    let aborted = false;
    const tools = registry(async (_tool, _args, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve("aborted"); }, { once: true });
    }));
    const store = new PromiseStore();
    const generated = await new PlanGenerator(tools, store, stream(["PLAN_BEGIN\nawait readFile(\"a\");\n"], ["PLAN_BEGIN\n// replacement\nPLAN_END\nrationale"]))
      .generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    await pause(1);
    const plan = await executeGenerated(tools, generated.source, generated, store);
    expect(aborted).toBe(true);
    expect(generated.speculationsDiscarded).toBe(1);
    expect(plan.calls).toHaveLength(0);
  });

  it("never speculates deferred, refused, or side-effecting calls", async () => {
    const tools = registry();
    tools.register({ name: "risky", paramNames: ["value"], deterministic: false, speculatable: true, sideEffectFree: false, argsSchema: z.unknown(), handler: async () => "risky" });
    const store = new PromiseStore();
    const generated = await new PlanGenerator(tools, store, stream([
      "PLAN_BEGIN\nawait writeFile(\"out\", \"x\");\nawait readFile(process.env.PATH);\nawait risky(\"x\");\nPLAN_END\nrationale",
    ])).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    const plan = await executeGenerated(tools, generated.source, generated, store);
    expect(generated.speculations).toHaveLength(0);
    expect(plan.calls.map((call) => call.speculatedAtMs)).toEqual([null, null, null]);
  });

  it("respects maxSpeculations", async () => {
    const tools = registry(async (_tool, args) => { await pause(20); return args; });
    const generated = await new PlanGenerator(tools, new PromiseStore(), stream([
      "PLAN_BEGIN\nawait readFile(\"a\");\nawait readFile(\"b\");\nawait readFile(\"c\");\nPLAN_END\nrationale",
    ]), { maxSpeculations: 2 }).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    expect(generated.speculations).toHaveLength(2);
  });

  it("falls through after a stream error and reports an unusable generation as a failed plan", async () => {
    const tools = registry();
    const completedThenThrows: StreamFn = async function* () { yield { text: "PLAN_BEGIN\nawait readFile(\"a\");\nPLAN_END\nrationale", atMs: Date.now() }; throw new Error("stream lost"); };
    const generated = await new PlanGenerator(tools, new PromiseStore(), completedThenThrows).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    const plan = await executeGenerated(tools, generated.source, generated, new PromiseStore());
    expect(plan.status).toBe("completed");

    const incomplete = await new PlanGenerator(tools, new PromiseStore(), stream(["PLAN_BEGIN\nawait readFile(\"a\");\n"])).generate("goal", (callId) => ({ planId: "g", callId, signal: new AbortController().signal }));
    const failed = await executeGenerated(tools, incomplete.source, incomplete, new PromiseStore());
    expect(failed.status).toBe("failed");
  });

  it("sends stream:true and disabled thinking in the Ark request", async () => {
    let body: unknown = null;
    const transport = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\ndata: [DONE]\n\n");
    }) as unknown as typeof fetch;
    const config = loadConfig({ NODE_ENV: "test", ARK_API_KEY: "test-key", ARK_MODEL: "test-model", ARK_BASE_URL: "https://example.test" });
    const deltas: string[] = [];
    for await (const delta of createArkStream(config, transport)("goal", new AbortController().signal)) deltas.push(delta.text);
    expect(body).toMatchObject({ stream: true, thinking: { type: "disabled" } });
    expect(deltas).toEqual(["x"]);
  });
});
