'use client'

import { ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { cn } from '@/lib/utils'

type Props = {
  section: string
  items?: string[]
  active: string
  onSelect: (item: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

export function AtriumTopRail({ section, items, active, onSelect, collapsed, onToggleCollapse }: Props) {
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose
  return (
    <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur md:px-6">
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
        title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (Ctrl/Cmd + B)`}
        className="hidden size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:flex"
      >
        <ToggleIcon className="size-5" aria-hidden />
      </button>

      <span className="flex shrink-0 items-center gap-1 text-sm font-semibold">
        {section}
        {items && <ChevronRight className="size-4 text-muted-foreground" aria-hidden />}
      </span>

      {items && (
        <nav aria-label={`${section} sections`} className="-mb-px flex h-full min-w-0 overflow-x-auto">
          <ul className="flex h-full items-stretch gap-1">
            {items.map((item) => {
              const isActive = item === active
              return (
                <li key={item} className="flex">
                  <button
                    type="button"
                    onClick={() => onSelect(item)}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'relative flex items-center whitespace-nowrap px-3 text-sm transition-colors',
                      isActive ? 'font-medium text-primary' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {item}
                    {isActive && (
                      <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 rounded-t bg-primary" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
      )}
    </div>
  )
}
