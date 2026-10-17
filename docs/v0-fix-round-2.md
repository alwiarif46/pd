# v0 fix round 2

Three prompts. Paste each into its own new v0 chat, in order (A, then B, then C), and wait for each to push before starting the next. All three push to the same branch, `v0/ui-screens`.

These come from an audit of every screen in `design/v0/` against `docs/v0-prompts.md` and `docs/plans/09-ui-workflow.md` section 5, plus a type-check against the real contracts (59 errors in 14 files on 15 Oct 2026).

---

## Prompt A: shell, overview, documents, settings, compliance

````text
Fix round 2, part A. Read every line before you start.

GROUND RULES (apply to every screen in this prompt)
- Work only inside design/v0/. Touch nothing else in the repo. Push to the branch v0/ui-screens (create it from v0-ui if it does not exist). Do not push to v0-ui, master, or any new branch name.
- The contract is docs/plans/09-ui-workflow.md section 5. It wins over everything, including docs/v0-prompts.md and anything I said in earlier chats. Implement each Props interface exactly: same names, prop names, types and callback signatures. Do not add, rename, or make optional any prop.
- Shared types come from @/types. Import Tab, AuthStatus, Plan, Role, BidType, FileKind, ReqType, RowFlag, FormStatus and AmendmentMark from there. Never redefine them locally. FormStatus is an object, not a string:
  { state: 'idle' } | { state: 'submitting' } | { state: 'error'; message: string } | { state: 'done'; message: string }
  Read it with status.state and show status.message exactly as given. Never invent messages like "Please check the details and try again."
- AmendmentMark comes from @/types. Its superseded variant has replacedById: string | null. Hide the jump button when it is null.
- Shared pieces: import SourceLink, EmptyState and MarkingPrompt from @/ui/common/<Name>, and ConfirmDialog from @/ui/shell/ConfirmDialog. Never from ../common or ../shell.
- Every folder has its own sample-data.ts holding all the sample data. types.ts holds types only. Preview.tsx imports from sample-data.ts and renders EVERY state listed for that screen in docs/v0-prompts.md.
- Dates: a date-only ISO string ('2026-11-01') must be split into its parts and built as a local date. Never call new Date('YYYY-MM-DD'), because it shows the day before in US time zones.
- Tabs render inside AppShell, which already provides the main landmark. Never put a <main> in a tab or page component. Remove invented headings and subtitles such as "Paid workspace". TabFrame supplies the tab title.
- Use shadcn components (Select, Dialog, DropdownMenu, Checkbox, Textarea, Tooltip, Progress, Table, Sheet) from @/components/ui/<name>, not native select, checkbox or textarea elements.
- Destructive actions go through ConfirmDialog, which names the item and puts default focus on Cancel.
- Before you push: every file must type-check against the real @/types with no unused variables. Claude Code runs the integration and tsc, and any error sends the screen back.

