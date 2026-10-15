# v0 prompts

One copy-paste prompt per v0 chat, in build order. Contracts are in `docs/plans/09-ui-workflow.md` section 5; the order is section 6.

## How to use these

1. Before chat 1, ask Claude Code to add the extra shadcn components these prompts name (alert-dialog, textarea, switch, progress, skeleton, separator) to `master`.
2. Run the chats in order, one chat per numbered prompt. Open a new v0 chat for each, paste the whole prompt (everything inside the box), and let it finish.
3. When v0 says it is done, merge `v0-ui` into `master`. Claude Code checks the fence first: the merge may touch only `design/v0/`.
4. Ask Claude Code: "Integrate `design/v0/<folder>`." It copies the screen into `apps/web/src/ui/`, moves the new types into `@/types`, builds the container, and runs type-check and tests.
5. Integrate each chat before starting the next. Chats 3 to 12 import the types and pieces that chats 1 and 2 created, from `@/types` and `@/ui/...`.
6. To change a screen later, go back to the same v0 chat, describe the change, and repeat steps 3 and 4 ("Re-integrate `design/v0/<folder>`, keep the container unchanged.").

Auth is done. The Schedule tab is not a v0 screen; Claude Code ports it.

---

## 1. Shell: AppShell, UpgradeDialog, ConfirmDialog

````text
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

SCREEN: App shell (top bar, sidebar, content area, row detail column), Upgrade dialog, Confirm dialog.

WHERE
- Folder: design/v0/shell/. Files: AppShell.tsx (with Sidebar and TopBar inside it or in their own files), UpgradeDialog.tsx, ConfirmDialog.tsx, types.ts, sample-data.ts, Preview.tsx.
- Push to branch v0-ui only. Touch nothing outside design/v0/shell/.

HOW
- Read first: AGENTS.md, design/v0/README.md, docs/plans/05-ui.md sections 1, 4 and 5, docs/plans/06-accounts-billing.md section 3 (plan table), and docs/plans/09-ui-workflow.md section 5 (the "Rules for every contract" list), 5.1 and 5.12.
- Implement 5.1 (AppShellProps), and from 5.12 UpgradeDialogProps and ConfirmDialogProps, exactly: same component names, prop names, types and callback signatures. Do not add, rename or make optional any prop. Local UI state (menu open, sheet open, typed text) is fine.
- Types: import Tab and AuthStatus from @/types. The other 5.12 types and the 5.1 types are not in @/types yet: copy OutsidePage, TabSignal, ShellBid, AppShellProps, PAID_TABS, Plan, UpgradeReason, UpgradeDialogProps, ConfirmDialogProps word for word into design/v0/shell/types.ts.
- shadcn: Button, Select, DropdownMenu, Sheet, Tooltip, Dialog, Badge from @/components/ui/<name>. Claude Code will add alert-dialog and separator with the shadcn CLI before integration; import them from @/components/ui/alert-dialog and @/components/ui/separator. Icons from lucide-react.
- Preview.tsx renders every component in every state below with sample data from sample-data.ts; callbacks log to the console.
- Accessibility (05 s5): every control reachable by keyboard with a visible focus ring; WCAG AA contrast; labels on every input; the sidebar is a nav landmark with aria-current="page" on the active tab; the top bar is a header landmark; content is main; the detail column is a complementary landmark labelled "Row detail".
- Responsive: at 1,024 px and wider the sidebar shows icons and labels; below 1,024 px icons only, each with a tooltip and an accessible name; below 640 px the sidebar is replaced by a "Menu" button in the top bar that opens the tab list in a Sheet from the left. No horizontal page scroll at 320 px. The detail column is about 420 px wide at 1,024 px and wider (the content shrinks beside it) and a full-width overlay below 1,024 px.

