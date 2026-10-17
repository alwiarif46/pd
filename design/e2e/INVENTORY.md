# Atrium inventory

## 1. Source and rules

- Source: `design/e2e/atrium-design/` (v0 export, 17 Oct 2026). Read-only. Never edit it. It is excluded from build, lint, type-check and tests (BUILD-PLAN s10).
- Integrate Atrium parts the way PD's v0 rule works: strip Next.js and `"use client"`, strip fetch and sample data, map types to contracts, keep markup and class names. Screens Atrium does not have are "new in Atrium style" (built with `frontend-design`, tokens and components below) and each enhancement gets one line in `design/e2e/ENHANCEMENTS.md`.
- Gaps are build work, not questions. Chats read this file at start (BUILD-PLAN s2 step 1).

## 2. Components

Atrium has four screen components, one UI primitive, and one data file. All four screen components live in `components/atrium/`. Icons come from `lucide-react`. `cn` comes from `lib/utils`.

| File | Props | What it renders | State it assumes | Hard-coded sample data |
|---|---|---|---|---|
| `atrium-shell.tsx` (`AtriumShell`) | `children` | The page frame: `div.theme-atrium` (adds `.dark` when dark), flex row of sidebar and a column holding the top rail and content. For anything except Run monitor / Overview it shows a dashed placeholder card titled "Sample screen". | Local `useState`: `dark`, `collapsed`, `activeNav` (default "Run monitor"), `activeSub` (default "Overview"). Ctrl/Cmd+B toggles the sidebar. No router, no persistence of theme or collapse. | `subMenus`: sub tabs for only three sections (Run monitor: Overview, Volumes, Compliance matrix, Timeline, Cost & tokens; Q&A: Open questions, Submitted, Agency answers; Request & collect: Outstanding, Received, Templates). Other sections have no sub tabs. The dashboard is shown only when nav is Run monitor and sub is Overview. |
| `atrium-sidebar.tsx` (`AtriumSidebar`, inner `Rail`, `BidList`, `ThemeToggle`) | `dark`, `onToggleDark`, `collapsed`, `activeNav`, `onSelectNav` | Desktop: a 64px icon rail (logo "BW", primary nav with badge dots, secondary nav pinned to bottom, theme toggle, user initials) plus a 256px bid list panel (tenant name, "New bid" button, filter input, four bid cards with number, T-minus days, name, stage, and a plan usage bar). The bid panel collapses to width 0 (`inert`). Mobile (below `lg`): a top strip with product name, theme toggle and menu button; the menu opens a drawer with rail and bid list. | Local `useState` `open` for the mobile drawer. The filter input is uncontrolled and does nothing. Bid cards are `href="#"` anchors. "New bid" has no handler. | `bids` array (4 bids, one `active`) is hard-coded in the file. `navPrimary`, `navSecondary`, `tenant` (name, plan usage 2 of 4, user initials) come from `lib/sample-data.ts`. Product name "Bidwright" and logo letters "BW" are literals. |
| `atrium-top-rail.tsx` (`AtriumTopRail`) | `section`, `items?`, `active`, `onSelect`, `collapsed`, `onToggleCollapse` | Sticky 56px bar: sidebar collapse button (desktop only), section name with chevron, and a tab strip of sub items with an underline on the active one. | None of its own. Fully controlled by the shell. | None. |
| `atrium-dashboard.tsx` (`AtriumDashboard`, inner `Card`, `Ring`) | none | The one real screen: Run monitor / Overview. Greeting and bid title; Draft progress ring with per-volume counts; "Submission due" card (primary fill); "Q&A window" card (signal fill) with a "Review 7 draft questions" link; Run budget bar; Journey (stage pills: done, running, gate, queued); "We still need these" (NEED cards with section, impact badge, "Add evidence" button); Requests list with status icon; "Recently" activity feed (first 3). | Stateless. Reads module constants. Derives percent drafted, current stage, received count. Every link is `href="#"`, buttons have no handlers. | Everything: `bid`, `stages`, `volumes`, `needs`, `requests`, `activity` from `lib/sample-data.ts`. Also literals: "Good morning, Dana", "Review 7 draft questions", "Red review starts when every page clears 90%". |
| `components/ui/button.tsx` (`Button`, `buttonVariants`) | Base UI `Button` props plus `variant` (default, outline, secondary, ghost, destructive, link) and `size` (default, xs, sm, lg, icon, icon-xs, icon-sm, icon-lg) | shadcn style button on `@base-ui/react/button`, radius `rounded-lg`, focus ring, press nudge. | None. | None. Note: no Atrium component uses it. The Atrium files use hand-written `<button>` classes instead. |
| `lib/sample-data.ts` | n/a | Types `NavItem`, `StageStatus`; data `navPrimary` (Bids, Run monitor, Q&A, Request & collect, Reviews, Packages), `navSecondary` (Repository, Settings), `tenant`, `bid`, `stages` (8), `volumes` (4), `needs` (4), `requests` (5), `activity` (4). | n/a | All of it. Replace with contract types and props. |
| `app/page.tsx`, `app/layout.tsx` | n/a | Mounts shell and dashboard; loads IBM Plex Sans (400 to 700) and Plex Mono (400, 500) through `next/font`; theme color `#f7f4ec`; Vercel analytics in production. | n/a | Title "Bidwright · Atrium". Strip `next/font`, `next/*` and Analytics on integration; load Plex through the web app's own font setup. |