1. SHELL (design/v0/shell). Fix list. Some of these reverse what I told you last time; 09 section 5.1 is the rule.
   1. A locked tab click calls onSelectTab(tab), never onUpgrade. The container renders LockedTab (09 s5.1).
   2. Top bar inside a bid: replace the bid DropdownMenu and the separate "Bids" link with a Select labelled "Bid" (an sr-only label is fine). It lists the bids plus "All bids", and "All bids" calls onOpenPage('bids').
   3. Due line: "Due Nov 3, 2:00 PM ET" in font-numeric. Do not run the time through Intl with a timeZone. Turn dueTime 'HH:mm' into 12-hour text yourself, and map timeZone to a short label (America/New_York ET, America/Chicago CT, America/Denver MT, America/Los_Angeles PT, America/Anchorage AKT, Pacific/Honolulu HT, anything else the raw zone).
   4. Credits: "3 RFP credits left · resets Nov 1" in font-numeric, with no year. Below 640 px, "3 credits".
   5. At 0 credits, show the credits text in text-warning plus an "Upgrade plan" button that calls onUpgrade. Remove the always-on Free "Upgrade plan" button and the plan pill.
   6. User menu trigger shows the user's initials, with the accessible name "Account menu for [name]". Put a separator directly before "Sign out".
   7. Sidebar icons: LayoutDashboard, CalendarDays, ListChecks, ListTree, Users, ClipboardCheck, PackageCheck, Mic, Lightbulb, FileStack, Settings.
   8. Locked tabs keep their own icon and show a Lock icon after the label. The accessible name still ends in "(locked)".
   9. Add the divider between Lessons and Documents (the "Paid" divider stays before Outline).
   10. Signals: a small dot (processing text-today, waiting text-warning, failed text-due) plus the text. In icon-only mode the dot sits on the icon and the tooltip carries the text. Keep the signal text in the button's accessible name.
   11. Detail at 1,024 px and wider: an aside about 420 px wide with aria-label "Row detail".
   12. Detail below 1,024 px: when detail is not null, show it as a full-width overlay panel. Remove the "View row detail" button, the bottom Sheet and the detailOpen state. Render detail exactly once, with responsive classes deciding where it sits. The detail content has its own close control.
   13. Content: main fills the remaining width and height (flex column, min-h-0), because the Schedule tab is a full calendar. Outside a bid, center the content at about 1,100 px max width.
   14. The top bar stays one row at 56 px down to 320 px. Collapse items instead of wrapping.
   15. ConfirmDialog: AlertDialogAction closes the dialog by itself, which fires onCancel after onConfirm. Prevent the auto-close; only the container closes it. Use the destructive button style, and clear the typed text each time the dialog opens.
   16. UpgradeDialog: Growth is 20 RFPs per period. Both cards list users (5) and how long files stay live. The Free line reads "Free: 1 RFP per period (2 in the first month), 50 MB per bid, 2 users, Overview, Schedule and Compliance." Format creditsResetOn as "Nov 1", parsed as a local date.
   17. Add sample-data.ts with the bids from prompt 1 (VA EHR Support Services, City of Austin Fleet Telematics, NAVSEA Logistics Support) and Dana Reyes.
   18. Preview: AppShell on Free (locked tabs, a processing and a waiting signal), Growth with orals and a detail open, outside a bid, and 0 credits, each at 1,280, 900 and 375 px. UpgradeDialog with every reason on Free and on Starter. ConfirmDialog plain, with typeToConfirm, and busy.
   19. Logo: put the Shaavir mark to the left of the "Shaavir PD" wordmark in the top bar: <img src="/shaavir-mark.png" alt="" className="size-7 shrink-0" />, about 28 px square, with an 8 px gap. The alt is empty because the wordmark beside it already names the app. The file is in the app's public folder, so use that path as written; do not import it, copy it, or add an image to design/v0. Below 640 px, show the mark and drop the wordmark text, but keep "Shaavir PD" as an sr-only label.

2. OVERVIEW (design/v0/overview). Fix list against prompt 5 and 09 s5.3.
   1. Delete the local AmendmentMark and the OverviewProps alias. Import from @/types.
   2. Rewrite sample-data.ts to the contract shapes. Every BidFact has origin, sourcePageEnd, sourceQuote and amendment. Countdown has only the 5.3 fields, and the countdown prop is Countdown | null.
   3. Countdown card: big numerals "12 days" and "8 workdays", then "Due Tue, Nov 3, 2026 at 2:00 PM ET" (same time rule as the shell). 0 days reads "Due today" in text-warning, below 0 "Past due" in text-due, and null reads "Set the due date in Settings."
   4. Facts: an "Edit [field]" icon button turns Value into an input with Save and Cancel; Save calls onEditFact. Superseded facts get the "Superseded" badge and a muted, struck value. Origin user shows "Added by user".
   5. Wrap the facts table in a container with role="region", aria-label "Bid facts" and tabIndex 0. Scroll the selectedRowId row into view.
   6. Add fact and add kickoff forms get visible labels (no placeholder-only inputs). The kickoff button reads "Add item".
   7. Empty facts: EmptyState "No bid facts found" / "Add one by hand." / "Add fact", where the action opens the add form.
   8. Kickoff: "N of M done" above the list, each note in muted text, checkboxes labelled "Done: [label]". The owner input calls onSetKickoffOwner on blur and on Enter only, never per keystroke.
   9. At 1,024 px and wider, put the countdown and checklist beside the facts. Below that, stack them.
   10. Preview: 10 facts (two superseded by Amd 1 with their replacements, one added by Amd 1, one user fact), the 7 kickoff items, countdowns of 12 days, 0 days, past due and null, and empty facts.