WHAT
Top bar (bg-ink, text-paper, 56 px):
- "Shaavir PD" wordmark.
- Inside a bid: a bid switcher (Select labelled "Bid", sr-only label is fine, listing bids by name, plus "All bids" which calls onOpenPage('bids')), then the due date and time ("Due Nov 3, 2:00 PM ET", numeric font). Outside a bid: links "Bids" and "Organization", the active one marked.
- Credits: "3 RFP credits left · resets Nov 1" (numeric font). At 0 it reads "0 RFP credits left" in a warning style with an "Upgrade plan" button calling onUpgrade. On narrow screens shorten to "3 credits".
- User menu (DropdownMenu, trigger shows the user's initials and has the accessible name "Account menu for [name]"): name and email at the top, then "Account", "Organization", "Privacy", a separator, "Sign out".
Sidebar (inside a bid only; bg-paper, border-line):
- Overview, Schedule, Compliance; a divider with the small label "Paid"; Outline, Resumes, Reviews, Production, Orals (only when oralsEnabled), Lessons; a divider; Documents, Settings. Lucide icons: LayoutDashboard, CalendarDays, ListChecks, ListTree, Users, ClipboardCheck, PackageCheck, Mic, Lightbulb, FileStack, Settings.
- On the free plan the tabs in PAID_TABS show a Lock icon after the label and their accessible name ends in "(locked)". They stay clickable and call onSelectTab.
- tabSignals: a small dot plus sr-only text after the label: processing "Processing" (today blue), waiting "Needs you" (warning), failed "Failed" (due red). In icon-only mode the dot sits on the icon and the tooltip includes the text.
Content: renders children in a main region with bg-canvas; it must give the children the full remaining width and height (the Schedule tab is a full calendar). detail: renders when not null, as described above.
Outside a bid (bid null): no sidebar; the content area is centered, max width about 1,100 px.

UpgradeDialog (Dialog):
- First line by reason: locked_tab "This tab is on a paid plan." / out_of_credits "You have N RFP credits left. They reset on [date]." / over_cap "This bid is at its file cap." / seats "Your plan's seats are full." / plan "Compare plans."
- Two cards side by side (stacked below 640 px), Starter and Growth, each listing: RFPs per period (10 / 20), files per bid (300 MB), users (5), tabs (All), files live on the server (until the later of upload + 90 days and due date + 90 days; the owner can extend). Mark the current plan with a "Current plan" badge and no button. Buttons "Choose Starter" and "Choose Growth" call onChoosePlan. Below the cards: "The price is shown at checkout." Footer button "Close".
- Show Free in a short line above the cards for comparison: "Free: 1 RFP per period (2 in the first month), 50 MB per bid, 2 users, Overview, Schedule and Compliance."

ConfirmDialog (alert-dialog):
- Title (names the item, for example "Delete RFQ 36C10B25Q0142?"), body text, then when typeToConfirm is set a labelled input "Type [typeToConfirm] to confirm" and the confirm button stays disabled until the text matches exactly. Cancel has default focus. The confirm button uses the destructive style and the confirmLabel text; busy shows a spinner and "Working…" and disables both buttons.

Preview states:
- AppShell: inside a bid on Free (locked tabs, one processing signal, one waiting signal), inside a bid on Growth with oralsEnabled and a detail column open (placeholder content), outside a bid on the Bids page, 0 credits left; each at 1,280 px, 900 px and 375 px wide frames.
- UpgradeDialog: each reason; plan free and plan starter.
- ConfirmDialog: plain, with typeToConfirm, busy.
Sample data: bids "VA EHR Support Services" (Department of Veterans Affairs, due 2026-11-03 14:00 America/New_York), "City of Austin Fleet Telematics" (SLED), "NAVSEA Logistics Support"; user Dana Reyes, dana.reyes@northbridge-gov.com.

Copy: sentence case, verb-first buttons, no exclamation marks.
When done: push to branch v0-ui only, then list the folder and the components for Claude Code to integrate.
````

---

## 2. Tab states and shared pieces

````text
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

SCREEN: Tab states and shared pieces: TabFrame, LockedTab, ProcessingBanner, EmptyState, SourceLink, MarkingPrompt, AmendmentConfirm.

WHERE
- Folder: design/v0/common/. Files: TabFrame.tsx, LockedTab.tsx, ProcessingBanner.tsx, EmptyState.tsx, SourceLink.tsx, MarkingPrompt.tsx, AmendmentConfirm.tsx, types.ts, sample-data.ts, Preview.tsx.
- Push to branch v0-ui only. Touch nothing outside design/v0/common/.

HOW
- Read first: AGENTS.md, design/v0/README.md, docs/plans/05-ui.md sections 3.3 (amendment display), 3.10 (marking prompt), 4 (states) and 5, and docs/plans/09-ui-workflow.md section 5 ("Rules for every contract") and 5.12.
- Implement these 5.12 contracts exactly: TabFrameProps, LockedTabProps, ProcessingBannerProps, EmptyStateProps, SourceLinkProps, MarkingPromptProps, AmendmentConfirmProps. Same names, props, types and callback signatures. Do not add, rename or make optional any prop.
- Types: import Tab and AuthStatus from @/types. ProcessingState and SourceLinkProps in @/types are the OLD shapes; do not use them. Copy every type in 09 section 5.12 except UpgradeReason, UpgradeDialogProps and ConfirmDialogProps word for word into design/v0/common/types.ts (Plan, BidType, Role, FileKind, ReqType, RowFlag, FormStatus, AmendmentMark, ProcessingStep, ProcessingState, ProcessingBannerProps, SourceLinkProps, EmptyStateProps, LockedTabProps, TabBlock, TabFrameProps, MarkingPromptProps, AmendmentSide, AmendmentProposal, AmendmentConfirmProps). Claude Code moves them into @/types at integration.
- shadcn: Button, Badge, Tooltip from @/components/ui/<name>. Claude Code will add progress and skeleton with the shadcn CLI before integration; import them from @/components/ui/progress and @/components/ui/skeleton. Icons from lucide-react.
- Preview.tsx renders every component in every state below with sample data; callbacks log to the console. Preview may show a fake tab table as TabFrame children.
- Accessibility (05 s5): keyboard reachable, visible focus, AA contrast; ProcessingBanner is a polite live region; failures and refusals use role="alert"; color is never the only signal (every status also has text).
- Responsive: no horizontal page scroll at 320 px; side-by-side layouts stack below 640 px.

WHAT
TabFrame (wraps every tab; the container decides the state):
- block replaces the children:
  - no_solicitation: icon, "No solicitation yet", "Upload the solicitation to fill this tab.", button "Upload solicitation" (onUploadSolicitation).
  - failed: "This step did not finish", the reason text as given (plain language from the container), button "Try again" (onRetry). Never raw error text.
  - locked: renders LockedTab with the tab, title, block.description and onUpgrade.
  - out_of_credits: "You are out of RFP credits", "N credits left. Credits reset on [date].", button "Upgrade plan".
- When block is null, from top to bottom: overCap notice (when set: "N MB of C MB used. New files cannot be added." with "Upgrade plan" when plan is free), ProcessingBanner (when processing is set), a "Needs you" section with the waiting node (when not null), the draft notice (when draftNotice: an info bar "Draft. Review every row before you rely on it."), then children.
LockedTab: the tab title as heading, "[Title] is on a paid plan", the description, a static sample of the tab (a small mock table or list drawn for that tab with 3 to 4 fake rows, a "Sample" label, aria-hidden, pointer-events none, slightly faded), and "Upgrade plan". Sample descriptions to use in Preview: outline "A volume and section tree with page budgets, writers, and due dates."; resumes "Roles and requirements beside candidate resumes, with gaps called out."; reviews "Pink, red, green, and gold team findings against the evaluation factors."; production "A submission checklist drawn from the solicitation."; orals "Orals rules, a preparation checklist, and a session plan."; lessons "A short survey after submission or award."
ProcessingBanner: heading "Processing", then one line per step: status icon (waiting circle, running spinner, done check, failed x) plus the status as text, the label, and a progress bar with the percent. "Queue position N" when queuePosition is set. "Usually about N minutes" from etaSeconds (round up to whole minutes; "Less than a minute" under 60), nothing when null. Steps labels in samples: "Virus scan", "Read the file", "Marking check", "Classify pages", "Bid facts", "Dates", "Compliance matrix".
EmptyState: icon, title, text, and the optional action button. Sample: "No items found", "Add one by hand.", "Add requirement".
SourceLink: a small link-style button "p. 12" or "pp. 12–13" (numeric font). Accessible name "Open source for [rowLabel], page 12" (or "pages 12 to 13"). With page null it renders muted text "No source" (not a button).
MarkingPrompt: a warning panel: "This file carries the marking [marking(s) joined with ', '] on page [page]. AI processing is paused. Confirm the file is public or approved for third-party processing." The file name above it. Buttons "Confirm file is public" (primary) and "Remove file" (outline, destructive text). busy disables both and shows a spinner on the pressed one. With page null, leave out "on page N".
AmendmentConfirm: heading "Confirm amendment changes", the line "Until you confirm, the old row stays active.", then one card per proposal: header "Amd N" plus the action text (supersede "Replaces", withdraw "Withdraws", add "Adds") and the confidence ("Confidence 62%", or nothing when null). Body: old row and new row side by side (stacked below 640 px), each with its label (for example "C.3.2"), its text, and a SourceLink calling onOpenSource(rowId). A withdraw has no new row: show "No replacement". An add has no old row: show "New requirement". Buttons "Confirm" and "Reject"; busyIds disables that card's buttons.

Preview states: TabFrame with each block kind, with processing (queued with position 3; running with 2 of 5 steps done), with waiting containing a MarkingPrompt and an AmendmentConfirm with 3 proposals (one of each action), with overCap on free and on starter, with draftNotice; every component on its own as well.

Copy: sentence case, verb-first buttons.
When done: push to branch v0-ui only, then list the folder and the components for Claude Code to integrate.
````

---

## 3. Bids list and New bid (update)

````text
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

SCREEN: Bids list and New bid. This is an update of the existing build in design/v0/bids/; keep its layout, styles and copy except where listed below.

WHERE
- Folder: design/v0/bids/. Files: BidsList.tsx, NewBid.tsx, OutOfCreditsMessage.tsx, format.ts, types.ts, sample-data.ts, Preview.tsx.
- Push to branch v0-ui only. Touch nothing outside design/v0/bids/.

HOW
- Read first: AGENTS.md, design/v0/README.md, docs/plans/05-ui.md sections 2 and 4, docs/plans/06-accounts-billing.md sections 3 and 4, and docs/plans/09-ui-workflow.md section 5 ("Rules for every contract") and 5.2.
- Implement 5.2 exactly: BidsListProps and NewBidProps with the same names, props, types and callback signatures. Do not add, rename or make optional any prop.
- Types: import Plan, BidType and FormStatus from @/types (added when chats 1 and 2 were integrated). Copy BidStatus, BidCard, BidsListProps and NewBidProps word for word from 5.2 into design/v0/bids/types.ts and delete the local BidType there.
- shadcn: Button, Input, Label, Select, Table, Badge, Dialog from @/components/ui/<name>; progress from @/components/ui/progress for the cap meter (replacing the hand-made bar). Icons from lucide-react.
- Preview.tsx renders every state below; callbacks log to the console.
- Accessibility and responsive rules as before: keyboard reachable, visible focus, labels on every input, the table scrolls in its own container (wrap it in a div with overflow-x-auto, role="region", aria-label="Bids", tabIndex 0), cards below 768 px, no horizontal page scroll at 320 px.

WHAT (changes)
- NewBid takes status: FormStatus. 'submitting' disables the whole form (fieldset disabled) and the submit button shows a spinner and "Creating bid…". 'error' shows the container's message as given in a role="alert" box above the buttons (samples: "This file belongs to a different solicitation. Start a new bid.", "Upload an unlocked copy.", "You are out of RFP credits."). 'done' is not shown (the container navigates away).
- Remove the NewBidForm export and the initialFiles prop; Preview can show the filled and over-cap states by rendering a Preview-only wrapper inside Preview.tsx that is not exported.
- The submit button reads "Create bid and upload". Keep "Cancel".
- Keep: the credit rule box, the MB cap meter ("Files on this bid: N MB of C MB"), the file type and over-cap notices with "Upgrade plan" on Free, the out-of-credits message and dialog, the empty state "No bids yet", the days-left and status badges.
- Dates through format.ts (Nov 3, 2026); credits line "3 RFP credits left · resets Nov 1".

Preview states: list with 3 bids (one past due, one due in 2 days, one with no due date), empty list, 0 credits (dialog open), New bid empty, filled, over cap on Free, submitting, error, out of credits.

When done: push to branch v0-ui only, then list the folder and the components for Claude Code to integrate.
````

---

## 4. Compliance matrix, Row detail slider, Source viewer

````text
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

SCREEN: Compliance matrix tab, Row detail slider, Source viewer. This is the free tier's main screen; take the time to get it right.

WHERE
- Folder: design/v0/compliance/. Files: ComplianceMatrixTab.tsx (split helpers into ComplianceFilters.tsx, SplitRowDialog.tsx, AddRequirementForm.tsx if you like), RowDetail.tsx, SourceViewer.tsx, types.ts, sample-data.ts, Preview.tsx.
- Push to branch v0-ui only. Touch nothing outside design/v0/compliance/.

HOW
- Read first: AGENTS.md, design/v0/README.md, docs/plans/05-ui.md sections 3.3, 3.12, 3.13, 4 and 5, and docs/plans/09-ui-workflow.md section 5 ("Rules for every contract"), 5.4, 5.12, 5.17 and 5.18.
- Implement ComplianceMatrixTabProps (5.4), RowDetailProps (5.17) and SourceViewerProps (5.18) exactly: same names, props, types and callback signatures. Do not add, rename or make optional any prop.
- Types: import Tab, Plan, ReqType, RowFlag, FormStatus and AmendmentMark from @/types. Copy every type in 5.4, 5.17 and 5.18 word for word into design/v0/compliance/types.ts.
- Shared pieces: import SourceLink and EmptyState from @/ui/common/<Name> and ConfirmDialog from @/ui/shell/ConfirmDialog. Do not rebuild them.
- shadcn: Button, Input, Label, Select, Checkbox, Table, Dialog, Badge, DropdownMenu, Tooltip, Sheet from @/components/ui/<name>. Claude Code will add textarea, skeleton and separator with the shadcn CLI before integration; import them from @/components/ui/<name>. Icons from lucide-react.
- Preview.tsx renders every state below with sample data; callbacks log to the console. Preview may wrap the tab in AppShell (@/ui/shell/AppShell) and TabFrame (@/ui/common/TabFrame) with RowDetail in the detail slot, to show it in context.
- Accessibility (05 s5): keyboard reachable with visible focus; the table has a caption (sr-only "Compliance matrix"); each row's ID is a button that opens the row (onOpenRow); row checkboxes are labelled "Select [reqId]"; struck-through rows also carry the text label ("Superseded", "Withdrawn"); flags have text; Esc closes the slider and the viewer.
- Responsive: the table scrolls inside its own container (overflow-x-auto, role="region", aria-label "Compliance matrix", tabIndex 0) with the ID column sticky on the left; the filter bar wraps, and below 640 px the filters move into a Sheet opened by "Filters (N)"; no horizontal page scroll at 320 px.

WHAT
ComplianceMatrixTab
- Toolbar: "Add requirement", "Merge selected" (enabled with 2 or more selected; shows the count), an Export menu ("Export XLSX", "Export CSV"), and "Showing N of M rows" (rows.length of totalRows).
- Filters (all call onFiltersChange with the whole new filters object): Section (Select from sections, plus "All sections"), Type (Shall, Must, Will, Should, Other), Status (Open, Assigned, Drafted, Done), Owner (from owners), Amendment ("Original", "Amd 1", … from amendments), checkboxes "Flagged", "Hide superseded and withdrawn", "Check these", and a labelled search input "Search requirements". "Clear filters" resets to all nulls, false, and empty search.
- Columns: select checkbox, ID, Section, Requirement, Type, Instruction ref, Evaluation factor, Response section, Owner, Status, Source, Amendment. When federal is true the two reference headers read "L ref" and "M factor".
- Requirement cell: the text (keep line breaks; clamp to 4 lines with "Show more"), then badges: flags ("May not be a requirement", "Page estimated", "OCR", "Quote not verified"), "Added by user" for origin user.
- Owner cell: Select from owners plus "Unassigned"; Status cell: Select. Both call onEditRow(id, { owner }) / ({ status }).
- Source cell: SourceLink with rowLabel = reqId, onOpen calls onOpenSource(row.id). Rows with origin user and no page show "No source".
- Amendment cell and row style by amendment.kind: original "Original"; added "Added by Amd N" badge; superseded: the whole row's text struck through and muted, the badge "Superseded", and a link-button "Superseded by Amd N" that calls onJumpToRow(replacedById) (no button when replacedById is null); withdrawn: struck through and muted, badge "Withdrawn", text "Withdrawn by Amd N", no jump.
- Row menu (DropdownMenu "Actions for [reqId]"): "Open details" (onOpenRow), "Split row" (opens a dialog with the requirement text; the user clicks between words or uses a labelled number input "Split after character" to set the point; the dialog shows the two parts; "Split row" calls onSplitRow(id, at)), "Delete row" (ConfirmDialog "Delete [reqId]?" with the requirement as body; confirm calls onDeleteRow).
- Add requirement: a Dialog with Requirement (textarea, required), Section, Type, Owner; "Add requirement" calls onAddRow.
- selectedRowId: that row has a left accent border and bg-weekend, and is scrolled into view when the prop changes.
- Check these (filters.checkThese true): the table is replaced by a list titled "Check these: sentences the pre-scan found that have no row". Each item: the sentence, its page, buttons "Add as requirement" (onPromoteCheckThese) and "Dismiss" (onDismissCheckThese). Empty: "Nothing to check."
- Empty (rows is empty and totalRows is 0): EmptyState "No requirements found", "Add one by hand.", action "Add requirement". When filters hide everything: "No rows match these filters" with "Clear filters".

RowDetail (slider; rendered by the container inside AppShell's detail slot)
- Header: row title, a close button (X, accessible name "Close row detail").
- Fields in this order, each hidden when null: Verbatim source text (a quote block, text exactly as given, whitespace preserved), Section reference, Document, Page ("12" or "12–13"), Amendment ("Original", "Added by Amd N", "Superseded by Amd N" as a button calling onJumpToRow(replacedById), "Withdrawn by Amd N"), Requirement type, Instruction and evaluation refs ("L ref" and "M factor" when federal), Confidence (percent), Flags (badges with text), Verified (quoteVerified, or confirmed for bid facts: "Yes"/"No"), Owner, Status, Origin ("AI"/"User"), then Edit history: a list of "[who] changed [field] from [from or 'empty'] to [to or 'empty']" with the date and time (Nov 3, 2026, 2:14 PM).
- Buttons at the bottom: "Open source" (onOpenSource; disabled when sourcePage is null), "Edit", "Close". Edit turns editFields into a form (text → Input, longtext → textarea, select → Select with options, number → Input type number, date → Input type date), each labelled; "Save changes" calls onSave with { [key]: value } for changed fields only, and "Cancel". saveStatus 'submitting' disables the form; 'error' shows the message; 'done' returns to view mode and shows the message briefly.
- row null: skeleton lines for the quote and 6 fields.
- Focus moves to the heading when it opens; Esc calls onClose.

SourceViewer (Dialog, max width about 960 px, full screen below 640 px)
- Header: file name, "Page 12" or "Pages 12–13", button "Close".
- view.mode:
  - loading: skeleton for a page.
  - page: the stored quote in a quote block ("Quote"), then pageView (the container's rendered page) in a scrolling area.
  - text: a "Page estimated" badge, then each page's text under "Page N", with the quote marked (<mark>, match ignoring case and runs of whitespace; if not found, show the quote above the text and the note "The quote could not be located on this page.").
  - archived: info bar "This file is archived. The stored quote and page text are shown." plus a button by restore: none "Restore file" (only when canRestore; otherwise "Ask the bid owner to restore this file."), requested "Restore requested" (disabled), restoring "Restoring (a short wait)" with a spinner. Then the marked page text as in text mode.
  - resume_deleted: "Resume deleted after 90 days" and "The quote and page text were deleted with the resume."
  - error: the message and "Try again" (onRetry).

Preview states: federal bid with 12 rows covering every amendment kind, every flag, a user row, and a selected row; SLED labels; filters active with "Showing 4 of 12 rows"; check these list; empty; no matches; split dialog; add dialog; RowDetail for a compliance row (all fields), a bid fact (few fields), loading, edit mode with error; SourceViewer in every mode (use a grey box with "PDF page 12" as the pageView sample).
Sample rows from a federal RFP (Section L/M), e.g. "L.4.2 The offeror shall submit a technical volume not to exceed 30 pages." and "C.3.2 The contractor shall provide Tier 2 help desk support 24 hours a day."

Copy: sentence case, verb-first buttons.
When done: push to branch v0-ui only, then list the folder and the components for Claude Code to integrate.
````

---

## 5. Overview and kickoff

````text
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

SCREEN: Overview and kickoff tab.

WHERE
- Folder: design/v0/overview/. Files: OverviewTab.tsx, types.ts, sample-data.ts, Preview.tsx.
- Push to branch v0-ui only. Touch nothing outside design/v0/overview/.

HOW
- Read first: AGENTS.md, design/v0/README.md, docs/plans/05-ui.md sections 3.1, 4 and 5, and docs/plans/09-ui-workflow.md section 5 ("Rules for every contract"), 5.3 and 5.12.
- Implement OverviewTabProps (5.3) exactly: same names, props, types and callback signatures. Do not add, rename or make optional any prop.
- Types: import AmendmentMark from @/types. Copy BidFact, KickoffItem, Countdown and OverviewTabProps word for word from 5.3 into design/v0/overview/types.ts.
- Shared pieces: import SourceLink and EmptyState from @/ui/common/<Name>. Do not rebuild them.
- shadcn: Button, Input, Label, Checkbox, Table, Badge, Dialog from @/components/ui/<name>. Icons from lucide-react.
- Preview.tsx renders every state below; callbacks log to the console.
- Accessibility (05 s5): keyboard reachable, visible focus, labels on every input (checkboxes labelled "Confirm [field]" and "Done: [label]"), struck rows also carry the text "Superseded".
- Responsive: the facts table scrolls in its own container (role="region", aria-label "Bid facts", tabIndex 0); the countdown and checklist stack under the facts below 1,024 px; no horizontal page scroll at 320 px.

WHAT
- Countdown card at the top: big numerals "12 days" and "8 workdays" (font-numeric), "Due Tue, Nov 3, 2026 at 2:00 PM ET". 0 days: "Due today" in warning. Below 0: "Past due" in due red. countdown null: "Set the due date in Settings."
- Bid facts table: Field, Value, Source, Confirmed. Value is editable: an "Edit" icon button per row (accessible name "Edit [field]") turns it into an input with "Save" and "Cancel"; Save calls onEditFact. Field is a button that calls onOpenRow. Source is a SourceLink (rowLabel = field) calling onOpenSource(id). Confirmed is a checkbox calling onConfirmFact. A fact with origin user shows "Added by user".
- Amendment display: superseded facts stay in place, value struck through and muted, with the badge "Superseded" and the button "Superseded by Amd N" calling onJumpToRow(replacedById); added facts show "Added by Amd N".
- "Add fact": a small form with Field and Value; "Add fact" calls onAddFact.
- Kickoff checklist: each item with a Done checkbox, the label, an Owner input (saves on blur and Enter via onSetKickoffOwner), and the note in muted text. "N of M done" above the list. "Add item" form (Label; "Add item" calls onAddKickoff).
- selectedRowId highlights and scrolls to that fact.
- Empty facts: EmptyState "No bid facts found", "Add one by hand.", action "Add fact".

Preview states: a federal bid with 10 facts (Solicitation number, Agency, Due date, Due time, Questions due, Page limit, Submission portal, Set-aside, NAICS, Period of performance), two superseded by Amd 1 with their replacements, one added by Amd 1, one user fact; 7 kickoff items (Assign roles, Agree the schedule, Name the compliance matrix owner, Set page budgets, Send data calls, Set review dates, Hold the kickoff meeting) some done; countdown 12 days, 0 days, past due, null; empty facts.

Copy: sentence case, verb-first buttons.
When done: push to branch v0-ui only, then list the folder and the components for Claude Code to integrate.
````

---

## 6. Documents, Bid settings, Date change prompt

````text
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

SCREEN: Documents tab, Bid settings tab, and the Date change prompt.

WHERE
- Folders: design/v0/documents/ (DocumentsPanel.tsx, OverrideKeyDialog.tsx if you split it, types.ts, sample-data.ts, Preview.tsx) and design/v0/settings/ (BidSettings.tsx, DateChangePrompt.tsx, types.ts, sample-data.ts, Preview.tsx).
- Push to branch v0-ui only. Touch nothing outside these two folders.

HOW
- Read first: AGENTS.md, design/v0/README.md, docs/plans/05-ui.md sections 3.10, 3.11, 4 and 5, docs/plans/06-accounts-billing.md sections 3 and 4, docs/plans/07-security-privacy.md sections 2 and 3, and docs/plans/09-ui-workflow.md section 5 ("Rules for every contract"), 5.11 and 5.12.
- Implement DocumentsPanelProps, BidSettingsProps and DateChangePromptProps (5.11) exactly: same names, props, types and callback signatures. Do not add, rename or make optional any prop.
- Types: import Plan, BidType, FileKind and FormStatus from @/types. Copy DocStatus, MarkingState, KeyCheck, Doc, UploadNotice, UploadProgress and DocumentsPanelProps into design/v0/documents/types.ts, and BidSettingsValues, BidSettingsProps and DateChangePromptProps into design/v0/settings/types.ts, word for word from 5.11.
- Shared pieces: import MarkingPrompt and EmptyState from @/ui/common/<Name>, ConfirmDialog from @/ui/shell/ConfirmDialog. Do not rebuild them.
- shadcn: Button, Input, Label, Select, Table, Dialog, Badge, DropdownMenu, Tooltip from @/components/ui/<name>. Claude Code will add progress, switch, textarea, alert-dialog and separator with the shadcn CLI before integration; import them from @/components/ui/<name>. Icons from lucide-react.
- Preview.tsx in each folder renders every state below; callbacks log to the console.
- Accessibility (05 s5): keyboard reachable, visible focus, labels on every input, the drop zone also has a "Choose files" button, notices use role="alert", destructive dialogs name the item and focus Cancel.
- Responsive: the documents table scrolls in its own container (role="region", aria-label "Files on this bid", tabIndex 0) with the Name column sticky; below 768 px each file becomes a card; the settings form is one column below 640 px; no horizontal page scroll at 320 px.

WHAT
DocumentsPanel
- Header: "Documents", "124 MB of 300 MB used" (font-numeric; usedBytes shown in MB with one decimal under 10 MB) with a progress meter labelled "Space used on this bid"; at 90 % or more the meter uses the warning color, and on Free an "Upgrade plan" button sits beside it. Under it, muted: "All files on the bid count. Free bids hold 50 MB; Starter and Growth bids hold 300 MB."
- Upload: a Kind select (Solicitation, Amendment, Attachment, Resume, Draft), a drop zone ("Drag files here" with "Choose files"; PDF, DOCX, XLSX), and a separate button "Add amendment" (opens the file picker and calls onUpload(files, 'amendment')). The standing note: "Do not upload CUI, classified, or export-controlled material."
- uploads: one row per file with name and a progress bar.
- notices: each as an alert with the file name, the message as given, and "Dismiss" (onDismissNotice). tone info is neutral, tone error is due red.
- Table columns: Name, Kind, Amendment ("Amd N" or "—"), Pages ("40", or "~40" with a "Page estimated" tooltip), Size, Uploaded, Live until, Status, Marking, Actions.
- Status text by status.state: processing "Processing" with "Queue position N" (spinner); live "Live"; failed "Failed" plus the reason; archived "Archived"; restore_requested "Restore requested"; restoring "Restoring (a short wait)"; restored "Restored until Nov 20"; deleted "Deleted" (for resumes: "Deleted after 90 days").
- Marking column: none "—"; blocked "Paused: [markings]" in warning with the MarkingPrompt shown in a highlighted row under the file (onConfirm → onConfirmMarking(id), onRemoveFile → onDelete(id)); confirmed "Confirmed public".
- keyCheck: mismatch on an amendment shows under the name "The solicitation number on this amendment does not match the bid." For isOwner, a button "Override" opens a dialog: title "Accept this amendment anyway?", text "Use this when the amendment leaves out the solicitation number. Your reason is logged.", "N overrides left on this bid" (font-numeric), a required Reason textarea, buttons "Cancel" and "Accept amendment" (disabled until a reason is entered and when overridesLeft is 0; at 0 show "No overrides left. Start a new bid for this file."). Members see "Ask the bid owner to override." overridden shows "Accepted by override".
- Actions: "Open" (live or restored), "Restore" (archived; onRestore), "Delete" (ConfirmDialog: title "Delete [file name]?", body "The rows and quotes this file produced stay. Its MB is freed.", confirm "Delete file").
- Empty: EmptyState "No files yet", "Upload the solicitation to start.", action "Choose files".

BidSettings
- Form with labelled fields: Name, Agency, Bid type (Federal, SLED), Solicitation number, Start date, Due date (Input type date), Due time (Input type time), Time zone (Select: Eastern, Central, Mountain, Pacific, Alaska, Hawaii as America/New_York, America/Chicago, America/Denver, America/Los_Angeles, America/Anchorage, Pacific/Honolulu), Orals (switch "Show the Orals tab"). The help under the dates: "Changing the due date asks how to move the schedule."
- Keep files live until: on paid plans for the owner, a date input with the help "Files stay live until [filesLiveUntil, formatted] unless you extend it. After that they move to the archive." Members see the date read-only with "Only the bid owner can change this." On Free the field is shown disabled with the help "Paid plans can keep files live longer."
- "Save changes" calls onSave with the whole values object; saveStatus 'submitting' disables the form, 'error' shows the message, 'done' shows "Saved." briefly. "Discard changes" resets the form.
- Danger zone (a bordered section at the bottom, due red heading "Delete this bid"): text "This deletes the bid, its files, its archive copies, and every tab." plus the credit sentence by creditStatus (consumed "The RFP credit used for this bid is not returned."; reserved "The reserved RFP credit is released."; none nothing). Button "Delete bid" opens ConfirmDialog with title "Delete [bid name]?", typeToConfirm = the bid name, confirm "Delete bid"; confirm calls onDeleteBid. deleteStatus 'submitting' → busy; 'error' shows the message.

DateChangePrompt (Dialog)
- Title "The due date moved". Text "The due date moved from Tue, Nov 3 to Fri, Nov 13. How should the schedule change?" Three choices as buttons with a one-line explanation each: "Shift dates" (move every unlocked activity by the same number of days), "Scale dates" (stretch or shrink the unlocked activities to fit the new window), "Keep dates" (leave the activities where they are). "Cancel" has default focus and calls onCancel.

Preview states: documents on Starter with 7 files covering every status, one blocked marking, one amendment with a key mismatch as owner and as member, notices (one of each refusal message and "Already uploaded."), uploads in progress, near the cap on Free, empty; overrides dialog with 2 left and 0 left. Settings as owner on Growth, as member, on Free, saving, error, delete dialog. DateChangePrompt open.

Copy: sentence case, verb-first buttons.
When done: push to branch v0-ui only, then list the folders and the components for Claude Code to integrate.
````

---

## 7. Organization, Account, Privacy summary

````text
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

SCREEN: Organization page, Account page, Privacy summary page. All three sit outside a bid (AppShell with bid null renders them as children; the Privacy page must also work on its own with no shell, because Sign up links to it).

WHERE
- Folders: design/v0/organization/ (OrganizationPage.tsx, types.ts, sample-data.ts, Preview.tsx), design/v0/account/ (AccountPage.tsx, types.ts, sample-data.ts, Preview.tsx), design/v0/privacy/ (PrivacyPage.tsx, types.ts, sample-data.ts, Preview.tsx).
- Push to branch v0-ui only. Touch nothing outside these three folders.

HOW
- Read first: AGENTS.md, design/v0/README.md, docs/plans/05-ui.md sections 2 and 5, docs/plans/06-accounts-billing.md sections 2, 3 and 5, docs/plans/07-security-privacy.md sections 2, 3 and 4, and docs/plans/09-ui-workflow.md section 5 ("Rules for every contract"), 5.13 (form rules), 5.14, 5.15 and 5.16.
- Implement OrganizationPageProps (5.14), AccountPageProps (5.15) and PrivacyPageProps (5.16) exactly: same names, props, types and callback signatures. Do not add, rename or make optional any prop.
- Types: import Plan, Role and FormStatus from @/types. Copy OrgMember, OrgCredits, ProcessingInfo and OrganizationPageProps into design/v0/organization/types.ts; AccountPageProps into design/v0/account/types.ts; ProcessingInfo and PrivacyPageProps into design/v0/privacy/types.ts; word for word.
- Shared pieces: import ConfirmDialog from @/ui/shell/ConfirmDialog. Reuse the look of the auth forms in apps/web/src/ui/auth (field layout, error text under fields, status banner, password show/hide) but do not import from it; copy the small helpers you need into the folder.
- shadcn: Button, Input, Label, Table, Badge, Dialog from @/components/ui/<name>. Claude Code will add separator and progress with the shadcn CLI before integration; import them from @/components/ui/<name>. Icons from lucide-react.
- Preview.tsx in each folder renders every state below; callbacks log to the console.
- Accessibility (05 s5): keyboard reachable, visible focus, labels on every input, errors linked with aria-describedby, status messages role="status" or role="alert", headings in order.
- Responsive: one column below 768 px; the members table scrolls in its own container below 640 px or becomes cards; Privacy text max about 70 characters per line; no horizontal page scroll at 320 px.

WHAT
OrganizationPage
- org null: a centered card "Create your organization", Organization name input, "Create organization" (onCreateOrg); createStatus submitting/error as in the auth forms.
- Otherwise sections with headings:
  - Plan: plan name badge (Free, Starter, Growth). past_due: warning "Your last payment failed. Stripe is retrying; paid features stay on." Credits: "Credits used this period: 1 of 10" with a progress meter, "1 reserved" when reserved > 0, "Resets on Nov 1, 2026". "Files per bid: 300 MB". Buttons: "Manage billing" (owner only; when billingAvailable is false it is disabled with the help "Billing opens when Stripe is connected."), "Upgrade plan" (Free, or Starter for Growth).
  - Members: "2 of 5 seats used". Table: Name, Email, Role (Owner, Member), with "(you)" after your own name. Owners see "Remove" on other members (ConfirmDialog "Remove [name]?", body "They lose access to every bid in this organization.", confirm "Remove member"). "Invite member": Work email input and "Send invite" (onInvite); inviteStatus done shows the container's message; error shows it under the field. When seats are full the form is replaced by "Your plan's seats are full." with "Upgrade plan".
  - Data and AI: "AI model: [model]", "Provider: [provider]", "Subprocessors" list, and a link-button "Read the privacy summary" (onOpenPrivacy). processing null: "Loading…" skeleton lines.
- Members who are not owners see the Plan section without billing buttons and the Members section without Remove.

AccountPage
- Profile: Name (input, "Save name" → onSaveName; profileStatus). Work email and Phone shown as read-only text (phone formatted (555) 555-0100) with "To change your email or phone, contact support."
- Password: Current password, New password (show/hide toggle; hint "12 characters or more"), "Change password" (onChangePassword(current, next)); validation before calling back: both filled, new at least 12 characters, new differs from current. passwordStatus submitting/error/done as in the auth forms; on done clear both fields and show the message.

PrivacyPage
- Title "Privacy summary", a "Back" button (onBack), and sections:
  1. What you can upload: no Controlled Unclassified Information (CUI), classified material, or export-controlled technical data. The app checks pages 1 to 3 and headers and footers for CUI and export-control markings and pauses AI processing until you confirm the file is public or approved for third-party processing. The check is a safeguard, not a guarantee. Resumes may hold personal data; your organization confirms it may process them.
  2. AI processing: "Documents are processed by [model] from [provider]." (from processing; when null, "The model and provider are named on the Organization page."). "If a China-origin model (for example Qwen or DeepSeek) is the one in use, it may process your documents."
  3. Who can access the server: Shaavir's support staff and server administrators are in India and can technically access the server. Root access is limited to named people and SSH sessions are logged. Support looks at your documents only with your written approval, and that is logged.
  4. How long data is kept, as a simple table: Files (Free: 90 days from upload; Starter and Growth: until the later of 90 days after upload and 90 days after the due date, and the owner can extend), then the archive (lifetime "To be confirmed"), restores (window "To be confirmed"), page text (until the bid is deleted, except resumes), resumes and their evidence quotes (deleted 90 days after upload, never archived; candidate names stay), exports (24 hours), database backups (30 days).
  5. Deleting data: deleting a bid or the organization deletes its rows, page text, server files, and archive copies; backups clear within 30 days; organization deletion finishes within 30 days.
  6. Subprocessors: Contabo (hosting, US East), DeepInfra (AI), Anthropic (AI, if used), Stripe (payments), Telnyx (SMS), the email provider, the archive storage provider, the off-site backup target, and the error tracking service; use processing.subprocessors when set.
- Footer: "Read the full Privacy Policy" (a normal link to policyUrl) when set, otherwise "The full Privacy Policy will be published before launch."

Preview states: Organization as owner on Free, owner on Growth, past_due, member, no organization, seats full, invite done and error, remove dialog, billing unavailable; Account idle, saving, errors, done; Privacy with processing set and null, policyUrl set and null, inside a plain frame and standalone.

Copy: sentence case, verb-first buttons.
When done: push to branch v0-ui only, then list the folders and the components for Claude Code to integrate.
````

---

## 8. Outline and status tracker

````text
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

SCREEN: Outline and status tracker tab (paid).

WHERE
- Folder: design/v0/outline/. Files: OutlineTab.tsx, types.ts, sample-data.ts, Preview.tsx.
- Push to branch v0-ui only. Touch nothing outside design/v0/outline/.

HOW
- Read first: AGENTS.md, design/v0/README.md, docs/plans/05-ui.md sections 3.4, 4 and 5, and docs/plans/09-ui-workflow.md section 5 ("Rules for every contract"), 5.5 and 5.12.
- Implement OutlineTabProps (5.5) exactly: same names, props, types and callback signatures. Do not add, rename or make optional any prop.
- Types: import AmendmentMark from @/types. Copy OutlineStatus, OutlineItem, OutlineEdit and OutlineTabProps word for word from 5.5 into design/v0/outline/types.ts.
- Shared pieces: import SourceLink and EmptyState from @/ui/common/<Name>, ConfirmDialog from @/ui/shell/ConfirmDialog. Do not rebuild them.
- shadcn: Button, Input, Label, Select, Table, Badge, Dialog, DropdownMenu from @/components/ui/<name>. Icons from lucide-react.
- Preview.tsx renders every state below; callbacks log to the console.
- Accessibility (05 s5): the tree is a table with expandable volume rows (button with aria-expanded, "Expand [volume]") or a treegrid; every control keyboard reachable; over-budget state has text, not only red; moving works with buttons, never drag only.
- Responsive: the outline scrolls in its own container (role="region", aria-label "Outline", tabIndex 0); no horizontal page scroll at 320 px.

WHAT
- Toolbar: "Add volume" (onAdd(null, title, number) via a small dialog with Number and Title), Export menu ("Export XLSX", "Export DOCX").
- Columns: Number, Title, Page limit, Writer, Status, Due date, Source ref, Source, Actions.
- Volume rows (parentId null) are bold with an expand/collapse button and a page budget line: "Pages planned 28 of 30" (sum of the sections' page limits against the volume's limit; font-numeric). Over the limit: due red text "Over by 3" plus an icon.
- Section rows are indented under their volume. Editable inline: Title, Page limit (number), Writer, Status (Not started, In progress, In review, Done), Due date (date input). Each change calls onEdit(id, { field }).
- Source ref (for example "L.4.2") is a button that calls onOpenRow(id). Source column: SourceLink (rowLabel = number + title) calling onOpenSource(id).
- Amendment marks as in the compliance tab: "Added by Amd N"; superseded and withdrawn rows struck through with the label.
- Row menu "Actions for [number]": "Add section" (onAdd(volumeId, title, number) via dialog), "Move up", "Move down", "Move to volume…" (dialog with a volume Select), "Open details", "Delete" (ConfirmDialog "Delete [number] [title]?"). Moves call onMove(id, parentId, index).
- selectedRowId highlights and scrolls to the row.
- Empty: EmptyState "No outline yet", "Add a volume by hand.", action "Add volume".

Preview states: 3 volumes (Technical 30 pages, Management 15 pages over by 2, Past performance 10 pages) with 4 to 6 sections each, mixed statuses, writers, due dates, one section added by Amd 1, one superseded; collapsed volume; empty.

Copy: sentence case, verb-first buttons.
When done: push to branch v0-ui only, then list the folder and the components for Claude Code to integrate.
````

---

## 9. Resume and key personnel matrix

````text
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

SCREEN: Resume and key personnel matrix tab (paid).

WHERE
- Folder: design/v0/resumes/. Files: ResumeMatrixTab.tsx, types.ts, sample-data.ts, Preview.tsx.
- Push to branch v0-ui only. Touch nothing outside design/v0/resumes/.

HOW
- Read first: AGENTS.md, design/v0/README.md, docs/plans/05-ui.md sections 3.5, 4 and 5, docs/plans/07-security-privacy.md section 2 (resume deletion), and docs/plans/09-ui-workflow.md section 5 ("Rules for every contract"), 5.6 and 5.12.
- Implement ResumeMatrixTabProps (5.6) exactly: same names, props, types and callback signatures. Do not add, rename or make optional any prop.
- Types: import AmendmentMark and FormStatus from @/types. Copy PersonnelKind, MatchResult, PersonnelRequirement, Candidate, ResumeMatch and ResumeMatrixTabProps word for word from 5.6 into design/v0/resumes/types.ts.
- Shared pieces: import SourceLink and EmptyState from @/ui/common/<Name>, ConfirmDialog from @/ui/shell/ConfirmDialog. Do not rebuild them.
- shadcn: Button, Input, Label, Select, Table, Badge, Dialog, DropdownMenu, Tooltip from @/components/ui/<name>. Icons from lucide-react.
- Preview.tsx renders every state below; callbacks log to the console.
- Accessibility (05 s5): grid cells are buttons with accessible names "[candidate], [requirement]: Meets"; results use text plus color plus an icon; evidence is reachable by keyboard (tooltip on focus, or a popover on click), not hover only.
- Responsive: requirements and candidates panels side by side at 1,024 px and wider, stacked below; the grid scrolls in its own container (role="region", aria-label "Resume matrix", tabIndex 0) with the requirement column sticky; no horizontal page scroll at 320 px.

WHAT
- Standing note at the top (info bar): "Resumes, their text, and evidence quotes are deleted 90 days after upload. Candidate names and results stay."
- Requirements panel: grouped by role (roles), each requirement with its kind badge (Degree, Years, Certification, Clearance, Skill, Other), the text (inline edit via an "Edit" button → onEditRequirement), a SourceLink (rowLabel = role + requirement) calling onOpenSource(id), a button to open details (onOpenRow), and "Delete". "Add requirement" per role (dialog: Role, Requirement, Kind → onAddRequirement).
- Candidates panel: "Upload resumes" with a Role select and file picker (PDF, DOCX) → onUploadResumes(files, role); uploadStatus submitting/error. Candidate list: name, role (Select → onAssignRole), status (Processing with spinner, Ready, Failed), uploaded date, "Remove" (ConfirmDialog "Remove [name]?").
- Grid: requirement rows grouped by role, candidate columns (only candidates assigned to that role have cells in that role's rows; others show "—"). Cell: Meets (team-green, check), Partial (warning, half circle), Gap (due red, x), Unknown (muted, question mark). "Reviewer set" small text when overridden. Evidence: the quote and "p. N" on focus/hover; when the candidate's resumeDeleted, "Removed: resume deleted after 90 days". Cell menu: "Set to Meets", "Set to Partial", "Set to Gap" → onSetResult.
- Below the grid: "Gaps by candidate" (for each entry in gaps: the candidate name and the list of requirement texts, or "Meets every requirement") and "Roles with no candidate who meets every requirement" (uncoveredRoles, or "Every role has a candidate who meets it.").
- Toolbar: "Export XLSX" (onExport).
- Empty: no requirements: EmptyState "No roles found", "Add a role and its requirements by hand.", action "Add requirement". No candidates: "Upload resumes to compare candidates."

Preview states: 3 roles (Program Manager, Lead Systems Engineer, Help Desk Lead) with 3 to 5 requirements each, 4 candidates (one processing, one with resumeDeleted), every result value, overrides, gaps and uncovered roles; upload error; empty.

Copy: sentence case, verb-first buttons.
When done: push to branch v0-ui only, then list the folder and the components for Claude Code to integrate.
````

---

## 10. Color team reviews

````text
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

SCREEN: Color team reviews tab (paid).

WHERE
- Folder: design/v0/reviews/. Files: ReviewsTab.tsx (helpers such as CreateReviewDialog.tsx and FindingCard.tsx if you like), types.ts, sample-data.ts, Preview.tsx.
- Push to branch v0-ui only. Touch nothing outside design/v0/reviews/.

HOW
- Read first: AGENTS.md, design/v0/README.md, docs/plans/05-ui.md sections 3.6, 4 and 5, and docs/plans/09-ui-workflow.md section 5 ("Rules for every contract"), 5.7 and 5.12.
- Implement ReviewsTabProps (5.7) exactly: same names, props, types and callback signatures. Do not add, rename or make optional any prop.
- Types: import FormStatus from @/types. Copy ReviewType, FindingKind, Disposition, Reviewer, Review, Finding, NewReview and ReviewsTabProps word for word from 5.7 into design/v0/reviews/types.ts.
- Shared pieces: import SourceLink and EmptyState from @/ui/common/<Name>, ConfirmDialog from @/ui/shell/ConfirmDialog. Do not rebuild them.
- shadcn: Button, Input, Label, Select, Table, Badge, Dialog, DropdownMenu, Tabs from @/components/ui/<name>. Claude Code will add textarea with the shadcn CLI before integration; import it from @/components/ui/textarea. Icons from lucide-react.
- Preview.tsx renders every state below; callbacks log to the console.
- Accessibility (05 s5): review types use color plus the type name; disposition controls are a labelled group; keyboard reachable with visible focus.
- Responsive: the review list is a left column at 1,024 px and wider and a Select above the findings below 1,024 px; no horizontal page scroll at 320 px.

WHAT
- Review list: one item per review with a color chip (bg-team-pink, -red, -green, -gold; "other" uses border-line) and the type name ("Pink team"), the date (font-numeric), status (Planned, In progress, Done), the draft file name or "No draft yet". Selecting calls onSelectReview. "Create review" button.
- Create review dialog: Type (Pink, Red, Green, Gold, Other), Date (date input), Draft (file input, optional), Reviewers: rows of Name and Sections with "Add reviewer"; "Create review" calls onCreateReview(review, file or null).
- Active review header: type chip, date, status Select (onEditReview), date edit, "Upload draft" (onUploadDraft) with uploadStatus, Reviewers list with sections and "Remove" (onRemoveReviewer), "Add reviewer" form (onAddReviewer).
- Findings: grouped by evaluation factor (heading "Section M factor: [factor]" when federal, else "Evaluation factor: [factor]"; findings with no factor under "General"), each group marked with the review's color as a left border. Inside a group, by kind in this order: Strengths, Weaknesses, Deficiencies, Risks, Comments, each with a count.
- Finding card: kind badge, text (edit via "Edit" → onEditFinding), the draft quote in a quote block with a SourceLink (rowLabel = kind + first words; page = draftPage) calling onOpenSource(id), origin "AI" or the author's name, "Open details" (onOpenRow), and the disposition as a segmented control "Open / Accept / Reject / Done" → onSetDisposition.
- "Add finding" form per review: Evaluation factor (Select from evalFactors plus "General"), Kind, Text (textarea) → onAddFinding.
- Export menu: "Export review summary (DOCX)", "Export findings (XLSX)".
- Empty: no reviews: EmptyState "No reviews yet", "Create a pink team review to start.", action "Create review". Review with no findings: "No findings yet. Add one by hand, or upload the draft to get AI findings."

Preview states: 3 reviews (pink done, red in progress with 14 findings across 3 factors and every kind and disposition, gold planned with no draft); federal and SLED labels; create dialog; upload error; empty.

Copy: sentence case, verb-first buttons.
When done: push to branch v0-ui only, then list the folder and the components for Claude Code to integrate.
````

---

## 11. Production checklist and Orals

````text
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

SCREEN: Production checklist tab and Orals tab (both paid).

WHERE
- Folders: design/v0/production/ (ProductionTab.tsx, types.ts, sample-data.ts, Preview.tsx) and design/v0/orals/ (OralsTab.tsx, types.ts, sample-data.ts, Preview.tsx).
- Push to branch v0-ui only. Touch nothing outside these two folders.

HOW
- Read first: AGENTS.md, design/v0/README.md, docs/plans/05-ui.md sections 3.7, 3.8, 4 and 5, and docs/plans/09-ui-workflow.md section 5 ("Rules for every contract"), 5.8, 5.9 and 5.12.
- Implement ProductionTabProps (5.8) and OralsTabProps (5.9) exactly: same names, props, types and callback signatures. Do not add, rename or make optional any prop.
- Types: import AmendmentMark from @/types. Copy ProductionCategory, ProductionItem and ProductionTabProps into design/v0/production/types.ts and OralsCategory, OralsItem and OralsTabProps into design/v0/orals/types.ts, word for word.
- Shared pieces: import SourceLink and EmptyState from @/ui/common/<Name>, ConfirmDialog from @/ui/shell/ConfirmDialog. Do not rebuild them.
- shadcn: Button, Input, Label, Select, Checkbox, Table, Badge, Dialog, DropdownMenu from @/components/ui/<name>. Claude Code will add progress with the shadcn CLI before integration; import it from @/components/ui/progress. Icons from lucide-react.
- Preview.tsx in each folder renders every state below; callbacks log to the console.
- Accessibility (05 s5): checkboxes labelled "Done: [rule]"; keyboard reachable; amendment and origin labels in text.
- Responsive: lists, not wide tables; owner and minutes fields wrap under the text below 640 px; no horizontal page scroll at 320 px.

WHAT
ProductionTab
- "Ready to submit" bar at the top: a progress meter and "18 of 24 done" (font-numeric); when all are done, "Ready to submit" in team-green text with a check.
- Groups with headings and counts: Format, Files, Submission, Copies, Other. Each item: Done checkbox (onToggle), the rule (inline edit → onEdit(id, { rule })), Owner input (onEdit(id, { owner })), origin label ("Standard", "From the solicitation" with a SourceLink, rowLabel = the rule's first words, calling onOpenSource(id), or "Added by user"), amendment label when not original, row menu "Open details" (onOpenRow), "Delete" (ConfirmDialog).
- "Add item" per group (onAdd(category, rule)).
- selectedRowId highlights and scrolls to the item.
- Empty: EmptyState "No checklist items", "Add one by hand.", action "Add item".

OralsTab
- Three sections:
  - "Orals rules": items in category rules, each with its text and a SourceLink (or "Added by user"), done checkbox ("Reviewed").
  - "Preparation checklist": category prep, done checkbox, text, Owner.
  - "Session plan": category session as a table: Topic, Presenter (the owner field), Minutes (number input), Done; footer "Total 55 minutes" (font-numeric).
- Each section has "Add" (onAdd(category, item)) and row menus with "Open details" and "Delete".
- Empty per section: "No rules found in the solicitation." / "No preparation items yet." / "No session topics yet." with an add button.

Preview states: production with 24 items across all categories (some standard, some extracted with sources, one added by Amd 2), all done, empty; orals with 4 rules, 6 prep items, 5 session topics, empty.

Copy: sentence case, verb-first buttons.
When done: push to branch v0-ui only, then list the folders and the components for Claude Code to integrate.
````

---

## 12. Lessons learned

````text
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

SCREEN: Lessons learned tab (paid).

WHERE
- Folder: design/v0/lessons/. Files: LessonsTab.tsx, types.ts, sample-data.ts, Preview.tsx.
- Push to branch v0-ui only. Touch nothing outside design/v0/lessons/.

HOW
- Read first: AGENTS.md, design/v0/README.md, docs/plans/05-ui.md sections 3.9, 4 and 5, and docs/plans/09-ui-workflow.md section 5 ("Rules for every contract"), 5.10 and 5.12.
- Implement LessonsTabProps (5.10) exactly: same names, props, types and callback signatures. Do not add, rename or make optional any prop.
- Types: import FormStatus from @/types. Copy Lesson and LessonsTabProps word for word from 5.10 into design/v0/lessons/types.ts.
- Shared pieces: import EmptyState from @/ui/common/EmptyState and ConfirmDialog from @/ui/shell/ConfirmDialog. Do not rebuild them.
- shadcn: Button, Input, Label, Dialog, DropdownMenu from @/components/ui/<name>. Claude Code will add textarea with the shadcn CLI before integration; import it from @/components/ui/textarea. Icons from lucide-react.
- Preview.tsx renders every state below; callbacks log to the console.
- Accessibility (05 s5): each question is the label of its text area; save state announced with role="status".
- Responsive: one column, max width about 760 px; no horizontal page scroll at 320 px.

WHAT
- Intro line: "Fill this in after submission or award. It helps the next bid."
- One card per lesson: the question as the label, a textarea with the answer, "Save answer" (enabled when changed; onAnswer), "Last updated Nov 20, 2026 by [author]" (or without "by" when author is null), and a menu with "Delete" (ConfirmDialog "Delete this question?").
- saveStatus: submitting disables the pressed card's button with "Saving…"; error shows the message; done shows "Saved."
- "Add question or note": an input and "Add" (onAddQuestion).
- "Export DOCX" (onExport).
- Empty: EmptyState "No questions yet", "Add a question or a note.", action "Add question".

Preview states: the seeded survey (What worked well?, What should we change next time?, What did the evaluators say?, Notes) partly answered; saving; error; empty.

Copy: sentence case, verb-first buttons.
When done: push to branch v0-ui only, then list the folder and the components for Claude Code to integrate.
````
