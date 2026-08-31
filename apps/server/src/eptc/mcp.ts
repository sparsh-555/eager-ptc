import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PlanRecord } from "../types.js";

const protocolVersion = "2025-06-18";
const planTool = {
  name: "plan",
  description: "Run a multi-step plan. Generates a plan over the platform tools, executes independent calls concurrently, and starts safe calls before the plan finishes generating. Use this instead of making several tool calls one at a time.",
  inputSchema: {
    type: "object",
    properties: { goal: { type: "string", description: "What to accomplish." } },
    required: ["goal"],
  },
} as const;

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
const initializeParamsSchema = z.object({ protocolVersion: z.string().min(1).optional() }).passthrough();
const toolCallParamsSchema = z.object({
  name: z.literal("plan"),
  arguments: z.object({ goal: z.string().trim().min(1) }),
});
const agentIdSchema = z.string().uuid();

export interface EptcMcpOptions {
  runPlan: (agentId: string, goal: string) => Promise<PlanRecord>;
  version?: string;
}

function error(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function result(id: string | number | null, value: unknown) {
  return { jsonrpc: "2.0" as const, id, result: value };
}

function resolveAgentId(request: FastifyRequest): { agentId: string } | { message: string } {
  const query = request.query as { agentId?: unknown };
  const candidate = query.agentId ?? request.headers["x-eptc-agent-id"];
  if (typeof candidate !== "string" || candidate.length === 0) {
    return { message: "Agent is unidentified; provide ?agentId= or X-EPTC-Agent-Id." };
  }
  const parsed = agentIdSchema.safeParse(candidate);
  return parsed.success ? { agentId: parsed.data } : { message: "Agent id must be a UUID." };
}

function formatPlanSummary(plan: PlanRecord): string {
  const calls = plan.calls.map((call) => {
    let resultText = "(no result)";
    if (typeof call.result === "string") resultText = call.result;
    else if (call.result !== null && call.result !== undefined) {
      try {
        resultText = JSON.stringify(call.result);
      } catch {
        resultText = String(call.result);
      }
    }
    return `${call.tool}: ${call.outcome}\n${resultText}`;
  });
  return [`Plan ${plan.id}`, ...calls].join("\n");
}

/** Registers the small Streamable HTTP JSON-RPC surface Codex needs for Eptc. */
export async function registerEptcMcpRoute(app: FastifyInstance, options: EptcMcpOptions): Promise<void> {
  app.post("/api/eptc/mcp", async (request, reply) => {
    const parsedRequest = requestSchema.safeParse(request.body);
    if (!parsedRequest.success) {
      return reply.send(error(null, -32600, "Invalid JSON-RPC request."));
    }
    const rpc = parsedRequest.data;
    const id = rpc.id ?? null;

    if (rpc.method === "notifications/initialized") {
      return reply.code(202).send();
    }

    if (rpc.method === "initialize") {
      const params = initializeParamsSchema.safeParse(rpc.params ?? {});
      if (!params.success) return reply.send(error(id, -32602, "Invalid initialize parameters."));
      return reply.send(result(id, {
        protocolVersion: params.data.protocolVersion === protocolVersion ? params.data.protocolVersion : protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "eptc", version: options.version ?? "1.0.0" },
      }));
    }

    if (rpc.method === "tools/list") {
      return reply.send(result(id, { tools: [planTool] }));
    }

    if (rpc.method !== "tools/call") {
      return reply.send(error(id, -32601, "Method not found."));
    }

    const params = toolCallParamsSchema.safeParse(rpc.params);
    if (!params.success) return reply.send(error(id, -32602, "Invalid tools/call parameters."));
    const identity = resolveAgentId(request);
    if ("message" in identity) return reply.send(error(id, -32602, identity.message));

    try {
      const plan = await options.runPlan(identity.agentId, params.data.arguments.goal);
      if (plan.status === "failed") {
        return reply.send(result(id, {
          content: [{ type: "text", text: plan.error ?? "Plan execution failed." }],
          isError: true,
        }));
      }
      return reply.send(result(id, {
        content: [{ type: "text", text: formatPlanSummary(plan) }],
        isError: false,
      }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return reply.send(result(id, {
        content: [{ type: "text", text: message }],
        isError: true,
      }));
    }
  });
}
