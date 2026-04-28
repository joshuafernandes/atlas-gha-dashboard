//
// Pull Request list component.
//
// Fetches PR data from /api/prs and renders one card per repo, with each
// card containing the list of open PRs sorted by most recent CI activity.
//
// ADAPTIVE POLLING:
//   SWR refreshInterval is a function, not a fixed number. When any PR is
//   currently building, the API sets hasBuilding=true and we poll every 15 s
//   so the status updates feel near-real-time. When nothing is building we
//   slow to 60 s — no point hammering GitHub for a stable green board.
//
// FILTERING:
//   selectedRepo and selectedAuthor come from RepoFilterContext (written by
//   the Header dropdowns). Filtering is done client-side so no extra API call
//   is needed and switching filters is instant.
//
// BUILD STATUS (BuildStatus component):
//   Renders a human-readable status line below the PR title:
//     - "Passed #234 ↗"                      (green, links to run)
//     - "Failed #234 ↗: job-a, job-b → View failures"  (red, links to failures page)
//     - "Running #234 ↗: job-a"              (yellow, spinning icon)
//     - "Cancelled #234 ↗"                   (orange)
//   Plus an optional test counts line when dorny/test-reporter (or similar)
//   is configured: "1 234 tests: 1 220 passed · 14 failed"
//

'use client'

import { useCallback } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import { formatDistanceToNow } from '@/lib/date'
import { useRepoFilter } from '@/components/common/RepoFilter/context'
import { WorkflowBadge } from '@/components/common/WorkflowBadge'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Card } from '@/components/ui/card'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  RefreshCw,
  GitPullRequest,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PrsApiResponse, PullRequest } from '@/types'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

// Build the URL for the dedicated failures page, carrying all the context the
// page needs so it doesn't have to fetch the PR metadata a second time.
function failuresUrl(pr: PullRequest): string {
  if (!pr.latestRun) return '#'
  const [owner, repo] = pr.repo.split('/')
  const p = new URLSearchParams({
    owner:     owner!,
    repo:      repo!,
    runId:     String(pr.latestRun.id),
    sha:       pr.head_sha,
    prNumber:  String(pr.number),
    prTitle:   pr.title,
    prUrl:     pr.html_url,
    runUrl:    pr.latestRun.html_url,
    runNumber: String(pr.latestRun.run_number),
    branch:    pr.head_sha,   // head_sha used as fallback; real branch not in PullRequest type
    author:    pr.author.login,
  })
  return `/test-failures?${p.toString()}`
}

// Build status row

function BuildStatus({ pr }: { pr: PullRequest }) {
  const { latestRun, workflowStatus, failedJobs, inProgressJobs, tests } = pr

  if (!latestRun && workflowStatus === 'pending') {
    return <span className="text-xs text-muted-foreground">No workflow runs yet</span>
  }
  if (!latestRun) return null

  // Clickable run number badge that links directly to the GitHub Actions run
  const runLink = (
    <a
      href={latestRun.html_url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 font-mono hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      #{latestRun.run_number}
      <ExternalLink className="h-2.5 w-2.5 opacity-60" />
    </a>
  )

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {/* Passed */}
        {workflowStatus === 'passing' && (
          <span className="inline-flex items-center gap-1 text-green-500 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Passed {runLink}
          </span>
        )}

        {/* Failed — list the specific job names + link to failures page */}
        {workflowStatus === 'failing' && (
          <span className="inline-flex items-center gap-1 text-red-500 font-medium">
            <XCircle className="h-3.5 w-3.5" />
            Failed {runLink}
            {failedJobs.length > 0 && (
              <span className="font-normal">
                {': '}
                {failedJobs.map((job, i) => (
                  <span key={job}>
                    {i > 0 && <span className="text-red-400">, </span>}
                    <span className="text-red-400">{job}</span>
                  </span>
                ))}
              </span>
            )}
          </span>
        )}

        {/* Running — show which jobs are in progress */}
        {workflowStatus === 'building' && (
          <span className="inline-flex items-center gap-1 text-yellow-500 font-medium">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Running {runLink}
            {inProgressJobs.length > 0 && (
              <span className="font-normal text-yellow-600 dark:text-yellow-400">
                {': '}
                {inProgressJobs.join(', ')}
              </span>
            )}
          </span>
        )}

        {/* Cancelled / timed out */}
        {workflowStatus === 'error' && (
          <span className="text-orange-500 font-medium inline-flex items-center gap-1">
            <XCircle className="h-3.5 w-3.5" />
            Cancelled {runLink}
          </span>
        )}

        {/* Test counts — only shown when fetchTestCounts() found data in check runs */}
        {tests && (
          <span className={cn('text-muted-foreground', 'flex items-center gap-1')}>
            <span className="opacity-40">·</span>
            <span>{tests.total.toLocaleString()} tests:</span>
            <span className="text-green-500">{tests.passed.toLocaleString()} passed</span>
            {tests.skipped > 0 && (
              <><span className="opacity-40">·</span><span>{tests.skipped.toLocaleString()} skipped</span></>
            )}
            {tests.failed > 0 && (
              <><span className="opacity-40">·</span><span className="text-red-500">{tests.failed.toLocaleString()} failed</span></>
            )}
          </span>
        )}
      </div>

      {/* View failures link on its own line, directly below the Failed status */}
      {workflowStatus === 'failing' && (
        <div>
          <Link
            href={failuresUrl(pr)}
            className="inline-flex items-center gap-0.5 text-xs text-red-400 hover:text-red-300 underline underline-offset-2 decoration-dotted transition-colors"
          >
            View failures <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      )}
    </div>
  )
}

