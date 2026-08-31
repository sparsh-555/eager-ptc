<h1 align="center">Eager Programmatic Tool Calling</h1>

<p align="center">
  <strong>Agents write a program that calls tools. This runs those calls before the program
  finishes being written — and decides which ones are safe to start early.</strong>
</p>

<p align="center">
  <img alt="112 server + 7 web tests" src="https://img.shields.io/badge/tests-119%20passing-33906d?style=flat-square&labelColor=20211f">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5-6954d9?style=flat-square&labelColor=20211f">
  <img alt="Node 22+" src="https://img.shields.io/badge/node-22%2B-6954d9?style=flat-square&labelColor=20211f">
  <img alt="median 3.27x" src="https://img.shields.io/badge/median-3.27%C3%97%20faster-33906d?style=flat-square&labelColor=20211f">
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-33906d?style=flat-square&labelColor=20211f">
</p>

---

**Track 1 — Agent Launchpad.** The middleware capability built here is a coordination and
reliability layer: it decides which of an agent's tool calls are safe to start before the plan
that calls them has finished being written, runs those, and refuses the ones it cannot account
for. It sits in the control plane and the Runtime path, between the agent and its tools, and
every decision it makes is recorded with a reason and the line of source that caused it.

## The problem

An agent doing real work makes several tool calls. Today they run one after another, even
when nothing connects them — because the program that calls them does not start until the
model has finished writing all of it, and then the calls fire in the order they were typed.

On this platform a single tool call is an entire agent turn. **I measured it at 66 seconds.**
So a six-call plan takes about seven and a half minutes, and almost all of that is the
platform sitting still, waiting on work it already had everything it needed to start.

Two different kinds of waiting, and this layer removes both.

## How it works

```mermaid
flowchart TD
    AGENT["Agent — calls plan(goal) as an MCP tool"]
    GEN["Plan Generator<br/>streaming, reasoning off, calls-first"]
    ANA["Analyzer — incremental"]
    GATE{"Admission gate"}
    SCHED["Scheduler + promise store"]
    POOL["Worker Agent pool"]
    LEDGER["Audit ledger"]

    AGENT --> GEN
    GEN -->|tokens, as they arrive| ANA
    ANA -->|classified call| GATE
    GATE -->|speculate| SCHED
    GATE -->|defer / refuse + reason| LEDGER
    SCHED -->|lease| POOL
    POOL -->|result| SCHED
    SCHED --> LEDGER
    SCHED --> AGENT

    classDef gen fill:#efecff,stroke:#6954d9,color:#20211f
    classDef code fill:#e6f2ec,stroke:#33906d,color:#20211f
    classDef io fill:#fbfaf7,stroke:#deddd6,color:#20211f
    class GEN,POOL gen
    class ANA,GATE,SCHED,STORE code
    class AGENT,LEDGER io
```

<sub>**Indigo is generation. Green is executed work.** These are the app's own colours — in the
waterfall, indigo is the band where the model is still writing and green is a call that ran.
Everything green is deterministic code; the model writes the plan and never decides what is
safe to start early.</sub>

### The one rule the whole design rests on

> **The model writes the plan. Nothing the model writes decides what is safe to run early.**

The analyzer, the admission gate and the scheduler are pure functions over a parsed program.
They are unit-testable without a model, they give the same answer every time, and a plan that
tries to talk its way past them has nothing to talk to.

That is also what makes the central guarantee testable: **the result must be identical whether
speculation is on or off.** A corpus of thirteen plans is executed serially, concurrently, and
speculatively — including under 30% injected provider faults — and the ordered results must
match exactly or the build fails.

## What it decides, per call

The analyzer classifies every argument and takes the worst class. Unknown means tainted.

| Decision | When | What happens |
|---|---|---|
| **speculate** | arguments are literal, purely computable, or resolved from an earlier call | Started as soon as its inputs exist — possibly while the model is still writing |
| **defer** | the tool has side effects, or sits under a predicate that cannot be resolved | Runs only when execution actually reaches it |
| **refuse** | an argument depends on something untrusted — `process`, `Math.random`, `Date.now`, filesystem reads, or any identifier that cannot be classified | Never speculated. **Still executes**, in order. Refusal governs *earliness*, never whether a call runs |