3. DOCUMENTS (design/v0/documents). Fix list against prompt 6 and 09 s5.11, including the 5.11 amendment-number additions.
   1. Implement the 5.11 additions: amendmentNoAssumed, amendmentNoFound, needsNumber, onSetAmendmentNo, and the optional amendment number on "Add amendment" / onUpload. Show an assumed number as editable, show the found number beside a different typed number, and for needsNumber ask for the number before processing.
   2. Upload: shadcn Select for Kind, plus a drop zone "Drag files here" with a "Choose files" button. "Add amendment" opens a file picker; it must never call onUpload with an empty list.
   3. Meter: warning color at 90 % or more.
   4. Notices: tone error in due red, tone info neutral.
   5. Pages "~N" gets a "Page estimated" tooltip. Processing status shows a spinner.
   6. Render the MarkingPrompt in a highlighted row directly under its file.
   7. Key check: owners always see "Override", even at 0 left, and the dialog then shows "No overrides left. Start a new bid for this file." Members see "Ask the bid owner to override." Build the override dialog on shadcn Dialog with the shadcn Textarea, and reject a whitespace-only reason. Delete the unused OverrideKeyDialog.tsx or make it the one in use.
   8. Delete opens ConfirmDialog "Delete [file name]?" / "The rows and quotes this file produced stay. Its MB is freed." / "Delete file". Hide Delete on deleted files.
   9. Empty: EmptyState "No files yet" / "Upload the solicitation to start." / "Choose files".
   10. Below 768 px each file is a card.
   11. Parse liveUntil and every other date-only value as a local date.
   12. Preview: Starter with 7 files covering every status (including failed, restore_requested and restoring) and one blocked marking; a key mismatch as owner and as member; Free near the 50 MB cap; empty; the override dialog with 2 and with 0 left; an assumed amendment number and a needsNumber file.

4. SETTINGS (design/v0/settings). Fix list against prompt 6 and 09 s5.11.
   1. saveStatus and deleteStatus are FormStatus objects. 'submitting' disables the whole form, 'error' shows the message, and 'done' shows "Saved." briefly.
   2. BidSettings calls onSave(values) directly. Remove the embedded DateChangePrompt and the previous-due logic; the container opens DateChangePrompt.
   3. Time zone and Bid type use the shadcn Select. Time zones: Eastern, Central, Mountain, Pacific, Alaska, Hawaii, mapped to America/New_York, America/Chicago, America/Denver, America/Los_Angeles, America/Anchorage, Pacific/Honolulu.
   4. Help under the dates: "Changing the due date asks how to move the schedule." The Orals switch is labelled "Show the Orals tab".
   5. Keep files live until: the owner on a paid plan edits it, with the help "Files stay live until [date] unless you extend it. After that they move to the archive." Members see it read-only with "Only the bid owner can change this." On Free it is disabled with "Paid plans can keep files live longer."
   6. Add "Discard changes", and resync the form when the bid prop changes.
   7. Danger zone: the heading "Delete this bid", the text "This deletes the bid, its files, its archive copies, and every tab.", and the credit sentence by creditStatus (nothing for 'none'). "Delete bid" opens ConfirmDialog "Delete [bid name]?" with typeToConfirm set to the bid name, busy while deleteStatus is submitting, then the error message if any.
   8. DateChangePrompt: shadcn Dialog titled "The due date moved", dates written as "Tue, Nov 3", each choice with its one-line explanation, and default focus on Cancel.
   9. Preview: owner on Growth, member, Free, saving, error, the delete dialog, and DateChangePrompt open.