Only `button.tsx` is present in `components/ui/`. Other shadcn parts (input, card, dialog, table, tabs, badge, checkbox, sheet, tooltip, toast) are not in the export and come from the shadcn CLI when a screen needs them.

## 3. Tokens

Source: `app/globals.css`. Tailwind v4, `@theme inline` maps each `--x` variable to `--color-x`. Light values sit on `:root, .theme-atrium`. Dark values sit on `.theme-atrium.dark`. All values are `oklch`.

### 3.1 Color tokens

| Token | Light | Dark |
|---|---|---|
| background | oklch(0.975 0.013 88) | oklch(0.185 0.02 262) |
| foreground | oklch(0.25 0.035 258) | oklch(0.93 0.014 88) |
| card | oklch(0.992 0.007 88) | oklch(0.225 0.025 262) |
| card-foreground | oklch(0.25 0.035 258) | oklch(0.93 0.014 88) |
| popover | oklch(0.992 0.007 88) | oklch(0.225 0.025 262) |
| popover-foreground | oklch(0.25 0.035 258) | oklch(0.93 0.014 88) |
| primary | oklch(0.48 0.17 258) | oklch(0.7 0.14 252) |
| primary-foreground | oklch(0.985 0.01 88) | oklch(0.18 0.04 262) |
| secondary | oklch(0.945 0.016 88) | oklch(0.28 0.03 262) |
| secondary-foreground | oklch(0.25 0.035 258) | oklch(0.93 0.014 88) |
| muted | oklch(0.945 0.014 88) | oklch(0.28 0.03 262) |
| muted-foreground | oklch(0.5 0.03 258) | oklch(0.7 0.025 258) |
| accent | oklch(0.93 0.035 255) | oklch(0.3 0.06 258) |
| accent-foreground | oklch(0.36 0.13 258) | oklch(0.88 0.06 245) |
| signal | oklch(0.8 0.13 80) | oklch(0.8 0.13 80) |
| signal-foreground | oklch(0.36 0.08 70) | oklch(0.88 0.1 85) |
| destructive | oklch(0.56 0.18 28) | oklch(0.7 0.16 28) |
| border | oklch(0.91 0.018 88) | oklch(0.3 0.03 262) |
| input | oklch(0.91 0.018 88) | oklch(0.3 0.03 262) |
| ring | oklch(0.48 0.17 258) | oklch(0.7 0.14 252) |
| sidebar-rail | oklch(0.27 0.1 262) | oklch(0.17 0.05 263) |
| sidebar | oklch(0.32 0.12 261) | oklch(0.21 0.07 262) |
| sidebar-foreground | oklch(0.97 0.012 88) | oklch(0.94 0.014 88) |
| sidebar-muted | oklch(0.8 0.045 255) | oklch(0.72 0.04 255) |
| sidebar-primary | oklch(0.86 0.09 230) | oklch(0.78 0.12 240) |
| sidebar-primary-foreground | oklch(0.26 0.09 262) | oklch(0.18 0.05 262) |
| sidebar-accent | oklch(0.38 0.12 260) | oklch(0.27 0.08 261) |
| sidebar-accent-foreground | oklch(0.97 0.012 88) | oklch(0.96 0.012 88) |
| sidebar-border | oklch(0.42 0.1 260) | oklch(0.3 0.07 261) |
| sidebar-ring | oklch(0.86 0.09 230) | oklch(0.78 0.12 240) |

