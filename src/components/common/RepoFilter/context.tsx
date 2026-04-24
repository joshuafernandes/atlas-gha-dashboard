// 
// RepoFilter context.
//
// Provides two filter values that are shared across all dashboard pages:
//
//   selectedRepo   — the currently viewed repo (e.g. "myOrgA/repo1").
//                    Empty string means "all repos".
//
//   selectedAuthor — a GitHub login to filter PRs by (e.g. "joshuafernandes").
//                    Empty string means "all authors".
//
// The Header component writes these values via the dropdowns; each page
// component reads them to filter its own data client-side (no extra API call).
//
// IMPORTANT: When the user switches repos, the author filter is cleared.
// Without this, a stale author name from repo-A would silently hide all
// PRs in repo-B if no one in repo-B has that same login.
// 

'use client'

import { createContext, useContext, useState } from 'react'

interface RepoFilterContextValue {
  selectedRepo: string
  setSelectedRepo: (repo: string) => void
  selectedAuthor: string   // '' = all authors
  setSelectedAuthor: (author: string) => void
}

const RepoFilterContext = createContext<RepoFilterContextValue>({
  selectedRepo: '',
  setSelectedRepo: () => {},
  selectedAuthor: '',
  setSelectedAuthor: () => {},
})

export function RepoFilterProvider({ children }: { children: React.ReactNode }) {
  const [selectedRepo, setSelectedRepo] = useState('')
  const [selectedAuthor, setSelectedAuthor] = useState('')

  // Clear author when repo changes so a stale author name from the previous
  // repo doesn't persist and silently filter out all PRs in the new repo.
  function handleSetRepo(repo: string) {
    setSelectedRepo(repo)
    setSelectedAuthor('')
  }

  return (
    <RepoFilterContext.Provider value={{ selectedRepo, setSelectedRepo: handleSetRepo, selectedAuthor, setSelectedAuthor }}>
      {children}
    </RepoFilterContext.Provider>
  )
}

export function useRepoFilter() {
  return useContext(RepoFilterContext)
}