5. COMPLIANCE (design/v0/compliance). Needs a full redo. Rebuild ComplianceMatrixTab, RowDetail and SourceViewer from prompt 4 in docs/v0-prompts.md, following it line by line, with contracts 09 s5.4, 5.17 and 5.18 copied word for word into types.ts. The current version is wrong in these ways, so do not keep them:
   - RowStatus is imported from ../common/types, which does not export it. RowDetailProps has an invented onEdit and is missing history, federal, editFields, saveStatus, onSave and onJumpToRow. SourceViewerProps uses state instead of view: SourceView, and lacks canRestore and onRetry.
   - The Type, Owner and Amendment filters, "Clear filters", the Filters Sheet below 640 px, the Export menu, the Add requirement dialog, the row menu with Split and Delete, the Split dialog, the Check these list and both empty states are missing.
   - RowDetail is a fixed overlay. It must be an in-flow panel for the shell's detail slot, with a "Close row detail" X, focus on the heading at open, Esc calling onClose, a skeleton when row is null, null fields hidden, the edit form and the edit history.
   - SourceViewer is not a Dialog and implements none of the view modes.
   - The selected row highlight and the sticky ID column (it overlaps the checkbox column, and its header is not sticky) are broken. The Owner cell is a per-keystroke Input instead of a Select.
   Preview: every state in prompt 4.

When done: push to v0/ui-screens, then list each folder you changed and the components in it.
````

---

## Prompt B: organization, account, privacy, outline

````text
Fix round 2, part B. Read every line before you start.

GROUND RULES: same as part A, repeated here so this chat stands alone.
- Work only inside design/v0/. Push to the branch v0/ui-screens and nowhere else.
- docs/plans/09-ui-workflow.md section 5 is the contract and wins over everything. Implement each Props interface exactly. Do not add, rename, or make optional any prop.
- Import Plan, Role, FormStatus and AmendmentMark from @/types; never redefine them. FormStatus is { state: 'idle' } | { state: 'submitting' } | { state: 'error'; message: string } | { state: 'done'; message: string }. Read status.state and show status.message as given. No invented messages.
- Shared pieces: SourceLink and EmptyState from @/ui/common/<Name>, ConfirmDialog from @/ui/shell/ConfirmDialog.
- Each folder has sample-data.ts with all sample data. types.ts holds types only. Preview renders every state listed for that screen in docs/v0-prompts.md.
- Date-only ISO strings are built as local dates; never new Date('YYYY-MM-DD').
- No <main> in pages or tabs (AppShell provides it). No invented headings or subtitles such as "Paid workspace".
- Use shadcn components; destructive actions go through ConfirmDialog.
- Everything must type-check against the real @/types with no unused variables.

1. ORGANIZATION (design/v0/organization). Fix list against prompt 7 and 09 s5.13 and 5.14.
   1. Delete the local Plan, Role and FormStatus and import them. Move OrgMember, OrgCredits, ProcessingInfo and OrganizationPageProps into types.ts word for word, and drop the re-exports.
   2. Every status shows its own message: the createStatus error under the Organization name field (aria-describedby, role="alert"); the inviteStatus done message with role="status", and its error under the invite field. Clear the invite email only on done.
   3. With org null, show a centered card "Create your organization".
   4. Invite form: the heading "Invite member", a visible "Work email" label, and the button "Send invite". When members.length >= seatLimit, replace the form with "Your plan's seats are full." and an "Upgrade plan" button.
   5. Plan section: the heading "Plan" and a plan badge (Free, Starter, Growth). Credits read "Credits used this period: U of A" with a Progress meter, "R reserved" only when reserved > 0, and "Resets on Nov 1, 2026". Then "Files per bid: 300 MB".
   6. "Manage billing" is for owners only. When billingAvailable is false, keep the label, disable the button, and show the help "Billing opens when Stripe is connected." linked by aria-describedby. "Upgrade plan" shows on Free and on Starter.
   7. Members: Table from @/components/ui/table, "(you)" after your own name, and the roles written as "Owner" or "Member". "Remove" (accessible name "Remove [name]") opens ConfirmDialog "Remove [name]?" / "They lose access to every bid in this organization." / "Remove member". Below 640 px, use a scroll container or cards.
   8. Data and AI: "AI model: [model]", "Provider: [provider]", and the subprocessors as a list. When processing is null, show "Loading…" skeleton lines.
   9. Preview: owner on Free, owner on Growth, past_due, member, no organization, seats full, invite done, invite error, the remove dialog, and billing unavailable.

