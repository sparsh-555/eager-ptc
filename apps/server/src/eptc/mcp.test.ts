import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { AgentService } from "../agent-service.js";
import { loadConfig, writeCodexConfig } from "../config.js";
import type { PlanRecord } from "../types.js";
import { registerEptcMcpRoute } from "./mcp.js";

const temporaryDirectories: string[] = [];
const agentId = "3b92ea37-ed70-4e44-9a0a-964a2e62f062";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function completedPlan(): PlanRecord {
  return {
    id: "5d1c0c25-327f-42a8-930d-afdaedc9dbda",
    status: "completed",
    error: null,
    calls: [{ tool: "search", outcome: "used", result: "found it" }],
  } as unknown as PlanRecord;
}

async function mcpApp(runPlan: (agent: string, goal: string) => Promise<PlanRecord>) {
  const app = Fastify();
  await registerEptcMcpRoute(app, { runPlan });
  return app;
}

function rpc(method: string, params?: unknown) {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

describe("Eptc MCP", () => {
  it("initializes with tools capability and server identity", async () => {
    const app = await mcpApp(async () => completedPlan());
    const response = await app.inject({ method: "POST", url: "/api/eptc/mcp", payload: rpc("initialize", { protocolVersion: "2025-06-18" }) });
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "eptc" } });
    await app.close();
  });

  it("lists the plan tool", async () => {
    const app = await mcpApp(async () => completedPlan());
    const response = await app.inject({ method: "POST", url: "/api/eptc/mcp", payload: rpc("tools/list") });
    expect(response.json().result.tools).toHaveLength(1);
    expect(response.json().result.tools[0]).toMatchObject({ name: "plan", inputSchema: { required: ["goal"] } });
    await app.close();
  });

  it("runs a plan for the caller identified by query string", async () => {
    const runPlan = async (receivedAgentId: string, goal: string) => {
      expect(receivedAgentId).toBe(agentId);
      expect(goal).toBe("Find project notes");
      return completedPlan();
    };
    const app = await mcpApp(runPlan);
    const response = await app.inject({
      method: "POST",
      url: "/api/eptc/mcp?agentId=" + agentId,
      payload: rpc("tools/call", { name: "plan", arguments: { goal: "Find project notes" } }),
    });
    expect(response.json().result).toMatchObject({ isError: false, content: [{ type: "text" }] });
    expect(response.json().result.content[0].text).toContain(completedPlan().id);
    expect(response.json().result.content[0].text).toContain("search: used");
    expect(response.json().result.content[0].text).toContain("found it");
    await app.close();
  });

  it("returns a JSON-RPC error when the caller is unidentified", async () => {
    const app = await mcpApp(async () => completedPlan());
    const response = await app.inject({ method: "POST", url: "/api/eptc/mcp", payload: rpc("tools/call", { name: "plan", arguments: { goal: "Find notes" } }) });
    expect(response.json().error.message).toMatch(/agent/i);
    await app.close();
  });

  it("returns a tool error when plan execution fails", async () => {
    const app = await mcpApp(async () => ({ ...completedPlan(), status: "failed", error: "plan exploded" }));
    const response = await app.inject({
      method: "POST",
      url: "/api/eptc/mcp?agentId=" + agentId,
      payload: rpc("tools/call", { name: "plan", arguments: { goal: "Find notes" } }),
    });
    expect(response.json().result).toMatchObject({ isError: true, content: [{ text: "plan exploded" }] });
    await app.close();
  });

  it("rejects unknown JSON-RPC methods", async () => {
    const app = await mcpApp(async () => completedPlan());
    const response = await app.inject({ method: "POST", url: "/api/eptc/mcp", payload: rpc("unknown/method") });
    expect(response.json().error.code).toBe(-32601);
    await app.close();
  });

  it("accepts initialized notifications without a response body", async () => {
    const app = await mcpApp(async () => completedPlan());
    const response = await app.inject({ method: "POST", url: "/api/eptc/mcp", payload: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe("");
    await app.close();
  });

  it("is protected by the existing API bearer-token hook", async () => {
    const service = { listAgents: () => [], systemInfo: async () => ({}) } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "mcp-test-token" }), service);
    const response = await app.inject({ method: "POST", url: "/api/eptc/mcp", payload: rpc("initialize") });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("writes an enabled MCP URL configuration without the auth token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eptc-mcp-config-"));
    temporaryDirectories.push(root);
    const token = "mcp-config-secret";
    const enabled = loadConfig({ NODE_ENV: "test", CODEX_HOME: root, APP_AUTH_TOKEN: token, EPTC_MCP_ENABLED: "true" });
    await writeCodexConfig(enabled);
    const configured = await readFile(path.join(root, "config.toml"), "utf8");
    expect(configured).toContain("[mcp_servers.eptc]");
    expect(configured).toContain("url =");
    expect(configured).toContain("env_http_headers");
    expect(configured).toContain("X-EPTC-Agent-Id");
    expect(configured).toContain("EPTC_AGENT_ID");
    expect(configured).toContain('bearer_token_env_var = "APP_AUTH_TOKEN"');
    expect(configured).not.toContain(token);

    const disabledRoot = await mkdtemp(path.join(tmpdir(), "eptc-mcp-disabled-"));
    temporaryDirectories.push(disabledRoot);
    await writeCodexConfig(loadConfig({ NODE_ENV: "test", CODEX_HOME: disabledRoot, EPTC_MCP_ENABLED: "false" }));
    const disabledConfig = await readFile(path.join(disabledRoot, "config.toml"), "utf8");
    expect(disabledConfig).not.toContain("[mcp_servers.eptc]");
    expect(disabledConfig).not.toContain("env_http_headers");
    expect(disabledConfig).not.toContain("X-EPTC-Agent-Id");
    expect(disabledConfig).not.toContain("EPTC_AGENT_ID");
  });
});
