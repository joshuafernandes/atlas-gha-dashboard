// Pull request workflow status
/**
 * High-level status we derive from a workflow run's status + conclusion fields.
 * GitHub gives us two fields: `status` (queued | in_progress | completed) and
 * `conclusion` (success | failure | cancelled | skipped | …). We collapse them
 * into a single enum to make rendering logic simpler.
 */
export type WorkflowStatus =
  | 'pending'   // run is queued or doesn't exist yet
  | 'building'  // run is in_progress
  | 'passing'   // completed with conclusion = success
  | 'failing'   // completed with conclusion = failure
  | 'error'     // completed with conclusion = cancelled / timed_out
  | 'skipped'
  | 'unknown'

/**
 * A single workflow run as returned by:
 *   GET /repos/{owner}/{repo}/actions/runs?head_sha={sha}
 * We strip it down to only the fields we display.
 */
export interface WorkflowRun {
  id: number          // internal GitHub run ID (large number)
  name: string        // workflow name, e.g. "CI"
  run_number: number  // sequential run number shown in the GitHub UI, e.g. 234
  status: string      // queued | in_progress | completed
  conclusion: string | null  // success | failure | cancelled | skipped | neutral | timed_out
  html_url: string    // link to the run in the GitHub UI
  updated_at: string  // ISO timestamp — for completed runs this is the finish time
}

/**
 * Test counts extracted from check run titles (best-effort) or JUnit artifacts.
 * May be null if the repo doesn't expose counts via check run output titles.
 */
export interface TestCounts {
  total: number
  passed: number
  failed: number
  skipped: number
}

/**
 * A pull request enriched with CI status, job details, and review decision.
 * Built in fetchPRsForRepo() by combining several GitHub API calls per PR.
 */
export interface PullRequest {
  number: number
  title: string
  html_url: string
  repo: string   // "owner/name" string, e.g. "myOrgA/repo1"
  author: {
    login: string
    avatar_url: string
  }
  head_sha: string    // SHA of the PR's head commit — used to look up workflow runs
  draft: boolean
  created_at: string
  updated_at: string
  /**
   * GitHub's review decision for this PR.
   * Fetched via GraphQL (batch) alongside the PR list to reduce API calls.
   */
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  workflowStatus: WorkflowStatus  // derived from latestRun
  workflowRuns: WorkflowRun[]     // all runs for this PR's head SHA
  latestRun: WorkflowRun | null   // the primary run (prefers "ci" or "ci.yml" named)
  failedJobs: string[]            // names of jobs with conclusion = failure
  inProgressJobs: string[]        // names of jobs currently running
  tests: TestCounts | null        // null if not available for this repo
  lastRunAt: string | null        // updated_at of latestRun, used for sorting
}

// Workflow analytics
/**
 * A single run entry used for the sparkline and metric calculations.
 * Slimmed-down version of the full workflow run from:
 *   GET /repos/{owner}/{repo}/actions/workflows/{id}/runs
 */
export interface WorkflowRunSummary {
  id: number
  run_number: number
  /**
   * GitHub increments run_attempt each time the workflow is manually re-run.
   * run_attempt > 1 means someone clicked "Re-run" — used for retrigger rate.
   */
  run_attempt: number
  status: string
  conclusion: string | null
  html_url: string
  created_at: string
  /**
   * When the runner actually picked up the job (after queuing time).
   * More accurate than created_at for duration calculations.
   */
  run_started_at: string | null
  updated_at: string
  head_branch: string | null  // branch name, shown in sparkline tooltip
}

/**
 * Per-workflow metrics computed from the last N runs (N = WORKFLOW_RUNS_LIMIT).
 * One of these is created per active workflow per configured repo.
 */
export interface WorkflowMetrics {
  id: number      // GitHub workflow ID
  name: string    // workflow name from the YAML file's `name:` field
  html_url: string
  repo: string
  recentRuns: WorkflowRunSummary[]  // newest first
  successRate: number    // 0–100, percentage of completed runs that succeeded
  avgDurationMs: number  // mean of (updated_at − run_started_at) for completed runs
  /**
   * Percentage of unique commits (head_sha) that had at least one re-run.
   * High retrigger rate = flaky CI or developers losing confidence in results.
   */
  retriggerRate: number
  /**
   * Average number of workflow runs per day across the observed window.
   * Gives a sense of PR/commit velocity.
   */
  runsPerDay: number
}


//Code scanning alerts
/**
 * Severity levels from the GitHub Code Scanning API, ordered highest → lowest.
 * These come from the SARIF severity assigned by the scanning tool (e.g. CodeQL).
 */
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'warning' | 'note' | 'error'

/** Whether the alert is still active, dismissed by a developer, or resolved. */
export type AlertState = 'open' | 'dismissed' | 'fixed'

/**
 * A single code scanning alert from:
 *   GET /repos/{owner}/{repo}/code-scanning/alerts?state=open
 *
 * Requires the GITHUB_TOKEN to have `security_events` scope (or be a repo admin).
 * Returns 404 if code scanning is not enabled for the repo.
 * Returns 403 if the token lacks the required scope.
 * Both cases are handled gracefully — the page shows "not available".
 */
export interface CodeScanAlert {
  number: number     // alert number within the repo
  state: AlertState
  rule: {
    id: string          // tool-specific rule identifier, e.g. "java/sql-injection"
    name: string        // human-readable rule name
    description: string
    severity: AlertSeverity
    tags: string[]      // e.g. ["security", "correctness"]
  }
  tool: {
    name: string        // e.g. "CodeQL"
    version: string | null
  }
  /** Where in the codebase the alert was found. Null if tool didn't report location. */
  location: {
    path: string
    start_line: number
    end_line: number
  } | null
  ref: string          // git ref (branch/tag) where the alert was found
  created_at: string
  updated_at: string
  html_url: string
  repo: string         // "owner/name"
}


