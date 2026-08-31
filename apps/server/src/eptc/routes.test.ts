import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Eptc routes", () => {
  it("round trips a submitted plan and returns 404 for an unknown id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eptc-routes-test-"));
    temporaryDirectories.push(root);
    const agentId = "3b92ea37-ed70-4e44-9a0a-964a2e62f062";
    const service = {
      listAgents: () => [],
      getAgent: (id: string) => ({ id, workspacePath: root }),
      systemInfo: async () => ({}),
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data") }),
      service,
    );
    const submitted = await app.inject({
      method: "POST",
      url: "/api/eptc/plans",
      payload: { agentId, calls: [{ tool: "notify", args: { channel: "test", message: "hello" } }] },
    });
    expect(submitted.statusCode).toBe(201);
    const plan = submitted.json().plan as { id: string };

    const fetched = await app.inject({ method: "GET", url: "/api/eptc/plans/" + plan.id });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().plan.id).toBe(plan.id);

    const replayed = await app.inject({
      method: "POST",
      url: "/api/eptc/plans/" + plan.id + "/replay",
      payload: { mode: "serial" },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().plan.id).not.toBe(plan.id);

    const missingReplay = await app.inject({
      method: "POST",
      url: "/api/eptc/plans/3b92ea37-ed70-4e44-9a0a-964a2e62f063/replay",
      payload: { mode: "concurrent" },
    });
    expect(missingReplay.statusCode).toBe(404);

    const missing = await app.inject({
      method: "GET",
      url: "/api/eptc/plans/3b92ea37-ed70-4e44-9a0a-964a2e62f063",
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