2. ACCOUNT (design/v0/account). Fix list against prompt 7 and 09 s5.15.
   1. Import FormStatus; move AccountPageProps into types.ts word for word.
   2. Show the profileStatus and passwordStatus messages as given: error with role="alert", done with role="status".
   3. Show Work email and Phone as read-only text, not inputs, with the phone formatted like (202) 555-0148.
   4. Validate before calling onChangePassword: both fields filled, new at least 12 characters, new different from current. Show each error under its field. Clear both fields only when passwordStatus becomes done.
   5. The hint reads exactly "12 characters or more". The toggle has the accessible name "Show password" or "Hide password", plus aria-pressed.
   6. Resync the name field when the name prop changes. Profile and Password are separate sections, each with its own heading.
   7. Preview: idle, saving, profile error, password error, validation errors, and done for both forms.

3. PRIVACY (design/v0/privacy). Needs a full redo from prompt 7.
   - Props are exactly { processing: ProcessingInfo | null; policyUrl: string | null; onBack: () => void }. Remove companyName and policyUpdatedOn, the stray stub component, the default export of a type, PRIVACY_SECTIONS and SAMPLE_PRIVACY_PROPS.
   - The title is "Privacy summary", with a "Back" button. No "Last updated" line and no marketing card.
   - Write the six sections from prompt 7 with its exact facts: What you can upload; AI processing (including the null case and the China-origin model sentence); Who can access the server (India-based staff, named root access, logged SSH, documents opened only with written approval, which is logged); How long data is kept (as a table, with the archive lifetime and restore window as "To be confirmed"); Deleting data; Subprocessors (processing.subprocessors when set, otherwise the default list).
   - Footer: "Read the full Privacy Policy" linking to policyUrl, or "The full Privacy Policy will be published before launch."
   - Lines about 70 characters wide (max-w-prose). The page must work standalone (its own background, min-h-screen and padding) and inside the shell without a second main landmark.
   - Preview: processing set and null, policyUrl set and null, standalone and inside a plain frame.

4. OUTLINE (design/v0/outline). Needs a full redo from prompt 8 and 09 s5.5.
   - OutlineItem.amendment is AmendmentMark from @/types, not string. Put the sample data in sample-data.ts.
   - Build a table (or treegrid) with the columns Number, Title, Page limit, Writer, Status, Due date, Source ref, Source, Actions. No div grids.
   - Volume rows get a real expand/collapse button (aria-expanded, "Expand [volume]") and the budget line "Pages planned N of L". Over budget shows due-red "Over by X" plus an icon.
   - Title, Page limit, Writer, Status (Not started, In progress, In review, Done, in theme colors) and Due date are editable inline, each labelled, each calling onEdit(id, { field }).
   - Source ref is a button calling onOpenRow. The Source column is a SourceLink calling onOpenSource. Show the amendment marks.
   - The row menu "Actions for [number]": Add section (dialog with Number and Title), Move up, Move down, Move to volume… (dialog with a volume Select), Open details, Delete (ConfirmDialog "Delete [number] [title]?"). Moves call onMove(id, parentId, index) with the target index. No drag affordance.
   - Toolbar: "Add volume" opens a dialog with Number and Title. An Export menu holds "Export XLSX" and "Export DOCX".
   - Highlight and scroll to selectedRowId. Empty: EmptyState "No outline yet" / "Add a volume by hand." / "Add volume". The outline scrolls in a region labelled "Outline" (tabIndex 0), with no page scroll at 320 px.
   - Preview: Technical (30 pages), Management (15 pages, over by 2) and Past performance (10 pages), each with 4 to 6 mixed sections, one added by Amd 1 and one superseded; plus a collapsed volume and the empty state.

When done: push to v0/ui-screens, then list each folder you changed and the components in it.
````

---

## Prompt C: resumes, reviews, production, orals, lessons

````text
Fix round 2, part C. Read every line before you start.

