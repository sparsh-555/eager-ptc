import type { ZodTypeAny } from "zod";

export interface ToolCtx {
  planId: string;
  callId: string;
  signal: AbortSignal;
}

export interface ToolSpec {
  name: string;
  speculatable: boolean;
  sideEffectFree: boolean;
  deterministic: boolean;
  paramNames: string[];
  argsSchema: ZodTypeAny;
  handler: (args: unknown, ctx: ToolCtx) => Promise<unknown>;
  estimatedMs?: number;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): void {
    if (this.tools.has(spec.name)) {
      throw new Error("Tool already registered: " + spec.name);
    }
    this.tools.set(spec.name, spec);
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }
}
