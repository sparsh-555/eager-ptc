import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { EptcCall, EptcPlan } from "../types";
import { layoutWaterfall, type WaterfallLayout } from "./layout";

const chartWidth = 920;
const chartLeft = 190;
const rowHeight = 58;
const chartTop = 66;
const serialRowHeight = 42;

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Just now" : new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

/** Waterfall convention: print the duration beside every bar, in a unit the eye can compare. */
function formatMs(ms: number): string {
  if (ms < 1000) return Math.round(ms) + " ms";
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + " s";
}

type EptcEvidenceTotals = Pick<EptcPlan["totals"], "wallClockMs" | "generationOverlapMs" | "speculationsLaunched" | "speculationsDiscarded" | "storeHits"> & {
  retriedCalls?: number;
  throttleEvents?: number;
  minConcurrencyDuringRun?: number;
};

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function comparisonTimes(plan: EptcPlan): {
  sequentialMs: number; parallelMs: number; eagerMs: number;
  nelMs: number; vsSequential: number; vsParallel: number;
} {
  const generationMs = finiteOrZero(plan.totals.generationMs);
  const serialMs = finiteOrZero(plan.totals.serialMs);
  const nelMs = finiteOrZero(plan.totals.wallClockMs);
  const maxWorkMs = plan.calls.reduce((max, call) => Math.max(max, finiteOrZero(call.workMs)), 0);
  const sequentialMs = finiteOrZero(generationMs + serialMs);
  const parallelMs = finiteOrZero(generationMs + maxWorkMs);
  const eagerMs = finiteOrZero(generationMs + nelMs);
  const ratio = (baselineMs: number) => eagerMs > 0 ? finiteOrZero(baselineMs / eagerMs) : 1;

  return {
    sequentialMs,
    parallelMs,
    eagerMs,
    nelMs,
    vsSequential: ratio(sequentialMs),
    vsParallel: ratio(parallelMs),
  };
}

export function evidenceItems(totals: EptcEvidenceTotals): Array<[label: string, value: string]> {
  const items: Array<[label: string, value: string]> = [
    ["left exposed", formatMs(totals.wallClockMs)],
    ["head start", formatMs(totals.generationOverlapMs)],
    ["speculated", `${totals.speculationsLaunched} launched · ${totals.speculationsDiscarded} discarded`],
    ["dedup", `${totals.storeHits} hits`],
  ];

  if ((totals.retriedCalls ?? 0) > 0) items.push(["retried", `${totals.retriedCalls} calls`]);
  if ((totals.throttleEvents ?? 0) > 0) items.push(["throttled", `${totals.throttleEvents} events`]);
  if ((totals.minConcurrencyDuringRun ?? 0) > 0) items.push(["concurrency floor", `${totals.minConcurrencyDuringRun}`]);

  return items;
}

function outcomeColor(call: EptcCall): string {
  if (call.decision === "speculate" && call.outcome === "not_run") return "#b9781d";
  if (call.outcome === "used") return "#33906d";
  if (call.outcome === "failed") return "#c55353";
  return "#8e8f89";
}

function decisionClass(decision: EptcCall["decision"]): string {
  return "eptc-decision-" + decision;
}

function countHeldCalls(plan: EptcPlan): number {
  return plan.calls.filter((call) => call.decision === "refuse" || call.decision === "defer").length;
}

