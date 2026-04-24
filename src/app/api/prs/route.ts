// 
// GET /api/prs
//
// Returns open pull requests with their latest CI workflow status.
//
// Cache TTL: 30 seconds. I've set a short TTL because build status changes frequently —
// a PR can go from "queued" → "building" → "passed" within a few minutes.
//
// The client uses the `hasBuilding` flag to drive adaptive SWR polling:
//   - true  → poll every 15 s (something is actively running)
//   - false → poll every 60 s (nothing running, slower is fine)
//
// Response: PrsApiResponse { prs, updatedAt, hasBuilding }
// 

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getRepos } from '@/lib/config'
import { fetchAllPRs } from '@/lib/github'
import { getCached, setCached } from '@/lib/cache'
import type { PrsApiResponse, PullRequest } from '@/types'

const CACHE_KEY = 'prs'
const CACHE_TTL_MS = 30_000 // 30s — short because CI status changes quickly

export async function GET() {
  // all dashboard API routes require an authenticated session
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Return cached data if still fresh
  const cached = getCached<PullRequest[]>(CACHE_KEY)
  if (cached) {
    // Recompute hasBuilding even from cache so the flag stays accurate
    const hasBuilding = cached.data.some((pr) => pr.workflowStatus === 'building')
    const response: PrsApiResponse = {
      prs: cached.data,
      updatedAt: cached.updatedAt,
      hasBuilding,
    }
    return NextResponse.json(response)
  }

  try {
    const repos = getRepos()
    // fetchAllPRs fans out across all configured repos concurrently, merges
    // results, and sorts by most-recent workflow run (newest activity first)
    const prs = await fetchAllPRs(repos)
    const entry = setCached(CACHE_KEY, prs, CACHE_TTL_MS)
    const hasBuilding = prs.some((pr) => pr.workflowStatus === 'building')
    const response: PrsApiResponse = { prs, updatedAt: entry.updatedAt, hasBuilding }
    return NextResponse.json(response)
  } catch (err) {
    console.error('Failed to fetch PRs:', err)
    return NextResponse.json({ error: 'Failed to fetch pull requests' }, { status: 500 })
  }
}
