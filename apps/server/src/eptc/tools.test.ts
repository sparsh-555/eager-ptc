import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "./tools.js";

describe("ToolRegistry", () => {
  it("registers, returns and lists tools", () => {
    const registry = new ToolRegistry();
    const tool = {
      name: "example",
      speculatable: true,
      sideEffectFree: true,
      deterministic: true,
      paramNames: [],
      argsSchema: z.object({}),
      handler: async () => "ok",
    };
    registry.register(tool);

    expect(registry.get("example")).toBe(tool);
    expect(registry.list()).toEqual([tool]);
    expect(() => registry.register(tool)).toThrow("Tool already registered: example");
  });
});
