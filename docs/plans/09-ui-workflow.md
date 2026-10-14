# 09 — UI Workflow: v0, Claude Code, Cursor

**Status:** Draft v2 · 14 Oct 2026

v0 builds the screens into a drop folder. Claude Code integrates them into the app and builds everything behind them. Cursor edits the app. v0 is connected to the GitHub repo and reads the plans from it, so the drop folder is the fence: v0 writes nowhere else, and the app never builds from it.

## 1. Setup (Claude Code, once)

1. Create the project: Vite + React + TypeScript in `apps/web`.
2. Install Tailwind and shadcn/ui, then add the base components v0 relies on: `button`, `input`, `select`, `checkbox`, `table`, `dialog`, `sheet`, `tabs`, `badge`, `dropdown-menu`, `tooltip`, `toast`.
3. Put the design tokens in `tailwind.config.ts` and `src/styles/tokens.css` (section 4).
4. Create the folders in section 2, the `CLAUDE.md` in section 3, and the `design/v0/README.md` in section 3.
5. Exclude `design/` from the build, lint, type-check, and tests (`tsconfig` exclude, ESLint ignore, Vitest exclude), so files v0 generates can never fail CI.
6. In v0's GitHub settings, point the sync at a branch named `v0-ui`, never `main`.

## 2. Folder rules

```
repo/
├── design/v0/     v0 writes here and nowhere else. One folder per screen, e.g. design/v0/compliance-matrix/.
│                  Not part of any build. May hold whatever v0 generates, including Next.js files. Nobody edits it by hand.
├── docs/plans/    These plans. v0 and Claude Code read them.
└── apps/web/src/
    ├── ui/        Integrated copies of v0 screens, made by Claude Code. Presentational. Props in, callbacks out. No fetch, no router, no store.
    │   ├── shell/     AppShell, Sidebar, TopBar, LockedTab, UpgradeDialog
    │   ├── bids/      BidsList, NewBid
    │   ├── overview/  OverviewTab
    │   ├── compliance/ComplianceMatrixTab, RowEditor, SourceViewer
    │   ├── outline/   OutlineTab
    │   ├── resumes/   ResumeMatrixTab
    │   ├── reviews/   ReviewsTab, ReviewForm
    │   ├── production/ProductionTab
    │   ├── orals/     OralsTab
    │   ├── lessons/   LessonsTab
    │   ├── documents/ DocumentsPanel
    │   ├── settings/  BidSettings
    │   └── common/    ProcessingBanner, EmptyState, FilterBar, SourceLink
    ├── features/  Claude Code. One container per screen: loads data, holds state, calls the API, renders the ui component.
    ├── schedule/  Claude Code. Port of the offline Proposal Schedule Builder. Not v0.
    ├── api/       Claude Code. Typed client for the Fastify API.
    └── types/     Shared types (also used by the API). ui components import from here.
```

Who writes where:

| Folder | v0 | Claude Code | Cursor |
|---|---|---|---|
| `design/v0/` | Writes | Reads only | Never |
| `apps/web/src/ui/` | Never | Writes during integration; styling kept as v0 made it | Small fixes |
| Everything else | Never | Writes | Edits |

## 3. CLAUDE.md (put at the repo root)

