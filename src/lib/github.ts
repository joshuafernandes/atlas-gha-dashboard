// 
// GitHub API client.
//
// All GitHub communication happens here. The rest of the app should never
// call fetch() directly against the GitHub API — always use the functions
// exported from this module.
//
// AUTHENTICATION
//   Every request uses a Bearer token resolved by getTokenForOwner() in
//   github-auth.ts. That function returns a GitHub App installation token
//   when app credentials are configured, or falls back to GITHUB_TOKEN.
//   Tokens are cached per org so each org is resolved at most once per hour.
//
// RATE LIMITS
//   Authenticated requests: 5 000/hour (REST), 5 000 points/hour (GraphQL).
//   Each call to fetchPRsForRepo() makes roughly 3+N requests (list PRs,
//   GraphQL batch, then per-PR: runs + jobs + check-runs = ~3 each).
//   The server-side cache in cache.ts is what keeps us well under the limit.
//
// ERROR HANDLING
//   ghJson() throws on non-2xx responses, with the HTTP status attached so
//   callers can distinguish 403 (auth) from 404 (not enabled) from 500 etc.
//   Promise.allSettled() is used throughout so a single failing repo doesn't
//   break the entire response.
// 

import type {
  PullRequest,
  WorkflowRun,
  WorkflowStatus,
  TestCounts,
  TestFailure,
  CodeScanAlert,
  AlertSeverity,
  AlertState,
  DependabotAlert,
  RepoConfig,
} from '@/types'
import { getTokenForOwner } from './github-auth'

const GH_API = 'https://api.github.com'

// Low-level HTTP helpers 

/**
 * Thin wrapper around fetch() that adds auth headers.
 * `cache: 'no-store'` tells Next.js not to use its own fetch cache — we handle
 * caching ourselves in cache.ts so we don't want stale data from the framework.
 */
async function ghFetch(path: string, token: string): Promise<Response> {
  const url = path.startsWith('http') ? path : `${GH_API}${path}`
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'gha-dashboard',
    },
    cache: 'no-store',
  })
}

/**
 * Fetch JSON from the GitHub REST API.
 * Throws an error with `error.status` set on non-2xx responses so callers
 * can handle specific status codes (403, 404) without try/catch on the message.
 */
async function ghJson<T>(path: string, token: string): Promise<T> {
  const res = await ghFetch(path, token)
  if (!res.ok) {
    const body = await res.text()
    throw Object.assign(new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`), {
      status: res.status,
    })
  }
  return res.json() as Promise<T>
}

/**
 * Run a GraphQL query against the GitHub GraphQL API (v4).
 * Returns null (without throwing) on network or GraphQL errors so failures
 * degrade gracefully — missing review decisions just show as null.
 *
 * We use GraphQL for review decisions because it lets us batch many PRs into
 * a single request, while the REST API would require one request per PR.
 */
async function ghGraphQL<T>(query: string, token: string): Promise<T | null> {
  const res = await fetch(`${GH_API}/graphql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'gha-dashboard',
    },
    body: JSON.stringify({ query }),
    cache: 'no-store',
  })
  if (!res.ok) return null
  const data = (await res.json()) as { data?: T; errors?: unknown[] }
  if (data.errors) {
    console.error('GraphQL errors:', JSON.stringify(data.errors))
    return null
  }
  return data.data ?? null
}

// Status derivation

/**
 * Collapse GitHub's two-field run state (status + conclusion) into our simpler
 * WorkflowStatus enum. GitHub separates these because a run transitions through
 * statuses (queued → in_progress → completed) and only sets conclusion at the end.
 */
function deriveStatus(run: WorkflowRun | null): WorkflowStatus {
  if (!run) return 'pending'
  if (run.status === 'queued') return 'pending'
  if (run.status === 'in_progress') return 'building'
  if (run.status === 'completed') {
    switch (run.conclusion) {
      case 'success':   return 'passing'
      case 'failure':   return 'failing'
      case 'cancelled': return 'error'
      case 'skipped':   return 'skipped'
      default:          return 'unknown'
    }
  }
  return 'unknown'
}

// Review decisions (GraphQL batch) 

type ReviewDecisionMap = Record<number, 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null>

/**
 * Fetch the review decision for a list of PRs in a single GraphQL request.
 *
 * WHY GRAPHQL: REST would need one request per PR. With 30 open PRs that's
 * 30 extra API calls. The GraphQL approach batches all of them into one by
 * using field aliases (pr1, pr2, … prN) in a single query.
 *
 * Returns a map of prNumber → reviewDecision so the caller can look up by PR.
 */