function Waterfall({
  plan,
  layout,
  selectedCallId,
  onSelectCall,
  label,
}: {
  plan: EptcPlan;
  layout: WaterfallLayout;
  selectedCallId: string | null;
  onSelectCall: (call: EptcCall) => void;
  label: string;
}) {
  const axisTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
    fraction,
    x: fraction * chartWidth,
    label: Math.round(fraction * layout.timeSpanMs) + " ms",
  }));
  const serialRowY = chartTop + Math.max(1, layout.rows.length) * rowHeight;
  const height = serialRowY + serialRowHeight + 44;
  const generationWidth = Math.min(layout.contentWidth, plan.totals.generationMs / layout.timeSpanMs * chartWidth);

  return (
    <section className="eptc-waterfall" aria-label={label}>
      <h3>{label}</h3>
      <div className="eptc-chart-scroll">
        <svg
          className="eptc-waterfall-svg"
          width="100%"
          style={{ minWidth: chartLeft + layout.contentWidth + 96 }}
          viewBox={`0 0 ${chartLeft + layout.contentWidth + 96} ${height}`}
          role="img"
          aria-label={`${label} waterfall showing ${plan.calls.length} calls`}
        >
          <defs>
            {/* Hatched so the counterfactual reads as a projection rather than measured work. */}
            <pattern id="eptc-projection-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="7" height="7" fill="#efecff" />
              <line x1="0" y1="0" x2="0" y2="7" stroke="#8b7ac9" strokeWidth="3.5" />
            </pattern>
          </defs>
          {plan.totals.generationMs > 0 && (
            <g>
              <rect x={chartLeft} y={34} width={generationWidth} height={height - 34} fill="#efecff" />
              <text x={chartLeft + 8} y={54} className="eptc-svg-label">generation</text>
            </g>
          )}
          {axisTicks.map((tick) => (
            <g key={tick.fraction}>
              <line x1={chartLeft + tick.x} x2={chartLeft + tick.x} y1={chartTop - 8} y2={height - 20} className="eptc-axis-line" />
              <text x={chartLeft + tick.x} y={24} textAnchor={tick.x === 0 ? "start" : tick.x === chartWidth ? "end" : "middle"} className="eptc-svg-label">{tick.label}</text>
            </g>
          ))}
          <text x={chartLeft} y={43} className="eptc-svg-label">elapsed time</text>
          {layout.edges.map((edge) => {
            const fromY = chartTop + edge.fromRow * rowHeight + 22;
            const toY = chartTop + edge.toRow * rowHeight + 22;
            return <path key={`${edge.fromId}-${edge.toId}`} d={`M ${chartLeft + edge.fromX} ${fromY} C ${chartLeft + edge.fromX + 14} ${fromY}, ${chartLeft + edge.toX - 14} ${toY}, ${chartLeft + edge.toX} ${toY}`} className="eptc-dependency" />;
          })}
          {layout.rows.map((row, index) => {
            const y = chartTop + index * rowHeight;
            const isSelected = selectedCallId === row.call.id;
            return (
              <g
                key={row.call.id}
                className="eptc-svg-row"
                role="button"
                tabIndex={0}
                aria-label={`Show ${row.call.tool} call details`}
                onClick={() => onSelectCall(row.call)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onSelectCall(row.call);
                }}
              >
                <rect x={0} y={y - 4} width={chartLeft + layout.contentWidth + 28} height={rowHeight - 2} className={isSelected ? "eptc-row-hit eptc-row-selected" : "eptc-row-hit"} />
                <text x={8} y={y + 18} className="eptc-tool-label">{row.call.tool}</text>
                <rect x={8} y={y + 27} width={78} height={21} rx={10} className={`eptc-decision-badge ${decisionClass(row.call.decision)}`} />
                <text x={47} y={y + 42} textAnchor="middle" className="eptc-decision-text">{row.call.decision}</text>
                {row.leadingStart !== null && row.leadingWidth > 0 && (
                  <rect x={chartLeft + row.leadingStart} y={y + 16} width={row.leadingWidth} height={5} rx={2} className="eptc-leading-bar" />
                )}
                <rect x={chartLeft + row.start} y={y + 12} width={row.width} height={21} rx={4} fill={outcomeColor(row.call)} />
                {row.width > 46 && <text x={chartLeft + row.start + 6} y={y + 27} className="eptc-bar-label">{row.call.outcome}</text>}
                <text x={chartLeft + row.start + row.width + 7} y={y + 27} className="eptc-bar-duration">{formatMs(row.call.workMs)}</text>
                <title>{`${row.call.tool} · ${row.call.decision} · ${formatMs(row.call.workMs)} · ${row.call.outcome}`}</title>
              </g>
            );
          })}
          {layout.rows.length > 0 && (
            <g className="eptc-serial-strip">
              <text x={8} y={serialRowY + 21} className="eptc-serial-label">if run serially</text>
              <text x={8} y={serialRowY + 36} className="eptc-serial-caption">projection</text>
              {layout.ghostSegments.map((segment, index) => (
                <rect key={index} x={chartLeft + segment.start} y={serialRowY + 10} width={segment.width} height={18} rx={3} className="eptc-ghost-bar" />
              ))}
              <text x={chartLeft + layout.ghostSegments[0].start + layout.ghostTotalWidth} y={serialRowY + 4} textAnchor="end" className="eptc-bar-duration">{formatMs(plan.totals.serialMs)}</text>
              <text x={chartLeft + layout.ghostSegments[0].start} y={serialRowY + 42} className="eptc-serial-caption">cannot start until the plan is written</text>
            </g>
          )}
          {layout.rows.length === 0 && <text x={chartLeft} y={chartTop + 24} className="eptc-svg-label">No calls were produced for this plan.</text>}
        </svg>
      </div>
      <ul className="eptc-legend">
        <li><span className="eptc-swatch eptc-swatch-generation" />model still writing the plan</li>
        <li><span className="eptc-swatch eptc-swatch-used" />call ran, result used</li>
        <li><span className="eptc-swatch eptc-swatch-held" />held back by the gate</li>
        <li><span className="eptc-swatch eptc-swatch-projection" />the same calls, run one after another</li>
      </ul>
    </section>
  );
}