Notes: `signal` (amber) is Atrium's own addition, used for the Q&A card. `sidebar-muted` and `sidebar-rail` are not stock shadcn names. There is no `success`, `warning` or `info` token; the dashboard uses `accent` for done, `destructive/10` for overdue and high impact.

### 3.2 Fonts, radius, motion, variant

| Item | Atrium value |
|---|---|
| Sans | IBM Plex Sans, weights 400, 500, 600, 700, via `--font-plex-sans`, mapped to `--font-sans` |
| Mono | IBM Plex Mono, weights 400, 500, via `--font-plex-mono`, mapped to `--font-mono`. Used for solicitation numbers |
| Numerals | `tabular-nums` utility on counts and money |
| Radius | `--radius: 0.75rem`. Scale: sm 0.6x, md 0.8x, lg 1x, xl 1.4x, 2xl 1.8x, 3xl 2.2x, 4xl 2.6x. Cards use `rounded-2xl`, controls `rounded-lg`, pills `rounded-full` |
| Elevation | Cards use `shadow-sm` and no border; the drawer uses `shadow-xl` |
| `.rise` motion | Keyframes `rise`: opacity 0 to 1 and `translateY(6px)` to 0, 0.45s, `cubic-bezier(0.2, 0.7, 0.2, 1)`, fill `both`. Applied to the dashboard header and each card. Disabled under `prefers-reduced-motion: reduce`. The sidebar collapse uses a 300ms width transition, also disabled for reduced motion |
| Custom variant | `@custom-variant dark (&:is(.dark *))`. Dark applies under a `.dark` ancestor. Atrium puts `.dark` on the same element as `.theme-atrium`, so the variant matches descendants only. The token block is `.theme-atrium.dark` |
| Base layer | `* { border-border outline-ring/50 }`, `body { bg-background text-foreground font-sans }`. Imports: `tailwindcss`, `tw-animate-css`, `shadcn/tailwind.css` |
| Theme switch | Atrium toggles `.dark` through React state only. No system preference follow, no storage. Build work for the web app (see gaps) |

### 3.3 PD's old tokens (`apps/web/src/styles/tokens.css`)

Atrium's tokens replace PD's shadcn mapping. PD's domain tokens stay.

