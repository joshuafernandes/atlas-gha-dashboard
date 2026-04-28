//
// TestFailures — dedicated full-page test failure viewer.
//
// Renders the results from GET /api/pr-failures (JUnit XML artifact data).
// Layour is stats bar at top, then failures grouped by artifact → suite → individual test case,
// each with an expandable stack trace.
//

'use client'

import { useState, useMemo } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  SkipForward,
  RefreshCw,
  Search,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { PRFailuresApiResponse, TestCase, TestSuite, TestArtifact } from '@/types'

// ─── query params the page passes in ───────────────────────────────────────

export interface TestFailuresProps {
  owner:    string
  repo:     string
  runId:    string
  sha:      string
  prNumber: string
  prTitle:  string
  prUrl:    string
  runUrl:   string
  runNumber: string
  branch:   string
  author:   string
}

// ─── low-level helpers ──────────────────────────────────────────────────────

function countFailed(suites: TestSuite[]): number {
  return suites.reduce(
    (n, s) => n + s.testcases.filter((t) => t.status === 'failed' || t.status === 'error').length,
    0,
  )
}

// Human-readable label for an artifact name.
// "unit-reports-unitTestLinux" → "Unit Tests · unitTestLinux"
// Falls back to the raw name.
function labelArtifact(name: string): string {
  const m = name.match(/^(unit|integration|acceptance|property|reference)-reports-(.+)$/i)
  if (m) {
    const kind  = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)
    const extra = m[2]!.replace(/[-_]/g, ' ')
    return `${kind} Tests · ${extra}`
  }
  return name
}

// ─── individual test case row ───────────────────────────────────────────────

