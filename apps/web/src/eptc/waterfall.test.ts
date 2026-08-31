import { describe, expect, it } from "vitest";
import { layoutWaterfall } from "./layout";
import type { EptcPlan } from "../types";

function planWith(calls: EptcPlan["calls"], overrides: Partial<EptcPlan["totals"]> = {}): EptcPlan {
  return {
    id: "plan-1",
    agentId: "agent-1",
    status: "completed",
    createdAt: "2026-08-31T10:00:00.000Z",
    completedAt: "2026-08-31T10:00:01.000Z",
    calls,
    error: null,
    totals: {
      wallClockMs: 100,
      serialMs: 180,
      speedup: 1.8,
      executionOverlapMs: 80,
      maxConcurrent: 2,
      storeHits: 0,
      storeMisses: 0,
      generationMs: 0,
      generationOverlapMs: 0,
      speculativeWorkDuringGenMs: 0,
      speculationsLaunched: 0,
      speculationsDiscarded: 0,
      ...overrides,
    },
  };
}

function call(id: string, startedAt: number | null, endedAt: number | null, overrides: Partial<EptcPlan["calls"][number]> = {}): EptcPlan["calls"][number] {
  return {
    id,
    tool: "fetch",
    decision: "speculate",
    argClass: "literal",
    reason: "safe",
    dependsOn: [],
    outcome: "used",
    startedAt,
    claimedAt: null,
    endedAt,
    workMs: endedAt !== null && startedAt !== null ? endedAt - startedAt : 0,
    speculatedAtMs: null,
    dedupedFrom: null,
    sourceLoc: { line: 1, column: 1 },
    workerAgentId: "worker-1",
    ...overrides,
  };
}

describe("layoutWaterfall", () => {
  it("positions bars proportionally to the plan time span", () => {
    const layout = layoutWaterfall(planWith([call("a", 25, 75), call("extent", 0, 100)], { wallClockMs: 100, serialMs: 100 }), 1000);
    expect(layout.rows[0]).toMatchObject({ start: 250, width: 500 });
  });

  it("preserves source order even when calls finish out of order", () => {
    const layout = layoutWaterfall(planWith([call("first", 30, 90), call("second", 10, 40)]), 1000);
    expect(layout.rows.map((row) => row.call.id)).toEqual(["first", "second"]);
  });

  it("creates a positive leading segment for generation-time speculation", () => {
    const layout = layoutWaterfall(planWith([call("a", 40, 80, { speculatedAtMs: 10 })], { generationMs: 30 }), 1000);
    expect(layout.rows[0].leadingWidth).toBeGreaterThan(0);
  });

  it("places a speculative call inside the generation band when its handler starts before generation ends", () => {
    const layout = layoutWaterfall(planWith([call("a", 20, 80, { speculatedAtMs: 20 })], { generationMs: 50 }), 1000);
    expect(layout.rows[0].start).toBeLessThan(500);
  });

  it("returns one separate serial ghost strip without ghost geometry on call rows", () => {
    const layout = layoutWaterfall(planWith([call("a", 0, 60), call("b", 60, 180)]), 1000);
    expect(layout.ghostTotalWidth).toBe(1000);
    expect(layout.ghostSegments).toEqual([{ start: 0, width: 333.3333333333333 }, { start: 333.3333333333333, width: 666.6666666666666 }]);
    expect(layout.rows[0]).not.toHaveProperty("ghostStart");
    expect(layout.rows[1]).not.toHaveProperty("ghostWidth");
  });

  it("does not divide by zero for one instantaneous call", () => {
    const layout = layoutWaterfall(planWith([call("a", 0, 0)], { wallClockMs: 0, serialMs: 0 }), 1000);
    expect(layout.rows[0]).toMatchObject({ start: 0, width: 3 });
    expect(Number.isFinite(layout.rows[0].start)).toBe(true);
  });

  it("fits the serial ghost strip inside the chart so the overhang never needs scrolling", () => {
    // Concurrent run finishes at 100ms; run serially the same work would take 400ms.
    const layout = layoutWaterfall(planWith([call("a", 0, 100), call("b", 0, 100)], { wallClockMs: 100, serialMs: 400 }), 1000);
    expect(layout.ghostTotalWidth).toBeLessThanOrEqual(1000);
    expect(layout.contentWidth).toBe(1000);
    expect(layout.rows[0].width).toBeLessThan(1000);
  });

  it("keeps a millisecond-scale call visible beside a slow one", () => {
    const layout = layoutWaterfall(planWith([call("quick", 0, 5), call("slow", 0, 20000)], { serialMs: 20005 }), 1000);
    expect(layout.rows[0].width).toBeGreaterThanOrEqual(3);
  });

  it("starts the serial counterfactual after generation, not at zero", () => {
    // Generation takes 100ms; a serial run could not begin executing until it finished.
    const layout = layoutWaterfall(planWith([call("a", 100, 300)], { generationMs: 100, serialMs: 200 }), 900);
    // span = generationMs + serialMs = 300, so 100ms of generation is a third of the chart.
    expect(layout.ghostSegments[0].start).toBeCloseTo(300, 5);
    expect(layout.ghostSegments[0].start + layout.ghostSegments[0].width).toBeCloseTo(900, 5);
  });

  it("connects dependency edges to their source and target rows", () => {
    const layout = layoutWaterfall(planWith([call("source", 10, 40), call("target", 50, 80, { dependsOn: ["source"] })], { serialMs: 80 }), 1000);
    expect(layout.edges).toEqual([{ fromId: "source", toId: "target", fromRow: 0, toRow: 1, fromX: 500, toX: 625 }]);
  });
});
