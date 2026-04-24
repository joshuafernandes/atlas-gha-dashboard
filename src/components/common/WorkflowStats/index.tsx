// 
// Workflow Analytics component.
//
// Fetches from /api/workflows and renders one WorkflowCard per workflow file
// found across all configured repos.
//
// Each card shows:
//
//   SPARKLINE — one bar per recent run, ordered oldest → newest (left → right).
//     Bar height = run duration relative to the longest run in this workflow.
//     Bar colour = status (green=success, red=failure, yellow=in_progress, etc.)
//     Bars are clickable links to the GitHub Actions run.
//     An in-progress bar pulses to draw the eye.
//
//   METRICS — four key numbers computed from the same N runs:
//     Success rate  — % of completed runs that succeeded (green if ≥80%, red if <50%)
//     Avg duration  — mean wall-clock time of successful runs
//     Retrigger %   — % of unique SHAs that were re-run at least once (retry rate)
//     Frequency     — runs per day / week / month depending on cadence
//
// N (number of runs) is configured via WORKFLOW_RUNS_LIMIT (default 20, max 100).
//
// Refresh interval: 2 minutes (matches the API cache TTL so we never poll faster
// than the cache refreshes — any more frequent would just return cached data).
// 

'use client'

import { useCallback } from 'react'
import useSWR from 'swr'
import { Activity, RefreshCw, ExternalLink, CheckCircle2, XCircle, Clock, RotateCcw, Zap } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useRepoFilter } from '@/components/common/RepoFilter/context'
import { formatDistanceToNow } from '@/lib/date'
import { cn } from '@/lib/utils'
import type { WorkflowMetrics, WorkflowRunSummary, WorkflowsApiResponse } from '@/types'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

// Formatting helpers

