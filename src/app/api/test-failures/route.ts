//
// GET /api/test-failures?owner=...&repo=...&sha=...
//
// Returns individual failed test cases with their error messages and stack
// traces, sourced from check run annotations written by test reporter actions
// (dorny/test-reporter, mikepenz/action-junit-report, etc.).
//
// This is called on-demand when the user expands a failing PR row — it is NOT
// included in the main /api/prs payload to keep that response fast.
//
// Returns [] when the repo's CI does not use annotation-based reporters.
//

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { fetchTestFailures } from '@/lib/github'
import { getTokenForOwner } from '@/lib/github-auth'
import type { TestFailuresApiResponse } from '@/types'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const owner = searchParams.get('owner')
  const repo  = searchParams.get('repo')
  const sha   = searchParams.get('sha')

  if (!owner || !repo || !sha) {
    return NextResponse.json({ error: 'Missing required params: owner, repo, sha' }, { status: 400 })
  }

  try {
    const token = await getTokenForOwner(owner)
    const failures = await fetchTestFailures(owner, repo, sha, token)
    const response: TestFailuresApiResponse = { failures }
    return NextResponse.json(response)
  } catch (err) {
    console.error('Failed to fetch test failures:', err)
    return NextResponse.json({ error: 'Failed to fetch test failures' }, { status: 500 })
  }
}