async function fetchReviewDecisions(
  owner: string,
  repo: string,
  prNumbers: number[],
  token: string,
): Promise<ReviewDecisionMap> {
  if (!prNumbers.length) return {}
  // Build one alias per PR: "pr123: pullRequest(number: 123) { reviewDecision }"
  const fragments = prNumbers
    .map((n) => `pr${n}: pullRequest(number: ${n}) { reviewDecision }`)
    .join('\n')
  const data = await ghGraphQL<{ repository: Record<string, { reviewDecision: string | null } | null> }>(
    `{ repository(owner: "${owner}", name: "${repo}") { ${fragments} } }`,
    token,
  )
  if (!data?.repository) return {}
  const out: ReviewDecisionMap = {}
  // Alias keys look like "pr123" — strip the "pr" prefix to get the number back
  for (const [key, val] of Object.entries(data.repository)) {
    out[parseInt(key.slice(2))] = (val?.reviewDecision as ReviewDecisionMap[number]) ?? null
  }
  return out
}

// Workflow runs

// Raw GitHub API shape before we map it to our WorkflowRun type
interface GhWorkflowRun {
  id: number
  name: string
  run_number: number
  status: string
  conclusion: string | null
  html_url: string
  updated_at: string
  path?: string  // e.g. ".github/workflows/ci.yml"
}

/**
 * Fetch all workflow runs triggered by a specific commit SHA.
 * We use head_sha to find runs associated with a PR's latest commit.
 * Returns up to 20 runs (a PR rarely has more than a few active workflows).
 */
async function fetchWorkflowRuns(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<WorkflowRun[]> {
  const data = await ghJson<{ workflow_runs: GhWorkflowRun[] }>(
    `/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=20`,
    token,
  )
  return (data.workflow_runs ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    run_number: r.run_number,
    status: r.status,
    conclusion: r.conclusion,
    html_url: r.html_url,
    updated_at: r.updated_at,
  }))
}

// Workflow jobs

interface GhJob {
  name: string
  status: string        // queued | in_progress | completed
  conclusion: string | null
}

/**
 * Fetch the individual jobs within a workflow run.
 * We use this to show *which* jobs failed (e.g. "compile, unit-tests") rather
 * than just showing "failed" at the workflow level.
 * Returns [] on any error (non-fatal — the PR row just won't list failed jobs).
 */
async function fetchWorkflowJobs(
  owner: string,
  repo: string,
  runId: number,
  token: string,
): Promise<GhJob[]> {
  try {
    const data = await ghJson<{ jobs: GhJob[] }>(
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
      token,
    )
    return data.jobs ?? []
  } catch {
    return []
  }
}

// Test counts from check run titles 
//
// APPROACH: When a repo uses a test reporter action (e.g. dorny/test-reporter,
// mikepenz/action-junit-report), that action creates a GitHub Check Run with
// the result counts embedded in the output title, like "234 tests, 5 failed".
//
// We fetch all check runs for the commit and try to parse counts from their
// titles using regexes. This is best-effort — if it doesn't match, we return
// null and the PR row simply doesn't show test counts.
//

interface GhCheckRun {
  id: number
  name: string
  conclusion: string | null
  output: { title: string | null } | null
}

/**
 * Try to extract test count numbers from a check run title string.
 * Handles formats like:
 *   "234 passed, 5 failed, 12 skipped"
 *   "250 tests: 230 passed"
 *   "16 failures detected"
 */
function parseCountsFromTitle(title: string): Partial<TestCounts> {
  const c: Partial<TestCounts> = {}
  const patterns: Array<[keyof TestCounts, RegExp[]]> = [
    ['total',   [/(\d+)\s+tests?/i, /(\d+)\s+results?/i]],
    ['passed',  [/(\d+)\s+pass(?:ed)?/i, /(\d+)\s+success(?:ful)?/i]],
    ['failed',  [/(\d+)\s+fail(?:ed|ures?)?/i]],
    ['skipped', [/(\d+)\s+skipp?e?d?/i, /(\d+)\s+ignored/i]],
  ]
  for (const [key, regexes] of patterns) {
    for (const re of regexes) {
      const m = title.match(re)
      if (m) { c[key] = parseInt(m[1]); break }
    }
  }
  return c
}

/**
 * Fetch all check runs for a commit and accumulate test counts from their titles.
 * Returns null if no check run titles contain parseable counts.
 */
