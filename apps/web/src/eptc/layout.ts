import type { EptcCall, EptcPlan } from "../types";

export interface WaterfallRow {
  call: EptcCall;
  start: number;
  width: number;
  leadingStart: number | null;
  leadingWidth: number;
}

export interface DependencyEdge {
  fromId: string;
  toId: string;
  fromRow: number;
  toRow: number;
  fromX: number;
  toX: number;
}

export interface WaterfallLayout {
  rows: WaterfallRow[];
  edges: DependencyEdge[];
  timeSpanMs: number;
  ghostTotalWidth: number;
  ghostSegments: Array<{ start: number; width: number }>;
  contentWidth: number;
}

/** Wide enough that a millisecond-scale tool still reads as a bar next to a slow one. */
const minimumBarWidth = 3;

function timestamp(value: string | number | null): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usesRelativeTimes(calls: EptcCall[]): boolean {
  return calls.some((call) => typeof call.startedAt === "number" || typeof call.endedAt === "number");
}

/** Builds source-ordered SVG positions without any DOM dependency. */
export function layoutWaterfall(
  plan: EptcPlan,
  chartWidth: number,
  sharedTimeSpanMs?: number,
): WaterfallLayout {
  const generationMs = Math.max(0, plan.totals.generationMs);
  const relativeTimes = usesRelativeTimes(plan.calls);
  const timestamps = plan.calls.flatMap((call) => [timestamp(call.startedAt), timestamp(call.endedAt)])
    .filter((value): value is number => value !== null);
  const claimTimes = plan.calls.map((call) => timestamp(call.claimedAt)).filter((value): value is number => value !== null);
  const executionOrigin = relativeTimes ? 0 : generationMs > 0 && claimTimes.length
    ? Math.min(...claimTimes) - generationMs
    : (timestamps.length ? Math.min(...timestamps) : 0);
  const normalize = (value: string | number | null): number | null => {
    const parsed = timestamp(value);
    return parsed === null ? null : Math.max(0, parsed - executionOrigin);
  };
  const ends = plan.calls.map((call) => normalize(call.endedAt)).filter((value): value is number => value !== null);
  // A serial run could not start executing until the plan was finished being written, so the
  // counterfactual begins at the end of generation rather than at zero.
  const serialMs = Math.max(0, plan.totals.serialMs);
  // The strip is `speedup` times longer than the concurrent run, so scaling to the concurrent
  // span alone pushes the overhang off-screen exactly when the result is best.
  const measuredSpan = Math.max(generationMs + serialMs, ...ends, 0);
  const timeSpanMs = Math.max(1, sharedTimeSpanMs ?? measuredSpan);
  const scale = chartWidth / timeSpanMs;
  const rows = plan.calls.map((call) => {
    const startMs = normalize(call.startedAt) ?? normalize(call.endedAt) ?? 0;
    const endMs = Math.max(startMs, normalize(call.endedAt) ?? startMs);
    const workMs = Math.max(0, endMs - startMs);
    const leadingStartMs = call.speculatedAtMs === null ? null : normalize(call.speculatedAtMs);
    const leadingWidth = leadingStartMs === null ? 0 : Math.max(0, startMs - leadingStartMs) * scale;
    const row: WaterfallRow = {
      call,
      start: startMs * scale,
      width: Math.max(minimumBarWidth, workMs * scale),
      leadingStart: leadingStartMs === null ? null : leadingStartMs * scale,
      leadingWidth,
    };
    return row;
  });
  const rowByCallId = new Map(rows.map((row, index) => [row.call.id, { row, index }]));
  const edges = rows.flatMap((row, toRow) => row.call.dependsOn.flatMap((dependencyId) => {
    const dependency = rowByCallId.get(dependencyId);
    if (!dependency) return [];
    return [{
      fromId: dependencyId,
      toId: row.call.id,
      fromRow: dependency.index,
      toRow,
      fromX: dependency.row.start + dependency.row.width,
      toX: row.start,
    }];
  }));
  const ghostTotalWidth = serialMs * scale;
  let serialCursor = generationMs;
  const ghostSegments = plan.calls.map((call) => {
    const segment = { start: serialCursor * scale, width: Math.max(0, call.workMs * scale) };
    serialCursor += Math.max(0, call.workMs);
    return segment;
  });
  return {
    rows,
    edges,
    timeSpanMs,
    ghostTotalWidth,
    ghostSegments,
    contentWidth: Math.max(chartWidth, (generationMs + serialMs) * scale),
  };
}
