import { useState } from "react"
import { Link, useLocation, useParams } from "react-router-dom"
import { ChevronDown, Lock } from "lucide-react"
import { StatusPill } from "@/cursor/components"
import { useRole } from "@/cursor/role-context"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { useRunDetail, type RunDetailView, type RunTurnView } from "@/cursor/use-run-detail"
import type { TraceTool } from "@/cursor/data"

const json = (o: unknown) => JSON.stringify(o, null, 2)
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(Math.round(n)))

type RunNavState = { from?: "person" | "aiops"; personId?: string; personName?: string }

export function RunDetailPage() {
  const { runId } = useParams()
  const { token } = useAdminAuth()
  const state = (useLocation().state ?? {}) as RunNavState
  const { data, isLoading, isError } = useRunDetail(runId, token)

  const backTo = state.from === "person" && state.personId ? `/people/${state.personId}` : "/ai-ops"
  const backLabel = state.from === "person" ? "Person" : "AI Ops"

  return (
    <div className="page">
      <div className="crumbs">
        <Link to={backTo}>{backLabel}</Link> › Runs › <span className="mono">{data?.shortId ?? runId?.slice(0, 8)}</span>
      </div>

      {isLoading ? (
        <div className="stub">Loading run trace…</div>
      ) : isError || !data ? (
        <div className="stub">This run could not be loaded, or its trace has been pruned (traces are retained for 1 week).</div>
      ) : (
        <RunTrace run={data} />
      )}
    </div>
  )
}

function RunTrace({ run }: { run: RunDetailView }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
        <h1 className="display mono" style={{ fontSize: "19px" }}>{run.id}</h1>
        <StatusPill status={run.status} />
      </div>

      <div className="runmeta">
        <span>Channel <b>{run.channel}</b></span>
        <span>Entry <b>{run.entrypoint}</b></span>
        <span>User <b>{run.userName ?? (run.userId ? run.userId.slice(0, 8) : "—")}</b></span>
        <span>Turns <b>{run.totals.turns}</b></span>
        <span>Tokens <b>{compact(run.totals.tokens)}</b></span>
        <span>Cost <b style={{ color: "var(--cur-primary)" }}>${run.totals.costUsd.toFixed(4)}</b></span>
        <span>Duration <b>{run.durationLabel}</b></span>
      </div>

      <div className="card" style={{ padding: "14px 18px", marginBottom: "22px" }}>
        <div style={{ fontSize: "11.5px" }} className="muted">Token composition — cache hits ~50× cheaper than misses</div>
        <div className="costbar">
          <i style={{ width: `${run.composition.missPct}%`, background: "var(--cur-primary)" }} />
          <i style={{ width: `${run.composition.hitPct}%`, background: "color-mix(in srgb, var(--cur-primary) 45%, transparent)" }} />
          <i style={{ width: `${run.composition.outPct}%`, background: "var(--cur-tl-edit)" }} />
        </div>
        <div style={{ display: "flex", gap: "18px", fontSize: "11.5px", marginTop: "9px" }} className="muted">
          <span><span className="lg-sq" style={{ background: "var(--cur-primary)" }} />cache-miss input</span>
          <span><span className="lg-sq" style={{ background: "color-mix(in srgb, var(--cur-primary) 45%, transparent)" }} />cache-hit input</span>
          <span><span className="lg-sq" style={{ background: "var(--cur-tl-edit)" }} />output</span>
        </div>
      </div>

      <div>
        {run.turns.map((turn, i) => (
          <TurnBlock key={i} turn={turn} index={i} />
        ))}
        {run.ended ? (
          <div className="step" style={{ justifyContent: "center", gap: "9px" }}>
            <span className="tl tl-done">Done</span><b>run_end · {run.statusLabel}</b>
          </div>
        ) : null}
      </div>
    </>
  )
}

function TurnBlock({ turn, index }: { turn: RunTurnView; index: number }) {
  return (
    <div className="turn">
      <div className="turn-h">Turn {index + 1}<div className="ln" /></div>
      {turn.model ? (
        <div className="step">
          <div className="main">
            <div className="title">
              <span className="tl tl-thinking">Thinking</span>
              <span className="name mono">{turn.model.modelName}</span>
            </div>
            <div className="meta">
              <span>in <b>{turn.model.input.toLocaleString()}</b></span>
              <span>out <b>{turn.model.output}</b></span>
              <span>cache-hit <b>{turn.model.cacheRead.toLocaleString()}</b></span>
              <span>cost <b style={{ color: "var(--cur-primary)" }}>${turn.model.costUsd.toFixed(5)}</b></span>
            </div>
          </div>
        </div>
      ) : null}
      {turn.tools.map((tool, k) => (
        <ToolStep key={k} tool={tool} />
      ))}
    </div>
  )
}

function ToolStep({ tool }: { tool: TraceTool }) {
  const { canViewRawExecutionData } = useRole()
  const [open, setOpen] = useState(false)
  const subtitle = tool._subtitle ?? ((tool.i.op ?? tool.i.query) as string | undefined)

  return (
    <div className="step">
      <div className="main">
        <div className="title">
          <span className={`tl tl-${tool.stage}`}>{tool.label}</span>
          <span className="name mono">{tool.n}</span>
          {tool._error ? (
            <span className="badge b-err"><span className="dot" />error</span>
          ) : (
            <span className="badge b-ok"><span className="dot" />ok</span>
          )}
        </div>
        <div className="meta">
          <span className="muted">{subtitle}</span>
          <span className={`expand${open ? " open" : ""}`} onClick={() => setOpen((v) => !v)}>
            {canViewRawExecutionData ? "expand raw I/O" : "expand"}<ChevronDown size={12} />
          </span>
        </div>
        {open ? (
          <div className="raw">
            {canViewRawExecutionData ? (
              <>
                <div className="lbl">Input</div>
                <pre>{json(tool.i)}</pre>
                <div className="lbl">Output</div>
                <pre>{json(tool.o)}</pre>
              </>
            ) : (
              <div className="gate"><Lock size={14} /> Raw tool input/output is available to company and super admins. The summary above is available to all admins.</div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