function TestCaseRow({ tc, highlight }: { tc: TestCase; highlight?: string }) {
  const [open, setOpen] = useState(false)
  const isFail = tc.status === 'failed' || tc.status === 'error'
  const isSkip = tc.status === 'skipped'

  const name = highlight
    ? tc.name.replace(new RegExp(`(${highlight})`, 'gi'), '<<MARK>>$1<</MARK>>')
    : tc.name

  return (
    <div
      className={cn(
        'border-l-2 pl-3 py-2 rounded-r',
        isFail && 'border-red-500',
        isSkip && 'border-yellow-500/50',
      )}
    >
      {/* Test name + status dot */}
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-0.5 h-2 w-2 rounded-full shrink-0',
            isFail && 'bg-red-500',
            isSkip && 'bg-yellow-500/60',
          )}
        />
        <span
          className={cn(
            'text-xs font-mono break-all',
            isFail && 'text-red-300',
            isSkip && 'text-yellow-300/70',
          )}
          dangerouslySetInnerHTML={{
            __html: name
              .replace(/<<MARK>>/g, '<mark class="bg-yellow-400/30 text-yellow-200 rounded px-0.5">')
              .replace(/<\/MARK>>/g, '</mark>'),
          }}
        />
        {tc.time > 0 && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            {tc.time.toFixed(1)}s
          </span>
        )}
      </div>

      {/* Error message */}
      {tc.failure?.message && (
        <div className="mt-1.5 ml-4 text-xs rounded px-2 py-1.5 bg-red-500/10 border border-red-500/20 text-red-200 font-mono break-words">
          {tc.failure.message}
        </div>
      )}

      {/* Stack trace toggle */}
      {tc.failure?.detail && tc.failure.detail !== tc.failure.message && (
        <div className="mt-1.5 ml-4">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Stack trace
          </button>
          {open && (
            <pre className="mt-1.5 text-[10px] leading-relaxed bg-muted/50 border border-border rounded p-3 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-all text-muted-foreground font-mono">
              {tc.failure.detail}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// ─── test suite group (one per suite inside an artifact) ────────────────────

function SuiteGroup({ suite, filter }: { suite: TestSuite; filter: string }) {
  const [open, setOpen] = useState(true)
  const failCount = countFailed([suite])

  const visibleCases = filter
    ? suite.testcases.filter((tc) => tc.name.toLowerCase().includes(filter.toLowerCase()))
    : suite.testcases

  if (visibleCases.length === 0) return null

  return (
    <div className="space-y-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left py-1 group"
      >
        <span className="text-muted-foreground group-hover:text-foreground transition-colors">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <span className="text-xs font-medium truncate flex-1 text-muted-foreground group-hover:text-foreground transition-colors font-mono">
          {suite.name}
        </span>
        <div className="flex items-center gap-1.5 shrink-0 text-[10px] text-muted-foreground">
          {failCount > 0 && (
            <span className="text-red-400">{failCount} failed</span>
          )}
          {suite.skipped > 0 && (
            <span className="text-yellow-500/70">{suite.skipped} skipped</span>
          )}
        </div>
      </button>

      {open && (
        <div className="ml-4 space-y-2">
          {visibleCases.map((tc, i) => (
            <TestCaseRow
              key={`${tc.classname}-${tc.name}-${i}`}
              tc={tc}
              highlight={filter || undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── artifact section (one per downloaded ZIP / check-run report) ───────────

function ArtifactSection({
  artifact,
  filter,
  isCheckRun,
}: {
  artifact: TestArtifact | { artifactName: string; suites: TestSuite[] }
  filter: string
  isCheckRun?: boolean
}) {
  const [open, setOpen] = useState(true)
  const failCount = artifact.suites.reduce((n, s) => n + countFailed([s]), 0)
  const visibleSuites = artifact.suites.filter((s) => {
    if (!filter) return s.testcases.length > 0
    return s.testcases.some((tc) => tc.name.toLowerCase().includes(filter.toLowerCase()))
  })

  if (visibleSuites.length === 0) return null

  const label = isCheckRun ? artifact.artifactName : labelArtifact(artifact.artifactName)

  return (
    <div className="space-y-2">
      {/* Artifact header row */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left py-1.5 group"
      >
        <span className="text-muted-foreground/70 group-hover:text-foreground transition-colors">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground/80 group-hover:text-foreground transition-colors flex-1">
          {label}
        </span>
        {failCount > 0 && (
          <Badge variant="destructive" className="shrink-0 text-[10px] py-0">
            {failCount} {failCount === 1 ? 'failure' : 'failures'}
          </Badge>
        )}
      </button>

      {open && (
        <div className="ml-2 pl-3 border-l border-border space-y-3">
          {visibleSuites.map((suite) => (
            <SuiteGroup key={suite.name} suite={suite} filter={filter} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── stats bar ──────────────────────────────────────────────────────────────

function StatsBadge({
  icon,
  label,
  value,
  className,
}: {
  icon: React.ReactNode
  label: string
  value: number
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-2 px-4 py-3', className)}>
      {icon}
      <div>
        <div className="text-xl font-bold font-mono">{value.toLocaleString()}</div>
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}

// ─── loading skeleton ────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex gap-4">
        {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-32 rounded-lg" />)}
      </div>
      <Card className="p-6 space-y-4">
        <Skeleton className="h-5 w-1/3" />
        <div className="space-y-3 ml-6">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-12 w-full" />
        </div>
      </Card>
    </div>
  )
}

// ─── main component ──────────────────────────────────────────────────────────

export function TestFailures(props: TestFailuresProps) {
  const { owner, repo, runId, sha, prNumber, prTitle, prUrl, runUrl, runNumber, branch, author } = props
  const [filter, setFilter] = useState('')
  const [tab, setTab] = useState<'failed' | 'all' | 'skipped'>('failed')

  const { data, error, isLoading, mutate } = useSWR<PRFailuresApiResponse>(
    `pr-failures:${owner}/${repo}/${runId}`,
    () =>
      fetch(
        `/api/pr-failures?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&runId=${encodeURIComponent(runId)}&sha=${encodeURIComponent(sha)}`,
      ).then((r) => r.json()),
    { revalidateOnFocus: false },
  )

  const results = data?.results

  // Merge artifacts + check-run fallback suites into a unified list for rendering
  const sections = useMemo(() => {
    if (!results) return []
    const out: Array<{ artifactName: string; suites: TestSuite[]; isCheckRun?: boolean }> = []
    for (const art of results.artifacts) out.push({ ...art })
    if (results.checkRunSuites.length > 0) {
      out.push({ artifactName: 'Check Run Reports', suites: results.checkRunSuites, isCheckRun: true })
    }
    return out
  }, [results])

  // Filter suites based on the active tab
  const filteredSections = useMemo(() => {
    return sections.map((sec) => ({
      ...sec,
      suites: sec.suites
        .map((suite) => ({
          ...suite,
          testcases:
            tab === 'failed'
              ? suite.testcases.filter((t) => t.status === 'failed' || t.status === 'error')
              : tab === 'skipped'
              ? suite.testcases.filter((t) => t.status === 'skipped')
              : suite.testcases,
        }))
        .filter((s) => s.testcases.length > 0),
    })).filter((sec) => sec.suites.length > 0)
  }, [sections, tab])

  const counts = results?.testCounts ?? { total: 0, failed: 0, passed: 0, skipped: 0 }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">

      {/* Back + heading */}
      <div className="flex items-start gap-3">
        <Link
          href="/prs"
          className="mt-0.5 shrink-0 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-semibold truncate">
              <a href={prUrl} target="_blank" rel="noopener noreferrer" className="hover:text-blue-400 transition-colors">
                #{prNumber} {prTitle}
              </a>
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs text-muted-foreground">
            <span>branch: <span className="font-mono text-foreground/70">{branch}</span></span>
            <span className="opacity-40">·</span>
            <span>commit: <span className="font-mono text-foreground/70">{sha.slice(0, 7)}</span></span>
            <span className="opacity-40">·</span>
            <span>by <span className="text-foreground/70">{author}</span></span>
            {runUrl && (
              <>
                <span className="opacity-40">·</span>
                <a
                  href={runUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-blue-400 hover:underline"
                >
                  CI Run #{runNumber} <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </>
            )}
            <span className="opacity-40">·</span>
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-blue-400 hover:underline"
            >
              PR on GitHub <ExternalLink className="h-2.5 w-2.5" />
            </a>
          </div>
        </div>
        <button
          onClick={() => mutate()}
          disabled={isLoading}
          className="shrink-0 mt-0.5 text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh"
        >
          <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
        </button>
      </div>

      {isLoading && <LoadingSkeleton />}

      {error && (
        <Card className="p-6 text-center space-y-2">
          <AlertTriangle className="h-8 w-8 text-red-500 mx-auto" />
          <p className="text-sm font-medium">Failed to load test results</p>
          <p className="text-xs text-muted-foreground">
            The artifact download may have timed out.{' '}
            <button onClick={() => mutate()} className="text-blue-400 hover:underline">
              Try again
            </button>
          </p>
        </Card>
      )}

      {results && (
        <>
          {/* Stats bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 rounded-lg border border-border overflow-hidden">
            <StatsBadge
              icon={<XCircle className="h-5 w-5 text-red-500" />}
              label="Failures"
              value={counts.failed}
              className="border-r border-border bg-red-500/5"
            />
            <StatsBadge
              icon={<CheckCircle2 className="h-5 w-5 text-green-500" />}
              label="Passed"
              value={counts.passed}
              className="border-r border-border"
            />
            <StatsBadge
              icon={<SkipForward className="h-5 w-5 text-yellow-500" />}
              label="Skipped"
              value={counts.skipped}
              className="border-r border-border"
            />
            <StatsBadge
              icon={<CheckCircle2 className="h-5 w-5 text-muted-foreground" />}
              label="Total"
              value={counts.total}
            />
          </div>

          {/* Expired artifact notice */}
          {results.expiredArtifacts > 0 && (
            <div className="flex items-center gap-2 text-xs text-yellow-500/80 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {results.expiredArtifacts} artifact{results.expiredArtifacts > 1 ? 's have' : ' has'} expired.
              {results.checkRunSuites.length > 0
                ? ' Showing results from check-run summaries instead.'
                : ' Some details may be missing.'}
            </div>
          )}

          {/* No data at all */}
          {sections.length === 0 && (
            <Card className="p-8 text-center space-y-2">
              <AlertTriangle className="h-8 w-8 text-muted-foreground mx-auto" />
              <p className="text-sm font-medium">No test results found</p>
              <p className="text-xs text-muted-foreground">
                This CI run may not have uploaded test artifacts, or the failure
                happened before tests ran.
              </p>
              {runUrl && (
                <a
                  href={runUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-400 hover:underline"
                >
                  View the full run on GitHub <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </Card>
          )}

          {sections.length > 0 && (
            <Card className="overflow-hidden">
              {/* Filter + tab bar */}
              <div className="flex flex-col sm:flex-row gap-3 px-4 py-3 border-b bg-muted/30">
                {/* Search */}
                <div className="relative flex-1 max-w-sm">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter by test name…"
                    className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>

                {/* Tabs */}
                <div className="flex items-center gap-1">
                  {(
                    [
                      { id: 'failed', label: 'Failed', count: counts.failed },
                      { id: 'all',    label: 'All',    count: counts.total },
                      { id: 'skipped',label: 'Skipped',count: counts.skipped },
                    ] as const
                  ).map(({ id, label, count }) => (
                    <button
                      key={id}
                      onClick={() => setTab(id)}
                      className={cn(
                        'px-2.5 py-1 rounded text-xs font-medium transition-colors',
                        tab === id
                          ? 'bg-background border border-border text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {label}{' '}
                      <span className={cn('text-[10px]', tab === id ? 'text-muted-foreground' : '')}>
                        ({count.toLocaleString()})
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Test failure groups */}
              <div className="divide-y divide-border">
                {filteredSections.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No tests match the current filter.
                  </div>
                ) : (
                  filteredSections.map((sec, i) => (
                    <div key={`${sec.artifactName}-${i}`} className="px-4 py-4">
                      <ArtifactSection
                        artifact={sec}
                        filter={filter}
                        isCheckRun={sec.isCheckRun}
                      />
                    </div>
                  ))
                )}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
