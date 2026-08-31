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
  const height = serialRowY + serialRowHeight + 24;
  const generationWidth = Math.min(layout.contentWidth, plan.totals.generationMs / layout.timeSpanMs * chartWidth);

  return (
    <section className="eptc-waterfall" aria-label={label}>
      <h3>{label}</h3>
      <div className="eptc-chart-scroll">
        <svg
          className="eptc-waterfall-svg"
          width="100%"
          style={{ minWidth: chartLeft + layout.contentWidth + 28 }}
          viewBox={`0 0 ${chartLeft + layout.contentWidth + 28} ${height}`}
          role="img"
          aria-label={`${label} waterfall showing ${plan.calls.length} calls`}
        >
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
                <text x={chartLeft + row.start + 6} y={y + 27} className="eptc-bar-label">{row.call.outcome}</text>
              </g>
            );
          })}
          {layout.rows.length > 0 && (
            <g className="eptc-serial-strip">
              <text x={8} y={serialRowY + 25} className="eptc-serial-label">if run serially</text>
              {layout.ghostSegments.map((segment, index) => (
                <rect key={index} x={chartLeft + segment.start} y={serialRowY + 12} width={segment.width} height={14} rx={3} className="eptc-ghost-bar" />
              ))}
            </g>
          )}
          {layout.rows.length === 0 && <text x={chartLeft} y={chartTop + 24} className="eptc-svg-label">No calls were produced for this plan.</text>}
        </svg>
      </div>
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
      setRunning(false);
    }
  };

  const comparePlan = async () => {
    if (!selectedPlan) return;
    setRunning(true);
    setError(null);
    try {
      const currentMode = selectedPlan.totals.maxConcurrent > 1 ? "concurrent" : "serial";
      const result = await api.replayPlan(selectedPlan.id, currentMode === "concurrent" ? "serial" : "concurrent");
      setComparisonPlan(result.plan);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  };

  const sharedSpan = useMemo(() => {
    if (!selectedPlan || !comparisonPlan) return undefined;
    const first = layoutWaterfall(selectedPlan, chartWidth).timeSpanMs;
    const second = layoutWaterfall(comparisonPlan, chartWidth).timeSpanMs;
    return Math.max(first, second);
  }, [comparisonPlan, selectedPlan]);
  const selectedLayout = useMemo(() => selectedPlan ? layoutWaterfall(selectedPlan, chartWidth, sharedSpan) : null, [selectedPlan, sharedSpan]);
  const comparisonLayout = useMemo(() => comparisonPlan ? layoutWaterfall(comparisonPlan, chartWidth, sharedSpan) : null, [comparisonPlan, sharedSpan]);
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
          {selectedPlan && selectedLayout && (
            <div className="eptc-selected-plan">
              <div className="eptc-metrics">
                <div><span>wall clock</span><strong>{selectedPlan.totals.wallClockMs} ms</strong></div>
                <div><span>if serial</span><strong>{selectedPlan.totals.serialMs} ms</strong></div>
                <div><span>speedup</span><strong>{selectedPlan.totals.speedup.toFixed(2)}×</strong></div>
                {selectedPlan.totals.speculationsLaunched > 0 && <div><span>work done during generation</span><strong>{selectedPlan.totals.speculativeWorkDuringGenMs} ms</strong></div>}
              </div>
              <div className="eptc-chart-actions"><span>{selectedPlan.status} · {selectedPlan.calls.length} calls</span><button className="button button-ghost" onClick={() => void comparePlan()} disabled={running}>{running ? <Spinner /> : "Compare"}</button></div>
              <Waterfall plan={selectedPlan} layout={selectedLayout} selectedCallId={selectedCall?.id ?? null} onSelectCall={setSelectedCall} label={comparisonPlan ? "Original plan" : "Execution waterfall"} />
              {comparisonPlan && comparisonLayout && <Waterfall plan={comparisonPlan} layout={comparisonLayout} selectedCallId={selectedCall?.id ?? null} onSelectCall={setSelectedCall} label="Replay comparison" />}
              {selectedCall && <CallDetail call={selectedCall} />}
            </div>
          )}
          <div className="eptc-plan-list" aria-label="Plans">
            {loading && !plans.length ? <Spinner /> : visiblePlans.map((plan) => (
              <button key={plan.id} className={selectedPlan?.id === plan.id ? "eptc-plan-item eptc-plan-item-selected" : "eptc-plan-item"} onClick={() => void selectPlan(plan.id)}>
                <span>{formatTime(plan.createdAt)}</span><span>{plan.status}</span><span>{plan.totals.speedup.toFixed(2)}×</span><span>{plan.totals.maxConcurrent} concurrent</span><span>{countHeldCalls(plan)} held</span>
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
