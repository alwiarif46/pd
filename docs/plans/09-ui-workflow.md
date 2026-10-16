# 09 — UI Workflow: v0, Claude Code, Cursor

**Status:** Draft v4 · 14 Oct 2026

v0 builds the screens into a drop folder. Claude Code integrates them into the app and builds everything behind them. Cursor edits the app. v0 is connected to the GitHub repo and reads the plans from it, so the drop folder is the fence: v0 writes nowhere else, and the app never builds from it.

## 1. Setup (Claude Code, once)

1. Create the project: Vite + React + TypeScript in `apps/web`.
2. Install Tailwind v4 (`@tailwindcss/vite`) and shadcn/ui (primitives in `src/components/ui/`), then add the base components v0 relies on: `button`, `input`, `label`, `select`, `checkbox`, `table`, `dialog`, `sheet`, `tabs`, `badge`, `dropdown-menu`, `tooltip`, `sonner` (shadcn's replacement for `toast`). Use React 19 (current shadcn components need it).
3. Put the design tokens in `src/styles/tokens.css` as a Tailwind v4 `@theme` block (section 4). Tailwind v4 has no `tailwind.config.ts`. Preflight stays off until the legacy screens are retired.
4. Create the folders in section 2, then `CLAUDE.md`, `AGENTS.md`, and `design/v0/README.md` (section 3).
5. Exclude `design/` from the build, lint, type-check, and tests. It sits at the repo root, outside every package, so package builds, `tsc`, Vite, Tailwind, and Turbo never see it; the root `tsconfig.json` excludes it; ESLint and Vitest must ignore it when they are added. Files v0 generates can then never fail CI.
6. In v0's GitHub settings, point the sync at a branch named `v0-ui`, never `master`.

## 2. Folder rules

```
repo/
├── design/v0/     v0 writes here and nowhere else. One folder per screen, e.g. design/v0/compliance-matrix/.
│                  Not part of any build. May hold whatever v0 generates, including Next.js files. Nobody edits it by hand.
├── docs/plans/    These plans. v0 and Claude Code read them.
└── apps/web/src/
    ├── ui/        Integrated copies of v0 screens, made by Claude Code. Presentational. Props in, callbacks out. No fetch, no router, no store.
    │   ├── auth/      AuthLayout, LogIn, SignUp, Verify, ResetRequest, ResetPassword
    │   ├── shell/     AppShell (with Sidebar, TopBar), UpgradeDialog, ConfirmDialog
    │   ├── common/    TabFrame, LockedTab, ProcessingBanner, EmptyState, SourceLink, MarkingPrompt, AmendmentConfirm
    │   ├── bids/      BidsList, NewBid
    │   ├── overview/  OverviewTab
    │   ├── compliance/ComplianceMatrixTab, RowDetail, SourceViewer
    │   ├── outline/   OutlineTab
    │   ├── resumes/   ResumeMatrixTab
    │   ├── reviews/   ReviewsTab
    │   ├── production/ProductionTab
    │   ├── orals/     OralsTab
    │   ├── lessons/   LessonsTab
    │   ├── documents/ DocumentsPanel
    │   ├── settings/  BidSettings, DateChangePrompt
    │   ├── organization/ OrganizationPage
    │   ├── account/   AccountPage
    │   └── privacy/   PrivacyPage
    ├── components/ui/ shadcn/ui primitives, added by the shadcn CLI. Not edited by hand.
    ├── styles/   globals.css (Tailwind entry), tokens.css
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

## 3. Repo instruction files

- `/CLAUDE.md`: rules for Claude Code and integration.
- `/AGENTS.md`: short rules for v0.
- `/design/v0/README.md`: drop-folder rules v0 sees.

The repo files are the source. This plan does not copy them, so they cannot drift.

## 4. Design tokens for v0

Paste this at the start of every v0 chat, then name the screen, point v0 at its section in the plans, and tell it the drop folder.

```
Design system for the Shaavir PD app. Plain React + Vite + TypeScript, Tailwind v4, shadcn/ui. No Next.js imports.
Colors: ink #1C2A3A (text, top bar), canvas #EBEFF4 (page), paper #FFFFFF (cards), line #D5DBE3, muted text #5B6878,
accent #1F4E79 (primary buttons), due red #B42318, today blue #1F6FEB, weekend #F3F5F8, holiday #FFF4DC, warning #B54708.
Color team colors: Blue #2F6FD6, Pink #E58AAE, Red #C62828, Green #3C9A4A, Gold #D4A017, White Glove #E9ECF0.
Type: UI text "Segoe UI", system-ui. Dates and big numbers: Bahnschrift, "DIN Alternate", "Roboto Condensed", with tabular numerals.
Rules: visible labels on every input, no placeholder-only fields; verb-first button labels; destructive actions name the item and
default focus to Cancel; tables scroll inside their own container; sentence case; no decorative gradients.
Theme classes: text-ink, bg-canvas, bg-paper, border-line, text-muted-foreground, bg-primary (the accent), text-due, text-today, bg-weekend, bg-holiday, text-warning, bg-team-blue/-pink/-red/-green/-gold/-white-glove, font-numeric with tabular-nums. shadcn components are at @/components/ui/<name>.
The component is presentational: props in, callbacks out, sample data inside, no fetching, no routing, no global state.
Write all files under design/v0/<screen>/ and touch nothing else. Shared types already exist in @/types; do not redefine them.
```

## 5. Component contracts

Give v0 the contract for the screen. Claude Code implements the container that supplies it.

Rules for every contract:
- Props are exactly as written. A value that can be missing is `| null`, not an optional prop, unless the contract itself writes `?`.
- Dates and times are ISO strings (`2026-11-03`, `2026-11-03T14:00:00-05:00`). The ui component formats them. Sizes are bytes unless the name says `Mb`.
- The container filters, sorts, and derives lists (for example gaps, totals, `daysLeft`). The ui component renders what it is given and keeps only local ui state (open menus, form drafts, row selection).
- Messages the API produces (errors, refusals) arrive as text in a `FormStatus` or an `UploadNotice`; the ui shows them as given.
- Every row that carries a source renders a `SourceLink`. Rows the user added show "Added by user" instead.
- The states in 05 s4 are drawn by `TabFrame` (5.12) around each tab, except "Empty result", which each tab draws inside its own table with `EmptyState` and its add-by-hand form.
- Tabs that hold source-bearing rows take `selectedRowId`: the row is highlighted and scrolled into view, and focus returns to it when the row detail slider closes.

### 5.1 Shell
```ts
type OutsidePage = 'bids' | 'organization' | 'account' | 'privacy';
type TabSignal = 'processing' | 'waiting' | 'failed';
interface ShellBid { id: string; name: string; agency: string | null; dueDate: string | null; dueTime: string | null; timeZone: string | null }
interface AppShellProps {
  bid: ShellBid | null;                 // null outside a bid: no sidebar
  bids: { id: string; name: string }[];
  activeTab: Tab | null;                // null outside a bid
  activePage: OutsidePage | null;       // null inside a bid
  plan: Plan;
  creditsLeft: number; creditsResetOn: string;
  oralsEnabled: boolean;
  tabSignals: { tab: Tab; signal: TabSignal }[];
  user: { name: string; email: string };
  detail: React.ReactNode;              // the row detail slider (5.17), or null when closed
  onSelectTab: (t: Tab) => void; onSwitchBid: (id: string) => void; onOpenPage: (p: OutsidePage) => void;
  onUpgrade: () => void; onSignOut: () => void;
  children: React.ReactNode;
}
const PAID_TABS: Tab[] = ['outline', 'resumes', 'reviews', 'production', 'orals', 'lessons'];
```
- Top bar (`bg-ink`): "Shaavir PD", then inside a bid the bid switcher and the due date and time, then "N RFP credits left · resets [date]", then a user menu (Account, Organization, Privacy, Sign out). Outside a bid the top bar has links to Bids and Organization instead of the switcher.
- Sidebar, inside a bid only: Overview, Schedule, Compliance; a divider labelled "Paid"; Outline, Resumes, Reviews, Production, Orals (only when `oralsEnabled`), Lessons; a divider; Documents, Settings. On the free plan paid tabs show a lock icon and their accessible name ends in "(locked)". A `tabSignals` entry shows a small dot with a text label (Processing, Needs you, Failed).
- Clicking a locked tab still calls `onSelectTab`; the container renders `LockedTab` as the children.
- The Schedule tab is rendered by Claude Code's port as the children; the content area must give it the full width and height left of the sidebar and slider.
- `detail` is a column on the right at 1,024 px and wider (the content shrinks; the table stays usable) and a full-width overlay below 1,024 px.
- Below 1,024 px the sidebar shows icons only, with tooltips. Below 640 px it becomes a "Menu" button that opens the tab list in a sheet.

### 5.2 Bids list and new bid
```ts
type BidStatus = 'planning' | 'writing' | 'submitted' | 'closed';
interface BidCard { id: string; name: string; agency?: string; dueDate?: string; daysLeft?: number; status: BidStatus; creditUsed: boolean }
interface BidsListProps {
  bids: BidCard[]; creditsLeft: number; creditsResetOn: string;
  onOpen: (id: string) => void; onCreate: () => void; onUpgrade: () => void;
}
interface NewBidProps {
  creditsLeft: number; creditsResetOn: string; plan: Plan; mbCap: number; status: FormStatus;
  onCreate: (name: string, bidType: BidType, files: File[]) => void; onCancel: () => void; onUpgrade: () => void;
}
```
- New bid asks for the name and the bid type (Federal or SLED, with the help "Bid facts can correct this later"), shows the credit rule and the bid's MB cap before upload, and takes the solicitation set by drag and drop or a file picker (PDF, DOCX, XLSX). Files that would pass the cap are not added; the message names them and the MB left, with "Upgrade plan" on Free.
- `status` `'submitting'` disables the form and shows "Creating bid…". `'error'` shows the container's message above the buttons (for example the out-of-credits, wrong-solicitation, or locked-PDF refusal from 05 s3.10).
- With `creditsLeft` at 0, Bids list opens an out-of-credits dialog instead of calling `onCreate`, and New bid shows the out-of-credits message with "Upgrade plan" and "Back to bids".

### 5.3 Overview and kickoff
```ts
interface BidFact {
  id: string; field: string; value: string; confirmed: boolean; origin: 'ai' | 'user';
  sourcePage: number | null; sourcePageEnd: number | null; sourceQuote: string | null; amendment: AmendmentMark;
}
interface KickoffItem { id: string; label: string; owner: string | null; note: string | null; done: boolean }
interface Countdown { dueDate: string; dueTime: string | null; timeZone: string | null; daysLeft: number; workdaysLeft: number }
interface OverviewTabProps {
  facts: BidFact[]; kickoff: KickoffItem[]; countdown: Countdown | null; selectedRowId: string | null;
  onEditFact: (id: string, value: string) => void; onConfirmFact: (id: string, confirmed: boolean) => void;
  onAddFact: (field: string, value: string) => void;
  onToggleKickoff: (id: string, done: boolean) => void; onSetKickoffOwner: (id: string, owner: string) => void;
  onAddKickoff: (label: string) => void;
  onOpenRow: (id: string) => void; onOpenSource: (id: string) => void; onJumpToRow: (id: string) => void;
}
```
- Bid facts table: Field, Value, Source, Confirmed. A superseded fact stays, value struck through, with the label "Superseded by Amd N" as a button that calls `onJumpToRow(replacedById)`. A fact added by an amendment shows "Added by Amd N".
- Countdown: days and workdays left to the due date and time, in the numeric font; "Due today" at 0; "Past due" below 0 in due red.
- Kickoff checklist: label, owner, done. The standard items are seeded by the container.

### 5.4 Compliance matrix
```ts
type RowStatus = 'open' | 'assigned' | 'drafted' | 'done';
interface ComplianceRow {
  id: string; reqId: string; sectionRef: string | null; requirement: string; type: ReqType | null;
  instrRef: string | null; evalRef: string | null; responseSection: string | null; owner: string | null; status: RowStatus;
  sourcePage: number | null; sourcePageEnd: number | null; sourceQuote: string | null; quoteVerified: boolean;
  origin: 'ai' | 'user'; flags: RowFlag[]; amendment: AmendmentMark;
}
interface CheckThese { id: string; sentence: string; page: number }
interface ComplianceFilters {
  section: string | null; type: ReqType | null; status: RowStatus | null; owner: string | null;
  amendment: number | 'original' | null; flaggedOnly: boolean; hideClosed: boolean; checkThese: boolean; search: string;
}
type ComplianceRowEdit = Partial<Pick<ComplianceRow, 'requirement' | 'owner' | 'status' | 'responseSection'>>;
interface NewComplianceRow { requirement: string; sectionRef: string | null; type: ReqType | null; owner: string | null }
interface ComplianceMatrixTabProps {
  rows: ComplianceRow[];              // already filtered by the container
  totalRows: number;
  checkThese: CheckThese[];
  filters: ComplianceFilters; federal: boolean;
  sections: string[]; owners: string[]; amendments: number[];
  selectedRowId: string | null;
  onFiltersChange: (f: ComplianceFilters) => void;
  onEditRow: (id: string, edit: ComplianceRowEdit) => void; onAddRow: (row: NewComplianceRow) => void;
  onMergeRows: (ids: string[]) => void; onSplitRow: (id: string, at: number) => void; onDeleteRow: (id: string) => void;
  onPromoteCheckThese: (id: string) => void; onDismissCheckThese: (id: string) => void;
  onOpenRow: (id: string) => void; onOpenSource: (id: string) => void; onJumpToRow: (id: string) => void;
  onExport: (format: 'xlsx' | 'csv') => void;
}
```
- Columns: ID, Section, Requirement, Type, Instruction ref, Evaluation factor, Response section, Owner, Status, Source, Amendment. When `federal` is true the two reference columns read "L ref" and "M factor".
- Amendment column and row display: `superseded` rows stay, struck through, with the text label "Superseded" and the button "Superseded by Amd N", which calls `onJumpToRow(replacedById)`; `withdrawn` rows stay, struck through, with "Withdrawn by Amd N" and no jump; `added` rows show "Added by Amd N"; `original` shows "Original". User rows show "Added by user".
- Flags show as small labelled badges: "May not be a requirement", "Page estimated", "OCR", "Quote not verified". The "Flagged" filter shows rows with any flag.
- Filters: Section, Type, Status, Owner, Amendment (Original or Amd N), "Flagged", "Hide superseded and withdrawn", "Check these", and a search box. "Check these" swaps the table for the pre-scan list: each sentence with its page, "Add as requirement", and "Dismiss". "Showing N of M rows" sits above the table.
- Row actions: select rows with checkboxes, then "Merge selected" (2 or more). "Split row" opens a dialog showing the requirement text; the user places the split point and confirms; the ui calls `onSplitRow(id, characterIndex)`. "Delete row" asks with `ConfirmDialog`. Owner and Status are editable in the table. "Add requirement" opens a small form.
- Export menu: "Export XLSX", "Export CSV". The XLSX is laid out by the instruction sections; superseded and withdrawn rows export with their status (container).
- `TabFrame` shows "Draft. Review every row before you rely on it." above the table once processing finishes (`draftNotice`), and the amendment-confirm panel in its `waiting` slot.

### 5.5 Outline and status tracker
```ts
type OutlineStatus = 'not_started' | 'in_progress' | 'review' | 'done';
interface OutlineItem {
  id: string; parentId: string | null; number: string | null; title: string; pageLimit: number | null;
  sourceRef: string | null; sourcePage: number | null; sourcePageEnd: number | null; sourceQuote: string | null;
  writer: string | null; status: OutlineStatus; dueDate: string | null; origin: 'ai' | 'user'; amendment: AmendmentMark;
}
type OutlineEdit = Partial<Pick<OutlineItem, 'title' | 'writer' | 'status' | 'pageLimit' | 'dueDate'>>;
interface OutlineTabProps {
  items: OutlineItem[]; selectedRowId: string | null;
  onEdit: (id: string, edit: OutlineEdit) => void; onAdd: (parentId: string | null, title: string, number: string | null) => void;
  onDelete: (id: string) => void; onMove: (id: string, parentId: string | null, index: number) => void;
  onOpenRow: (id: string) => void; onOpenSource: (id: string) => void; onExport: (format: 'xlsx' | 'docx') => void;
}
```
- Tree of volumes (items with `parentId` null) and their sections: number, title, page limit, writer, status, due date, source ref. Sections expand and collapse.
- Each volume shows "Pages planned N of L": the sum of its sections' page limits against the volume's own limit, in due red with the text "Over by X" when over.
- The source ref is a button that calls `onOpenRow`. Move a section with "Move up", "Move down", and "Move to volume…" (no drag-only control).

### 5.6 Resume and key personnel matrix
```ts
type PersonnelKind = 'degree' | 'years' | 'certification' | 'clearance' | 'skill' | 'other';
type MatchResult = 'meets' | 'partial' | 'gap' | 'unknown';
interface PersonnelRequirement {
  id: string; role: string; requirement: string; kind: PersonnelKind | null; origin: 'ai' | 'user';
  sourcePage: number | null; sourcePageEnd: number | null; sourceQuote: string | null; amendment: AmendmentMark;
}
interface Candidate {
  id: string; name: string; role: string; status: 'processing' | 'ready' | 'failed';
  uploadedAt: string | null; resumeDeleted: boolean;
}
interface ResumeMatch { candidateId: string; requirementId: string; result: MatchResult; evidence: string | null; evidencePage: number | null; overridden: boolean }
interface ResumeMatrixTabProps {
  requirements: PersonnelRequirement[]; candidates: Candidate[]; matches: ResumeMatch[]; roles: string[];
  gaps: { candidateId: string; requirementIds: string[] }[]; uncoveredRoles: string[];
  uploadStatus: FormStatus; selectedRowId: string | null;
  onEditRequirement: (id: string, edit: { role?: string; requirement?: string }) => void;
  onAddRequirement: (role: string, requirement: string, kind: PersonnelKind | null) => void; onDeleteRequirement: (id: string) => void;
  onUploadResumes: (files: File[], role: string) => void; onAssignRole: (candidateId: string, role: string) => void;
  onRemoveCandidate: (id: string) => void;
  onSetResult: (candidateId: string, requirementId: string, result: 'meets' | 'partial' | 'gap') => void;
  onOpenRow: (id: string) => void; onOpenSource: (id: string) => void; onExport: () => void;
}
```
- Left: roles and their requirements (editable). Right: "Upload resumes" for a chosen role, and the candidate list with role, status, and upload date.
- Grid: requirement rows by candidate columns, grouped by role. Each cell shows Meets, Partial, Gap, or Unknown as text plus color, the evidence quote and page in a tooltip, and "Reviewer set" when `overridden`. A cell menu sets the result.
- Below the grid: a gap list per candidate and "Roles with no candidate who meets every requirement".
- A standing note: "Resumes, their text, and evidence quotes are deleted 90 days after upload. Candidate names and results stay." When `resumeDeleted`, evidence reads "Removed: resume deleted after 90 days".

### 5.7 Color team reviews
```ts
type ReviewType = 'pink' | 'red' | 'green' | 'gold' | 'other';
type FindingKind = 'strength' | 'weakness' | 'deficiency' | 'risk' | 'comment';
type Disposition = 'open' | 'accepted' | 'rejected' | 'done';
interface Reviewer { id: string; name: string; sections: string }
interface Review {
  id: string; type: ReviewType; scheduledAt: string | null; status: 'planned' | 'in_progress' | 'done';
  draftFileName: string | null; reviewers: Reviewer[];
}
interface Finding {
  id: string; reviewId: string; evalFactor: string | null; kind: FindingKind; text: string;
  draftQuote: string | null; draftPage: number | null; origin: 'ai' | 'user'; author: string | null; disposition: Disposition;
}
interface NewReview { type: ReviewType; scheduledAt: string | null; reviewers: { name: string; sections: string }[] }
interface ReviewsTabProps {
  reviews: Review[]; findings: Finding[]; activeReviewId: string | null; evalFactors: string[]; federal: boolean;
  uploadStatus: FormStatus; selectedRowId: string | null;
  onCreateReview: (r: NewReview, draft: File | null) => void; onSelectReview: (id: string) => void;
  onEditReview: (id: string, edit: { status?: Review['status']; scheduledAt?: string | null }) => void;
  onUploadDraft: (reviewId: string, file: File) => void;
  onAddReviewer: (reviewId: string, name: string, sections: string) => void; onRemoveReviewer: (id: string) => void;
  onAddFinding: (f: { reviewId: string; evalFactor: string | null; kind: FindingKind; text: string }) => void;
  onEditFinding: (id: string, text: string) => void; onSetDisposition: (id: string, d: Disposition) => void;
  onOpenRow: (id: string) => void; onOpenSource: (id: string) => void; onExport: (format: 'docx' | 'xlsx') => void;
}
```
- Review list (type chip in its color team color, date, status, draft file), "Create review" (type, date, draft upload, reviewers and their sections).
- Findings for the active review grouped by evaluation factor ("Section M factor" on federal bids), then by kind: strengths, weaknesses, deficiencies, risks, comments. Each finding: text, draft quote and page as a `SourceLink`, origin (AI or the author's name), and a disposition control (Open, Accept, Reject, Done).

### 5.8 Production checklist
```ts
type ProductionCategory = 'format' | 'files' | 'submission' | 'copies' | 'other';
interface ProductionItem {
  id: string; category: ProductionCategory; rule: string; owner: string | null; done: boolean; origin: 'ai' | 'user' | 'standard';
  sourcePage: number | null; sourcePageEnd: number | null; sourceQuote: string | null; amendment: AmendmentMark;
}
interface ProductionTabProps {
  items: ProductionItem[]; selectedRowId: string | null;
  onToggle: (id: string, done: boolean) => void; onEdit: (id: string, edit: { rule?: string; owner?: string | null }) => void;
  onAdd: (category: ProductionCategory, rule: string) => void; onDelete: (id: string) => void;
  onOpenRow: (id: string) => void; onOpenSource: (id: string) => void;
}
```
- Grouped by category (Format, Files, Submission, Copies, Other). Standard items show "Standard"; extracted rules show their `SourceLink`.
- "Ready to submit" bar at the top: done over total, with "Ready to submit" in green text when all are done.

### 5.9 Orals
```ts
type OralsCategory = 'rules' | 'prep' | 'session';
interface OralsItem {
  id: string; category: OralsCategory; item: string; owner: string | null; minutes: number | null; done: boolean; origin: 'ai' | 'user' | 'standard';
  sourcePage: number | null; sourcePageEnd: number | null; sourceQuote: string | null; amendment: AmendmentMark;
}
interface OralsTabProps {
  items: OralsItem[]; selectedRowId: string | null;
  onToggle: (id: string, done: boolean) => void;
  onEdit: (id: string, edit: { item?: string; owner?: string | null; minutes?: number | null }) => void;
  onAdd: (category: OralsCategory, item: string) => void; onDelete: (id: string) => void;
  onOpenRow: (id: string) => void; onOpenSource: (id: string) => void;
}
```
- Three sections: "Orals rules" (from the solicitation, each with source), "Preparation checklist" (done, owner), "Session plan" (topic, presenter = `owner`, minutes, with a total).

### 5.10 Lessons learned
```ts
interface Lesson { id: string; question: string; answer: string; author: string | null; updatedAt: string }
interface LessonsTabProps {
  lessons: Lesson[]; saveStatus: FormStatus;
  onAnswer: (id: string, answer: string) => void; onAddQuestion: (question: string) => void; onDelete: (id: string) => void;
  onExport: () => void;
}
```
- The seeded survey questions (what worked, what to change, evaluator feedback) and notes, each with a text area, "Save answer", and the author and last update.

### 5.11 Documents and bid settings
```ts
type DocStatus =
  | { state: 'processing'; queuePosition: number | null }
  | { state: 'live' }
  | { state: 'failed'; reason: string }
  | { state: 'archived' }
  | { state: 'restore_requested' }
  | { state: 'restoring' }
  | { state: 'restored'; until: string }
  | { state: 'deleted' };
type MarkingState =
  | { state: 'none' }
  | { state: 'blocked'; markings: string[]; page: number | null }
  | { state: 'confirmed'; markings: string[] };
type KeyCheck = 'not_applicable' | 'ok' | 'mismatch' | 'overridden';
interface Doc {
  id: string; name: string; kind: FileKind; amendmentNo: number | null; pages: number | null; pagesEstimated: boolean;
  sizeBytes: number; uploadedAt: string; liveUntil: string | null; status: DocStatus; marking: MarkingState; keyCheck: KeyCheck;
  amendmentNoAssumed: boolean; amendmentNoFound: number | null; needsNumber: boolean;
}
interface UploadNotice { id: string; fileName: string; tone: 'error' | 'info'; message: string }
interface UploadProgress { fileName: string; percent: number }
interface DocumentsPanelProps {
  docs: Doc[]; usedBytes: number; capMb: number; plan: Plan; isOwner: boolean; overridesLeft: number;
  notices: UploadNotice[]; uploads: UploadProgress[];
  onUpload: (files: File[], kind: FileKind, amendmentNo?: number) => void; onDismissNotice: (id: string) => void;
  onSetAmendmentNo: (id: string, amendmentNo: number) => void;
  onOpen: (id: string) => void; onDelete: (id: string) => void; onRestore: (id: string) => void;
  onConfirmMarking: (id: string) => void; onOverrideKey: (id: string, reason: string) => void; onUpgrade: () => void;
}
interface BidSettingsValues {
  name: string; agency: string; bidType: BidType; solicitationNumber: string;
  startDate: string | null; dueDate: string | null; dueTime: string | null; timeZone: string;
  oralsEnabled: boolean; keepFilesLiveUntil: string | null;
}
interface BidSettingsProps {
  bid: BidSettingsValues; plan: Plan; isOwner: boolean; filesLiveUntil: string | null;
  creditStatus: 'reserved' | 'consumed' | 'none';
  saveStatus: FormStatus; deleteStatus: FormStatus;
  onSave: (v: BidSettingsValues) => void; onDeleteBid: () => void;
}
interface DateChangePromptProps {
  open: boolean; previousDue: string; nextDue: string;
  onChoose: (mode: 'shift' | 'scale' | 'keep') => void; onCancel: () => void;
}
```
Documents:
- Header: "N MB of C MB used" with a meter (`usedBytes`, `capMb`; 50 MB on Free, 300 MB on paid), "Upgrade plan" beside it on Free when 90 % or more is used.
- Upload area: kind (Solicitation, Amendment, Attachment, Resume, Draft), drag and drop or "Choose files", and a separate "Add amendment" button. Progress per file from `uploads`. Each `notices` entry shows as an alert with its file name and message and a "Dismiss" button. The container sends the 05 s3.10 messages: over the cap with the MB left, "This file belongs to a different solicitation. Start a new bid.", "Already uploaded.", "Upload an unlocked copy."
- Table: Name, Kind, Amendment, Pages ("~N" with "Page estimated" when `pagesEstimated`), Size, Uploaded, Live until, Status, Marking, Actions. Status text: "Processing" with "Queue position N", "Live", "Failed" with the reason, "Archived", "Restore requested", "Restoring (a short wait)", "Restored until [date]", "Deleted".
- Marking prompt for a `blocked` file (uses `MarkingPrompt`, 5.12): "This file carries the marking [CUI] on page 2. AI processing is paused. Confirm the file is public or approved for third-party processing." Buttons "Confirm file is public" and "Remove file".
- `keyCheck` `mismatch` on an amendment: "The solicitation number on this amendment does not match the bid." The owner sees "Override" (dialog with a required reason and "N overrides left"); a member sees "Ask the bid owner to override." `overridden` shows "Accepted by override".
- The API's `DocumentDto` also carries `keyReason` (`mismatch`: another solicitation number was found; `not_found`: no number was found; `bid_key_pending`: the bid has no solicitation number yet, and the amendment is rechecked when one is saved in Bid settings; null otherwise) and `keyFound` (the number the check found, or null). They are not part of the `Doc` contract above; the container can use them in the mismatch message. A held amendment runs no AI step until it matches or the owner overrides it (04 s3.1). An override of a `bid_key_pending` amendment is refused with 409 `set_bid_number_first` ("This bid has no solicitation number yet. Set it in Bid settings instead of overriding: that is free, and the amendment is checked again automatically."); the container can offer Bid settings instead of "Override" for that reason. A bid number with no digit (a word) never matches an amendment, so its amendments always need an override.
- Amendment number (04 s3.1). Contract additions, documented here and not yet in the v0 screen: `Doc` gains `amendmentNoAssumed: boolean` (the number was taken in sequence because the file names none; show "Amd N (assumed)" with an edit control), `amendmentNoFound: number | null` (when it differs from `amendmentNo`, show "The file reads Amendment M"), and `needsNumber: boolean` (show "Set the amendment number. The number in this file is already used on this bid, or the file names two numbers." with a number field); `DocumentsPanelProps` gains `onSetAmendmentNo: (id: string, amendmentNo: number) => void`, open to every member, and `onUpload` takes an optional `amendmentNo` for "Add amendment", which gets an optional "Amendment number" field (1 to 999). The API is in place: `DocumentDto.amendmentNoSource` (`sequence` maps to `amendmentNoAssumed`), `amendmentNoFound`, and `amendmentStatus` (`needs_number` maps to `needsNumber`); upload start takes `amendmentNo` (409 `amendment_no_taken`); `PATCH /api/documents/:id/amendment-no` sets it (409 `amendment_no_taken`, `document_deleted`, `not_an_amendment`; 400 `invalid_amendment_no`).
- Actions per row: "Open" (live or restored), "Restore" (archived), "Delete" (`ConfirmDialog`: "Delete [file name]? The rows and quotes it produced stay. Its MB is freed.").

Bid settings:
- Fields: Name, Agency, Bid type (Federal or SLED), Solicitation number, Start date, Due date, Due time, Time zone (US zones), Orals (switch). "Save changes".
- "Keep files live until": a date the owner can set on paid plans, with the help "Files stay live until [filesLiveUntil] unless you extend it." Members see it read-only; Free shows it disabled with "Paid plans can keep files live longer."
- The container compares dates after `onSave`; when the due date changed it opens `DateChangePrompt`: "The due date moved from [previous] to [next]. Move the schedule with it?" Buttons "Shift dates", "Scale dates", "Keep dates", "Cancel". The Schedule port reuses this prompt.
- Amendment date changes (PR5): the Schedule tab opens the same prompt on its own from the tab payload's `pendingDateChange`, titled "Amendment N moved the due date". The answer is `adjustSchedule(bidId, { mode, amendmentId })` alone: the server sets the due date, so the web never PATCHes it first (that would make the server refuse the answer with 409 `date_change_resolved`). 409 `date_change_resolved` and 404 close the prompt and reload; other failures keep it open, and a retry is safe. When `previousDue` is null (the bid had no due date) only "Keep dates" applies. The prompt shows the amendment quote and its source link. Cancel, or opening the source, leaves a "Review date change" notice on the tab.
- Danger zone: "Delete bid" opens a dialog that names the bid, requires typing the bid name, and says what happens to the credit (`consumed`: "The RFP credit used for this bid is not returned."; `reserved`: "The reserved RFP credit is released."). It also says archive copies are deleted. Cancel has default focus.

### 5.12 Shared
```ts
type Plan = 'free' | 'starter' | 'growth';
type BidType = 'federal' | 'sled';
type Role = 'owner' | 'member';
type FileKind = 'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft';
type ReqType = 'shall' | 'must' | 'will' | 'should' | 'other';
type RowFlag = 'maybe_not_requirement' | 'page_estimated' | 'ocr' | 'quote_unverified';
type FormStatus = AuthStatus;   // { state: 'idle' } | { state: 'submitting' } | { state: 'error'; message } | { state: 'done'; message }
type AmendmentMark =
  | { kind: 'original' }
  | { kind: 'added'; amendmentNo: number }
  | { kind: 'superseded'; amendmentNo: number; replacedById: string | null }
  | { kind: 'withdrawn'; amendmentNo: number };

interface ProcessingStep { id: string; label: string; status: 'waiting' | 'running' | 'done' | 'failed'; percent: number }
interface ProcessingState { steps: ProcessingStep[]; queuePosition: number | null; etaSeconds: number | null }
interface ProcessingBannerProps { processing: ProcessingState }

interface SourceLinkProps { page: number | null; pageEnd: number | null; rowLabel: string; onOpen: () => void }
interface EmptyStateProps { title: string; text: string; action?: { label: string; onClick: () => void } }
interface LockedTabProps { tab: Tab; title: string; description: string; onUpgrade: () => void }

type TabBlock =
  | { kind: 'no_solicitation' }
  | { kind: 'failed'; reason: string }
  | { kind: 'locked'; description: string }
  | { kind: 'out_of_credits'; creditsLeft: number; creditsResetOn: string };
interface TabFrameProps {
  tab: Tab; title: string; plan: Plan;
  block: TabBlock | null;                 // replaces the content
  processing: ProcessingState | null;     // banner above the content
  waiting: React.ReactNode;               // MarkingPrompt and AmendmentConfirm, or null
  overCap: { usedBytes: number; capMb: number } | null;
  draftNotice: boolean;
  onUploadSolicitation: () => void; onRetry: () => void; onUpgrade: () => void;
  children: React.ReactNode;
}

interface MarkingPromptProps {
  fileName: string; markings: string[]; page: number | null; busy: boolean;
  onConfirm: () => void; onRemoveFile: () => void;
}
interface AmendmentSide { rowId: string; label: string; text: string; sourcePage: number | null }
interface AmendmentProposal {
  id: string; amendmentNo: number; action: 'supersede' | 'withdraw' | 'add'; confidence: number | null;
  oldRow: AmendmentSide | null; newRow: AmendmentSide | null;
}
interface AmendmentConfirmProps {
  proposals: AmendmentProposal[]; busyIds: string[];
  onConfirm: (id: string) => void; onReject: (id: string) => void; onOpenSource: (rowId: string) => void;
}

type UpgradeReason = 'locked_tab' | 'out_of_credits' | 'over_cap' | 'seats' | 'plan';
interface UpgradeDialogProps {
  open: boolean; reason: UpgradeReason; plan: Plan; creditsLeft: number; creditsResetOn: string;
  onChoosePlan: (p: 'starter' | 'growth') => void; onClose: () => void;
}
interface ConfirmDialogProps {
  open: boolean; title: string; body: string; confirmLabel: string;
  typeToConfirm: string | null;           // when set, the confirm button stays disabled until this text is typed
  busy: boolean; onConfirm: () => void; onCancel: () => void;
}
```
- `TabFrame` draws the 05 s4 states: `no_solicitation` ("No solicitation yet" and "Upload solicitation"), `failed` (the plain reason and "Try again"; never raw error text), `locked` (`LockedTab`), `out_of_credits` (credits left, reset date, "Upgrade plan"). `processing` shows `ProcessingBanner` above the content (the content still renders). `waiting` renders under a "Needs you" heading above the content. `overCap` shows "N MB of C MB used. New files cannot be added." with "Upgrade plan" on Free. `draftNotice` shows "Draft. Review every row before you rely on it."
- `ProcessingBanner`: one line per step with its label, status, and a progress bar; "Queue position N" when queued; "Usually about N minutes" from `etaSeconds`, or nothing when null. Live region, polite.
- `SourceLink`: "p. 12" or "pp. 12–13"; accessible name "Open source for [rowLabel], page 12". With `page` null it renders the muted text "No source".
- `LockedTab`: tab title, "[Tab] is on a paid plan", the description, a static sample (a small mock table or list for that tab, marked "Sample" and hidden from screen readers), and "Upgrade plan".
- `MarkingPrompt`: "This file carries the marking [marking] on page [page]. AI processing is paused. Confirm the file is public or approved for third-party processing." Buttons "Confirm file is public" and "Remove file". With `page` null, "on page N" is left out.
- `AmendmentConfirm`: heading "Confirm amendment changes", the line "Until you confirm, the old row stays active.", and one card per proposal: "Amd N" and the action ("Replaces", "Withdraws", "Adds"), the old row beside the new row (stacked below 640 px), confidence as a percent, and "Confirm" and "Reject".
- Amendment links in the API (`AmendmentLinkDto`, 04 s3.1): every link carries `sourcePage` and `sourceQuote`, the amendment text behind a supersede or withdraw (null on adds). Only supersede and withdraw are ever proposed; an add is always applied, so the container never builds an "Adds" proposal. Decisions are final: confirm and reject answer the decision and `amendmentStatus`; the other decision on a decided link is 409 `link_already_decided`; confirm is 409 `row_already_closed` when the old row was already closed and `new_row_missing` when the replacing row was removed (the container drops the card and reloads). `AmendmentProposal` may gain `sourcePage` and `sourceQuote` in a later v0 round; not built yet.
- `AmendmentMark` mapping (container, `features/compliance/amendment-mark.ts`): `superseded` takes `changedByAmendment` and `replacedById` = `supersededByRowId` when that row is still listed (else null); `withdrawn` takes `changedByAmendment`; `amendmentNo` above 0 is `added`; anything else, including a closed row with no recorded amendment, is `original`.
- `UpgradeDialog`: the reason as the first line ("Outline is on a paid plan.", "You have 0 RFP credits left. They reset on [date].", "This bid is at its file cap.", "Your plan's seats are full."), then Starter and Growth side by side with 06 s3's allowances (RFPs per period, MB per bid, users, tabs, file retention), the current plan marked, and "Choose Starter" or "Choose Growth". No prices; the line "The price is shown at checkout."
- `ConfirmDialog`: built on alert-dialog; the title names the item; Cancel has default focus.

### 5.13 Auth: log in, sign up, verify, reset
```ts
type AuthStatus =
  | { state: 'idle' }
  | { state: 'submitting' }
  | { state: 'error'; message: string }
  | { state: 'done'; message: string };
interface AuthLayoutProps { title: string; children: React.ReactNode }
interface LogInProps { status: AuthStatus; onLogIn: (email: string, password: string) => void; onForgotPassword: () => void; onSignUp: () => void }
interface SignUpValues { email: string; name: string; password: string; phone: string }
interface SignUpProps { status: AuthStatus; onSignUp: (v: SignUpValues) => void; onLogIn: () => void; onOpenPrivacy: () => void }
interface VerifyProps {
  email: string; phone: string; step: 'email' | 'phone' | 'done'; status: AuthStatus;
  onSubmitCode: (code: string) => void; onResendEmail: () => void; onResendCode: () => void; onLogIn: () => void;
}
interface ResetRequestProps { status: AuthStatus; onRequest: (email: string) => void; onLogIn: () => void }
interface ResetPasswordProps { status: AuthStatus; onSetPassword: (password: string) => void; onLogIn: () => void }
```
The email link lands on the app with a token; the container verifies it and moves `VerifyProps.step` to `'phone'`. Error text comes from the API and is shown as given. Rules the forms check before calling back: work email, password at least 12 characters, phone `+1` and 10 digits, SMS code 6 digits.

### 5.14 Organization
```ts
interface OrgMember { userId: string; name: string; email: string; role: Role; isYou: boolean }
interface OrgCredits { allowed: number; used: number; reserved: number; periodStart: string; periodEnd: string }
interface ProcessingInfo { provider: string; model: string; subprocessors: string[] }
interface OrganizationPageProps {
  org: { name: string; plan: Plan; planStatus: 'active' | 'past_due' | 'free' } | null;   // null: no organization yet
  role: Role; members: OrgMember[]; seatLimit: number; credits: OrgCredits | null; mbCap: number;
  processing: ProcessingInfo | null; billingAvailable: boolean;
  createStatus: FormStatus; inviteStatus: FormStatus;
  onCreateOrg: (name: string) => void; onInvite: (email: string) => void; onRemoveMember: (userId: string) => void;
  onOpenBilling: () => void; onUpgrade: () => void; onOpenPrivacy: () => void;
}
```
- `org` null: "Create your organization" with Organization name and "Create organization".
- Plan: plan name, `past_due` warning "Your last payment failed. Stripe is retrying; paid features stay on.", "Credits used this period: U of A" (and "R reserved" when above 0), "Resets on [periodEnd]", files per bid (`mbCap`), "Manage billing" (owner only; disabled with "Billing opens when Stripe is connected." when `billingAvailable` is false), "Upgrade plan" on Free.
- Members: table of name, email, role ("You" marker); "Invite member" (work email) with "N of S seats used" (blocked with an upgrade message when full); owners see "Remove" on other members (`ConfirmDialog`, naming the member).
- Data and AI: "AI model: [model]", "Provider: [provider]", the subprocessor list, and "Read the privacy summary".

### 5.15 Account
```ts
interface AccountPageProps {
  name: string; email: string; phone: string;
  profileStatus: FormStatus; passwordStatus: FormStatus;
  onSaveName: (name: string) => void; onChangePassword: (currentPassword: string, newPassword: string) => void;
}
```
- Profile: Name (editable, "Save name"), Work email and Phone shown read-only with "To change your email or phone, contact support."
- Password: Current password, New password (12 characters or more, show/hide), "Change password". Validation as in 5.13.

### 5.16 Privacy summary
```ts
interface PrivacyPageProps { processing: ProcessingInfo | null; policyUrl: string | null; onBack: () => void }
```
- A readable page (max about 70 characters per line) that works inside the shell and on its own (Sign up links to it). Sections and content from 07: what you may upload (no CUI, classified, or export-controlled data; the marking check); AI processing (the model and provider from `processing`, and the plain statement that a China-origin model may process documents if it is the one in use); who can access the server (support staff and administrators in India can technically access it; support access to your documents needs your written approval); how long data is kept (07 s2 table in plain words, with "To be confirmed" where 07 is open); deletion and backups; subprocessors. "Read the full Privacy Policy" when `policyUrl` is set, otherwise "The full Privacy Policy will be published before launch."

### 5.17 Row detail slider
```ts
type RowKind = 'bid_fact' | 'schedule' | 'compliance' | 'outline' | 'requirement' | 'finding' | 'production' | 'orals';
interface RowDetailData {
  id: string; kind: RowKind; title: string;
  sourceQuote: string | null; sectionRef: string | null; documentName: string | null;
  sourcePage: number | null; sourcePageEnd: number | null; amendment: AmendmentMark;
  reqType: ReqType | null; instrRef: string | null; evalRef: string | null;
  confidence: number | null;               // 0 to 1
  flags: RowFlag[]; quoteVerified: boolean | null; confirmed: boolean | null;
  owner: string | null; status: string | null; origin: 'ai' | 'user' | null;
}
interface RowEditField {
  key: string; label: string; kind: 'text' | 'longtext' | 'select' | 'number' | 'date';
  value: string; options: { value: string; label: string }[] | null;
}
interface RowHistoryEntry { id: string; who: string; field: string; from: string | null; to: string | null; at: string }
interface RowDetailProps {
  open: boolean; row: RowDetailData | null;   // null while loading
  history: RowHistoryEntry[]; federal: boolean; editFields: RowEditField[]; saveStatus: FormStatus;
  onOpenSource: () => void; onSave: (values: Record<string, string>) => void;
  onJumpToRow: (id: string) => void; onClose: () => void;
}
```
- Fields in the 05 s3.12 order; a field whose value is null is hidden. Verbatim source text in a quote block exactly as given (whitespace kept). Page "12" or "12–13". Amendment "Original" or "Amd N", with "Superseded by Amd N" as a jump button. Refs labelled "L ref" and "M factor" when `federal`. Confidence as a percent. Verified "Yes" or "No". Origin "AI" or "User". Edit history: who changed which field, from, to, and when.
- Buttons: "Open source", "Edit" (turns `editFields` into a form with "Save changes" and "Cancel"), "Close". Esc closes. Focus moves into the slider on open; the container returns it to the row.
- Skeleton while `row` is null. Rendered inside `AppShellProps.detail`: a column of about 420 px at 1,024 px and wider, full width below.

### 5.18 Source viewer
```ts
interface PageText { pageNo: number; text: string }
type SourceView =
  | { mode: 'loading' }
  | { mode: 'page'; pageView: React.ReactNode }                // the container renders the PDF page(s) with the quote highlighted
  | { mode: 'text'; pages: PageText[] }                        // Word file that could not be converted: "Page estimated"
  | { mode: 'archived'; pages: PageText[]; restore: 'none' | 'requested' | 'restoring' }
  | { mode: 'resume_deleted' }
  | { mode: 'error'; message: string };
interface SourceViewerProps {
  open: boolean; fileName: string; page: number; pageEnd: number | null; quote: string | null;
  view: SourceView; canRestore: boolean;
  onRestore: () => void; onRetry: () => void; onClose: () => void;
}
```
- A large dialog (full screen below 640 px): header with file name and "Page 12" or "Pages 12–13", "Close".
- `page`: the stored quote above `pageView`. `text`: the page text with the quote marked (`<mark>`, matched ignoring case and runs of whitespace) and the label "Page estimated". `archived`: "This file is archived. The stored quote and page text are shown." with the marked page text and "Restore file" (or "Restore requested" / "Restoring (a short wait)"). `resume_deleted`: "Resume deleted after 90 days". `error`: the message and "Try again".
- The viewing token and its quiet renewal are the container's job; the ui never sees a URL.

### 5.19 API gaps (container supplies until the API adds them)
- Upload refusals arrive as API errors; the container maps them to the 05 s3.10 messages (5.2, 5.11).
- Retention and restore: no worker archives files at their live-until date or moves a restore from `restore_requested` through `restoring` to `restored`, so documents stay in the state the API set (07 s2, 5.11).

### 5.20 Invite accept and seat locked (built in the repo, not by v0)
These two screens are hand-built in `apps/web/src/features/membership/ui/` with shadcn/ui and Tailwind, not integrated from `design/v0/`. They take props and report actions through callbacks, and render outside `.app-shell`. A v0 re-integration never touches them.
```ts
type InviteFailure = 'invalid' | 'expired' | 'used' | 'email_mismatch' | 'already_in_org' | 'seats_full' | 'other';
type InviteStep =
  | { kind: 'enter_code' } | { kind: 'signed_out' } | { kind: 'ready'; email: string }
  | { kind: 'joined'; orgName: string } | { kind: 'failed'; reason: InviteFailure; message: string };
interface AcceptInviteProps {
  step: InviteStep; submitting: boolean;
  onSubmitCode(code: string): void; onAccept(): void; onSignUp(): void; onLogIn(): void;
  onSignOut(): void; onRetry(): void; onContinue(): void; onDismiss(): void;
}
interface SeatLockedProps { email: string; message: string; checking: boolean; onCheckAgain(): void; onSignOut(): void }
```
- `AcceptInvite` ("Join your team"), route `#/invite[?token=<code>]`, open to signed-in and signed-out people. `enter_code`: "Invite code" field, checked for shape before `onSubmitCode` (an uppercase org id is lowercased; the error is an alert). `signed_out`: "Create account" and "Log in". `ready`: "You are signed in as [email].", "Join organization" (the person always clicks; landing never joins) and "Not now". `joined`: "You joined [org]." and "Open Shaavir PD". `failed`: the API's message in an alert, with "Try again" (`seats_full`, `other`: an account load that failed loads again) or "Sign out and use another account" (`email_mismatch`), each with "Not now"; a final refusal (`invalid`, `expired`, `used`, `already_in_org`) shows "Open Shaavir PD". "Not now" (`onDismiss`) drops the kept code and opens `#/bids`.
- The invite code is `<orgId>.<token>`. The container keeps it in `localStorage` (`pd-pending-invite`, 7 days) across sign-up and log in, strips it from the address bar, clears it on success and on final refusals, and keeps it for `email_mismatch`, `seats_full` and other errors until "Not now". After log in the app returns to `#/invite` while a code is waiting; a signed-in person with no organization is sent there at most once per browser session (`sessionStorage` `pd-invite-redirected`).
- `SeatLocked` ("You have no seat right now"): shown full page, without the shell navigation, for a member whose plan has no seat (403 `seat_locked`). Shows the API's message, "Signed in as [email].", a line on what to do, "Check again" ("Checking...") and "Sign out". No organization switch: an account belongs to one organization.

## 6. Order of v0 chats

The copy-paste prompt for each chat is in `docs/v0-prompts.md`.

| # | Chat | Folder(s) | Contracts |
|---|---|---|---|
| 1 | Shell: AppShell (sidebar, top bar), UpgradeDialog, ConfirmDialog | `design/v0/shell/` | 5.1, 5.12 |
| 2 | Tab states and shared pieces: TabFrame, LockedTab, ProcessingBanner, EmptyState, SourceLink, MarkingPrompt, AmendmentConfirm | `design/v0/common/` | 5.12 |
| 3 | Bids list and New bid (update of the existing v0 build) | `design/v0/bids/` | 5.2 |
| 4 | Compliance matrix, Row detail slider, Source viewer. The free tier's hook; spend the most time here | `design/v0/compliance/` | 5.4, 5.17, 5.18 |
| 5 | Overview and kickoff | `design/v0/overview/` | 5.3 |
| 6 | Documents, Bid settings, DateChangePrompt | `design/v0/documents/`, `design/v0/settings/` | 5.11 |
| 7 | Organization, Account, Privacy summary | `design/v0/organization/`, `design/v0/account/`, `design/v0/privacy/` | 5.14, 5.15, 5.16 |
| 8 | Outline | `design/v0/outline/` | 5.5 |
| 9 | Resume matrix | `design/v0/resumes/` | 5.6 |
| 10 | Color team reviews | `design/v0/reviews/` | 5.7 |
| 11 | Production and Orals | `design/v0/production/`, `design/v0/orals/` | 5.8, 5.9 |
| 12 | Lessons learned | `design/v0/lessons/` | 5.10 |

Chats 1 and 2 come first because every later screen uses their types and pieces; after they are integrated, the 5.12 types live in `@/types`. Chats 8 to 12 are the paid tabs in Phase 4 order.

Auth (5.13) is done (`design/v0/auth/`, integrated).

The Schedule tab is not a v0 chat. Claude Code ports it from the offline builder into `src/schedule/`.

Each chat ends the same way: v0 pushes to the `v0-ui` branch, you merge it to `master` (the folder cannot break the build), then you ask Claude Code to integrate that screen.

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
| 14 Oct 2026 | Auth screens (log in, sign up, verify, reset) rebuilt by v0 under contract 5.13 |
| 14 Oct 2026 | Tailwind v4 CSS-first (no `tailwind.config.ts`), React 19, sonner replaces toast, label added, preflight off until legacy screens retire; plans live only in `docs/plans`; `AGENTS.md` for v0 |
| 14 Oct 2026 | 5.2 bids contract: `creditsResetOn`, `plan`, `mbCap`, `onUpgrade`, and `bidType` in `onCreate` are adopted, plus `status: FormStatus` on New bid. The earlier "no" is overridden because 05 s2 requires bid type and showing the credit rule and MB cap before upload, and 05 s4 requires reset date and upgrade for out of credits; v0's existing build already matches this shape |
| 14 Oct 2026 | Contracts added for Organization (5.14), Account (5.15), Privacy summary (5.16), Row detail slider (5.17), Source viewer (5.18), and in 5.12: TabFrame for the 05 s4 states, UpgradeDialog, ConfirmDialog, MarkingPrompt, AmendmentConfirm |
| 14 Oct 2026 | 5.1 shell: works outside a bid (`bid` null, `activePage`), carries the row detail slider as a `detail` column, tab signals, and the responsive rules |
| 14 Oct 2026 | Shared `AmendmentMark` drives amendment display in every source-bearing tab; 5.4 gains the amendment, flagged, and hide-closed filters, jump to the replacing row, and `onSplitRow(id, at)` to match the API's split at a character index |
| 14 Oct 2026 | Tabs no longer take `processing`; `TabFrame` draws processing, waiting, failed, locked, out of credits, no solicitation, and over cap. Empty results stay inside each tab |
| 14 Oct 2026 | `ProcessingState` reshaped to steps, queue position, and expected wait; `SourceLinkProps` reshaped to open by row (`onOpen()`), because page and quote alone cannot name the document. Neither was used by an integrated screen |
| 14 Oct 2026 | Containers filter and derive lists; ui components render what they get. Missing values are typed as null, not as optional props |
| 14 Oct 2026 | Account: email and phone are read-only in v1 (support changes them); password change asks for the current password |
| 14 Oct 2026 | Source viewer: the container renders the PDF page with the highlight (`pageView`); v0 builds the frame and the text, archived, and deleted modes |
| 14 Oct 2026 | Order of v0 chats set to 12 chats (s6); prompts in `docs/v0-prompts.md`; API gaps listed in 5.19 |
| 15 Oct 2026 | 5.19 trimmed: Members, Billing, Processing, Documents, Bids, Compliance, Outline, Resumes, Reviews, Production and Orals, Row history, Amendment links, and Account are in the API. Open: the worker amendment key check, seats after a move to free, the retention and restore worker |
| 15 Oct 2026 | Worker amendment key check built (04 s3.1): removed from 5.19; 5.11 notes `DocumentDto.keyReason` and `keyFound` (API and web types only, not the v0 `Doc` contract) |
| 15 Oct 2026 | 5.11: override of a `bid_key_pending` amendment refused with `set_bid_number_first`; a bid number with no digit never matches |
| 15 Oct 2026 | 5.11: amendment number contract additions documented (`amendmentNoAssumed`, `amendmentNoFound`, `needsNumber`, `onSetAmendmentNo`, number field on "Add amendment"); API and web types done, UI not built yet |
| 15 Oct 2026 | 5.12: amendment links carry `sourcePage` and `sourceQuote`; adds are never proposed; decisions final with 409 codes; `AmendmentMark` container mapping written (no "Amd 0" fallback) |
| 16 Oct 2026 | Seats after a move to free enforced by the API (06 s5): removed from 5.19. A member past the plan's seats gets 403 `seat_locked` on every org route; `GET /api/org/members` returns `seatLocked` per member (API and web types only, UI not built yet: 5.14, `UpgradeDialog`) |
| 16 Oct 2026 | Overview and Schedule show the amendment proposals from their tab payloads ("Changes from amendments"), with Insert (`confirmAmendmentLink`) and Dismiss (`rejectAmendmentLink`) by link id and a source control on every AI row; the web words `row_already_closed` and `new_row_missing` itself, because the API's text says "Reject" |
| 16 Oct 2026 | Amendment cards and "Needs you" tab signals count compliance links only; fact and date proposals belong to Overview and Schedule |
| 16 Oct 2026 | Until v0's Overview is integrated, `features/overview` renders the proposals panel (Tailwind, outside `.app-shell`) above the legacy Overview in a LegacyFrame, with no TabFrame (the legacy screen draws its own banners) |
| 16 Oct 2026 | The legacy Documents list shows an amendment's tabs status in its Status cell ("Updating bid facts and dates", or "did not update" with Retry), with legacy classes only, until v0's Documents is integrated |
| 16 Oct 2026 | 5.20 added: the invite-accept and seat-locked screens are built in `features/membership/ui` (shadcn + Tailwind, not by v0). The "UI not built yet" note on seats (16 Oct) is done for the seat-locked member's own screen |
| 16 Oct 2026 | 5.20 review fixes: `onDismiss` ("Not now") on `ready` and on kept-code failures; `other` offers "Try again"; the no-organization redirect to `#/invite` happens at most once per browser session |
| 17 Oct 2026 | 5.11: amendment number additions added to the web `Doc` and `DocumentsPanelProps` types (`@/types`) and to the code block above; v0's panel-level shape (one number for the whole bid, no file id) is a contract error |
