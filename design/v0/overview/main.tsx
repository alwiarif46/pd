import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import OverviewTab from './OverviewTab'
import './overview.css'

function Preview() {
  return (
    <div className="preview-shell">
      <header className="topbar-preview"><span>Shaavir PD</span><span>DOT Highway Safety Data Platform · 42 days left</span></header>
      <div className="preview-body">
        <aside className="preview-sidebar" aria-label="Bid sections">
          <p>Workspace</p>
          <div className="active">Overview</div><div>Schedule</div><div>Compliance matrix</div><div>Outline</div><div>Reviews</div>
          <p>Bid</p><div>Documents</div><div>Settings</div>
        </aside>
        <main><OverviewTab /></main>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Preview /></StrictMode>)
