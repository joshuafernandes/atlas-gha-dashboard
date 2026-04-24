// 
// GET /api/workflows
//
// Returns workflow metrics and recent run history for all configured repos.
//
// Each WorkflowMetrics entry contains:
//   - Basic info: repo, name, path, badge URL
//   - Metrics: successRate, avgDurationMs, retriggerRate, runsPerDay
//   - History: last N runs (N = WORKFLOW_RUNS_LIMIT, default 20, max 100)
//     used to render the sparkline chart on the Workflows page
//
// Cache TTL: 2 minutes.  Workflow metrics don't need to be real-time.
// I've designed the Workflows page to be analytics-oriented rather than live monitoring.
//
// The depth of run history is configurable via the WORKFLOW_RUNS_LIMIT env
// var (see config.ts) so operators can trade off API cost vs. sparkline detail.
//
// Response: WorkflowsApiResponse { workflows, updatedAt }
// 

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getRepos, getWorkflowRunsLimit } from '@/lib/config'
import { fetchAllWorkflows } from '@/lib/github'
import { getCached, setCached } from '@/lib/cache'
import type { WorkflowMetrics, WorkflowsApiResponse } from '@/types'

const CACHE_KEY = 'workflows'
const CACHE_TTL_MS = 2 * 60_000 // 2 min — analytics don't need to be live

export async function GET() {
  // all dashboard API routes require an authenticated session
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Return cached data if still fresh
  const cached = getCached<WorkflowMetrics[]>(CACHE_KEY)
  if (cached) {
    const response: WorkflowsApiResponse = { workflows: cached.data, updatedAt: cached.updatedAt }
    return NextResponse.json(response)
  }

  try {
    const repos = getRepos()
    // getWorkflowRunsLimit() reads WORKFLOW_RUNS_LIMIT env var (default 20, max 100)
    const limit = getWorkflowRunsLimit()
    // fetchAllWorkflows fans out across repos, fetching active workflows and
    // their recent run history, then computes per-workflow metrics
    const workflows = await fetchAllWorkflows(repos, limit)
    const entry = setCached(CACHE_KEY, workflows, CACHE_TTL_MS)
    const response: WorkflowsApiResponse = { workflows, updatedAt: entry.updatedAt }
    return NextResponse.json(response)
  } catch (err) {
    console.error('Failed to fetch workflows:', err)
    return NextResponse.json({ error: 'Failed to fetch workflows' }, { status: 500 })
  }
}
