'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { AtriumSidebar } from './atrium-sidebar'
import { AtriumTopRail } from './atrium-top-rail'

const subMenus: Record<string, string[]> = {
  'Run monitor': ['Overview', 'Volumes', 'Compliance matrix', 'Timeline', 'Cost & tokens'],
  'Q&A': ['Open questions', 'Submitted', 'Agency answers'],
  'Request & collect': ['Outstanding', 'Received', 'Templates'],
}

export function AtriumShell({ children }: { children: React.ReactNode }) {
  const [dark, setDark] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [activeNav, setActiveNav] = useState('Run monitor')
  const [activeSub, setActiveSub] = useState('Overview')

  const subItems = subMenus[activeNav]

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setCollapsed((c) => !c)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function selectNav(label: string) {
    setActiveNav(label)
    setActiveSub(subMenus[label]?.[0] ?? '')
  }

  const showDashboard = activeNav === 'Run monitor' && activeSub === 'Overview'

  return (
    <div className={cn('theme-atrium min-h-dvh bg-background text-foreground lg:flex', dark && 'dark')}>
      <AtriumSidebar
        dark={dark}
        onToggleDark={() => setDark((d) => !d)}
        collapsed={collapsed}
        activeNav={activeNav}
        onSelectNav={selectNav}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <AtriumTopRail
          section={activeNav}
          items={subItems}
          active={activeSub}
          onSelect={setActiveSub}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
        />
        {showDashboard ? (
          children
        ) : (
          <main className="flex flex-1 flex-col p-4 pb-24 md:p-6 md:pb-24">
            <section className="rise flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-card p-10 text-center">
              <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Sample screen</p>
              <h1 className="text-balance text-2xl font-semibold tracking-tight">
                {activeSub ? `${activeNav} / ${activeSub}` : activeNav}
              </h1>
              <p className="max-w-sm text-pretty text-sm leading-relaxed text-muted-foreground">
                This screen is a placeholder. Open Run monitor, then Overview, to see the full dashboard.
              </p>
            </section>
          </main>
        )}
      </div>
    </div>
  )
}