Taint is transitive. `writeFile` and `notify` are never speculated regardless of their
arguments, because you cannot un-write a file or un-send a message if the branch turns out not
to be taken.

## See it

<p align="center">
  <img src="docs/media/waterfall.png" alt="The execution waterfall: four agent calls beginning inside the indigo generation band, a grey serial-counterfactual strip stretching far beyond them, and headline numbers reading 4623 ms wall clock against 21716 ms if serial." width="900">
</p>

<p align="center"><b>Four calls, all started before the plan finished being written.</b><br>
<sub>The indigo band is the model still generating. Every green bar begins inside it. The grey
strip beneath is the same plan laid out serially — the overhang is the saving.
<b>4,623 ms against 21,716 ms, with 9,164 ms of tool work done during generation.</b></sub></p>

<table>
<tr>
<td width="50%"><img src="docs/media/compare.png" alt="The same plan replayed serially beneath the original, both on a shared time axis: four overlapping bars above finishing near 9 seconds, four sequential bars below finishing near 20"></td>
<td width="50%"><img src="docs/media/denial.png" alt="A plan where a notify call under a tainted predicate is marked defer, with the reason and source line"></td>
</tr>
<tr>
<td><b>Compare replays the same plan serially.</b> Above, four calls overlapping and done by
about nine seconds; below, the same four as a staircase reaching twenty. One shared axis, so the
difference is a length rather than a claim. Every number is rendered from the audit ledger — none
of it is annotated afterwards.</td>
<td><b>A deferral names its reason and its line.</b> <code>notify</code> under a predicate the
analyzer cannot resolve reads <i>"side-effecting tool under unresolved predicate at line 3"</i>,
with the source position, its dependency, and <code>Worker: Not assigned</code>. It runs only if
execution reaches it. Being fast would have been the wrong answer here, and the layer worked that
out without being asked.</td>
</tr>
</table>

## Where the speedup comes from

Two independent mechanisms, measured separately because they answer different questions.

| | Mechanism | Preconditions |
|---|---|---|
| **Execution overlap** | Independent calls run concurrently even though the program wrote them sequentially | None |
| **Generation overlap** | Calls start while the model is still writing the rest of the plan | The generation contract below |

**The generation contract.** The eager window is the time between the last call becoming
parseable and generation finishing. Two changes create it:

- `thinking: {"type": "disabled"}` for the planner. Writing six structured tool calls is
  decomposition, not reasoning. Measured: first code token **26.9 s → 0.43 s**, output tokens
  **2248 → 338**, and protocol adherence went from 0/3 valid calls to 3/3. Reasoning stays on
  in the sub-agents, where the actual work happens.
- **Calls before prose.** The model emits `PLAN_BEGIN`, the calls, `PLAN_END`, and only then
  its rationale — which is written while the calls are already executing.

Together these took the usable window from **0.46 s to 8.82 s**.

## Measured results

Five plan shapes, three repetitions each, n=15 per arm, against a live model.

| shape | scheduler alone | with speculation | eager marginal |
|---|---|---|---|
| fan-out (4 independent) | 3.16× | **4.94×** | 1.56× |
| loop (3, unrolled) | 1.95× | **3.38×** | 1.74× |
| mixed (3 + 1 dependent) | 2.14× | **3.27×** | 1.53× |
| two independent | 1.71× | **2.73×** | 1.59× |
| **median** | **1.86×** | **3.27×** | **1.6–1.8×** |

Median **1,104 ms** of critical-path head start and **4,079 ms** of tool work executed during
generation.

**Two results worth more than the median.** `fan-out-4` reached **4.94× on a four-call plan**
— above the arithmetic ceiling of 4× for pure parallelism, which is only possible because work
began before the plan finished being written. And on a **genuine dependency chain**, where
concurrency can contribute exactly nothing and correctly reports **1.00×**, speculation still
moved **2,208 ms** of work into the generation window.

