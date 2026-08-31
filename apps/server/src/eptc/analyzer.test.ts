import { describe, expect, it } from "vitest";
import { z } from "zod";
import { analyzePlan, resolveAnalyzedCallArgs } from "./analyzer.js";
import { ToolRegistry } from "./tools.js";

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  for (const [name, speculatable, sideEffectFree, paramNames] of [
    ["agent", true, true, ["role", "prompt"]],
    ["readFile", true, true, ["path"]],
    ["grep", true, true, ["pattern", "path"]],
    ["writeFile", false, false, ["path", "body"]],
    ["notify", false, false, ["channel", "message"]],
  ] as const) {
    tools.register({
      name,
      speculatable,
      sideEffectFree,
      deterministic: true,
      paramNames,
      argsSchema: z.unknown(),
      handler: async () => null,
    });
  }
  return tools;
}

describe("analyzePlan", () => {
  it("classifies literal arguments as speculatable", () => {
    const plan = analyzePlan('await agent({ prompt: "hello", count: 2 });', registry());
    expect(plan.errors).toEqual([]);
    expect(plan.calls[0]).toMatchObject({ argClass: "literal", decision: "speculate" });
  });

  it("normalizes positional readFile arguments", () => {
    const plan = analyzePlan('await readFile("notes.txt");', registry());
    expect(plan.errors).toEqual([]);
    expect(plan.calls[0]).toMatchObject({ args: { path: "notes.txt" }, argClass: "literal" });
  });

  it("normalizes positional grep arguments", () => {
    const plan = analyzePlan('await grep("eptc", "notes.txt");', registry());
    expect(plan.errors).toEqual([]);
    expect(plan.calls[0]?.args).toEqual({ pattern: "eptc", path: "notes.txt" });
  });

  it("preserves object-form arguments", () => {
    const plan = analyzePlan('await readFile({ path: "notes.txt" });', registry());
    expect(plan.errors).toEqual([]);
    expect(plan.calls[0]?.args).toEqual({ path: "notes.txt" });
  });

  it("keeps positional tool-result dependencies in their parameter slot", () => {
    const plan = analyzePlan(
      'const a = await readFile("notes.txt"); const b = await grep(a, "notes.txt");',
      registry(),
    );
    expect(plan.calls[1]).toMatchObject({ argClass: "tool", dependsOn: ["c0"] });
    expect(resolveAnalyzedCallArgs(plan, "c1", new Map([["c0", "eptc"]]))).toEqual({
      pattern: "eptc",
      path: "notes.txt",
    });
  });

  it("normalizes positional arguments in unrolled loops", () => {
    const plan = analyzePlan(
      'for (const path of ["a.txt", "b.txt"]) { await readFile(path); }',
      registry(),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.calls.map((call) => call.args)).toEqual([
      { path: "a.txt" },
      { path: "b.txt" },
    ]);
  });

  it("rejects positional argument overflow", () => {
    const plan = analyzePlan('await readFile("a", "b");', registry());
    expect(plan.errors).toContain("grammar error: too many arguments for readFile: expected 1, got 2 at line 1");
  });

  it("normalizes positional agent arguments", () => {
    const plan = analyzePlan('await agent("researcher", "prompt text");', registry());
    expect(plan.errors).toEqual([]);
    expect(plan.calls[0]?.args).toEqual({ role: "researcher", prompt: "prompt text" });
  });

  it("records dependencies on previous tool calls", () => {
    const plan = analyzePlan(
      'const a = await agent({ prompt: "a" }); const b = await agent("x", a);',
      registry(),
    );
    expect(plan.calls[1]).toMatchObject({ argClass: "tool", dependsOn: ["c0"] });
    expect(plan.order.indexOf("c0")).toBeLessThan(plan.order.indexOf("c1"));
  });

  it.each(["Math.random()", "Date.now()", "process.env"]) (
    "refuses tainted global %s",
    (expression) => {
      const plan = analyzePlan(`await agent(${expression});`, registry());
      expect(plan.errors).toEqual([]);
      expect(plan.calls[0]).toMatchObject({ decision: "refuse" });
      expect(plan.calls[0]?.reason).toContain(expression.split(/[.(]/)[0] ?? expression);
    },
  );

  it("propagates taint through pure expressions", () => {
    const plan = analyzePlan(
      "const x = unknown; const y = String(x); await agent(y);",
      registry(),
    );
    expect(plan.calls[0]).toMatchObject({ argClass: "tainted", decision: "refuse" });
    expect(plan.calls[0]?.reason).toContain("unknown");
  });

  it.each(["import x from 'x';", "require('x');", "const f = () => 1;", "while (true) {}"]) (
    "reports a grammar error for %s",
    (source) => {
      expect(analyzePlan(source, registry()).errors).not.toEqual([]);
    },
  );

  it("defers side effects under unresolved predicates", () => {
    const plan = analyzePlan(
      'if (taintedThing) { await writeFile({ path: "a", body: "b" }); }',
      registry(),
    );
    expect(plan.calls[0]).toMatchObject({ decision: "defer" });
    expect(plan.calls[0]?.reason).toContain("unresolved predicate");
  });

  it("defers non-speculatable tools on the main path", () => {
    const plan = analyzePlan('await writeFile({ path: "a", body: "b" });', registry());
    expect(plan.calls[0]).toMatchObject({ decision: "defer", reason: "tool writeFile is not speculatable" });
  });

  it("unrolls loops over known arrays", () => {
    const plan = analyzePlan(
      'for (const item of ["a", "b", "c"]) { await agent({ prompt: item }); }',
      registry(),
    );
    expect(plan.calls).toHaveLength(3);
    expect(plan.calls.map((call) => call.occurrence)).toEqual([0, 1, 2]);
    expect(plan.calls.map((call) => call.args)).toEqual([
      { prompt: "a" },
      { prompt: "b" },
      { prompt: "c" },
    ]);
  });

  it("does not unroll tainted iterables", () => {
    const plan = analyzePlan(
      'for (const item of unknownItems) { await agent({ prompt: item }); }',
      registry(),
    );
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]).toMatchObject({ decision: "defer" });
    expect(plan.calls[0]?.reason).toContain("loop iterable is tainted");
  });

  it("refuses unknown identifiers", () => {
    const plan = analyzePlan("await agent(missingValue);", registry());
    expect(plan.calls[0]).toMatchObject({ decision: "refuse", argClass: "tainted" });
  });

  it("resolves permitted logical expressions correctly", () => {
    const plan = analyzePlan('await agent(false || "x");', registry());
    expect(plan.calls[0]?.args).toEqual({ role: "x" });
  });

  it("rejects non-primitive literals", () => {
    expect(analyzePlan("await agent(/x/);", registry()).errors).not.toEqual([]);
  });

  it("allows Array.prototype methods only on arrays", () => {
    const mapped = analyzePlan("await agent([1, 2].map(String));", registry());
    expect(mapped.errors).toEqual([]);
    expect(mapped.calls[0]?.args).toEqual({ role: ["1", "2"] });
    expect(analyzePlan('await agent(String("x").slice(1));', registry()).errors).not.toEqual([]);
  });

  it("reports calls to unregistered functions as grammar errors", () => {
    expect(analyzePlan("unknownFunction('x');", registry()).errors).not.toEqual([]);
  });
});
