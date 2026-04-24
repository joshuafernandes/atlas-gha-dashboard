'use client'

import { useCallback } from 'react'
import useSWR from 'swr'
import {
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  Info,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useRepoFilter } from '@/components/common/RepoFilter/context'
import { formatDistanceToNow } from '@/lib/date'
import { cn } from '@/lib/utils'
import type { SecretScanAlert, SecretScanApiResponse } from '@/types'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

// alert row

const RESOLUTION_STYLES: Record<string, { label: string; className: string }> = {
  false_positive: { label: 'False positive', className: 'bg-muted text-muted-foreground border-border' },
  wont_fix:       { label: "Won't fix",      className: 'bg-muted text-muted-foreground border-border' },
  revoked:        { label: 'Revoked',         className: 'bg-green-500/20 text-green-500 border-green-500/30' },
  used_in_tests:  { label: 'Used in tests',   className: 'bg-muted text-muted-foreground border-border' },
}

function AlertRow({ alert }: { alert: SecretScanAlert }) {
  const res = alert.resolution ? RESOLUTION_STYLES[alert.resolution] : null

  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
      {/* State indicator */}
      <div className="pt-0.5 shrink-0">
        <span className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
          alert.state === 'open'
            ? 'bg-red-600/20 text-red-500 border-red-500/30'
            : 'bg-muted text-muted-foreground border-border',
        )}>
          <span className={cn('h-1.5 w-1.5 rounded-full', alert.state === 'open' ? 'bg-red-500' : 'bg-muted-foreground')} />
          {alert.state === 'open' ? 'Open' : 'Resolved'}
        </span>
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={alert.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium hover:text-blue-500 transition-colors flex items-center gap-1"
          >
            {alert.secret_type_display_name}
            <ExternalLink className="h-3 w-3 opacity-50" />
          </a>
          {res && (
            <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-[10px]', res.className)}>
              {res.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono opacity-60">{alert.secret_type}</span>
          <span className="opacity-30">·</span>
          <span className="shrink-0">found {formatDistanceToNow(alert.created_at)}</span>
        </div>
      </div>

      {/* Repo label */}
      <span className="shrink-0 text-[10px] text-muted-foreground font-mono hidden sm:inline">
        {alert.repo.split('/')[1]}
      </span>
    </div>
  )
}

// Skeletons

function AlertSkeletons() {
  return (
    <div className="divide-y">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="h-5 w-16 rounded-full mt-0.5" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

// Main component

export function SecretScanAlerts() {
  const { selectedRepo } = useRepoFilter()

  const { data, error, isLoading, mutate, isValidating } = useSWR<SecretScanApiResponse>(
    '/api/secret-scanning',
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 10 * 60_000 },
  )

  const refresh = useCallback(() => mutate(), [mutate])

  const allAlerts = data?.alerts ?? []
  const alerts = selectedRepo ? allAlerts.filter((a) => a.repo === selectedRepo) : allAlerts

  const byRepo = alerts.reduce<Record<string, SecretScanAlert[]>>((acc, a) => {
    if (!acc[a.repo]) acc[a.repo] = []
    acc[a.repo].push(a)
    return acc
  }, {})

  const unavailable = data?.unavailableRepos ?? []
  const filteredUnavailable = selectedRepo
    ? unavailable.filter((r) => r === selectedRepo)
    : unavailable

  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Secret Scanning</h1>
          {data && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {alerts.length} open alert{alerts.length !== 1 ? 's' : ''}
              {' · '}updated {formatDistanceToNow(data.updatedAt)}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={isValidating} className="gap-2">
          <RefreshCw className={`h-3.5 w-3.5 ${isValidating ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Access notice */}
      {filteredUnavailable.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-400">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">Secret scanning not available for: </span>
            {filteredUnavailable.join(', ')}
            <p className="text-xs mt-0.5 opacity-80">
              Either GitHub Advanced Security is not enabled, or the token needs the{' '}
              <code className="font-mono bg-blue-500/20 px-1 rounded">secret_scanning_alerts</code> scope.
            </p>
          </div>
        </div>
      )}

      {error && (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          Failed to load alerts.{' '}
          <button onClick={refresh} className="text-blue-500 hover:underline">Try again</button>
        </Card>
      )}

      {isLoading ? (
        <Card className="overflow-hidden"><AlertSkeletons /></Card>
      ) : alerts.length === 0 && !error ? (
        <Card className="p-12 text-center">
          <AlertTriangle className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium">No open alerts</p>
          <p className="text-xs text-muted-foreground mt-1">
            {filteredUnavailable.length > 0
              ? 'Check the notice above for repos without access.'
              : 'No open secret scanning alerts found.'}
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          {Object.entries(byRepo).map(([repo, repoAlerts]) => (
            <Card key={repo} className="overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
                <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{repo}</span>
                <Badge variant="secondary" className="ml-auto text-[10px] py-0">
                  {repoAlerts.length}
                </Badge>
              </div>
              <div className="divide-y">
                {repoAlerts.map((alert) => (
                  <AlertRow key={`${alert.repo}#${alert.number}`} alert={alert} />
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
