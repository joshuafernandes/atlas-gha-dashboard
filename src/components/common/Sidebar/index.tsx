// 
// Dashboard sidebar (Grafana-style fixed left nav).
//
// Always dark-themed regardless of the user's light/dark preference — matches
// the Grafana / Datadog sidebar pattern where the nav is visually separate
// from the content area. The colour scheme is driven by the CSS variables
// prefixed with `--sidebar-*` in globals.css.
//
// Navigation items:
//   Pull Requests   /prs            — CI status per open PR
//   Workflows       /workflows      — analytics, sparklines, metrics
//   Code Scanning   /code-scanning  — open security alerts (requires security_events scope)
//   Dependabot      /dependabot-alerts — open vulnerability alerts (requires vulnerability_alerts scope)
//
// Bottom section contains:
//   ThemeToggle     — switches the main content area between light and dark
//   User avatar     — name + email from the Google OAuth session
//   Sign-out button — calls next-auth signOut, redirects to /login
// 

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useSession, signOut } from 'next-auth/react'
import {
  GitPullRequest,
  Bug,
  KeyRound,
  LogOut,
  LayoutDashboard,
  ChevronRight,
  Activity,
  ShieldAlert,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/common/ThemeToggle'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Nav items

const navItems = [
  {
    label: 'Pull Requests',
    href: '/prs',
    icon: GitPullRequest,
  },
  {
    label: 'Workflows',
    href: '/workflows',
    icon: Activity,
  },
  {
    label: 'Code Scanning',
    href: '/code-scanning',
    icon: ShieldAlert,
  },
  {
    label: 'Dependabot',
    href: '/dependabot-alerts',
    icon: Bug,
  },
  {
    label: 'Secret Scanning',
    href: '/secret-scanning',
    icon: KeyRound,
  },
]

// Individual nav link

function NavItem({
  href,
  icon: Icon,
  label,
  active,
}: {
  href: string
  icon: React.ElementType
  label: string
  active: boolean
}) {
  return (
    // Tooltip only visible on smaller screens where the sidebar might be collapsed
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          className={cn(
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            active
              ? 'bg-sidebar-active text-sidebar-active-fg'
              : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-fg',
          )}
        >
          <Icon className="h-4 w-4 shrink-0" />
          <span className="truncate">{label}</span>
          {/* Chevron indicates the currently active page */}
          {active && <ChevronRight className="ml-auto h-3 w-3 opacity-60" />}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right" className="md:hidden">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

// Sidebar

export function Sidebar() {
  const pathname = usePathname()
  const { data: session } = useSession()

  // Generate up-to-2-letter initials for the avatar fallback
  const userInitials = session?.user?.name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) ?? '?'

  return (
    <aside className="flex h-screen w-56 flex-col bg-sidebar border-r border-sidebar-border shrink-0">
      {/* Logo / app title */}
      <div className="flex items-center gap-2.5 px-4 py-5 border-b border-sidebar-border">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 shrink-0">
          <LayoutDashboard className="h-4 w-4 text-white" />
        </div>
        <span className="font-semibold text-sm text-sidebar-foreground truncate">GHA Dashboard</span>
      </div>

      {/* Navigation links */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
          Monitors
        </p>
        {navItems.map((item) => (
          <NavItem
            key={item.href + item.label}
            href={item.href}
            icon={item.icon}
            label={item.label}
            // Mark active for exact match OR any sub-path (e.g. /prs/123)
            active={pathname === item.href || pathname.startsWith(item.href + '/')}
          />
        ))}
      </nav>

      {/* Bottom section: theme toggle + signed-in user */}
      <div className="px-3 pb-4 border-t border-sidebar-border pt-3 space-y-2">
        <div className="flex items-center justify-between px-2">
          <ThemeToggle />
        </div>
        {session?.user && (
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-sidebar-accent transition-colors">
            {/* User avatar from Google OAuth profile picture */}
            <Avatar className="h-7 w-7">
              <AvatarImage src={session.user.image ?? undefined} alt={session.user.name ?? ''} />
              <AvatarFallback className="text-[10px]">{userInitials}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-sidebar-foreground truncate">
                {session.user.name}
              </p>
              <p className="text-[10px] text-sidebar-foreground/60 truncate">
                {session.user.email}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => signOut({ callbackUrl: '/login' })}
                  className="text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors"
                  aria-label="Sign out"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Sign out</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </aside>
  )
}
