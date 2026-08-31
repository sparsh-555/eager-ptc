import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentService } from "../agent-service.js";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { JsonStore } from "../store.js";
import { createBuiltinToolRegistry } from "./builtin-tools.js";
import { createArkStream } from "./ark-stream.js";
import { PlanGenerator } from "./plan-generator.js";
import { PlanService } from "./plan-service.js";
import { PromiseStore } from "./promise-store.js";
import { redactString } from "./redact.js";
import { registerEptcMcpRoute } from "./mcp.js";

const planBody = z.object({
  agentId: z.string().uuid(),
  calls: z.array(z.object({ tool: z.string().trim().min(1), args: z.unknown() })).optional(),
  source: z.string().optional(),
  mode: z.enum(["serial", "concurrent"]).optional(),
});
const agentIdQuery = z.object({ agentId: z.string().uuid().optional() });
const planIdParams = z.object({ id: z.string().uuid() });
const replayBody = z.object({ mode: z.enum(["serial", "concurrent"]) });
const generateBody = z.object({
  agentId: z.string().uuid(),
  goal: z.string().trim().min(1),
  speculation: z.boolean().optional(),
});

export async function registerEptcRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service: AgentService,
): Promise<void> {
  const planAgents = new Map<string, string>();
  const registry = createBuiltinToolRegistry({
    service,
    dataDirectory: config.dataDirectory,
    workspaceForPlan: (planId) => {
      const agentId = planAgents.get(planId);
      if (!agentId) throw new HttpError(500, "Plan workspace is unavailable");
      return service.getAgent(agentId).workspacePath;
    },
  });
  const store = new JsonStore(path.join(config.dataDirectory, "eptc.json"));
  await store.initialize();
  const plans = new PlanService(store, registry, (plan) => {
    planAgents.set(plan.id, plan.agentId);
  });
  const arkStream = createArkStream(config);

  const generateAndExecute = async (body: z.infer<typeof generateBody>) => {
    service.getAgent(body.agentId);
    const promiseStore = new PromiseStore();
    // Generated calls need a workspace before a PlanRecord exists. This short-lived id is
    // mapped to the same agent and is only used by side-effect-free built-in handlers.
    const generationPlanId = "generation-" + crypto.randomUUID();
    planAgents.set(generationPlanId, body.agentId);
    try {
      const generator = new PlanGenerator(
        registry,
        promiseStore,
        arkStream,
        body.speculation === undefined ? {} : { speculation: body.speculation },
      );
      const generated = await generator.generate(body.goal, (callId) => ({
        planId: generationPlanId, callId, signal: new AbortController().signal,
      }));
      const plan = await plans.execute({ agentId: body.agentId, source: generated.source }, {
        promiseStore,
        speculatedAtMsByCallId: new Map(generated.speculations.map((item) => [item.callId, item.launchedAtMs])),
        generation: generated,
        validationErrors: generated.errors,
      });
      return { plan, generated };
    } finally {
      planAgents.delete(generationPlanId);
    }
  };

  await registerEptcMcpRoute(app, {
    runPlan: async (agentId, goal) => (await generateAndExecute({ agentId, goal })).plan,
  });

  app.post("/api/eptc/plans", async (request, reply) => {
    const body = planBody.parse(request.body);
    service.getAgent(body.agentId);
    const plan = await plans.execute(body);
    return reply.code(201).send({ plan });
  });

  app.post("/api/eptc/plans/generate", async (request, reply) => {
    const body = generateBody.parse(request.body);
    const { plan, generated } = await generateAndExecute(body);
    return reply.code(201).send({
      plan,
      generation: {
        source: redactString(generated.source),
        rationale: redactString(generated.rationale),
        generationStartedAtMs: generated.generationStartedAtMs,
        generationCompletedAtMs: generated.generationCompletedAtMs,
        firstCodeTokenAtMs: generated.firstCodeTokenAtMs,
        speculationsDiscarded: generated.speculationsDiscarded,
        speculationsLaunched: generated.speculationsLaunched,
        attempts: generated.attempts,
        errors: generated.errors.map(redactString),
        speculations: generated.speculations.map(({ callId, launchedAtMs }) => ({ callId, launchedAtMs })),
      },
    });
  });

  app.get("/api/eptc/plans", async (request) => {
    const { agentId } = agentIdQuery.parse(request.query);
    return {
      plans: plans.list(agentId).map((plan) => ({
        ...plan,
        calls: plan.calls.map(({ result: _result, ...call }) => call),
      })),
    };
  });

  app.get("/api/eptc/plans/:id", async (request) => {
    const { id } = planIdParams.parse(request.params);
    const plan = plans.get(id);
    if (!plan) throw new HttpError(404, "Plan not found");
    return { plan };
  });

  app.post("/api/eptc/plans/:id/replay", async (request) => {
    const { id } = planIdParams.parse(request.params);
    const { mode } = replayBody.parse(request.body);
    return { plan: await plans.replay(id, mode) };
  });

  app.get("/api/eptc/tools", async () => ({
    tools: registry.list().map(({ name, speculatable, sideEffectFree, deterministic }) => ({
      name,
      speculatable,
      sideEffectFree,
      deterministic,
    })),
  }));
}
