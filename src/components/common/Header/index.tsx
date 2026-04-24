// 
// Dashboard header.
//
// Contains two filter controls:
//
//   1. Repo selector  — reads from /api/repos (static list from GITHUB_REPOS).
//                       Defaults to the first repo once loaded so the PR page
//                       is never blank on first visit.
//
//   2. Author filter  — derives the author list from /api/prs data that PrList
//                       already fetched. SWR deduplicates the request so there
//                       is NO extra network call — both components share the
//                       same cache entry. Only shown once at least one PR is
//                       loaded. Highlighted blue when an author is active.
//
// Both controls write into RepoFilterContext (context.tsx). All page components
// read from the same context to apply the active filter client-side.
//
// 

'use client'

import { useEffect, useMemo } from 'react'
import useSWR from 'swr'
import { ChevronDown, Layers, User } from 'lucide-react'
import { useRepoFilter } from '@/components/common/RepoFilter/context'
import { cn } from '@/lib/utils'
import type { PrsApiResponse } from '@/types'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

interface ReposResponse {
  repos: string[]
}

// tyled <select> wrapper 

function Select({
  value,
  onChange,
  active,
  children,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  active?: boolean
  children: React.ReactNode
  ariaLabel: string
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={cn(
          'appearance-none cursor-pointer rounded-md border border-input bg-background',
          'pl-3 pr-7 py-1.5 text-sm font-medium',
          'focus:outline-none focus:ring-1 focus:ring-ring',
          'hover:bg-accent hover:text-accent-foreground transition-colors',
          // Highlight border + text when a non-default value is active
          active && 'border-blue-500/50 text-blue-600 dark:text-blue-400',
        )}
      >
        {children}
      </select>
      {/* Decorative caret — pointer-events-none so it doesn't block the select */}
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
    </div>
  )
}

// Header up top

export function Header() {
  const { selectedRepo, setSelectedRepo, selectedAuthor, setSelectedAuthor } = useRepoFilter()

  // Fetch the configured repo list — rarely changes, so no revalidation needed
  const { data: reposData } = useSWR<ReposResponse>('/api/repos', fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  })

  // Re-use PR data already in SWR cache from PrList — no extra network request.
  // This gives us the author list without a dedicated /api/authors endpoint.
  const { data: prsData } = useSWR<PrsApiResponse>('/api/prs', fetcher, {
    revalidateOnFocus: false,
  })

  const repos = reposData?.repos ?? []

  // Default the repo selector to the first repo once the list arrives so
  // the user sees a meaningful view rather than a blank "All repos" state.
  useEffect(() => {
    if (repos.length > 0 && !selectedRepo) {
      setSelectedRepo(repos[0])
    }
  }, [repos, selectedRepo, setSelectedRepo])

  // Derive unique, sorted authors for the selected repo.
  // Re-memoised whenever the PR data or selected repo changes.
  const authors = useMemo(() => {
    const prs = prsData?.prs ?? []
    const filtered = selectedRepo ? prs.filter((pr) => pr.repo === selectedRepo) : prs
    const logins = [...new Set(filtered.map((pr) => pr.author.login))].sort()
    return logins
  }, [prsData, selectedRepo])

  return (
    <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b bg-background/95 backdrop-blur px-6">
      <Layers className="h-4 w-4 text-muted-foreground shrink-0" />

      {/* Repo selector */}
      <Select
        value={selectedRepo}
        onChange={setSelectedRepo}
        ariaLabel="Select project"
      >
        {repos.map((repo) => (
          <option key={repo} value={repo}>
            {repo.split('/')[1]}
          </option>
        ))}
      </Select>

      {/* Author filter — only shown once PR data has loaded (avoid flash) */}
      {authors.length > 0 && (
        <>
          <span className="text-muted-foreground/40 text-sm select-none">/</span>
          <div className="flex items-center gap-1.5">
            <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Select
              value={selectedAuthor}
              onChange={setSelectedAuthor}
              active={!!selectedAuthor}  // highlight when filtering by a specific author
              ariaLabel="Filter by author"
            >
              <option value="">All authors</option>
              {authors.map((login) => (
                <option key={login} value={login}>
                  {login}
                </option>
              ))}
            </Select>
          </div>
        </>
      )}

      {/* Org / project count summary on the far right */}
      <div className="ml-auto text-xs text-muted-foreground">
        {selectedRepo && `${selectedRepo.split('/')[0]} / ${repos.length} project${repos.length !== 1 ? 's' : ''}`}
      </div>
    </header>
  )
}
