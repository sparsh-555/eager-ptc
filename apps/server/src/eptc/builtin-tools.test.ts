import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "../agent-service.js";
import { createBuiltinToolRegistry } from "./builtin-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("builtin file tools", () => {
  it("rejects parent and absolute paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eptc-tools-test-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "file.txt"), "match\n");
    const registry = createBuiltinToolRegistry({
      service: {} as AgentService,
      dataDirectory: root,
      workspaceForPlan: () => root,
    });
    const context = { planId: "plan", callId: "call", signal: new AbortController().signal };

    for (const tool of ["readFile", "writeFile", "grep"] as const) {
      const spec = registry.get(tool);
      if (!spec) throw new Error("missing " + tool);
      const args = tool === "grep" ? { pattern: "match", path: "../file.txt" } : tool === "writeFile" ? { path: "../file.txt", body: "x" } : { path: "../file.txt" };
      await expect(spec.handler(args, context)).rejects.toMatchObject({ statusCode: 400 });
      const absoluteArgs = tool === "grep" ? { pattern: "match", path: path.join(root, "file.txt") } : tool === "writeFile" ? { path: path.join(root, "file.txt"), body: "x" } : { path: path.join(root, "file.txt") };
      await expect(spec.handler(absoluteArgs, context)).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it("rejects a broken symlink that points outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eptc-tools-test-"));
    const outside = await mkdtemp(path.join(tmpdir(), "eptc-tools-outside-"));
    temporaryDirectories.push(root, outside);
    await symlink(path.join(outside, "created-outside.txt"), path.join(root, "escape"));
    const registry = createBuiltinToolRegistry({
      service: {} as AgentService,
      dataDirectory: root,
      workspaceForPlan: () => root,
    });
    const write = registry.get("writeFile");
    if (!write) throw new Error("missing writeFile");

    await expect(
      write.handler(
        { path: "escape", body: "must not be written" },
        { planId: "plan", callId: "call", signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