| PD token | Value today | Fate |
|---|---|---|
| ink | #1C2A3A | Alias of `foreground` (`--color-ink: var(--foreground)`) |
| canvas | #EBEFF4 | Alias of `background` |
| paper | #FFFFFF | Alias of `card` |
| line | #D5DBE3 | Alias of `border` |
| due | #B42318 | Stays as a domain token. Define a light and a dark value; start from `destructive` hue (28) |
| today | #1F6FEB | Stays. Define light and dark; start from the `primary` hue (258) |
| weekend | #F3F5F8 | Stays. Light and dark values, near `muted` |
| holiday | #FFF4DC | Stays. Light and dark values, near `signal` at low opacity |
| warning | #B54708 | Stays. Light and dark values, near `signal-foreground` |
| team-blue, team-pink, team-red, team-green, team-gold, team-white-glove | PD hexes | Stay as domain tokens (review team colors, 05 labels). Each needs a dark value. Keep a text label with each, never color alone (05 s9) |
| background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring (+ foregrounds) | PD navy-gray values | Replaced by Atrium's values in 3.1 |
| sidebar-*, signal | not in PD | New from Atrium |
| `--font-sans` | Segoe UI | Replaced by IBM Plex Sans |
| `--font-numeric` | Bahnschrift stack | Dropped; use Plex Mono and `tabular-nums` |

Domain tokens must be defined for dark mode, and every PD component that uses `bg-ink`, `bg-canvas`, `bg-paper` or `border-line` keeps working through the aliases until it is moved to the Atrium names.

## 4. Screen map

Status words: **Atrium** means Atrium has it and it is integrated as built. **Atrium + data** means the markup exists and needs real data and handlers. **Partial** means Atrium has a part of it. **New** means new in Atrium style.

The shell has two nav levels: an icon rail (6 primary, 2 secondary) with a top rail of sub tabs for the active section. 05 s2 describes a different layout (top bar, one sidebar, detail slider); see gaps G1 to G3. The "Needs you" column below is the 05 s8 state set: Not reached yet (NR), Running (RUN), Needs you (NY), Paused at cap (CAP), Failed (FAIL), Out of proposals (OOP), Disconnected (DISC). Each PD tab also needs the PD states from CLAUDE.md: no solicitation, processing, failed, empty, locked (free plan), out of credits. "All" below means every 05 s8 state that applies to that screen; the building chat writes the Playwright states test for them.

### 4.1 Frame and shell

| Screen or part (05 ref) | Atrium part | States required | Chat |
|---|---|---|---|
| App shell, rail, top rail, theme toggle, collapse (05 s2) | Atrium: `AtriumShell`, `AtriumSidebar`, `AtriumTopRail` | n/a. Needs mobile drawer, collapsed, light and dark checks | 1 (tokens, fonts, theme helper, exclude folder), 2 (shell markup, wired to routes) |
| Bid switcher and bid list panel (05 s2, s3 Bids list) | Atrium: `BidList` | Empty (no bids), loading | 2 |
| Sidebar status dots with text: Needs you, Running, Failed, Done (05 s2) | Partial: the rail has an unlabeled badge dot; bid cards show stage text | Four labels | 2 (rail), 3 (run states) |
| Greyed gate items that still open and say when ready (05 s2) | New | NR | 3 |
| Top bar: bid switcher, due date, proposals left, user (05 s2) | Partial: plan usage bar in bid list, due countdown on bid cards, initials in rail | n/a | 2 |
| Detail slider and source viewer (05 s2, PD reuse) | New (sheet from shadcn, Atrium tokens) | Loading, no source | 2 (PD tabs need it), 3 |
| Amendment banner on every bid screen (05 s4.4) | New | One state plus a change list link | 7 |
| Notification bell and list (05 s7) | New | Empty | 7 |

### 4.2 Outside a bid (05 s3)

