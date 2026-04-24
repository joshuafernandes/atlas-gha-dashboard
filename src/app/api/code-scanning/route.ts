// 
// GET /api/code-scanning
//
// Returns open code scanning alerts for all configured repos.
//
// REQUIRES: GitHub App must have the `Code scanning alerts: Read` permission,
// or a PAT with `security_events` scope. Without it, GitHub returns 403 and
// the repo is listed in `unavailableRepos` — the UI shows an info note instead.
//
// Cache TTL: 10 minutes. Alerts change slowly and each fetch costs one API
// call per repo, so we don't need to poll aggressively.
// 

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getRepos } from '@/lib/config'
import { fetchAllCodeScanningAlerts } from '@/lib/github'
import { getCached, setCached } from '@/lib/cache'
import type { CodeScanAlert, CodeScanApiResponse } from '@/types'

const CACHE_KEY = 'code-scanning'
const CACHE_TTL_MS = 10 * 60_000  // 10 minutes

export async function GET() {
  // All dashboard API routes require an authenticated session
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Return cached data if still fresh
  const cached = getCached<{ alerts: CodeScanAlert[]; unavailableRepos: string[] }>(CACHE_KEY)
  if (cached) {
    const response: CodeScanApiResponse = {
      alerts: cached.data.alerts,
      unavailableRepos: cached.data.unavailableRepos,
      updatedAt: cached.updatedAt,
    }
    return NextResponse.json(response)
  }

  try {
    const repos = getRepos()
    const { alerts, unavailableRepos } = await fetchAllCodeScanningAlerts(repos)
    const entry = setCached(CACHE_KEY, { alerts, unavailableRepos }, CACHE_TTL_MS)
    const response: CodeScanApiResponse = { alerts, unavailableRepos, updatedAt: entry.updatedAt }
    return NextResponse.json(response)
  } catch (err) {
    console.error('Failed to fetch code scanning alerts:', err)
    return NextResponse.json({ error: 'Failed to fetch code scanning alerts' }, { status: 500 })
  }
}
