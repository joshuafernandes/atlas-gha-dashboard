//
// GET /api/dependabot-alerts
//
// Returns open Dependabot vulnerability alerts for all configured repos.
//
// REQUIRES: GitHub App must have the `Dependabot alerts: Read` permission,
// or a PAT with `vulnerability_alerts` scope. Without it, GitHub returns 403
// and the repo is listed in `unavailableRepos` — the UI shows an info note.
//
// Cache TTL: 10 minutes. Dependency alerts change slowly.
//

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getRepos } from '@/lib/config'
import { fetchAllDependabotAlerts } from '@/lib/github'
import { getCached, setCached } from '@/lib/cache'
import type { DependabotAlert, DependabotAlertsApiResponse } from '@/types'

const CACHE_KEY = 'dependabot-alerts'
const CACHE_TTL_MS = 10 * 60_000  // 10 minutes

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cached = getCached<{ alerts: DependabotAlert[]; unavailableRepos: string[] }>(CACHE_KEY)
  if (cached) {
    const response: DependabotAlertsApiResponse = {
      alerts: cached.data.alerts,
      unavailableRepos: cached.data.unavailableRepos,
      updatedAt: cached.updatedAt,
    }
    return NextResponse.json(response)
  }

  try {
    const repos = getRepos()
    const { alerts, unavailableRepos } = await fetchAllDependabotAlerts(repos)
    const entry = setCached(CACHE_KEY, { alerts, unavailableRepos }, CACHE_TTL_MS)
    const response: DependabotAlertsApiResponse = { alerts, unavailableRepos, updatedAt: entry.updatedAt }
    return NextResponse.json(response)
  } catch (err) {
    console.error('Failed to fetch Dependabot alerts:', err)
    return NextResponse.json({ error: 'Failed to fetch Dependabot alerts' }, { status: 500 })
  }
}
