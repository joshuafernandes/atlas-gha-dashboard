'use client'

import { useCallback } from 'react'
import useSWR from 'swr'
import {
  Bug,
  RefreshCw,
  ExternalLink,
  Info,
  Package,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useRepoFilter } from '@/components/common/RepoFilter/context'
import { formatDistanceToNow } from '@/lib/date'
import { cn } from '@/lib/utils'
import type { DependabotAlert, DependabotAlertsApiResponse } from '@/types'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

// aeverity config

type DepSeverity = DependabotAlert['security_advisory']['severity']

const SEVERITY_ORDER: DepSeverity[] = ['critical', 'high', 'medium', 'low']

const SEVERITY_STYLES: Record<DepSeverity, { badge: string; dot: string; label: string }> = {
  critical: { badge: 'bg-red-600/20 text-red-500 border-red-500/30',           dot: 'bg-red-500',     label: 'Critical' },
  high:     { badge: 'bg-orange-500/20 text-orange-400 border-orange-400/30',  dot: 'bg-orange-400',  label: 'High' },
  medium:   { badge: 'bg-yellow-500/20 text-yellow-500 border-yellow-500/30',  dot: 'bg-yellow-500',  label: 'Medium' },
  low:      { badge: 'bg-blue-500/20 text-blue-400 border-blue-400/30',        dot: 'bg-blue-400',    label: 'Low' },
}

// severity badge

function SeverityBadge({ severity }: { severity: DepSeverity }) {
  const s = SEVERITY_STYLES[severity]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', s.badge)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  )
}

// ecosystem badge

function EcosystemBadge({ ecosystem }: { ecosystem: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
      {ecosystem}
    </span>
  )
}

// severity summary bar

function SeveritySummary({ alerts }: { alerts: DependabotAlert[] }) {
  const counts: Partial<Record<DepSeverity, number>> = {}
  for (const a of alerts) {
    counts[a.security_advisory.severity] = (counts[a.security_advisory.severity] ?? 0) + 1
  }
  const present = SEVERITY_ORDER.filter((s) => counts[s])
  if (!present.length) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      {present.map((sev) => (
        <span key={sev} className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium', SEVERITY_STYLES[sev].badge)}>
          <span className={cn('h-2 w-2 rounded-full', SEVERITY_STYLES[sev].dot)} />
          {counts[sev]} {SEVERITY_STYLES[sev].label}
        </span>
      ))}
    </div>
  )
}

// individual alert row

function AlertRow({ alert }: { alert: DependabotAlert }) {
  const { security_advisory: adv, security_vulnerability: vuln, dependency: dep } = alert
  const patchedVersion = vuln.first_patched_version?.identifier

  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
      {/* Severity */}
      <div className="pt-0.5 shrink-0">
        <SeverityBadge severity={adv.severity} />
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0 space-y-1">
        {/* Package name + ecosystem + link */}
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={alert.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium hover:text-blue-500 transition-colors flex items-center gap-1"
          >
            <Package className="h-3.5 w-3.5 opacity-60 shrink-0" />
            {dep.package.name}
            <ExternalLink className="h-3 w-3 opacity-50" />
          </a>
          <EcosystemBadge ecosystem={dep.package.ecosystem} />
          {dep.scope && (
            <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
              {dep.scope}
            </span>
          )}
        </div>

        {/* Advisory summary */}
        <p className="text-xs text-muted-foreground truncate">{adv.summary}</p>

        {/* Version range + fix + manifest + age */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          <span className="font-mono opacity-70">{vuln.vulnerable_version_range}</span>
          {patchedVersion && (
            <>
              <span className="opacity-30">→</span>
              <span className="font-mono text-green-500">fix: {patchedVersion}</span>
            </>
          )}
          <span className="opacity-30">·</span>
          <span className="font-mono opacity-60 truncate max-w-[200px]">{dep.manifest_path}</span>
          {adv.cve_id && (
            <>
              <span className="opacity-30">·</span>
              <span className="opacity-60">{adv.cve_id}</span>
            </>
          )}
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
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="h-5 w-16 rounded-full mt-0.5" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

// Main component

export function DependabotAlerts() {
  const { selectedRepo } = useRepoFilter()

  const { data, error, isLoading, mutate, isValidating } = useSWR<DependabotAlertsApiResponse>(
    '/api/dependabot-alerts',
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 10 * 60_000 },
  )

  const refresh = useCallback(() => mutate(), [mutate])

  const allAlerts = data?.alerts ?? []
  const alerts = selectedRepo ? allAlerts.filter((a) => a.repo === selectedRepo) : allAlerts

  const byRepo = alerts.reduce<Record<string, DependabotAlert[]>>((acc, a) => {
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
          <h1 className="text-xl font-semibold">Dependabot Alerts</h1>
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
            <span className="font-medium">Dependabot alerts not available for: </span>
            {filteredUnavailable.join(', ')}
            <p className="text-xs mt-0.5 opacity-80">
              Either Dependabot alerts are not enabled, or the token needs the{' '}
              <code className="font-mono bg-blue-500/20 px-1 rounded">vulnerability_alerts</code> scope.
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

      {/* Severity summary bar */}
      {!isLoading && alerts.length > 0 && <SeveritySummary alerts={alerts} />}

      {isLoading ? (
        <Card className="overflow-hidden"><AlertSkeletons /></Card>
      ) : alerts.length === 0 && !error ? (
        <Card className="p-12 text-center">
          <Bug className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium">No open alerts</p>
          <p className="text-xs text-muted-foreground mt-1">
            {filteredUnavailable.length > 0
              ? 'Check the notice above for repos without access.'
              : 'No open Dependabot vulnerability alerts found.'}
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          {Object.entries(byRepo).map(([repo, repoAlerts]) => (
            <Card key={repo} className="overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
                <Bug className="h-4 w-4 text-muted-foreground" />
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
