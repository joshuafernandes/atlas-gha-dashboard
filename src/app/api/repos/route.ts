// 
// GET /api/repos
//
// Returns the list of repos configured in the dashboard (read from GITHUB_REPOS).
//

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getRepos } from '@/lib/config'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const repos = getRepos().map((r) => `${r.owner}/${r.name}`)
  return NextResponse.json({ repos })
}
