//
// JUnit XML parsing
//
// Parses JUnit XML produced by Gradle/Maven test runners. Each .xml file has
// a <testsuites> root (or bare <testsuite>) containing <testcase> children,
// where failures have a nested <failure> or <error> element.
//
// Gradle's retry plugin re-runs flaky tests, so the same test can appear
// multiple times. We resolve those retries: any passing attempt wins (flaky),
// otherwise the last attempt is kept.
//

import { XMLParser } from 'fast-xml-parser'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  // force these to always be arrays even when there's only one element
  isArray: (name) => ['testsuite', 'testcase'].includes(name),
  parseAttributeValue: false,
})

export interface TestFailureInfo {
  message: string
  detail: string
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
  // Only failures + skipped are kept; passing testcases are dropped to keep payload small
  testcases: TestCase[]
  fromCheckRun?: boolean
}

// Extract the error message + full detail from a JUnit failure/error node.
// The node can be a plain string ("AssertionError: ...") or an object with
// message/type attributes and #text for the body (stack trace).
function extractFailure(node: unknown): TestFailureInfo | null {
  if (!node) return null
  if (typeof node === 'string') {
    return { message: node.split('\n')[0] ?? '', detail: node, type: '' }
  }
  const n = node as Record<string, string>
  return {
    message: n.message ?? n['#text']?.split('\n')[0] ?? '',
    detail:  n['#text'] ?? n.message ?? '',
    type:    n.type ?? '',
  }
}

// When Gradle's retry plugin re-runs a test, the same classname+name appears
// multiple times. Resolve to the final outcome: any passing attempt → flaky
// pass; all failed → genuine failure.
function deduplicateRetries(testcases: TestCase[]): TestCase[] {
  const groups = new Map<string, TestCase[]>()
  for (const tc of testcases) {
    const key = `${tc.classname}\0${tc.name}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(tc)
  }
  const result: TestCase[] = []
  for (const [, attempts] of groups) {
    if (attempts.length === 1) { result.push(attempts[0]); continue }
    const passed = attempts.find((tc) => tc.status === 'passed')
    result.push(passed ?? attempts[attempts.length - 1]!)
  }
  return result
}

// Parse a JUnit XML string into an array of test suites with all test cases.
export function parseXml(xml: string): TestSuite[] {
  let parsed: Record<string, unknown>
  try {
    parsed = xmlParser.parse(xml) as Record<string, unknown>
  } catch {
    return []
  }

  type RawSuite = { name?: string; time?: string; testcase?: RawCase[] }
  type RawCase  = { classname?: string; name?: string; time?: string; failure?: unknown; error?: unknown; skipped?: unknown }

  const root = parsed as { testsuites?: { testsuite?: RawSuite[] }; testsuite?: RawSuite[] }
  const suites: RawSuite[] = root.testsuites?.testsuite ?? (root.testsuite as RawSuite[] | undefined) ?? []

  return suites.filter(Boolean).map((suite) => {
    const raw: TestCase[] = (suite.testcase ?? []).map((tc) => {
      let status: TestCase['status'] = 'passed'
      let failure: TestFailureInfo | null = null

      if (tc.failure !== undefined) {
        failure = extractFailure(tc.failure)
        if (failure) status = 'failed'
      } else if (tc.error !== undefined) {
        failure = extractFailure(tc.error)
        if (failure) status = 'error'
      } else if (tc.skipped !== undefined) {
        status = 'skipped'
      }

      return {
        classname: tc.classname ?? '',
        name:      tc.name ?? '',
        time:      parseFloat(tc.time ?? '0') || 0,
        status,
        failure,
      }
    })

    const testcases = deduplicateRetries(raw)
    return {
      name:      suite.name ?? 'Unknown',
      time:      parseFloat(suite.time ?? '0') || 0,
      total:     testcases.length,
      passed:    testcases.filter((t) => t.status === 'passed').length,
      skipped:   testcases.filter((t) => t.status === 'skipped').length,
      testcases,
    }
  })
}

// Compact suites for transport: discard passing testcases, keep only failures
// and skipped entries. The total/passed/skipped counts are preserved so the
// UI can show aggregate numbers without the full list.
export function compactSuites(suites: TestSuite[]): TestSuite[] {
  return suites.map(({ name, time, total, passed, skipped, testcases }) => ({
    name,
    time,
    total,
    passed,
    skipped,
    testcases: testcases.filter((t) => t.status === 'failed' || t.status === 'error' || t.status === 'skipped'),
  }))
}

// Helpers used by the HTML fallback parser

export function htmlDecode(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim()
}

// Parse a check-run HTML summary into a compact TestSuite.
// Check-run summaries are the fallback when artifacts have expired — the test
// reporter action (dorny/test-reporter, mikepenz/action-junit-report) writes a
// markdown/HTML summary to the check run, including <details> blocks per failure.
export function parseReportHtml(name: string, html: string | null | undefined): TestSuite | null {
  if (!html) return null

  // Try to extract total count from a 4-column table (total, pass, fail, skip)
  const statsMatch = html.match(
    /<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>/,
  )
  const total = statsMatch ? parseInt(statsMatch[1]!) : 0

  const testcases: TestCase[] = []
  const detailsRe = /<details[^>]*>([\s\S]*?)<\/details>/gi
  let m: RegExpExecArray | null
  while ((m = detailsRe.exec(html)) !== null) {
    const inner = m[1]!
    const sumMatch = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(inner)
    if (!sumMatch) continue
    const rawName = htmlDecode(stripTags(sumMatch[1]!))
      .replace(/^[❌✅⚠️\s]+/, '')
      .trim()
    if (!rawName || rawName.length < 3) continue
    const preMatch = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(inner)
    const raw = preMatch ? htmlDecode(preMatch[1]!).trim() : ''
    testcases.push({
      classname: name,
      name:      rawName,
      time:      0,
      status:    'failed',
      failure: {
        message: raw.split('\n')[0]?.trim() ?? rawName,
        detail:  raw,
        type:    '',
      },
    })
  }

  return {
    name,
    time:    0,
    total,
    passed:  Math.max(0, total - testcases.length),
    skipped: 0,
    testcases,
    fromCheckRun: true,
  }
}
