import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonStore } from "../store.js";
import { PlanService } from "./plan-service.js";
import { ToolRegistry } from "./tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(registry: ToolRegistry): Promise<PlanService> {
  const root = await mkdtemp(path.join(tmpdir(), "eptc-plan-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "eptc.json"));
  await store.initialize();
  return new PlanService(store, registry);
}

function register(registry: ToolRegistry, name: string, handler: (args: unknown) => Promise<unknown>): void {
  registry.register({
    name,
    speculatable: true,
    sideEffectFree: true,
    deterministic: true,
    paramNames: ["value"],
    argsSchema: z.object({ value: z.string() }),
    handler: async (args) => handler(args),
  });
}

describe("PlanService", () => {
  it("runs calls strictly in serial order", async () => {
    const registry = new ToolRegistry();
    const events: string[] = [];
    for (const name of ["first", "second", "third"]) {
      register(registry, name, async () => {
        events.push(name + ":start");
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        events.push(name + ":end");
        return name;
      });
    }

    const plan = await (await makeService(registry)).execute({
      agentId: "agent-1",
      calls: ["first", "second", "third"].map((tool) => ({ tool, args: { value: tool } })),
    });

    expect(plan.status).toBe("completed");
    expect(plan.calls.map((call) => call.decision)).toEqual(["defer", "defer", "defer"]);
    expect(plan.totals.speedup).toBe(1);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
      "third:start",
      "third:end",
    ]);
  });

  it("records invalid arguments as failed and stops", async () => {
    const registry = new ToolRegistry();
    let ran = false;
    register(registry, "valid", async () => "ok");
    register(registry, "later", async () => {
      ran = true;
      return "no";
    });
    const plan = await (await makeService(registry)).execute({
      agentId: "agent-1",
      calls: [
        { tool: "valid", args: { value: 1 } },
        { tool: "later", args: { value: "later" } },
      ],
    });

    expect(plan.status).toBe("failed");
    expect(plan.calls.map((call) => call.outcome)).toEqual(["failed", "not_run"]);
    expect(plan.calls[0]?.error).toContain("value");
    expect(ran).toBe(false);
  });

  it("records handler failures and leaves later calls unrun", async () => {
    const registry = new ToolRegistry();
    register(registry, "broken", async () => {
      throw new Error("boom");
    });
    register(registry, "later", async () => "no");
    const plan = await (await makeService(registry)).execute({
      agentId: "agent-1",
      calls: [
        { tool: "broken", args: { value: "x" } },
        { tool: "later", args: { value: "y" } },
      ],
    });

    expect(plan.status).toBe("failed");
    expect(plan.calls.map((call) => call.outcome)).toEqual(["failed", "not_run"]);
    expect(plan.calls[0]?.error).toBe("boom");
  });

  it("redacts tokens before persisting results", async () => {
    const registry = new ToolRegistry();
    register(registry, "secret", async () => "ark-ABCDEFGHIJ");
    const service = await makeService(registry);
    const plan = await service.execute({
      agentId: "agent-1",
      calls: [{ tool: "secret", args: { value: "x" } }],
    });

    expect(plan.calls[0]?.result).toBe("[REDACTED]");
    expect(service.get(plan.id)?.calls[0]?.result).toBe("[REDACTED]");
  });

  it("redacts token-shaped unknown tool names before persisting them", async () => {
    const service = await makeService(new ToolRegistry());
    const plan = await service.execute({
      agentId: "agent-1",
      calls: [{ tool: "ark-ABCDEFGHIJ", args: {} }],
    });

    expect(plan.calls[0]?.tool).toBe("[REDACTED]");
    expect(service.get(plan.id)?.calls[0]?.tool).toBe("[REDACTED]");
  });

  it("executes analyzed source calls serially", async () => {
    const registry = new ToolRegistry();
    const events: string[] = [];
    register(registry, "first", async () => {
      events.push("first");
      return "first";
    });
    register(registry, "second", async () => {
      events.push("second");
      return "second";
    });

    const plan = await (await makeService(registry)).execute({
      agentId: "agent-1",
      source: 'await first({ value: "one" }); await second({ value: "two" });',
    });

    expect(plan.status).toBe("completed");
    expect(plan.calls.map((call) => call.decision)).toEqual(["speculate", "speculate"]);
    expect(events).toEqual(["first", "second"]);
  });

  it("records grammar failures from source without executing calls", async () => {
    const registry = new ToolRegistry();
    let ran = false;
    register(registry, "valid", async () => {
      ran = true;
      return "no";
    });
    const plan = await (await makeService(registry)).execute({
      agentId: "agent-1",
      source: 'import x from "x"; await valid({ value: "x" });',
    });

    expect(plan.status).toBe("failed");
    expect(plan.error).toContain("import");
    expect(ran).toBe(false);
  });

  it("passes prior tool results into dependent source calls", async () => {
    const registry = new ToolRegistry();
    register(registry, "first", async () => "from-first");
    let received: unknown = null;
    register(registry, "second", async (args) => {
      received = args;
      return "ok";
    });

    const plan = await (await makeService(registry)).execute({
      agentId: "agent-1",
      source: 'const value = await first({ value: "x" }); await second({ value });',
    });

    expect(plan.status).toBe("completed");
    expect(received).toEqual({ value: "from-first" });
  });

  it("only executes the selected branch of a known conditional", async () => {
    const registry = new ToolRegistry();
    const events: string[] = [];
    register(registry, "first", async () => {
      events.push("first");
      return "first";
    });
    register(registry, "second", async () => {
      events.push("second");
      return "second";
    });

    const plan = await (await makeService(registry)).execute({
      agentId: "agent-1",
      source: 'if (false) await first({ value: "x" }); else await second({ value: "y" });',
    });

    expect(plan.status).toBe("completed");
    expect(events).toEqual(["second"]);
  });

  it("keeps loop-local tool dependencies bound to each unrolled iteration", async () => {
    const registry = new ToolRegistry();
    register(registry, "first", async (args) => (args as { value: string }).value + "!");
    const received: string[] = [];
    register(registry, "second", async (args) => {
      received.push((args as { value: string }).value);
      return "ok";
    });

    const plan = await (await makeService(registry)).execute({
      agentId: "agent-1",
      source: 'for (const item of ["a", "b"]) { const value = await first({ value: item }); await second({ value }); }',
    });

    expect(plan.status).toBe("completed");
    expect(received).toEqual(["a!", "b!"]);
  });
});
