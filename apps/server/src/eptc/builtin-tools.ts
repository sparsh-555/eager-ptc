import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentService } from "../agent-service.js";
import { HttpError } from "../errors.js";
import type { ToolCtx } from "./tools.js";
import { ToolRegistry } from "./tools.js";
import { WorkerPool } from "./worker-pool.js";

interface BuiltinToolsOptions {
  service: AgentService;
  dataDirectory: string;
  workspaceForPlan: (planId: string) => string;
  pool?: WorkerPool;
}

interface WorkerToolCtx extends ToolCtx {
  workerAgentId?: string;
}

function rejectUnsafePath(input: string): void {
  if (path.isAbsolute(input) || input.split(/[\\/]/).includes("..")) {
    throw new HttpError(400, "Path must stay inside the Agent workspace");
  }
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
    return;
  }
  throw new HttpError(400, "Path must stay inside the Agent workspace");
}

async function readPath(workspace: string, input: string): Promise<string> {
  rejectUnsafePath(input);
  const root = await realpath(workspace);
  const target = path.resolve(root, input);
  assertContained(root, target);
  const resolved = await realpath(target);
  assertContained(root, resolved);
  return resolved;
}

async function writePath(workspace: string, input: string): Promise<string> {
  rejectUnsafePath(input);
  const root = await realpath(workspace);
  const target = path.resolve(root, input);
  assertContained(root, target);
  const parts = path.relative(root, target).split(path.sep);
  const fileName = parts.pop();
  if (!fileName) throw new HttpError(400, "Path must name a file");
  let parent = root;
  for (const part of parts) {
    const directory = path.join(parent, part);
    try {
      await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(directory);
    }
    parent = await realpath(directory);
    assertContained(root, parent);
  }
  const filePath = path.join(parent, fileName);
  let info: Stats;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return filePath;
    throw error;
  }
  if (info.isSymbolicLink()) {
    try {
      assertContained(root, await realpath(filePath));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "Path must stay inside the Agent workspace");
    }
  }
  return filePath;
}

async function waitForRun(service: AgentService, runId: string): Promise<string> {
  for (;;) {
    const run = service.getRun(runId);
    if (run.status === "completed") return run.output ?? "";
    if (run.status === "failed" || run.status === "cancelled") {
      throw new Error(run.error ?? "Worker Agent run failed");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

export function createBuiltinToolRegistry(options: BuiltinToolsOptions): ToolRegistry {
  const registry = new ToolRegistry();
  const pool = options.pool ?? new WorkerPool(options.service);
  const workspace = (context: ToolCtx): string => options.workspaceForPlan(context.planId);

  registry.register({
    name: "agent",
    speculatable: true,
    sideEffectFree: true,
    deterministic: false,
    paramNames: ["role", "prompt"],
    argsSchema: z.object({ role: z.string(), prompt: z.string() }),
    handler: async (args, context) => {
      const { role, prompt } = args as { role: string; prompt: string };
      const lease = await pool.lease();
      (context as WorkerToolCtx).workerAgentId = lease.agentId;
      try {
        const { run } = await options.service.sendMessage(
          lease.agentId,
          "Role: " + role + "\n\n" + prompt,
        );
        return await waitForRun(options.service, run.id);
      } finally {
        lease.release();
      }
    },
  });

  registry.register({
    name: "readFile",
    speculatable: true,
    sideEffectFree: true,
    deterministic: true,
    paramNames: ["path"],
    argsSchema: z.object({ path: z.string().min(1) }),
    handler: async (args, context) => readFile(await readPath(workspace(context), (args as { path: string }).path), "utf8"),
  });

  registry.register({
    name: "grep",
    speculatable: true,
    sideEffectFree: true,
    deterministic: true,
    paramNames: ["pattern", "path"],
    argsSchema: z.object({ pattern: z.string(), path: z.string().min(1) }),
    handler: async (args, context) => {
      const { pattern, path: filePath } = args as { pattern: string; path: string };
      let expression: RegExp;
      try {
        expression = new RegExp(pattern);
      } catch {
        throw new HttpError(400, "Invalid grep pattern");
      }
      const lines = (await readFile(await readPath(workspace(context), filePath), "utf8")).split(/\r?\n/);
      return lines
        .map((line, index) => ({ line: index + 1, text: line }))
        .filter((item) => expression.test(item.text))
        .slice(0, 200);
    },
  });

  registry.register({
    name: "writeFile",
    speculatable: false,
    sideEffectFree: false,
    deterministic: false,
    paramNames: ["path", "body"],
    argsSchema: z.object({ path: z.string().min(1), body: z.string() }),
    handler: async (args, context) => {
      const { path: filePath, body } = args as { path: string; body: string };
      await writeFile(await writePath(workspace(context), filePath), body, "utf8");
      return { written: true };
    },
  });

  registry.register({
    name: "notify",
    speculatable: false,
    sideEffectFree: false,
    deterministic: false,
    paramNames: ["channel", "message"],
    argsSchema: z.object({ channel: z.string(), message: z.string() }),
    handler: async (args) => {
      await mkdir(options.dataDirectory, { recursive: true });
      await appendFile(
        path.join(options.dataDirectory, "notify.log"),
        JSON.stringify(args) + "\n",
        "utf8",
      );
      return { delivered: true };
    },
  });

  return registry;
}