GROUND RULES: same as parts A and B.
- Work only inside design/v0/. Push to the branch v0/ui-screens and nowhere else.
- docs/plans/09-ui-workflow.md section 5 is the contract and wins over everything. Implement each Props interface exactly. Do not add, rename, or make optional any prop. The correct shapes already exist in apps/web/src/types/ (resumes.ts, reviews.ts and so on). Read them, and import shared types from @/types instead of redefining them.
- FormStatus is { state: 'idle' } | { state: 'submitting' } | { state: 'error'; message: string } | { state: 'done'; message: string }. Show status.message as given.
- Every AI-extracted row shows a SourceLink from @/ui/common/SourceLink, even when its page is null. Never render an AI row without a source control. User-added rows show "Added by user".
- Shared pieces: SourceLink and EmptyState from @/ui/common/<Name>, ConfirmDialog from @/ui/shell/ConfirmDialog. Delete always goes through ConfirmDialog.
- Use shadcn Select, Dialog, DropdownMenu, Checkbox, Textarea, Tooltip and Progress; no native controls.
- Each folder has sample-data.ts with all sample data. types.ts holds types only. Preview renders every state listed in docs/v0-prompts.md (each screen currently renders one state).
- No <main>, and no "Paid workspace" or invented subtitles (TabFrame supplies the title).
- selectedRowId: highlight the row with a theme class, scroll it into view, and allow focus to return to it.
- Show amendment marks as text: "Added by Amd N", "Superseded by Amd N", "Withdrawn by Amd N".
- Everything must type-check against the real @/types with no unused variables.

1. RESUMES (design/v0/resumes). Needs a full redo from prompt 9 and 09 s5.6.
   - Types exactly as 5.6. PersonnelRequirement is { ...; requirement: string; kind: PersonnelKind | null; origin: 'ai' | 'user' } (no text field). Candidate.role is string and uploadedAt is string | null. ResumeMatch has no id, uses evidencePage (not sourcePage) and overridden (not reviewerSet).
   - Callbacks: onEditRequirement(id, { role?, requirement? }), onAddRequirement(role, requirement, kind), onSetResult(candidateId, requirementId, 'meets' | 'partial' | 'gap'). There is no onSetMatch.
   - Requirements are grouped by role, each role with "Add requirement" (a Dialog with Role, Requirement and Kind), per-row Edit and Open details, and Delete through ConfirmDialog.
   - "Upload resumes": a labelled Role Select and a file input (PDF, DOCX) calling onUploadResumes, with uploadStatus shown.
   - Candidates: a role Select (onAssignRole), the formatted upload date, a spinner while processing, and Remove through ConfirmDialog "Remove [name]?".
   - The grid is grouped by role; only candidates assigned to a role get cells there, and everyone else shows "—". Each cell opens a DropdownMenu (Set to Meets, Partial, Gap) calling onSetResult. The evidence quote and "p. N" show in a Tooltip that also opens on focus. When resumeDeleted is true, show "Removed: resume deleted after 90 days".
   - Theme colors only: Partial in warning with a half-circle icon, Gap in due red.
   - "Gaps by candidate" shows "Meets every requirement" for a candidate with none. The other heading is "Roles with no candidate who meets every requirement".
   - The panels stack below 1,024 px, with no page scroll at 320 px.
   - Preview: 3 roles with 3 to 5 requirements each; 4 candidates (one processing, one with resumeDeleted); every result value; overrides; gaps; uncovered roles; an upload error; and empty.

2. REVIEWS (design/v0/reviews). Needs a full redo from prompt 10 and 09 s5.7.
   - Disposition is 'open' | 'accepted' | 'rejected' | 'done'. Import every type from @/types.
   - "Create review" Dialog: Type, Date, an optional Draft file, and reviewer rows (Name, Sections) with "Add reviewer". It calls onCreateReview(review, file or null).
   - Active review header: a status Select and a date edit (onEditReview), "Upload draft" (a file input calling onUploadDraft, with uploadStatus), and reviewers with their sections plus Remove (onRemoveReviewer) and an add form (onAddReviewer).
   - "Add finding" per review: an Evaluation factor Select (evalFactors plus "General"), Kind, and a Textarea, calling onAddFinding.
   - Finding cards: a kind badge, Edit (onEditFinding), Open details (onOpenRow), a SourceLink on every AI finding, and the disposition as a labelled segmented control (role="group": Open, Accept, Reject, Done).
   - Group headings: Strengths, Weaknesses, Deficiencies, Risks, Comments. Each group's border uses the active review's team color.
   - One Export menu: "Export review summary (DOCX)" and "Export findings (XLSX)".
   - Below 1,024 px the review list becomes a Select. The active item gets aria-current. Format scheduledAt dates. With reviews but none active, prompt the user to select one.
   - Preview: pink done; red in progress with 14 findings across 3 factors covering every kind and disposition; gold planned with no draft; federal and SLED labels; the create dialog; an upload error; and empty.