function CallDetail({ call }: { call: EptcCall }) {
  return (
    <div className="eptc-call-detail" aria-live="polite">
      <h3>{call.tool} details</h3>
      <dl>
        <div><dt>Reason</dt><dd>{call.reason}</dd></div>
        <div><dt>Argument class</dt><dd>{call.argClass}</dd></div>
        <div><dt>Source</dt><dd>{call.sourceLoc ? `line ${call.sourceLoc.line}, column ${call.sourceLoc.column}` : "Not available"}</dd></div>
        <div><dt>Depends on</dt><dd>{call.dependsOn.length ? call.dependsOn.join(", ") : "None"}</dd></div>
        <div><dt>Work</dt><dd>{call.workMs} ms</dd></div>
        <div><dt>Worker</dt><dd>{call.workerAgentId ?? "Not assigned"}</dd></div>
      </dl>
    </div>
  );
}

export function EptcPanel({ agentId }: { agentId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [plans, setPlans] = useState<EptcPlan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<EptcPlan | null>(null);
  const [comparisonPlan, setComparisonPlan] = useState<EptcPlan | null>(null);
  const [selectedCall, setSelectedCall] = useState<EptcCall | null>(null);
  const [showAllPlans, setShowAllPlans] = useState(false);
  const [goal, setGoal] = useState("");
  const [speculation, setSpeculation] = useState(true);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [liveTarget, setLiveTarget] = useState<"plan" | "comparison" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listPlans(agentId);
      setPlans([...result.plans].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    setPlans([]);
    setSelectedPlan(null);
    setComparisonPlan(null);
    setSelectedCall(null);
    setShowAllPlans(false);
    setError(null);
    if (expanded) void loadPlans();
  }, [agentId, expanded, loadPlans]);

  const selectPlan = async (id: string) => {
    setError(null);
    setComparisonPlan(null);
    setSelectedCall(null);
    setLoading(true);
    try {
      const result = await api.getPlan(id);
      setSelectedPlan(result.plan);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const runPlan = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!goal.trim()) return;
    setRunning(true);
    setLiveTarget("plan");
    setError(null);
    setComparisonPlan(null);
    setSelectedCall(null);
    try {
      const result = await api.generatePlan(agentId, goal.trim(), speculation);
      setSelectedPlan(result.plan);
      setPlans((current) => [result.plan, ...current.filter((plan) => plan.id !== result.plan.id)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLiveTarget(null);
      setRunning(false);
    }
  };

  const comparePlan = async () => {
    if (!selectedPlan) return;
    setRunning(true);
    setLiveTarget("comparison");
    setError(null);
    try {
      const currentMode = selectedPlan.totals.maxConcurrent > 1 ? "concurrent" : "serial";
      const result = await api.replayPlan(selectedPlan.id, currentMode === "concurrent" ? "serial" : "concurrent");
      setComparisonPlan(result.plan);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLiveTarget(null);
      setRunning(false);
    }
  };

  // The server persists each call as it settles, so poll while a run is in flight and draw the
  // waterfall as it fills rather than only once the request returns.
  useEffect(() => {
    if (!expanded) return;
    const knownIds = new Set(plans.map((plan) => plan.id));
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.listPlans(agentId).then(({ plans: latest }) => {
        if (cancelled) return;

        if (liveTarget) {
          const inFlight = latest.find((plan) => !knownIds.has(plan.id));
          if (!inFlight) return;
          if (liveTarget === "plan") setSelectedPlan(inFlight);
          else setComparisonPlan(inFlight);
          return;
        }

        const refreshedPlans = [...latest].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        setPlans(refreshedPlans);
        const newestPlan = refreshedPlans[0];
        if (!newestPlan) return;

        if (!knownIds.has(newestPlan.id)) {
          setSelectedPlan(newestPlan);
        } else {
          setSelectedPlan((current) => current?.id === newestPlan.id ? newestPlan : current);
        }
      }).catch(() => undefined);
    }, liveTarget ? 400 : 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [expanded, liveTarget, agentId, plans]);

  const sharedSpan = useMemo(() => {
    if (!selectedPlan || !comparisonPlan) return undefined;
    const first = layoutWaterfall(selectedPlan, chartWidth).timeSpanMs;
    const second = layoutWaterfall(comparisonPlan, chartWidth).timeSpanMs;
    return Math.max(first, second);
  }, [comparisonPlan, selectedPlan]);
  const selectedLayout = useMemo(() => selectedPlan ? layoutWaterfall(selectedPlan, chartWidth, sharedSpan) : null, [selectedPlan, sharedSpan]);
  const comparisonLayout = useMemo(() => comparisonPlan ? layoutWaterfall(comparisonPlan, chartWidth, sharedSpan) : null, [comparisonPlan, sharedSpan]);
  const selectedComparison = useMemo(() => selectedPlan ? comparisonTimes(selectedPlan) : null, [selectedPlan]);
  const visiblePlans = showAllPlans ? plans : plans.slice(0, 8);

  return (
    <section className="eptc-panel">
      <button className="eptc-heading" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span>Plans</span><span aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="eptc-content">
          <form className="eptc-run-form" onSubmit={runPlan}>
            <label>Goal<input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Describe a goal to plan" /></label>
            <label className="eptc-checkbox"><input type="checkbox" checked={speculation} onChange={(event) => setSpeculation(event.target.checked)} /> <span>Speculation</span></label>
            <button className="button button-primary" disabled={running || !goal.trim()}>{running ? <Spinner /> : "Run plan"}</button>
          </form>
          {error && <div className="eptc-error" role="alert">{error}</div>}
          {selectedPlan && selectedLayout && selectedComparison && (
            <div className="eptc-selected-plan">
              <div className="eptc-metrics">
                <div><span>end to end</span><strong>{formatMs(selectedComparison.eagerMs)}</strong></div>
                <div><span>vs sequential</span><strong>{selectedComparison.vsSequential.toFixed(2)}×</strong></div>
                <div><span>vs parallel</span><strong>{selectedComparison.vsParallel.toFixed(2)}×</strong></div>
                <div><span>work during generation</span><strong>{formatMs(selectedPlan.totals.speculativeWorkDuringGenMs)}</strong></div>
              </div>
              <p className="eptc-compare-line">sequential {formatMs(selectedComparison.sequentialMs)} · parallel {formatMs(selectedComparison.parallelMs)} · eager {formatMs(selectedComparison.eagerMs)}</p>
              <ul className="eptc-evidence">
                {evidenceItems(selectedPlan.totals as EptcEvidenceTotals).map(([label, value]) => (
                  <li key={label} className="eptc-evidence-item">{label}: {value}</li>
                ))}
              </ul>
              <div className="eptc-chart-actions"><span>{selectedPlan.status} · {selectedPlan.calls.length} calls</span><button className="button button-ghost" onClick={() => void comparePlan()} disabled={running}>{running ? <Spinner /> : "Compare"}</button></div>
              <Waterfall plan={selectedPlan} layout={selectedLayout} selectedCallId={selectedCall?.id ?? null} onSelectCall={setSelectedCall} label={comparisonPlan ? "Original plan" : "Execution waterfall"} />
              {comparisonPlan && comparisonLayout && <Waterfall plan={comparisonPlan} layout={comparisonLayout} selectedCallId={selectedCall?.id ?? null} onSelectCall={setSelectedCall} label="Replay comparison" />}
              {selectedCall && <CallDetail call={selectedCall} />}
            </div>
          )}
          <div className="eptc-plan-list" aria-label="Plans">
            {loading && !plans.length ? <Spinner /> : visiblePlans.map((plan) => (
              <button key={plan.id} className={selectedPlan?.id === plan.id ? "eptc-plan-item eptc-plan-item-selected" : "eptc-plan-item"} onClick={() => void selectPlan(plan.id)}>
                <span>{formatTime(plan.createdAt)}</span><span>{plan.status}</span><span>{comparisonTimes(plan).vsSequential.toFixed(2)}×</span><span>{plan.totals.maxConcurrent} concurrent</span><span>{countHeldCalls(plan)} held</span>
              </button>
            ))}
            {!loading && plans.length === 0 && <p className="eptc-empty">No plans yet. Run a goal to inspect its execution.</p>}
          </div>
          {plans.length > 8 && (
            <button className="button button-ghost eptc-plan-toggle" onClick={() => setShowAllPlans((value) => !value)}>
              {showAllPlans ? "Show recent" : "Show all"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