async function fetchTestCounts(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<TestCounts | null> {
  try {
    const data = await ghJson<{ check_runs: GhCheckRun[] }>(
      `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
      token,
    )
    let total = 0, passed = 0, failed = 0, skipped = 0, found = false
    for (const cr of data.check_runs ?? []) {
      const title = cr.output?.title
      if (!title) continue
      const c = parseCountsFromTitle(title)
      if (!Object.keys(c).length) continue
      found = true
      total   += c.total   ?? 0
      passed  += c.passed  ?? 0
      failed  += c.failed  ?? 0
      skipped += c.skipped ?? 0
    }
    if (!found) return null
    // If no "total" line was found, derive it from the parts
    if (total === 0) total = passed + failed + skipped
    return { total, passed, failed, skipped }
  } catch {
    return null
  }
}

// Test failure details from check run annotations
//
// Test reporter actions (dorny/test-reporter, mikepenz/action-junit-report, etc.)
// write one annotation per failed test case onto the check run. Each annotation
// has annotation_level="failure", a title (test name), a message (error summary),
// and raw_details (stack trace). We fetch these for all failed check runs and
// return them structured so the UI can render expandable failure cards.

interface GhAnnotation {
  path: string
  annotation_level: string   // 'notice' | 'warning' | 'failure'
  title: string | null       // test name set by the reporter action
  message: string            // error message / assertion failure text
  raw_details: string | null // full stack trace, when provided
}

/**
 * Fetch individual test failure details for a PR's head commit.
 *
 * Finds all check runs with conclusion=failure, then fetches their annotations
 * (up to 100 per check run). Only annotation_level="failure" entries are kept.
 *
 * Returns [] if the repo's CI doesn't use annotation-based test reporters.
 */
export async function fetchTestFailures(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<TestFailure[]> {
  const data = await ghJson<{ check_runs: GhCheckRun[] }>(
    `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
    token,
  )

  const failedRuns = (data.check_runs ?? []).filter((cr) => cr.conclusion === 'failure')
  if (!failedRuns.length) return []

  const results = await Promise.allSettled(
    failedRuns.map(async (cr): Promise<TestFailure[]> => {
      const annotations = await ghJson<GhAnnotation[]>(
        `/repos/${owner}/${repo}/check-runs/${cr.id}/annotations?per_page=100`,
        token,
      )
      return (annotations ?? [])
        .filter((a) => a.annotation_level === 'failure')
        .map((a) => ({
          checkRunName: cr.name,
          testName: a.title ?? a.path,
          message: a.message,
          stackTrace: a.raw_details ?? null,
        }))
    }),
  )

  return results
    .filter((r): r is PromiseFulfilledResult<TestFailure[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value)
}


// JUnit XML artifact-based test results
//
//   1. List artifacts for the run; filter to those that look like test reports.
//   2. Download each artifact ZIP and parse all .xml files inside as JUnit XML.
//   3. Deduplicate suites across artifacts (parallel CI jobs can contain the
//      same test suite in multiple ZIPs).
//   4. Fall back to check-run HTML summaries when all artifacts have expired.
//

import AdmZip from 'adm-zip'
import { parseXml, compactSuites, parseReportHtml } from './junit'
import type { TestArtifact, TestSuite, PRTestResults } from '@/types'

// Test artifact names in Teku follow the pattern:
//   {unit|integration|acceptance|property|reference}-reports-{jobname}
// We match both that exact format and common generic patterns used by other repos.
const TEST_ARTIFACT_RE = /^(unit|integration|acceptance|property|reference)-reports-|test[-_]report|junit[-_]results/i
const TEST_REPORT_CHECK_RUN_RE = /^(unit|integration|acceptance|property|reference)TestsReport$/i

interface GhArtifact {
  id: number
  name: string
  expired: boolean
}

async function downloadAndParseArtifact(
  owner: string,
  repo: string,
  artifactId: number,
  artifactName: string,
  token: string,
): Promise<TestArtifact> {
  // GitHub returns a 302 redirect to a short-lived signed URL.
  // Node.js fetch follows the redirect automatically; the auth header is
  // stripped on the cross-origin hop to the storage server (correct behaviour).
  const res = await ghFetch(
    `/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`,
    token,
  )
  if (!res.ok) {
    return { artifactName, suites: [], error: `HTTP ${res.status}` }
  }

  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()))
  const rawSuites: ReturnType<typeof parseXml>[0][] = []

  for (const entry of zip.getEntries()) {
    if (!entry.entryName.endsWith('.xml')) continue
    try {
      rawSuites.push(...parseXml(entry.getData().toString('utf8')))
    } catch (e) {
      console.error(`Parse error ${entry.entryName}: ${(e as Error).message}`)
    }
  }

  // Within a single ZIP, prefer the suite with the most test cases when the
  // same suite name appears in both a per-class file and an aggregate file.
  const bySuiteName = new Map<string, (typeof rawSuites)[0]>()
  for (const s of rawSuites) {
    const existing = bySuiteName.get(s.name)
    if (!existing || s.testcases.length > existing.testcases.length) {
      bySuiteName.set(s.name, s)
    }
  }

  return { artifactName, suites: compactSuites([...bySuiteName.values()]) }
}

// When suites with the same name appear in multiple artifact ZIPs (parallel CI
// shards uploading their own copy of the full report), keep only the first one.
function deduplicateSuites(artifactResults: TestArtifact[]): void {
  const seen = new Set<string>()
  for (const art of artifactResults) {
    art.suites = art.suites.filter((s) => {
      if (seen.has(s.name)) return false
      seen.add(s.name)
      return true
    })
  }
}

// Fetch check-run summaries as a fallback when all test artifacts have expired.
async function fetchCheckRunSuites(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<TestSuite[]> {
  const data = await ghGraphQL<{
    repository: {
      object: {
        checkSuites: {
          nodes: Array<{
            checkRuns: {
              nodes: Array<{ name: string; conclusion: string | null; summary: string | null }>
            }
          }>
        }
      } | null
    } | null
  }>(
    `{
      repository(owner: "${owner}", name: "${repo}") {
        object(expression: "${sha}") {
          ... on Commit {
            checkSuites(first: 20) {
              nodes {
                checkRuns(first: 100) {
                  nodes { name conclusion summary }
                }
              }
            }
          }
        }
      }
    }`,
    token,
  )

  if (!data?.repository?.object) return []
  const seen = new Set<string>()
  return (data.repository.object.checkSuites?.nodes ?? [])
    .flatMap((s) => s.checkRuns?.nodes ?? [])
    .filter((cr) => {
      if (!TEST_REPORT_CHECK_RUN_RE.test(cr.name) || seen.has(cr.name)) return false
      seen.add(cr.name)
      return true
    })
    .map((cr) => parseReportHtml(cr.name, cr.summary))
    .filter((s): s is TestSuite => s !== null)
}

function computeTestCounts(
  artifacts: TestArtifact[],
  checkRunSuites: TestSuite[],
): PRTestResults['testCounts'] {
  let total = 0, failed = 0, passed = 0, skipped = 0
  for (const art of artifacts) {
    for (const s of art.suites) {
      failed  += s.testcases.filter((t) => t.status === 'failed' || t.status === 'error').length
      total   += s.total   ?? 0
      passed  += s.passed  ?? 0
      skipped += s.skipped ?? 0
    }
  }
  for (const s of checkRunSuites) {
    failed  += s.testcases.filter((t) => t.status === 'failed' || t.status === 'error').length
    total   += s.total   ?? 0
    passed  += s.passed  ?? 0
    skipped += s.skipped ?? 0
  }
  return { total, failed, passed, skipped }
}

/**
 * Fetch and parse JUnit XML test results for a completed workflow run.
 *
 * Downloads artifact ZIPs whose names match the test-report pattern, unzips
 * them in memory, and parses all JUnit XML files inside. Falls back to
 * check-run HTML summaries when artifacts have expired.
 *
 * stateless per-request model (no in-memory state between calls).
 */
export async function fetchPRTestResults(
  owner: string,
  repo: string,
  runId: number,
  sha: string,
  token: string,
): Promise<PRTestResults> {
  const [artifactsData] = await Promise.all([
    ghJson<{ artifacts: GhArtifact[] }>(
      `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
      token,
    ),
  ])

  const allTestArtifacts = (artifactsData.artifacts ?? []).filter((a) =>
    TEST_ARTIFACT_RE.test(a.name),
  )

  // When a run is re-triggered, stale artifacts from the previous attempt share
  // the same name. Keep only the highest-id artifact per name (most recent upload).
  const byName = new Map<string, GhArtifact>()
  for (const a of allTestArtifacts) {
    const existing = byName.get(a.name)
    if (!existing || a.id > existing.id) byName.set(a.name, a)
  }
  const testArtifacts = [...byName.values()]
  const expiredCount  = testArtifacts.filter((a) => a.expired).length
  const downloadable  = testArtifacts.filter((a) => !a.expired)

  // All artifacts expired → fall back to check-run summaries
  if (expiredCount > 0 && downloadable.length === 0) {
    const checkRunSuites = await fetchCheckRunSuites(owner, repo, sha, token)
    return {
      artifacts: [],
      checkRunSuites,
      expiredArtifacts: expiredCount,
      hasArtifacts: false,
      testCounts: computeTestCounts([], checkRunSuites),
    }
  }

  // No test artifacts at all (build failure before tests ran, or different CI setup)
  if (testArtifacts.length === 0) {
    const checkRunSuites = await fetchCheckRunSuites(owner, repo, sha, token)
    return {
      artifacts: [],
      checkRunSuites,
      expiredArtifacts: 0,
      hasArtifacts: false,
      testCounts: computeTestCounts([], checkRunSuites),
    }
  }

  // Download and parse all available artifacts concurrently
  const artifactResults = await Promise.all(
    downloadable.map((a) => downloadAndParseArtifact(owner, repo, a.id, a.name, token)),
  )
  deduplicateSuites(artifactResults)

  return {
    artifacts: artifactResults,
    checkRunSuites: [],
    expiredArtifacts: expiredCount,
    hasArtifacts: true,
    testCounts: computeTestCounts(artifactResults, []),
  }
}

// Pull requests
// Raw shape from GET /repos/{owner}/{repo}/pulls
interface GhPR {
  number: number
  title: string
  html_url: string
  draft: boolean
  created_at: string
  updated_at: string
  head: { sha: string }
  user: { login: string; avatar_url: string }
}

/**
 * Pick the "primary" workflow run from a list of runs for a PR.
 * We prefer a run named exactly "ci" or whose name contains "ci" (matching
 * common patterns like "CI", "ci.yml"). If there's no CI-named run, we fall
 * back to the most recently updated run.
 */
function pickLatestRun(runs: WorkflowRun[]): WorkflowRun | null {
  return (
    runs.find((r) => r.name === 'ci' || r.name?.toLowerCase().includes('ci')) ??
    [...runs].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0] ??
    null
  )
}

/**
 * Fetch all open PRs for a single repo and enrich each with CI status.
 *
 * For each PR this makes:
 *   1. GET …/actions/runs?head_sha=SHA       — workflow runs for this commit
 *   2. GET …/actions/runs/{id}/jobs           — jobs in the primary run
 *   3. GET …/commits/SHA/check-runs           — check runs for test counts
 * All three are kicked off concurrently with Promise.all.
 *
 * The outer Promise.allSettled ensures a single failing PR doesn't abort the
 * entire list — it just gets excluded from the response with an error logged.
 */
export async function fetchPRsForRepo(
  repo: RepoConfig,
  token: string,
): Promise<PullRequest[]> {
  const { owner, name } = repo
  const repoStr = `${owner}/${name}`

  // Fetch all open PRs (up to 100, sorted newest first)
  const prs = await ghJson<GhPR[]>(
    `/repos/${owner}/${name}/pulls?state=open&per_page=100&sort=updated&direction=desc`,
    token,
  )
  if (!prs.length) return []

  // Batch-fetch review decisions for all PRs via a single GraphQL call
  const reviewDecisions = await fetchReviewDecisions(owner, name, prs.map((p) => p.number), token)

  const results = await Promise.allSettled(
    prs.map(async (pr): Promise<PullRequest> => {
      // Step 1: find what workflows ran for this PR's HEAD commit
      const runs = await fetchWorkflowRuns(owner, name, pr.head.sha, token)
      const latestRun = pickLatestRun(runs)

      // Step 2 & 3: fetch jobs + test counts in parallel (both need latestRun first)
      const [jobs, tests] = await Promise.all([
        latestRun
          ? fetchWorkflowJobs(owner, name, latestRun.id, token)
          : Promise.resolve([]),
        latestRun
          ? fetchTestCounts(owner, name, pr.head.sha, token)
          : Promise.resolve(null),
      ])

      const failedJobs     = jobs.filter((j) => j.conclusion === 'failure').map((j) => j.name)
      const inProgressJobs = jobs.filter((j) => j.status === 'in_progress').map((j) => j.name)

      return {
        number: pr.number,
        title: pr.title,
        html_url: pr.html_url,
        repo: repoStr,
        author: { login: pr.user.login, avatar_url: pr.user.avatar_url },
        head_sha: pr.head.sha,
        draft: pr.draft,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        reviewDecision: reviewDecisions[pr.number] ?? null,
        workflowStatus: deriveStatus(latestRun),
        workflowRuns: runs,
        latestRun,
        failedJobs,
        inProgressJobs,
        tests,
        lastRunAt: latestRun?.updated_at ?? null,
      }
    }),
  )

  return results
    .filter((r): r is PromiseFulfilledResult<PullRequest> => r.status === 'fulfilled')
    .map((r) => r.value)
}

/**
 * Fetch PRs for all configured repos and merge into a single list.
 * Sorted by most recent workflow run (or PR update if no runs yet) so the
 * most active work appears first regardless of which repo it's in.
 */
export async function fetchAllPRs(repos: RepoConfig[]): Promise<PullRequest[]> {
  const results = await Promise.allSettled(
    repos.map(async (r) => fetchPRsForRepo(r, await getTokenForOwner(r.owner))),
  )
  const prs: PullRequest[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') prs.push(...r.value)
    else console.error('Failed to fetch PRs:', r.reason)
  }
  return prs.sort((a, b) => {
    const aTime = a.lastRunAt ?? a.updated_at
    const bTime = b.lastRunAt ?? b.updated_at
    return new Date(bTime).getTime() - new Date(aTime).getTime()
  })
}


// Workflow analytics 
// Raw GitHub shape from GET /repos/{owner}/{repo}/actions/workflows
interface GhWorkflow {
  id: number
  name: string
  html_url: string
  state: string  // active | deleted | disabled_manually | disabled_inactivity
}

// Raw GitHub shape from GET /repos/{owner}/{repo}/actions/workflows/{id}/runs
interface GhWorkflowRunDetailed {
  id: number
  run_number: number
  run_attempt: number   // 1 = first run, 2+ = re-run
  status: string
  conclusion: string | null
  html_url: string
  created_at: string
  run_started_at: string | null  // when the runner picked it up (after queue wait)
  updated_at: string
  head_branch: string | null
  head_sha: string
}

/**
 * Compute analytics metrics from a list of workflow runs.
 *
 * successRate:   % of completed runs with conclusion = success
 * avgDurationMs: mean of (updated_at - run_started_at) for completed runs
 * retriggerRate: % of unique commits (SHAs) where someone clicked Re-run
 * runsPerDay:    runs / days across the observed window (velocity indicator)
 */
function calcMetrics(runs: GhWorkflowRunDetailed[]) {
  const completed = runs.filter((r) => r.status === 'completed')
  const successful = completed.filter((r) => r.conclusion === 'success')
  const successRate = completed.length > 0 ? (successful.length / completed.length) * 100 : 0

  // Use run_started_at (post-queue) rather than created_at for accurate durations
  const durations = completed
    .map((r) => {
      const start = new Date(r.run_started_at ?? r.created_at).getTime()
      const end = new Date(r.updated_at).getTime()
      return end - start
    })
    .filter((d) => d > 0)
  const avgDurationMs =
    durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0

  // Track the highest run_attempt seen per commit SHA.
  // If any SHA has attempt > 1, that commit was retriggered.
  const bySha = new Map<string, number>()
  for (const r of runs) {
    bySha.set(r.head_sha, Math.max(bySha.get(r.head_sha) ?? 1, r.run_attempt))
  }
  const retriggered = [...bySha.values()].filter((maxAttempt) => maxAttempt > 1).length
  const retriggerRate = bySha.size > 0 ? (retriggered / bySha.size) * 100 : 0

  // Frequency: divide total run count by the time window they span
  let runsPerDay = 0
  if (runs.length > 1) {
    const times = runs.map((r) => new Date(r.created_at).getTime())
    const spanMs = Math.max(...times) - Math.min(...times)
    const spanDays = spanMs / (1000 * 60 * 60 * 24)
    if (spanDays > 0) runsPerDay = runs.length / spanDays
  }

  return { successRate, avgDurationMs, retriggerRate, runsPerDay }
}

/**
 * Fetch analytics for all active workflows in a single repo.
 * Only "active" state workflows are included — deleted/disabled ones are skipped.
 * `runsLimit` controls how many past runs to fetch per workflow (from config).
 */
export async function fetchWorkflowsForRepo(
  repo: RepoConfig,
  token: string,
  runsLimit: number = 20,
): Promise<import('@/types').WorkflowMetrics[]> {
  const { owner, name } = repo

  const wfData = await ghJson<{ workflows: GhWorkflow[] }>(
    `/repos/${owner}/${name}/actions/workflows`,
    token,
  )
  const workflows = (wfData.workflows ?? []).filter((w) => w.state === 'active')

  const results = await Promise.allSettled(
    workflows.map(async (wf) => {
      const runsData = await ghJson<{ workflow_runs: GhWorkflowRunDetailed[] }>(
        `/repos/${owner}/${name}/actions/workflows/${wf.id}/runs?per_page=${runsLimit}`,
        token,
      )
      const runs = runsData.workflow_runs ?? []
      const { successRate, avgDurationMs, retriggerRate, runsPerDay } = calcMetrics(runs)

      return {
        id: wf.id,
        name: wf.name,
        html_url: wf.html_url,
        repo: `${owner}/${name}`,
        recentRuns: runs.map((r) => ({
          id: r.id,
          run_number: r.run_number,
          run_attempt: r.run_attempt,
          status: r.status,
          conclusion: r.conclusion,
          html_url: r.html_url,
          created_at: r.created_at,
          run_started_at: r.run_started_at,
          updated_at: r.updated_at,
          head_branch: r.head_branch,
        })),
        successRate,
        avgDurationMs,
        retriggerRate,
        runsPerDay,
      }
    }),
  )

  return results
    .filter(
      (r): r is PromiseFulfilledResult<import('@/types').WorkflowMetrics> =>
        r.status === 'fulfilled',
    )
    .map((r) => r.value)
}

/** Fetch workflow analytics for all configured repos and merge into one list. */
export async function fetchAllWorkflows(
  repos: RepoConfig[],
  runsLimit: number = 20,
): Promise<import('@/types').WorkflowMetrics[]> {
  const results = await Promise.allSettled(
    repos.map(async (r) => fetchWorkflowsForRepo(r, await getTokenForOwner(r.owner), runsLimit)),
  )
  const workflows: import('@/types').WorkflowMetrics[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') workflows.push(...r.value)
    else console.error('Failed to fetch workflows:', r.reason)
  }
  return workflows
}


// Code scanning alerts
// Raw GitHub shape from GET /repos/{owner}/{repo}/code-scanning/alerts
interface GhCodeScanAlert {
  number: number
  state: string
  rule: {
    id: string
    name: string
    description: string
    security_severity_level: string | null  // critical | high | medium | low
    severity: string  // warning | error | note (tool-level, less useful)
    tags: string[] | null
  }
  tool: { name: string; version: string | null }
  most_recent_instance: {
    ref: string
    location: {
      path: string
      start_line: number
      end_line: number
    } | null
  } | null
  created_at: string
  updated_at: string
  html_url: string
}

/**
 * Map GitHub's security_severity_level (or severity fallback) to our AlertSeverity type.
 * GitHub prefers security_severity_level for security rules; severity is the
 * SARIF-level value which is less granular.
 */
function mapSeverity(alert: GhCodeScanAlert): AlertSeverity {
  const s = (alert.rule.security_severity_level ?? alert.rule.severity ?? 'note').toLowerCase()
  const valid: AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'warning', 'note', 'error']
  return valid.includes(s as AlertSeverity) ? (s as AlertSeverity) : 'note'
}

/**
 * Fetch open code scanning alerts for a single repo.
 *
 * Returns { alerts: [], unavailable: true } if:
 *   - Code scanning is not enabled (404)
 *   - Token lacks security_events scope (403)
 * Both are treated as "not available" rather than errors.
 *
 * Requires token scope: security_events
 */
export async function fetchCodeScanningAlerts(
  repo: RepoConfig,
  token: string,
): Promise<{ alerts: CodeScanAlert[]; unavailable: boolean }> {
  const { owner, name } = repo
  try {
    // Fetch open alerts only, sorted by creation date (newest first)
    const data = await ghJson<GhCodeScanAlert[]>(
      `/repos/${owner}/${name}/code-scanning/alerts?state=open&per_page=100&sort=created&direction=desc`,
      token,
    )
    const alerts: CodeScanAlert[] = data.map((a) => ({
      number: a.number,
      state: a.state as AlertState,
      rule: {
        id: a.rule.id,
        name: a.rule.name,
        description: a.rule.description,
        severity: mapSeverity(a),
        tags: a.rule.tags ?? [],
      },
      tool: { name: a.tool.name, version: a.tool.version },
      location: a.most_recent_instance?.location ?? null,
      ref: a.most_recent_instance?.ref ?? '',
      created_at: a.created_at,
      updated_at: a.updated_at,
      html_url: a.html_url,
      repo: `${owner}/${name}`,
    }))
    return { alerts, unavailable: false }
  } catch (err: unknown) {
    const status = (err as { status?: number }).status
    // 404 = code scanning not enabled; 403 = token lacks security_events scope
    if (status === 404 || status === 403) return { alerts: [], unavailable: true }
    throw err
  }
}

/**
 * Fetch code scanning alerts across all configured repos.
 * Repos where code scanning is unavailable are tracked separately so the UI
 * can show an informational note rather than hiding the page entirely.
 */
export async function fetchAllCodeScanningAlerts(
  repos: RepoConfig[],
): Promise<{ alerts: CodeScanAlert[]; unavailableRepos: string[] }> {
  const results = await Promise.allSettled(
    repos.map(async (r) => fetchCodeScanningAlerts(r, await getTokenForOwner(r.owner))),
  )
  const alerts: CodeScanAlert[] = []
  const unavailableRepos: string[] = []

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const repoStr = `${repos[i].owner}/${repos[i].name}`
    if (r.status === 'fulfilled') {
      alerts.push(...r.value.alerts)
      if (r.value.unavailable) unavailableRepos.push(repoStr)
    } else {
      console.error(`Failed to fetch code scanning for ${repoStr}:`, r.reason)
    }
  }

  // Sort by severity (critical first) then by creation date
  const severityOrder: AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'warning', 'note', 'error']
  alerts.sort((a, b) => {
    const si = severityOrder.indexOf(a.rule.severity) - severityOrder.indexOf(b.rule.severity)
    if (si !== 0) return si
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  return { alerts, unavailableRepos }
}


// Secret scanning alerts
interface GhSecretScanAlert {
  number: number
  state: string
  secret_type: string
  secret_type_display_name: string
  resolution: string | null
  created_at: string
  updated_at: string
  html_url: string
}

/**
 * Fetch open secret scanning alerts for a single repo.
 * Returns { alerts: [], unavailable: true } on 403/404 (not enabled or no access).
 * Requires token scope: secret_scanning_alerts
 */
export async function fetchSecretScanningAlerts(
  repo: RepoConfig,
  token: string,
): Promise<{ alerts: import('@/types').SecretScanAlert[]; unavailable: boolean }> {
  const { owner, name } = repo
  try {
    const data = await ghJson<GhSecretScanAlert[]>(
      `/repos/${owner}/${name}/secret-scanning/alerts?state=open&per_page=100`,
      token,
    )
    const alerts = data.map((a) => ({
      number: a.number,
      state: a.state as 'open' | 'resolved',
      secret_type: a.secret_type,
      secret_type_display_name: a.secret_type_display_name,
      resolution: a.resolution,
      created_at: a.created_at,
      updated_at: a.updated_at,
      html_url: a.html_url,
      repo: `${owner}/${name}`,
    }))
    return { alerts, unavailable: false }
  } catch (err: unknown) {
    const status = (err as { status?: number }).status
    if (status === 403 || status === 404) return { alerts: [], unavailable: true }
    throw err
  }
}

/** Fetch secret scanning alerts for all repos, merged newest-first. */
export async function fetchAllSecretScanningAlerts(
  repos: RepoConfig[],
): Promise<{ alerts: import('@/types').SecretScanAlert[]; unavailableRepos: string[] }> {
  const results = await Promise.allSettled(
    repos.map(async (r) => fetchSecretScanningAlerts(r, await getTokenForOwner(r.owner))),
  )
  const alerts: import('@/types').SecretScanAlert[] = []
  const unavailableRepos: string[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const repoStr = `${repos[i].owner}/${repos[i].name}`
    if (r.status === 'fulfilled') {
      alerts.push(...r.value.alerts)
      if (r.value.unavailable) unavailableRepos.push(repoStr)
    } else {
      console.error(`Failed to fetch secret scanning for ${repoStr}:`, r.reason)
    }
  }
  alerts.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  return { alerts, unavailableRepos }
}


// Dependabot alerts
// Raw shape from GET /repos/{owner}/{repo}/dependabot/alerts
interface GhDependabotAlert {
  number: number
  state: string
  dependency: {
    package: { ecosystem: string; name: string }
    manifest_path: string
    scope: string | null
  }
  security_advisory: {
    ghsa_id: string
    cve_id: string | null
    summary: string
    severity: string
  }
  security_vulnerability: {
    vulnerable_version_range: string
    first_patched_version: { identifier: string } | null
  }
  html_url: string
  created_at: string
  updated_at: string
}

/**
 * Fetch open Dependabot vulnerability alerts for a single repo.
 * Returns { alerts: [], unavailable: true } on 403/404 (not enabled or no access).
 * Requires: GitHub App `Dependabot alerts: Read` permission, or PAT with `vulnerability_alerts` scope.
 */
export async function fetchDependabotAlerts(
  repo: RepoConfig,
  token: string,
): Promise<{ alerts: DependabotAlert[]; unavailable: boolean }> {
  const { owner, name } = repo
  try {
    const data = await ghJson<GhDependabotAlert[]>(
      `/repos/${owner}/${name}/dependabot/alerts?state=open&per_page=100&sort=created&direction=desc`,
      token,
    )
    const alerts: DependabotAlert[] = data.map((a) => ({
      number: a.number,
      state: a.state as DependabotAlert['state'],
      dependency: {
        package: {
          ecosystem: a.dependency?.package?.ecosystem ?? '',
          name: a.dependency?.package?.name ?? '',
        },
        manifest_path: a.dependency?.manifest_path ?? '',
        scope: (a.dependency?.scope as DependabotAlert['dependency']['scope']) ?? null,
      },
      security_advisory: {
        ghsa_id: a.security_advisory?.ghsa_id ?? '',
        cve_id: a.security_advisory?.cve_id ?? null,
        summary: a.security_advisory?.summary ?? '',
        severity: (a.security_advisory?.severity ?? 'medium') as DependabotAlert['security_advisory']['severity'],
      },
      security_vulnerability: {
        vulnerable_version_range: a.security_vulnerability?.vulnerable_version_range ?? '',
        first_patched_version: a.security_vulnerability?.first_patched_version ?? null,
      },
      html_url: a.html_url,
      created_at: a.created_at,
      updated_at: a.updated_at,
      repo: `${owner}/${name}`,
    }))
    return { alerts, unavailable: false }
  } catch (err: unknown) {
    const status = (err as { status?: number }).status
    if (status === 403 || status === 404) return { alerts: [], unavailable: true }
    throw err
  }
}

/**
 * Fetch Dependabot alerts across all configured repos.
 * Repos where alerts are unavailable are tracked separately for the info notice.
 */
export async function fetchAllDependabotAlerts(
  repos: RepoConfig[],
): Promise<{ alerts: DependabotAlert[]; unavailableRepos: string[] }> {
  const results = await Promise.allSettled(
    repos.map(async (r) => fetchDependabotAlerts(r, await getTokenForOwner(r.owner))),
  )
  const alerts: DependabotAlert[] = []
  const unavailableRepos: string[] = []

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const repoStr = `${repos[i].owner}/${repos[i].name}`
    if (r.status === 'fulfilled') {
      alerts.push(...r.value.alerts)
      if (r.value.unavailable) unavailableRepos.push(repoStr)
    } else {
      console.error(`Failed to fetch Dependabot alerts for ${repoStr}:`, r.reason)
    }
  }

  // Sort by severity (critical first) then newest-first
  const severityOrder = ['critical', 'high', 'medium', 'low']
  alerts.sort((a, b) => {
    const si = severityOrder.indexOf(a.security_advisory.severity) - severityOrder.indexOf(b.security_advisory.severity)
    if (si !== 0) return si
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  return { alerts, unavailableRepos }
}