3. PRODUCTION (design/v0/production). Fix list against prompt 11.
   1. Done is a shadcn Checkbox labelled "Done: [rule]". The rule edits inline (onEdit(id, { rule })). The Owner input is labelled (onEdit(id, { owner })) and wraps under the text below 640 px.
   2. Row menu: Open details (onOpenRow) and Delete through ConfirmDialog.
   3. Origin: standard shows "Standard"; ai shows "From the solicitation" plus a SourceLink (also when the page is null, and page 0 is a real page); user shows "Added by user".
   4. Always render all five groups with heading and count, each with its own "Add item" form calling onAdd(category, rule). Remove the global stub button.
   5. The ready bar uses Progress. When every item is done, show "Ready to submit" in team-green with a check icon.
   6. Empty: "No checklist items" / "Add one by hand." / "Add item".
   7. Preview: 24 items across all categories (standard, extracted with sources, one added by Amd 2), all done, and empty.

4. ORALS (design/v0/orals). Fix list against prompt 11.
   1. Always render the three sections "Orals rules", "Preparation checklist" and "Session plan", each with its own Add form (onAdd(category, item)) and its own empty text: "No rules found in the solicitation.", "No preparation items yet.", "No session topics yet."
   2. Rules have a "Reviewed" checkbox and a SourceLink when origin is ai, otherwise "Added by user". Every done control is a shadcn Checkbox labelled "Done: [item]".
   3. Prep items have a labelled Owner input (onEdit(id, { owner })).
   4. Session plan is a table: Topic (editable), Presenter (owner input), Minutes (number input), Done, with the footer "Total N minutes" in font-numeric.
   5. Inline item edit (onEdit(id, { item })), and a row menu with Open details and Delete through ConfirmDialog.
   6. Owner and minutes fields wrap under the text below 640 px, with no page scroll at 320 px.
   7. Preview: 4 rules, 6 prep items, 5 session topics, and empty.

5. LESSONS (design/v0/lessons). Fix list against prompt 12.
   1. saveStatus is FormStatus from @/types. Import Lesson and LessonsTabProps from @/types.
   2. Keep a local draft per card. "Save answer" is enabled only when the draft changed and calls onAnswer; never on every keystroke. While submitting, only the pressed card shows "Saving…" in a role="status" region, then the error message or "Saved.".
   3. The question is the visible Label of a shadcn Textarea.
   4. "Last updated Nov 20, 2026 by [author]", without "by" when author is null.
   5. Delete sits in a DropdownMenu and goes through ConfirmDialog "Delete this question?".
   6. The add form has the visible label "Add question or note", a shadcn Input, and the button "Add".
   7. The export button reads "Export DOCX". Add the intro line "Fill this in after submission or award. It helps the next bid."
   8. Empty: "No questions yet" / "Add a question or a note.", with an action that focuses the add input.
   9. One column, about 760 px max width.
   10. Preview: the seeded survey (What worked well?, What should we change next time?, What did the evaluators say?, Notes) partly answered, plus saving, error, and empty.

When done: push to v0/ui-screens, then list each folder you changed and the components in it.
````

---

## Round 3 (17 Oct 2026)

v0 did not push round 3. At the owner's request, Claude Code applied the round-3 fix text to `design/v0/shell`, `settings`, `compliance` and `documents` on branch `ui/v0-round2-batch1` (commits titled `design: <screen> fix round 3 (applied by Claude Code at the owner's request)`), then integrated them into `src/ui/`. This is a one-time exception to "never edit `design/v0`".

v0's next round must start from these files, not from its own earlier copies, or it will undo the fixes. Outline, Resumes, Reviews, Production, Orals and Lessons (Prompts B and C) are untouched.
