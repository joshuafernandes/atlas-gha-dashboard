//
// GET /api/secret-scanning
//
// Returns open secret scanning alerts for all configured repos.
//
// REQUIRES: GitHub App must have the `Secret scanning alerts: Read` permission,
// or a PAT with `secret_scanning_alerts` scope. Without it, GitHub returns 403
// and the repo is listed in `unavailableRepos` — the UI shows an info note.
// Also requires GitHub Advanced Security to be enabled on the repo.
//
// Cache TTL: 10 minutes. Alerts change slowly.
//

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getRepos } from '@/lib/config'
import { fetchAllSecretScanningAlerts } from '@/lib/github'
import { getCached, setCached } from '@/lib/cache'
import type { SecretScanAlert, SecretScanApiResponse } from '@/types'

const CACHE_KEY = 'secret-scanning'
const CACHE_TTL_MS = 10 * 60_000  // 10 minutes

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cached = getCached<{ alerts: SecretScanAlert[]; unavailableRepos: string[] }>(CACHE_KEY)
  if (cached) {
    const response: SecretScanApiResponse = {
      alerts: cached.data.alerts,
      unavailableRepos: cached.data.unavailableRepos,
      updatedAt: cached.updatedAt,
    }
    return NextResponse.json(response)
  }

  try {
    const repos = getRepos()
    const { alerts, unavailableRepos } = await fetchAllSecretScanningAlerts(repos)
    const entry = setCached(CACHE_KEY, { alerts, unavailableRepos }, CACHE_TTL_MS)
    const response: SecretScanApiResponse = { alerts, unavailableRepos, updatedAt: entry.updatedAt }
    return NextResponse.json(response)
  } catch (err) {
    console.error('Failed to fetch secret scanning alerts:', err)
    return NextResponse.json({ error: 'Failed to fetch secret scanning alerts' }, { status: 500 })
  }
}