## Run it

Requires **Node 22+**, **Docker** (or Colima/Podman), and a **BytePlus ModelArk** API key.

```bash
npm install
export ARK_API_KEY=<your ap-southeast Ark model key>
export ARK_MODEL=dola-seed-2-1-turbo-260628
export ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3
npm run poc
```

Then open **http://127.0.0.1:3000**, create an Agent, and expand **Plans** below the
Playground.

> **Two things that will cost you an hour otherwise.**
> Nothing in this repository reads `.env` — there is no dotenv and no `--env-file`, so the
> variables must be exported into the real environment. And `ARK_BASE_URL` must be the
> **international** BytePlus endpoint above; the starter kit ships the China-domestic
> Volcengine URL, which will not authenticate with a BytePlus key. API keys are region-scoped.

If port 3000 is taken, `PORT=3100 PUBLIC_PORT=3100 npm run poc`.

```bash
npm run check     # typecheck + 119 tests + both production builds
```

## Demo steps

1. Create an Agent from the sidebar and send it a task in the Playground — the baseline
   platform is unchanged.
2. Expand **Plans**, enter a goal such as *"research four independent drone subsystems, one
   researcher agent call each"*, and press **Run plan** with **Speculation** ticked.
3. The waterfall shows calls beginning **inside the generation band** — work running before
   the model finished writing the plan.
4. Press **Compare** to replay the same plan with speculation off, on a shared time axis.
5. For the denial case, run a plan whose branch predicate reads a file and whose branch body
   calls `notify`. The gate marks it `defer` with the reason and the source line, and the
   notify log stays empty.
6. The plan list, decision reasons and per-call provenance remain inspectable throughout.

## Limitations

- **The generation contract is a precondition for the speculative half only.** The scheduler
  needs nothing and carries the larger share of the speedup. Present in that order.
- `speedup` is `serialMs / wallClockMs` and measures **execution-phase** concurrency only. On a
  strict dependency chain the generation saving is real and this metric still reads 1.00×.
  Report it alongside `generationOverlapMs`, never merged into it.
- **The plan language is a restricted subset.** Arbitrary JavaScript is refused, not executed.
- **Speculation wastes work** when a plan is revised mid-generation. Discarded speculations are
  counted and displayed rather than hidden.
- **Adaptive concurrency has never fired in production.** Halve-on-throttle with additive
  recovery is unit-tested against injected faults; no real provider throttle occurred during
  measurement.
- Five plan shapes, one model, one provider. *"Median 3.3× on this workload"* is supported.
  *"eager PTC gives 3.3×"* is not.

## Layout

```
apps/server/src/eptc/
  tools.ts            registry; speculatable / sideEffectFree / deterministic
  builtin-tools.ts    agent, readFile, grep, writeFile, notify
  analyzer.ts         parse, classify, taint, loop unrolling, admission
  plan-generator.ts   streaming generation, incremental speculation, phantom discard
  ark-stream.ts       SSE client for the Responses API
  plan-service.ts     scheduler, barriers, adaptive concurrency, audit
  promise-store.ts    claim-or-run, keyed (tool, argsHash, occurrence)
  worker-pool.ts      leases over platform Agents
  retry.ts            error classification for backoff
  redact.ts           secret redaction before persistence
  mcp.ts              MCP server exposing plan() as a native tool
apps/web/src/eptc/    waterfall panel and layout maths
docs/ARCHITECTURE-EPTC.md   the one-page architecture, trust boundary, and data flow
```

## Built on

The TikTok TechJam **Agent Launchpad** starter kit. Agent CRUD, lifecycle, Playground,
persistence and Codex execution are the kit's and are unchanged; everything under
`apps/server/src/eptc/` and `apps/web/src/eptc/` is this project.

**Tools and services used:** TypeScript, Node 22, Fastify, React, Vite, Vitest, Zod, acorn,
Docker, the OpenAI Codex CLI as the Agent runtime, and BytePlus ModelArk (Responses API) as the
model provider.

## License

MIT — see [LICENSE](LICENSE).
