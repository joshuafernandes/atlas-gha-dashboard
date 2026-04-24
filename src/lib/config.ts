// 
// Config helpers — read environment variables and return typed values.
//
// All env vars are read at request time (not build time) so you can change
// .env.local and restart the dev server without rebuilding.
//
// GitHub auth vars (one set required):
//   GitHub App:  GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY
//                optionally GITHUB_APP_INSTALLATION_ID
//   PAT fallback: GITHUB_TOKEN
//
// Required vars:   GITHUB_REPOS, NEXTAUTH_SECRET,
//                  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, NEXTAUTH_URL
// Optional vars:   ALLOWED_EMAIL_DOMAIN, WORKFLOW_RUNS_LIMIT
// 

import type { RepoConfig } from '@/types'

/**
 * Parse GITHUB_REPOS into a list of {owner, name} objects.
 *
 * Format: comma-separated "owner/repo" pairs
 * Example: GITHUB_REPOS=myOrgA/repo1,myOrgA/repo1,myOrgB/repo2
 *
 * Returns an empty array (with a warning) if the variable is unset, so the
 * dashboard loads rather than crashing — you'll just see empty pages.
 */
export function getRepos(): RepoConfig[] {
  const raw = process.env.GITHUB_REPOS ?? ''
  if (!raw.trim()) {
    console.warn('GITHUB_REPOS is not set — no repositories configured')
    return []
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [owner, name] = entry.split('/')
      if (!owner || !name)
        throw new Error(`Invalid GITHUB_REPOS entry: "${entry}" — expected "owner/repo"`)
      return { owner, name }
    })
}

/**
 * Optional: restrict Google sign-in to a single email domain.
 *
 * Example: ALLOWED_EMAIL_DOMAIN=consensys.net
 * → only @consensys.net addresses can log in.
 *
 * Leave unset to allow any Google account.
 */
export function getAllowedEmailDomain(): string | null {
  return process.env.ALLOWED_EMAIL_DOMAIN ?? null
}

/**
 * Number of past workflow runs to fetch per workflow on the Analytics page.
 *
 * More runs = better statistical accuracy but more API calls.
 * GitHub's API allows up to 100 per request (one request per workflow).
 * Defaults to 20.
 */
export function getWorkflowRunsLimit(): number {
  const raw = process.env.WORKFLOW_RUNS_LIMIT
  if (!raw) return 20
  const n = parseInt(raw, 10)
  if (isNaN(n) || n < 1) return 20
  return Math.min(n, 100) // GitHub API max per_page is 100
}
