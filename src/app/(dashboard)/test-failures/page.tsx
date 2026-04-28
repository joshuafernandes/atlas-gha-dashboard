import { TestFailures } from '@/components/common/TestFailures'

export const metadata = { title: 'Test Failures · GHA Dashboard' }

interface Props {
  searchParams: Promise<Record<string, string | undefined>>
}

export default async function TestFailuresPage({ searchParams }: Props) {
  const params = await searchParams

  const owner     = params.owner     ?? ''
  const repo      = params.repo      ?? ''
  const runId     = params.runId     ?? ''
  const sha       = params.sha       ?? ''
  const prNumber  = params.prNumber  ?? ''
  const prTitle   = params.prTitle   ?? 'Pull Request'
  const prUrl     = params.prUrl     ?? '#'
  const runUrl    = params.runUrl    ?? ''
  const runNumber = params.runNumber ?? ''
  const branch    = params.branch    ?? ''
  const author    = params.author    ?? ''

  return (
    <TestFailures
      owner={owner}
      repo={repo}
      runId={runId}
      sha={sha}
      prNumber={prNumber}
      prTitle={prTitle}
      prUrl={prUrl}
      runUrl={runUrl}
      runNumber={runNumber}
      branch={branch}
      author={author}
    />
  )
}
