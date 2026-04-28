//
// GET /api/pr-failures?owner=...&repo=...&runId=...&sha=...
//
// Downloads JUnit XML artifact ZIPs for a completed CI run and returns
// structured test failure data: suite names, failed test cases, error
// messages, and full stack traces.
//
// Falls back to GraphQL check-run HTML summaries when artifacts have expired.
//
// Cache TTL: 5 minutes. Completed runs don't change, so aggressive caching
// is safe. The cache key is {owner}/{repo}/{runId} so different runs/PRs get
// separate entries.
//
// This is called on-demand by the /test-failures page — it is NOT part of the
// main /api/prs payload because artifact downloads are too slow for polling.
//

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { fetchPRTestResults } from '@/lib/github'
import { getTokenForOwner } from '@/lib/github-auth'
import { getCached, setCached } from '@/lib/cache'
import type { PRFailuresApiResponse, PRTestResults } from '@/types'

const CACHE_TTL_MS = 5 * 60_000  // 5 min — completed runs never change

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const owner = searchParams.get('owner')
  const repo  = searchParams.get('repo')
  const runId = searchParams.get('runId')
  const sha   = searchParams.get('sha')

  if (!owner || !repo || !runId || !sha) {
    return NextResponse.json(
      { error: 'Missing required params: owner, repo, runId, sha' },
      { status: 400 },
    )
  }

  const cacheKey = `pr-failures:${owner}/${repo}/${runId}`
  const cached = getCached<PRTestResults>(cacheKey)
  if (cached) {
    return NextResponse.json({ results: cached.data } satisfies PRFailuresApiResponse)
  }

  try {
    const token = await getTokenForOwner(owner)
    const results = await fetchPRTestResults(owner, repo, parseInt(runId), sha, token)
    setCached(cacheKey, results, CACHE_TTL_MS)
    return NextResponse.json({ results } satisfies PRFailuresApiResponse)
  } catch (err) {
    console.error('Failed to fetch PR failures:', err)
    return NextResponse.json({ error: 'Failed to fetch test results' }, { status: 500 })
  }
}
