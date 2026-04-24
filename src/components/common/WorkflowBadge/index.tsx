import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  SkipForward,
  HelpCircle,
  AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkflowStatus } from '@/types'

interface WorkflowBadgeProps {
  status: WorkflowStatus
  className?: string
}

const config: Record<
  WorkflowStatus,
  { icon: React.ElementType; label: string; className: string; spin?: boolean }
> = {
  passing:  { icon: CheckCircle2, label: 'Passing',  className: 'text-green-500' },
  failing:  { icon: XCircle,      label: 'Failing',  className: 'text-red-500' },
  building: { icon: Loader2,      label: 'Building', className: 'text-yellow-500', spin: true },
  pending:  { icon: Clock,        label: 'Pending',  className: 'text-muted-foreground' },
  error:    { icon: AlertCircle,  label: 'Error',    className: 'text-orange-500' },
  skipped:  { icon: SkipForward,  label: 'Skipped',  className: 'text-muted-foreground' },
  unknown:  { icon: HelpCircle,   label: 'Unknown',  className: 'text-muted-foreground' },
}

export function WorkflowBadge({ status, className }: WorkflowBadgeProps) {
  const { icon: Icon, label, className: colorClass, spin } = config[status] ?? config.unknown
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', colorClass, className)}>
      <Icon className={cn('h-3.5 w-3.5', spin && 'animate-spin')} />
      {label}
    </span>
  )
}