| Screen | Atrium part | States required | Chat |
|---|---|---|---|
| Sign up, sign in, reset | New. Zitadel hosted login themed with Atrium tokens (05 s3 Proposed); an E2E-side fallback page only if the theme cannot reach it | FAIL, DISC | 2 |
| Accept invite, seat locked (PD `features/membership/ui`) | New in Atrium style (restyle PD's hand-built component) | FAIL (bad code), locked | 2 |
| Bids list | Partial: sidebar bid list shows the data; no full table page | empty, OOP | 2 |
| New bid (drop zone, optional past performance zone, Fetch from portal) | New | FAIL (bad file), OOP; portal option shows DISC | 2 (drop zone), 7 (portal option) |
| Repository (05 s5 browser) | Partial: only the rail entry "Repository" and a placeholder | empty, FAIL | 3 (service). Screen unassigned, see G9 |
| Organization (members, roles, plan, billing) | Partial: rail entry "Settings" and placeholder | OOP | 8 |
| Account (name, email, MFA factors, linked accounts) | New | FAIL | 2 |

### 4.3 Inside a bid (05 s4)

| Screen | Atrium part | States required | Chat |
|---|---|---|---|
| Soft intake, Gate 0 (s4.1): two columns, AI-ban banner, estimate panel, Start run | Partial: "We still need these" NEED cards, `Card`, impact badge, "Add evidence" button; no two-column layout, no "already have" list, no banner, no estimate | NR, RUN (scan), NY, OOP, FAIL | 3 |
| Bid/no-bid, Gate 0b (s4.2): 5 panels, Bid and No bid buttons | New | NR, NY, FAIL | 3 |
| Run monitor, overview (s4.3) | Atrium: `AtriumDashboard` (Journey = stage list, Draft progress = volumes, Run budget = cost meter, Requests, Recently = events feed) | NR, RUN, FAIL, CAP, OOP | 3 (screen), 5 (Pink review link) |
| Run monitor, page grid (volumes by sections, score vs 90%, NEED and lock counts) | New (tab "Volumes" exists in the shell menu with no screen) | RUN, FAIL, empty | 3 |
| Run monitor, Compliance matrix tab (also PD tab) | New (tab name exists in shell menu) | all | 2 |
| Run monitor, Timeline tab | New. 05 has no timeline screen; see G6 | RUN | 3 |
| Run monitor, Cost and tokens tab | Partial: Run budget card. 05 has only the cost meter; see G6 | CAP | 3 |
| Failed stage with Retry; Cost cap paused message (s4.3) | New (inline states inside the run monitor) | FAIL, CAP | 3 |
| Amendment change list (s4.4) | New | NY, empty | 7 |
| Q&A review and send (s4.5): deadline, format, questions, email, two checkboxes, Send | Partial: Q&A window card, "Review 7 draft questions" link, sub tabs Open questions, Submitted, Agency answers | NR, NY, DISC (no mailbox, offer download), FAIL | 7 |
| Request and collect tracker (s4.6) | Partial: Requests card, rail entry, sub tabs Outstanding, Received, Templates; no table, no check result, no Upload instead | NR, NY, DISC, empty | 7 |
| Red review, Gate 1 (s4.7): summary bar, Pages, Findings, NEEDs panels | Partial: NEED cards, impact badge. Rail entry "Reviews" is a placeholder | NR, NY, RUN, FAIL | 6 |
| Locks and proposed changes (s4.8) | New (lock icon, tag, change proposed tag with text labels) | NY | 6 |
| Sign-off, Gate 2 (s4.9): round diff, page list, per volume, uncited claims, Confirm volume | New | NR, NY, FAIL | 6 |
| Package and signature notice (s4.10) | Partial: rail entry "Packages" is a placeholder | NR, RUN, NY, FAIL, DISC (portal) | 6 (package, notice), 7 (portal agent view and checklist) |
| Outcome entry after submission (s4.10, s5) | New | NY | 6 (prompt), 3 (repository store) |
| Documents (s4.11, PD reuse) | New in Atrium style | empty, FAIL, processing | 2 (PD tab), 7 (Drive copy and link) |
| Bid settings (s4.11: format spec, volumes, page budget) | New | FAIL | 2 (PD part), 4 (format spec) |

### 4.4 Settings (05 s6) and notifications (05 s7)

| Screen | Atrium part | States required | Chat |
|---|---|---|---|
| Settings frame (rail entry "Settings", sub tabs) | Partial: rail entry only; placeholder content | n/a | 8 (frame), each owner chat adds its page |
| Fonts and Request a font | New | FAIL, OOP (fee) | 4 |
| Format specs | New | empty | 4 |
| Mailbox | New | DISC | 7 |
| Shaavir Drive | New | DISC | 7 |
| Portals | New | DISC | 7 |
| eBuy inbound | New | empty, DISC | 7 |
| Data and AI | New | n/a | 8 (legal pass). Owner unclear, see G10 |
| Billing (plan, proposals left, reset date, usage, Stripe portal) | Partial: plan usage bar in the bid list | OOP, FAIL | 8 |
| Notifications (7 event types, in-app) | New | empty | 7 |

### 4.5 PD tabs as E2E features (09 s7)

All nine are built by chat 2 ("PD tabs as E2E features", chat-2 item 8), in Atrium style and under the sidebar below the line in 05 s2. Atrium has a nav slot for none of them except the sub tab "Compliance matrix" under Run monitor.

| PD tab | Atrium part | Notes and states | Chat |
|---|---|---|---|
| Overview | Atrium + data: reuse `AtriumDashboard` cards (due, progress); PD overview content must be mapped | All six PD states, plus 05 s8 | 2 |
| Schedule | New (PD schedule grid uses `due`, `today`, `weekend`, `holiday` domain tokens) | Dark values needed | 2 |
| Compliance matrix | New (shell sub tab exists). Rows follow amendment display: superseded, withdrawn, added | Source control on every row | 2 |
| Outline | New | Feeds the outline stage; source control | 2 |
| Resumes | New | Locked (plan), empty | 2 |
| Reviews | New. Lives next to the rail's "Reviews" entry, which Gate 1 and Gate 2 also use | See gap G5 | 2 (PD tab), 6 (Gate 1 and 2) |
| Production | New | Package checklist overlaps the Package screen | 2 (tab), 6 (checklist) |
| Orals | New | Locked (plan), empty | 2 |
| Lessons | New | Fed to learning loop | 2 |

## 5. Gaps and drift between 05 and Atrium

Gaps are build work. Count: 14.

| # | Gap or drift | Direction | What to do | Chat |
|---|---|---|---|---|
| G1 | 05 s2 draws one top bar, one sidebar (Intake, Bid/no-bid, Run, Q&A, Requests, Red review, Sign-off, Package, then PD tabs below a line, then Documents and Bid settings) and a detail slider. Atrium has an icon rail with 8 entries, a bid list panel and a top rail with sub tabs | Drift | Keep Atrium's frame. Inside a bid, map 05's run-order items to rail entries and top rail sub tabs; record the mapping as an enhancement. Suggested: Run monitor (Intake, Bid/no-bid, Overview, Volumes, Compliance matrix, Timeline, Cost), Q&A, Request & collect, Reviews (Red, Sign-off), Packages | 1 (decide and log), 2 (build) |
| G2 | Atrium's rail mixes "Bids" (list), run sections, "Repository" and "Settings". 05 says outside a bid the top bar links Bids, Repository, Organization, Account | Drift | Add Organization and Account as rail or user-menu entries; the user initials in the rail become an account menu | 2 |
| G3 | The 05 detail slider (open on row click) and the PD source viewer have no Atrium part | 05 only | Build as a shadcn sheet on the right in Atrium tokens. Required by every row with `sourcePage` and `sourceQuote` | 2 |
| G4 | 05 s2 sidebar items show a labeled status ("Needs you", "Running", "Failed", "Done"). Atrium shows a dot with no text and uses dots to mean count badges | Drift | Add text-labeled status chips; a dot alone breaks the 05 s9 rule (never color alone) | 2 |
| G5 | Rail entry "Reviews" is one slot. 05 has Red review (Gate 1), Sign-off (Gate 2) and PD's Reviews tab | Drift | Decide the sub tabs: Red review, Gold and White Glove, Sign-off, PD reviews. Log it | 6 |
| G6 | Atrium's Run monitor menu has Timeline and Cost and tokens tabs. 05 s4.3 describes stage list, page grid, cost meter, time, events feed, but no Timeline screen and no per-token view | Atrium only | Build Timeline as the stage list with start, end, retries and elapsed time. Build Cost and tokens as cost meter plus cap and per-stage spend (01 s8). Log in ENHANCEMENTS | 3 |
| G7 | Atrium's Q&A sub tab "Agency answers" and Request and collect sub tab "Templates" are not in 05 | Atrium only | Agency answers: store of answers to Q&A (05 s4.5 says a Q&A release follows the amendment path). Templates: request templates (05 s4.6 "Format"). Decide scope, log it | 7 |
| G8 | Atrium's dashboard has no handling for 05 s8 states (Not reached yet, Paused at cap, Failed with Retry, Out of proposals, Disconnected). It also has no loading, empty or error | 05 only | Add a state layer for every screen; shared "state panel" component. Needed for every Playwright states test | 3 (first), all later |
| G9 | Repository browser (05 s5: filters, item kinds, item view, outcome entry, retire) has no Atrium screen and no chat names it. Chat 3 builds the repository service but its list has no screen | 05 only, and unowned | Assign to chat 3 (store, search) and build the browser screen there unless chat 3 plan refines it. Outcome entry belongs with chat 6 package step | 3 |
| G10 | Settings pages "Data and AI" (providers, subprocessors, Terms, Privacy) has no owner chat. Chat 4 owns Fonts and Format specs, chat 7 owns Mailbox, Drive, Portals, eBuy, chat 8 owns Billing | 05 only | Assign to chat 8 with the legal work | 8 |
| G11 | Atrium dashboard shows items 05 does not describe: greeting ("Good morning, Dana"), the "Submission due" and "Q&A window" countdown cards, "Recently" feed with three items, a "Plan usage" bar with a count out of 4 (05 shows "proposals left") | Atrium only | Keep. Make the greeting use the user name from the session. Wire "proposals left" to 06 numbers. 05 should list the countdown cards (add to 05 in a later doc pass) | 3 |
| G12 | 05 s4.3 Pink review link and "Add anything here at any time" note, the time estimate to the next gate, and the amendment banner have no place in the dashboard | 05 only | Add a link card and a time line to the run monitor | 3 (time), 5 (Pink link), 7 (banner) |
| G13 | Product name. Atrium says "Bidwright" (title, rail logo "BW", mobile header). 05 and BUILD-PLAN say the working name is E2E Proposal, final name open (00 s7) | Drift | Read the name and logo letters from one config constant; do not hard-code. Use "E2E Proposal" for now | 2 (with the shell) |
| G14 | Tokens and theme behavior. Atrium has no system-preference theme follow, no stored choice, no `success` or `warning` tokens, and the `dark` variant only matches inside `.dark`. PD's domain tokens have no dark values. CLAUDE.md says PD's dark variants apply only under a `.dark` class that the app never sets | Drift | Put `.theme-atrium` and `.dark` on `html`, follow `prefers-color-scheme` and store the choice, add `success`, `warning`, and dark values for due, today, weekend, holiday, warning, team-* (section 3.3). Replace `ui-preflight`/legacy layer setup when the last legacy screen goes | 1 (tokens, `.dark` on html, stored choice: done); OS follow and domain dark values later (ENHANCEMENTS) |

Other drift to keep in mind (not counted, small):
- Atrium's hand-written buttons skip `Button`. On integration, prefer `Button` from `components/ui` for new work and leave the Atrium markup as it is, so re-integration stays a clean diff.
- Atrium bid cards show "T-28d". 05 and the bids list want a due date and days left. Show both.
- The bid list in Atrium lists stages by plain name ("Gate 1", "Bid / no-bid"); keep the same words as 04 stage names.
- Atrium has no Atrium form controls (input, checkbox, table, tabs, dialog). Add them with the shadcn CLI, using Atrium tokens, when chat 2 needs them. Do not hand-edit `components/ui/**` (CLAUDE.md).
