import { describe, expect, it } from "vitest";
import type { AgentService } from "../agent-service.js";
import { WorkerPool } from "./worker-pool.js";

describe("WorkerPool", () => {
  it("waits for an idle worker instead of throwing when exhausted", async () => {
    let nextId = 0;
    const service = {
      listAgents: () => [],
      createAgent: async ({ name }: { name: string }) => ({ id: "worker-" + ++nextId, name }),
    } as unknown as AgentService;
    const pool = new WorkerPool(service, 2);
    const first = await pool.lease();
    const second = await pool.lease();
    let resolved = false;
    const third = pool.lease().then((lease) => {
      resolved = true;
      return lease;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    first.release();
    const thirdLease = await third;
    expect(resolved).toBe(true);
    expect([first.agentId, second.agentId]).toContain(thirdLease.agentId);
    second.release();
    thirdLease.release();
  });
});
