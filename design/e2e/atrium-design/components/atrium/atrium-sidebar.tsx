'use client'

import { useState } from 'react'
import { Menu, Moon, Plus, Search, Sun, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { navPrimary, navSecondary, tenant } from '@/lib/sample-data'

const bids = [
  { no: '36C10B26R0042', name: 'EHR Modernization Support', stage: 'Drafting', due: '28d', active: true },
  { no: '47QTCA26Q0118', name: 'Cloud Ops BPA Call', stage: 'Gate 1', due: '11d' },
  { no: 'W91QUZ26R0007', name: 'Logistics Data Platform', stage: 'Bid / no-bid', due: '34d' },
  { no: 'TX-DIR-26-311', name: 'State Benefits Portal', stage: 'Intake', due: '41d' },
]

type ThemeProps = { dark: boolean; onToggleDark: () => void }
type NavProps = { activeNav: string; onSelectNav: (label: string) => void }

function ThemeToggle({ dark, onToggleDark, className }: ThemeProps & { className?: string }) {
  return (
    <button
      type="button"
      onClick={onToggleDark}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={dark}
      title={dark ? 'Light mode' : 'Dark mode'}
      className={cn(
        'flex size-10 items-center justify-center rounded-lg text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground',
        className,
      )}
    >
      {dark ? <Sun className="size-5" aria-hidden /> : <Moon className="size-5" aria-hidden />}
    </button>
  )
}

function Rail({ activeNav, onSelectNav, ...theme }: ThemeProps & NavProps) {
  return (
    <div className="flex w-16 shrink-0 flex-col items-center gap-2 bg-sidebar-rail py-3">
      <span className="mb-2 flex size-9 items-center justify-center rounded-lg bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">
        BW
      </span>
      <nav aria-label="Main" className="flex flex-col items-center gap-1">
        {navPrimary.map((item) => {
          const Icon = item.icon
          const active = item.label === activeNav
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => onSelectNav(item.label)}
              title={item.label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex size-10 items-center justify-center rounded-lg transition-colors',
                active
                  ? 'bg-sidebar-accent text-sidebar-primary'
                  : 'text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground',
              )}
            >
              {active && <span aria-hidden className="absolute -left-3 h-5 w-1 rounded-r bg-sidebar-primary" />}
              <Icon className="size-5" aria-hidden />
              <span className="sr-only">{item.label}</span>
              {item.badge && (
                <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-sidebar-primary" aria-hidden />
              )}
            </button>
          )
        })}
      </nav>
      <nav aria-label="Workspace" className="mt-auto flex flex-col items-center gap-1">
        {navSecondary.map((item) => {
          const Icon = item.icon
          const active = item.label === activeNav
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => onSelectNav(item.label)}
              title={item.label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex size-10 items-center justify-center rounded-lg transition-colors',
                active
                  ? 'bg-sidebar-accent text-sidebar-primary'
                  : 'text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground',
              )}
            >
              <Icon className="size-5" aria-hidden />
              <span className="sr-only">{item.label}</span>
            </button>
          )
        })}
        <ThemeToggle {...theme} />
        <span className="mt-2 flex size-8 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold">
          {tenant.user.initials}
        </span>
      </nav>
    </div>
  )
}

function BidList({ onClose }: { onClose?: () => void }) {
  return (
    <div className="flex h-full w-64 shrink-0 flex-col bg-sidebar">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <div className="flex flex-col">
          <span className="text-xs font-medium uppercase tracking-widest text-sidebar-muted">Active bids</span>
          <span className="text-sm font-semibold">{tenant.name}</span>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex size-8 items-center justify-center rounded-lg text-sidebar-muted hover:bg-sidebar-accent"
          >
            <X className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="New bid"
            className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground hover:opacity-90"
          >
            <Plus className="size-4" />
          </button>
        )}
      </div>
      <div className="px-3 pb-3">
        <label className="flex h-9 items-center gap-2 rounded-lg bg-sidebar-accent px-2.5 text-sm text-sidebar-muted focus-within:ring-1 focus-within:ring-sidebar-ring">
          <Search className="size-4" aria-hidden />
          <span className="sr-only">Filter bids</span>
          <input
            placeholder="Filter by number or agency"
            className="w-full bg-transparent text-sidebar-foreground outline-none placeholder:text-sidebar-muted"
          />
        </label>
      </div>
      <ul className="flex flex-col gap-1 px-2">
        {bids.map((b) => (
          <li key={b.no}>
            <a
              href="#"
              aria-current={b.active ? 'page' : undefined}
              className={cn(
                'flex flex-col gap-1 rounded-lg border px-3 py-2.5 transition-colors',
                b.active ? 'border-sidebar-primary/50 bg-sidebar-accent' : 'border-transparent hover:bg-sidebar-accent',
              )}
            >
              <span className="flex items-center justify-between font-mono text-xs text-sidebar-muted">
                {b.no}
                <span className={cn('tabular-nums', b.active && 'text-sidebar-primary')}>T-{b.due}</span>
              </span>
              <span className="truncate text-sm font-medium">{b.name}</span>
              <span className="text-xs text-sidebar-muted">{b.stage}</span>
            </a>
          </li>
        ))}
      </ul>
      <div className="mt-auto flex flex-col gap-2 border-t border-sidebar-border p-4">
        <div className="flex items-center justify-between text-xs text-sidebar-muted">
          <span>Plan usage</span>
          <span className="tabular-nums text-sidebar-foreground">
            {tenant.used} / {tenant.total}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-sidebar-accent">
          <div
            className="h-full rounded-full bg-sidebar-primary"
            style={{ width: `${(tenant.used / tenant.total) * 100}%` }}
          />
        </div>
      </div>
    </div>
  )
}

export function AtriumSidebar({
  collapsed,
  ...props
}: ThemeProps & NavProps & { collapsed: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="flex items-center justify-between bg-sidebar px-4 py-3 text-sidebar-foreground lg:hidden">
        <span className="text-sm font-semibold">Bidwright</span>
        <div className="flex gap-1">
          <ThemeToggle {...props} />
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="flex size-10 items-center justify-center rounded-lg hover:bg-sidebar-accent"
          >
            <Menu className="size-5" />
          </button>
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-foreground/30 backdrop-blur-sm"
          />
          <aside className="absolute inset-y-0 left-0 flex text-sidebar-foreground shadow-xl">
            <Rail
              {...props}
              onSelectNav={(label) => {
                props.onSelectNav(label)
                setOpen(false)
              }}
            />
            <BidList onClose={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <aside className="sticky top-0 hidden h-dvh text-sidebar-foreground lg:flex">
        <Rail {...props} />
        <div
          inert={collapsed}
          className={cn(
            'overflow-hidden bg-sidebar transition-[width] duration-300 ease-out motion-reduce:transition-none',
            collapsed ? 'w-0' : 'w-64',
          )}
        >
          <BidList />
        </div>
      </aside>
    </>
  )
}