function fmtDuration(ms: number): string {
  if (ms <= 0) return '–'
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function fmtRate(n: number): string {
  return `${Math.round(n)}%`
}

// Picks the most human-readable unit: /day if frequent, /week or /month if sparse
function fmtFrequency(n: number): string {
  if (n <= 0) return '–'
  if (n >= 1) return `${n.toFixed(1)}/day`
  const perWeek = n * 7
  if (perWeek >= 1) return `${perWeek.toFixed(1)}/week`
  return `${(n * 30).toFixed(1)}/month`
}

// Wall-clock time from run_started_at (or created_at fallback) to updated_at.
// Returns 0 for runs that haven't completed yet (in_progress, queued).
function runDurationMs(run: WorkflowRunSummary): number {
  if (run.status !== 'completed') return 0
  const start = new Date(run.run_started_at ?? run.created_at).getTime()
  const end = new Date(run.updated_at).getTime()
  return Math.max(0, end - start)
}

// Maps a run's status/conclusion to a Tailwind background colour class
function runColor(run: WorkflowRunSummary): string {
  if (run.status === 'in_progress') return 'bg-yellow-400'
  if (run.status === 'queued') return 'bg-muted-foreground/40'
  switch (run.conclusion) {
    case 'success':   return 'bg-green-500'
    case 'failure':   return 'bg-red-500'
    case 'cancelled': return 'bg-orange-400'
    case 'skipped':   return 'bg-muted-foreground/30'
    default:          return 'bg-muted-foreground/30'
  }
}

// Sparkline

function Sparkline({ runs }: { runs: WorkflowRunSummary[] }) {
  // API returns newest first — reverse so the sparkline reads left=old, right=new
  const ordered = [...runs].reverse()
  const durations = ordered.map(runDurationMs)
  const maxDuration = Math.max(...durations, 1)  // avoid divide-by-zero

  return (
    <div className="flex items-end gap-px" style={{ height: '36px' }}>
      {ordered.map((run, i) => {
        const d = durations[i]
        // Clamp minimum height to 12% so short/zero-duration runs are still visible
        const heightPct = d > 0 ? Math.max(12, (d / maxDuration) * 100) : 20
        const label = [
          `#${run.run_number}`,
          run.run_attempt > 1 ? `(retry ${run.run_attempt})` : '',
          run.conclusion ?? run.status,
          d > 0 ? fmtDuration(d) : '',
          run.head_branch ? `@ ${run.head_branch}` : '',
        ].filter(Boolean).join(' · ')

        return (
          <Tooltip key={run.id}>
            <TooltipTrigger asChild>
              <a
                href={run.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'w-3 rounded-sm transition-opacity hover:opacity-70',
                  runColor(run),
                  // Pulse animation draws attention to actively running jobs
                  run.status === 'in_progress' && 'animate-pulse',
                )}
                style={{ height: `${heightPct}%` }}
              />
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

// Metric pill

function Metric({
  icon: Icon,
  label,
  value,
  highlight,
}: {
  icon: React.ElementType
  label: string
  value: string
  highlight?: 'good' | 'bad' | 'neutral'
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
        <Icon className="h-3 w-3" />
        {label}
      </span>
      <span
        className={cn(
          'text-sm font-semibold tabular-nums',
          highlight === 'good' && 'text-green-500',
          highlight === 'bad' && 'text-red-500',
        )}
      >
        {value}
      </span>
    </div>
  )
}

// Workflow card

function WorkflowCard({ wf }: { wf: WorkflowMetrics }) {
  const latestRun = wf.recentRuns[0] ?? null
  const lastRanAt = latestRun?.updated_at ?? null

  // Colour-code success rate: green ≥80%, neutral 50–79%, red <50%
  const successHighlight: 'good' | 'bad' | 'neutral' =
    wf.successRate >= 80 ? 'good' : wf.successRate < 50 ? 'bad' : 'neutral'

  // Colour-code retrigger rate: green =0% (nobody's re-running), red >25%
  const retriggerHighlight: 'good' | 'bad' | 'neutral' =
    wf.retriggerRate === 0 ? 'good' : wf.retriggerRate > 25 ? 'bad' : 'neutral'

  return (
    <Card className="p-4 space-y-3">
      {/* Card header: workflow name + live status badge + last-run time */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <a
              href={wf.html_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium hover:text-blue-500 transition-colors flex items-center gap-1"
            >
              {wf.name}
              <ExternalLink className="h-3 w-3 opacity-50" />
            </a>
            {latestRun && (
              <Badge
                variant={
                  latestRun.conclusion === 'success' ? 'success'
                  : latestRun.status === 'in_progress' ? 'warning'
                  : latestRun.conclusion === 'failure' ? 'destructive'
                  : 'muted'
                }
                className="text-[10px] py-0"
              >
                {latestRun.status === 'in_progress' ? 'running'
                  : latestRun.conclusion ?? latestRun.status}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {wf.repo}
            {lastRanAt && <> · last ran {formatDistanceToNow(lastRanAt)}</>}
            {wf.recentRuns.length > 0 && <> · {wf.recentRuns.length} runs shown</>}
          </p>
        </div>
      </div>

      {/* Run history sparkline — bars are clickable links to individual runs */}
      {wf.recentRuns.length > 0 ? (
        <Sparkline runs={wf.recentRuns} />
      ) : (
        <p className="text-xs text-muted-foreground italic">No recent runs</p>
      )}

      {/* Metrics row */}
      <div className="grid grid-cols-4 gap-4 pt-1 border-t">
        <Metric
          icon={CheckCircle2}
          label="Success"
          value={fmtRate(wf.successRate)}
          highlight={successHighlight}
        />
        <Metric
          icon={Clock}
          label="Avg duration"
          value={fmtDuration(wf.avgDurationMs)}
        />
        <Metric
          icon={RotateCcw}
          label="Retrigger"
          value={fmtRate(wf.retriggerRate)}
          highlight={retriggerHighlight}
        />
        <Metric
          icon={Zap}
          label="Frequency"
          value={fmtFrequency(wf.runsPerDay)}
        />
      </div>
    </Card>
  )
}

// Loading skeleton

function CardSkeletons() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i} className="p-4 space-y-3">
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-9 w-full" />
          <div className="grid grid-cols-4 gap-4 pt-1 border-t">
            {Array.from({ length: 4 }).map((_, j) => (
              <div key={j} className="space-y-1">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-4 w-10" />
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}

// Main component

export function WorkflowStats() {
  const { selectedRepo } = useRepoFilter()

  // 2-minute polling matches the API cache TTL — polling faster would just
  // return the same cached response without touching GitHub.
  const { data, error, isLoading, mutate, isValidating } = useSWR<WorkflowsApiResponse>(
    '/api/workflows',
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 120_000 },
  )

  const refresh = useCallback(() => mutate(), [mutate])

  // Apply repo filter from the header dropdown
  const allWorkflows = data?.workflows ?? []
  const workflows = selectedRepo
    ? allWorkflows.filter((w) => w.repo === selectedRepo)
    : allWorkflows

  // Group by repo for the section-per-repo layout
  const byRepo = workflows.reduce<Record<string, WorkflowMetrics[]>>((acc, w) => {
    if (!acc[w.repo]) acc[w.repo] = []
    acc[w.repo].push(w)
    return acc
  }, {})

  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Workflow Analytics</h1>
          {data && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {workflows.length} workflow{workflows.length !== 1 ? 's' : ''} · last 20 runs each
              {' · '}updated {formatDistanceToNow(data.updatedAt)}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={isValidating} className="gap-2">
          <RefreshCw className={`h-3.5 w-3.5 ${isValidating ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          Failed to load workflows.{' '}
          <button onClick={refresh} className="text-blue-500 hover:underline">Try again</button>
        </Card>
      )}

      {isLoading ? (
        <CardSkeletons />
      ) : workflows.length === 0 ? (
        <Card className="p-12 text-center">
          <Activity className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium">No active workflows found</p>
          <p className="text-xs text-muted-foreground mt-1">
            Workflows must be active and have at least one run.
          </p>
        </Card>
      ) : (
        <div className="space-y-8">
          {/* Section per repo, 2-column grid of workflow cards within each */}
          {Object.entries(byRepo).map(([repo, repoWorkflows]) => (
            <div key={repo} className="space-y-3">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{repo}</span>
                <span className="text-xs text-muted-foreground">
                  {repoWorkflows.length} workflow{repoWorkflows.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {repoWorkflows.map((wf) => (
                  <WorkflowCard key={`${wf.repo}-${wf.id}`} wf={wf} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