// Individual PR row

function PrRow({ pr }: { pr: PullRequest }) {
  const [owner, repo] = pr.repo.split('/')
  return (
    <div className="flex items-start gap-4 px-4 py-3.5 hover:bg-muted/50 transition-colors">
      {/* Compact status badge (Passing / Failing / Building etc.) */}
      <div className="pt-0.5 shrink-0 w-16">
        <WorkflowBadge status={pr.workflowStatus} />
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0 space-y-1.5">
        {/* PR title + review decision badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href={pr.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium hover:text-blue-500 transition-colors"
          >
            {pr.title}
          </Link>
          {pr.draft && <Badge variant="muted" className="text-[10px] py-0">Draft</Badge>}
          {pr.reviewDecision === 'APPROVED' && (
            <Badge variant="success" className="text-[10px] py-0">Approved</Badge>
          )}
          {pr.reviewDecision === 'CHANGES_REQUESTED' && (
            <Badge variant="destructive" className="text-[10px] py-0">Changes requested</Badge>
          )}
        </div>

        {/* Repo + PR number + age */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">
            <span className="text-blue-500/70">{owner}/</span>
            <span className="text-blue-500/90 font-medium">{repo}</span>
            <span className="ml-1">#{pr.number}</span>
          </span>
          <span className="opacity-40">·</span>
          <span>
            {pr.lastRunAt
              ? `ran ${formatDistanceToNow(pr.lastRunAt)}`
              : `updated ${formatDistanceToNow(pr.updated_at)}`}
          </span>
        </div>

        {/* Build status line (pass/fail/running + test counts + failures link) */}
        <BuildStatus pr={pr} />
      </div>

      {/* Author avatar + login */}
      <div className="shrink-0 flex items-center gap-1.5 pt-0.5">
        <Avatar className="h-6 w-6">
          <AvatarImage src={pr.author.avatar_url} alt={pr.author.login} />
          <AvatarFallback className="text-[9px]">
            {pr.author.login.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="text-xs text-muted-foreground hidden sm:inline">{pr.author.login}</span>
      </div>
    </div>
  )
}

// Loading skeleton

function PrSkeletons() {
  return (
    <div className="divide-y">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-start gap-4 px-4 py-3.5">
          <Skeleton className="h-4 w-16 mt-0.5" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-6 w-6 rounded-full" />
        </div>
      ))}
    </div>
  )
}

// Main component

export function PrList() {
  const { selectedRepo, selectedAuthor } = useRepoFilter()

  // refreshInterval as a function enables adaptive polling:
  //   - 15 s when any PR is building (fast feedback during active CI runs)
  //   - 60 s otherwise (reduce unnecessary API calls when board is stable)
  const { data, error, isLoading, mutate, isValidating } = useSWR<PrsApiResponse>(
    '/api/prs',
    fetcher,
    {
      refreshInterval: (data) => (data?.hasBuilding ? 15_000 : 60_000),
      revalidateOnFocus: false,
    },
  )

  const refresh = useCallback(() => mutate(), [mutate])

  if (error) {
    return (
      <Card className="m-6 p-6 text-center text-sm text-muted-foreground">
        Failed to load pull requests.{' '}
        <button onClick={refresh} className="text-blue-500 hover:underline">Try again</button>
      </Card>
    )
  }

  // Apply repo + author filters from the header dropdowns
  const allPrs = data?.prs ?? []
  const prs = allPrs
    .filter((pr) => !selectedRepo || pr.repo === selectedRepo)
    .filter((pr) => !selectedAuthor || pr.author.login === selectedAuthor)

  // Group by repo for the card-per-repo layout
  const byRepo = prs.reduce<Record<string, PullRequest[]>>((acc, pr) => {
    if (!acc[pr.repo]) acc[pr.repo] = []
    acc[pr.repo].push(pr)
    return acc
  }, {})

  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Pull Requests</h1>
          {data && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {prs.length} open PR{prs.length !== 1 ? 's' : ''} across{' '}
              {Object.keys(byRepo).length} repo{Object.keys(byRepo).length !== 1 ? 's' : ''}
              {' · '}updated {formatDistanceToNow(data.updatedAt)}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={isValidating} className="gap-2">
          <RefreshCw className={`h-3.5 w-3.5 ${isValidating ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <Card className="overflow-hidden"><PrSkeletons /></Card>
      ) : prs.length === 0 ? (
        <Card className="p-12 text-center">
          <GitPullRequest className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium">No open pull requests</p>
          <p className="text-xs text-muted-foreground mt-1">All configured repos are clear.</p>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* One card per repo, each containing its PR rows */}
          {Object.entries(byRepo).map(([repo, repoPrs]) => (
            <Card key={repo} className="overflow-hidden">
              {/* Repo header */}
              <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
                <GitPullRequest className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{repo}</span>
                <Badge variant="secondary" className="ml-auto text-[10px] py-0">{repoPrs.length}</Badge>
              </div>
              <div className="divide-y">
                {repoPrs.map((pr) => (
                  <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