```markdown
# PD web app

## Who edits what
- `design/v0/**` is v0's drop folder. Read it, never edit it. It is excluded from the build.
- `apps/web/src/ui/**` holds screens you integrate from `design/v0/`. During integration: strip Next.js imports,
  remove any fetch or router code, map types to `@/types`, and keep markup, class names, and styles exactly as v0 made them,
  so a later re-integration is a clean diff. Do not restyle.
- `apps/web/src/features/**`, `schedule/**`, `api/**`, and everything under `apps/api` and `apps/worker` is yours.
- UI components take data as props and report user actions through callbacks. They never fetch, route, or store.

## Integration task, when asked
1. Read `design/v0/<screen>/`.
2. Write or update `apps/web/src/ui/<screen>/` as above.
3. Write or keep the container in `apps/web/src/features/<screen>/`. On a re-integration, the container does not change
   unless the props contract changed.
4. Run type-check and tests. Commit as `ui: <screen> from v0` and `feature: <screen> container` separately.

## Conventions
- TypeScript strict. Shared types live in `apps/web/src/types` and `packages/core`.
- Every AI-extracted row carries `sourcePage` and `sourceQuote`. Never render a row without a source control.
- Every tab handles: no solicitation, processing, failed, empty, locked (free plan), out of credits.
- Dates are ISO strings in data; display formatting happens in ui components.
- Tenant safety: the API sets `app.org_id` per request. Never query without it.

## Plans
- Product and build plans are in `docs/plans/` (copied from C:\Tools\PD\plans). Read `00-overview.md`, `05-ui.md`, and `09-ui-workflow.md` before UI work.
```

Also put this `design/v0/README.md` in the repo so v0 sees it:

```markdown
# v0 drop folder
Write every file for a screen under `design/v0/<screen>/`. Touch nothing outside this folder.
Build presentational components only: props in, callbacks out, sample data as constants, no fetching, no routing, no global state.
Read the screen description in `docs/plans/05-ui.md` and the props contract in `docs/plans/09-ui-workflow.md` section 5.
Shared types (`Tab`, `ProcessingState`, `SourceLinkProps`) already exist; import them from `@/types`, do not redefine them.
```

## 4. Design tokens for v0

Paste this at the start of every v0 chat, then name the screen, point v0 at its section in the plans, and tell it the drop folder.

```
Design system for the Shaavir PD app. Plain React + Vite + TypeScript, Tailwind, shadcn/ui. No Next.js imports.
Colors: ink #1C2A3A (text, top bar), canvas #EBEFF4 (page), paper #FFFFFF (cards), line #D5DBE3, muted text #5B6878,
accent #1F4E79 (primary buttons), due red #B42318, today blue #1F6FEB, weekend #F3F5F8, holiday #FFF4DC, warning #B54708.
Color team colors: Blue #2F6FD6, Pink #E58AAE, Red #C62828, Green #3C9A4A, Gold #D4A017, White Glove #E9ECF0.
Type: UI text "Segoe UI", system-ui. Dates and big numbers: Bahnschrift, "DIN Alternate", "Roboto Condensed", with tabular numerals.
Rules: visible labels on every input, no placeholder-only fields; verb-first button labels; destructive actions name the item and
default focus to Cancel; tables scroll inside their own container; sentence case; no decorative gradients.
The component is presentational: props in, callbacks out, sample data inside, no fetching, no routing, no global state.
Write all files under design/v0/<screen>/ and touch nothing else. Shared types already exist in @/types; do not redefine them.
```

## 5. Component contracts

Give v0 the contract for the screen. Claude Code implements the container that supplies it.

### 5.1 Shell
```ts
type Tab = 'overview' | 'schedule' | 'compliance' | 'outline' | 'resumes' | 'reviews' | 'production' | 'orals' | 'lessons' | 'documents' | 'settings';
interface AppShellProps {
  bid: { id: string; name: string; agency?: string; dueDate?: string; dueTime?: string; timeZone?: string };
  bids: { id: string; name: string }[];
  activeTab: Tab;
  plan: 'free' | 'starter' | 'growth';
  creditsLeft: number; creditsResetOn: string;
  oralsEnabled: boolean;
  user: { name: string; email: string };
  onSelectTab: (t: Tab) => void; onSwitchBid: (id: string) => void; onUpgrade: () => void; onSignOut: () => void;
  children: React.ReactNode;
}
```
Paid tabs show a lock on the free plan. Clicking one renders `LockedTab` with the tab's description and an upgrade button.

### 5.2 Bids list and new bid
```ts
interface BidsListProps { bids: BidCard[]; onOpen: (id: string) => void; onCreate: () => void; creditsLeft: number }
interface BidCard { id: string; name: string; agency?: string; dueDate?: string; daysLeft?: number; status: 'planning' | 'writing' | 'submitted' | 'closed'; creditUsed: boolean }
interface NewBidProps { creditsLeft: number; onCreate: (name: string, files: File[]) => void; onCancel: () => void }
```

### 5.3 Overview and kickoff
```ts
interface BidFact { id: string; field: string; value: string; sourcePage?: number; sourceQuote?: string; confirmed: boolean }
interface KickoffItem { id: string; label: string; owner?: string; done: boolean }
interface OverviewTabProps {
  facts: BidFact[]; kickoff: KickoffItem[];
  countdown: { daysLeft: number; workdaysLeft: number; dueLabel: string } | null;
  processing: ProcessingState;
  onEditFact: (id: string, value: string) => void; onConfirmFact: (id: string, confirmed: boolean) => void;
  onToggleKickoff: (id: string, done: boolean) => void; onSetOwner: (id: string, owner: string) => void;
  onOpenSource: (page: number, quote: string) => void;
}
```

### 5.4 Compliance matrix
```ts
type ReqType = 'shall' | 'must' | 'will' | 'should' | 'other';
type RowStatus = 'open' | 'assigned' | 'drafted' | 'done';
interface ComplianceRow {
  id: string; reqId: string; sectionRef: string; requirement: string; type: ReqType;
  instrRef?: string; evalRef?: string; responseSection?: string; owner?: string; status: RowStatus;
  sourcePage?: number; quoteVerified: boolean; origin: 'ai' | 'user'; flags: ('unverified' | 'duplicate' | 'outside_scope')[];
}
interface CheckThese { id: string; sentence: string; page: number }
interface ComplianceFilters { section?: string; type?: ReqType; status?: RowStatus; owner?: string; unverifiedOnly: boolean; search: string }
interface ComplianceMatrixTabProps {
  rows: ComplianceRow[]; checkThese: CheckThese[]; filters: ComplianceFilters; federal: boolean;
  sections: string[]; owners: string[]; processing: ProcessingState;
  onFiltersChange: (f: ComplianceFilters) => void;
  onEditRow: (id: string, patch: Partial<ComplianceRow>) => void; onAddRow: (row: Omit<ComplianceRow, 'id'>) => void;
  onMergeRows: (ids: string[]) => void; onSplitRow: (id: string, parts: string[]) => void; onDeleteRow: (id: string) => void;
  onPromoteCheckThese: (id: string) => void; onDismissCheckThese: (id: string) => void;
  onOpenSource: (page: number, quote: string) => void; onExport: (format: 'xlsx' | 'csv') => void;
}
```
When `federal` is true, label the reference columns "L ref" and "M factor"; otherwise "Instruction ref" and "Evaluation factor". Always show the banner "Draft. Review every row before you rely on it." once processing finishes.

### 5.5 Outline and status tracker
```ts
interface OutlineItem { id: string; parentId?: string; number: string; title: string; pageLimit?: number; pagesPlanned?: number; sourceRef?: string; writer?: string; status: 'not_started' | 'in_progress' | 'review' | 'done'; dueDate?: string }
interface OutlineTabProps { items: OutlineItem[]; processing: ProcessingState; onEdit: (id: string, patch: Partial<OutlineItem>) => void; onAdd: (parentId?: string) => void; onDelete: (id: string) => void; onMove: (id: string, parentId: string | undefined, index: number) => void; onExport: (format: 'xlsx' | 'docx') => void }
```
Show the page total per volume against its limit, red when over.

### 5.6 Resume and key personnel matrix
```ts
interface PersonnelRequirement { id: string; role: string; requirement: string; kind: 'degree' | 'years' | 'certification' | 'clearance' | 'skill' | 'other'; sourcePage?: number; sourceQuote?: string }
interface Candidate { id: string; name: string; role: string; documentId: string; status: 'processing' | 'ready' | 'failed' }
interface ResumeMatch { candidateId: string; requirementId: string; result: 'meets' | 'partial' | 'gap' | 'unknown'; evidence?: string; override?: 'meets' | 'partial' | 'gap' }
interface ResumeMatrixTabProps {
  requirements: PersonnelRequirement[]; candidates: Candidate[]; matches: ResumeMatch[]; roles: string[]; processing: ProcessingState;
  onEditRequirement: (id: string, patch: Partial<PersonnelRequirement>) => void; onAddRequirement: (role: string) => void; onDeleteRequirement: (id: string) => void;
  onUploadResumes: (files: File[], role: string) => void; onAssignRole: (candidateId: string, role: string) => void; onRemoveCandidate: (id: string) => void;
  onOverride: (candidateId: string, requirementId: string, result: 'meets' | 'partial' | 'gap' | null) => void;
  onOpenSource: (page: number, quote: string) => void; onExport: () => void;
}
```
Grid: requirement rows by candidate columns, grouped by role. Below it, a gap list per candidate and a list of roles no candidate fully meets.

### 5.7 Color team reviews
```ts
interface Review { id: string; type: 'pink' | 'red' | 'green' | 'gold' | 'other'; scheduledAt?: string; status: 'planned' | 'in_progress' | 'done'; draftDocumentId?: string; reviewers: { name: string; sections: string[] }[] }
interface Finding { id: string; reviewId: string; evalFactor?: string; kind: 'strength' | 'weakness' | 'deficiency' | 'risk' | 'comment'; text: string; draftQuote?: string; origin: 'ai' | 'user'; author?: string; disposition: 'open' | 'accepted' | 'rejected' | 'done' }
interface ReviewsTabProps {
  reviews: Review[]; findings: Finding[]; activeReviewId?: string; evalFactors: string[]; processing: ProcessingState;
  onCreateReview: (r: Omit<Review, 'id' | 'status'>, draft?: File) => void; onSelectReview: (id: string) => void; onEditReview: (id: string, patch: Partial<Review>) => void;
  onAddFinding: (f: Omit<Finding, 'id' | 'origin' | 'disposition'>) => void; onEditFinding: (id: string, patch: Partial<Finding>) => void; onSetDisposition: (id: string, d: Finding['disposition']) => void;
  onExport: (format: 'docx' | 'xlsx') => void;
}
```
Findings grouped by evaluation factor, with the review type's color as the group marker.

### 5.8 Production checklist
```ts
interface ProductionItem { id: string; category: 'format' | 'files' | 'submission' | 'copies' | 'other'; rule: string; sourcePage?: number; sourceQuote?: string; owner?: string; done: boolean; origin: 'ai' | 'user' | 'standard' }
interface ProductionTabProps { items: ProductionItem[]; processing: ProcessingState; onToggle: (id: string, done: boolean) => void; onEdit: (id: string, patch: Partial<ProductionItem>) => void; onAdd: (category: ProductionItem['category']) => void; onDelete: (id: string) => void; onOpenSource: (page: number, quote: string) => void }
```
Show a "ready to submit" bar: done items over total.

### 5.9 Orals
```ts
interface OralsItem { id: string; category: 'rules' | 'prep' | 'session'; item: string; sourcePage?: number; owner?: string; minutes?: number; done: boolean }
interface OralsTabProps { items: OralsItem[]; processing: ProcessingState; onToggle: (id: string, done: boolean) => void; onEdit: (id: string, patch: Partial<OralsItem>) => void; onAdd: (category: OralsItem['category']) => void; onDelete: (id: string) => void; onOpenSource: (page: number, quote: string) => void }
```

### 5.10 Lessons learned
```ts
interface Lesson { id: string; question: string; answer: string; author?: string; updatedAt: string }
interface LessonsTabProps { lessons: Lesson[]; onAnswer: (id: string, answer: string) => void; onAddQuestion: (q: string) => void; onExport: () => void }
```

### 5.11 Documents and settings
```ts
interface Doc { id: string; name: string; kind: 'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft'; pages?: number; uploadedAt: string; deleteOn: string; status: 'scanning' | 'extracting' | 'ready' | 'failed' | 'deleted' }
interface DocumentsPanelProps { docs: Doc[]; onUpload: (files: File[], kind: Doc['kind']) => void; onDelete: (id: string) => void; onOpen: (id: string) => void }
interface BidSettingsProps { bid: BidSettingsValues; onSave: (v: BidSettingsValues) => void; onDeleteBid: () => void }
interface BidSettingsValues { name: string; agency: string; solicitationNumber: string; startDate?: string; dueDate?: string; dueTime?: string; timeZone: string; oralsEnabled: boolean }
```

### 5.12 Shared
```ts
interface ProcessingState { stage: 'idle' | 'scanning' | 'extracting' | 'classifying' | 'extract' | 'verify' | 'map' | 'done' | 'failed'; percent: number; message?: string; etaSeconds?: number }
interface SourceLinkProps { page?: number; quote?: string; fileGone?: boolean; onOpen: (page: number, quote: string) => void }
interface LockedTabProps { tab: Tab; title: string; description: string; onUpgrade: () => void }
interface EmptyStateProps { title: string; text: string; action?: { label: string; onClick: () => void } }
```

## 6. Order of v0 chats

1. Shell (sidebar, top bar, locked tab, upgrade dialog) and the common pieces (ProcessingBanner, EmptyState, SourceLink).
2. Bids list and New bid.
3. Compliance matrix. This is the free tier's hook; spend the most time here.
4. Overview and kickoff.
5. Documents and Bid settings.
6. Paid tabs in Phase 4 order: Outline, Resume matrix, Reviews, Production, Orals, Lessons.

The Schedule tab is not a v0 chat. Claude Code ports it from the offline builder into `src/schedule/`.

Each chat ends the same way: v0 pushes to the `v0-ui` branch, you merge it to `main` (the folder cannot break the build), then you ask Claude Code to integrate that screen.

## 7. Round trip for a change

| Change | Where | How |
|---|---|---|
| Looks wrong, spacing, colors, labels | v0, then Claude Code | Same v0 chat, describe the change, push to `v0-ui`, merge. Then: "Re-integrate `design/v0/<screen>`, keep the container unchanged." |
| Needs new data on screen | Claude Code, then v0, then Claude Code | Add the field to `@/types` and the container first, tell v0 the new prop, then re-integrate |
| Behavior, validation, saving | Claude Code | Container in `src/features/`. v0 is not involved |
| Small fix in the app | Cursor | Keep the rule: no logic in `ui/`, no styling in `features/`, nothing in `design/v0/` |

## 8. Costs of this setup, accepted

- Each screen exists twice: the v0 original in `design/v0/` and the integrated copy in `src/ui/`.
- Every look change is two steps: v0, then a Claude Code re-integration.
- In return, v0 never touches the app, and a v0 push can never break the build.

## Decision log

| Date | Decision |
|---|---|
| 14 Oct 2026 | v0 for presentational components only; Claude Code owns containers, API, worker, and the schedule port |
| 14 Oct 2026 | v0 connected to the repo: writes only to `design/v0/` on branch `v0-ui`; Claude Code integrates into `src/ui/` |