// Secret scanning alerts
/**
 * A secret scanning alert from:
 *   GET /repos/{owner}/{repo}/secret-scanning/alerts?state=open
 *
 * GitHub detects accidentally committed secrets (API keys, tokens, etc.).
 * Requires the token to have `secret_scanning_alerts` scope.
 * Returns 404 if secret scanning is not enabled (requires GitHub Advanced Security).
 */
export interface SecretScanAlert {
  number: number
  state: 'open' | 'resolved'
  secret_type: string              // e.g. "github_personal_access_token"
  secret_type_display_name: string // e.g. "GitHub Personal Access Token"
  resolution: string | null        // null | "false_positive" | "wont_fix" | "revoked" | "used_in_tests"
  created_at: string
  updated_at: string
  html_url: string
  repo: string  // "owner/name"
}


// Dependabot alerts
/**
 * A Dependabot vulnerability alert from:
 *   GET /repos/{owner}/{repo}/dependabot/alerts?state=open
 *
 * Requires the GitHub App to have the `Dependabot alerts: Read` permission,
 * or a PAT with `vulnerability_alerts` scope.
 * Returns 404 if Dependabot alerts are not enabled, 403 if the token lacks scope.
 */
export interface DependabotAlert {
  number: number
  state: 'open' | 'dismissed' | 'fixed' | 'auto_dismissed'
  dependency: {
    package: {
      ecosystem: string  // e.g. "npm", "maven", "pip"
      name: string       // e.g. "lodash"
    }
    manifest_path: string  // e.g. "package-lock.json"
    scope: 'runtime' | 'development' | null
  }
  security_advisory: {
    ghsa_id: string        // e.g. "GHSA-29mw-wpgm-hmr9"
    cve_id: string | null  // e.g. "CVE-2021-23337"
    summary: string
    severity: 'critical' | 'high' | 'medium' | 'low'
  }
  security_vulnerability: {
    vulnerable_version_range: string                             // e.g. "< 4.17.21"
    first_patched_version: { identifier: string } | null        // e.g. { identifier: "4.17.21" }
  }
  html_url: string
  created_at: string
  updated_at: string
  repo: string  // "owner/name"
}


// Configuration
/** A parsed entry from the GITHUB_REPOS environment variable. */
export interface RepoConfig {
  owner: string  // GitHub organisation or user, e.g. "Consensys"
  name: string   // repository name, e.g. "teku"
}


// Test failure details (annotation-based, used by the inline panel)
/**
 * A single failed test case fetched from check run annotations.
 * Annotations are created by test reporter actions (dorny/test-reporter,
 * mikepenz/action-junit-report, etc.) when a test suite has failures.
 */
export interface TestFailure {
  checkRunName: string   // e.g. "Reference Tests / gloas - mainnet - operations/withdrawals"
  testName: string       // e.g. "random_partial_withdrawals_1"
  message: string        // error message or assertion failure summary
  stackTrace: string | null  // full stack trace, if the reporter included it
}

/** Response from GET /api/test-failures (annotation-based) */
export interface TestFailuresApiResponse {
  failures: TestFailure[]
}


// JUnit XML artifact-based test results (used by the dedicated failures page)

export interface TestFailureInfo {
  message: string
  detail: string  // full stack trace
  type: string
}

export interface TestCase {
  classname: string
  name: string
  time: number
  status: 'passed' | 'failed' | 'error' | 'skipped'
  failure: TestFailureInfo | null
}

export interface TestSuite {
  name: string
  time: number
  total: number
  passed: number
  skipped: number
  /** Only failure/error/skipped entries kept — passing tests are dropped to reduce payload */
  testcases: TestCase[]
  fromCheckRun?: boolean
}

export interface TestArtifact {
  artifactName: string
  suites: TestSuite[]
  error?: string
}

export interface PRTestResults {
  artifacts: TestArtifact[]
  checkRunSuites: TestSuite[]  // fallback when artifacts have expired
  expiredArtifacts: number
  hasArtifacts: boolean
  testCounts: {
    total: number
    failed: number
    passed: number
    skipped: number
  }
}

/** Response from GET /api/pr-failures (artifact/JUnit XML based) */
export interface PRFailuresApiResponse {
  results: PRTestResults
}


// API response envelopes
/**
 * Response from GET /api/prs
 * hasBuilding drives adaptive polling on the client — when true, the client
 * polls every 15s instead of 60s so running builds update quickly.
 */
export interface PrsApiResponse {
  prs: PullRequest[]
  updatedAt: string   // ISO timestamp of when this data was fetched from GitHub
  hasBuilding: boolean
}

/** Response from GET /api/secret-scanning */
export interface SecretScanApiResponse {
  alerts: SecretScanAlert[]
  unavailableRepos: string[]  // repos where secret scanning is not enabled / no access
  updatedAt: string
}

/** Response from GET /api/dependabot-alerts */
export interface DependabotAlertsApiResponse {
  alerts: DependabotAlert[]
  unavailableRepos: string[]  // repos where Dependabot alerts are not enabled / no access
  updatedAt: string
}

/** Response from GET /api/workflows */
export interface WorkflowsApiResponse {
  workflows: WorkflowMetrics[]
  updatedAt: string
}

/** Response from GET /api/code-scanning */
export interface CodeScanApiResponse {
  alerts: CodeScanAlert[]
  updatedAt: string
  /**
   * Repos where code scanning is not available (not enabled or token lacks scope).
   * Displayed as an info note rather than an error.
   */
  unavailableRepos: string[]
}
