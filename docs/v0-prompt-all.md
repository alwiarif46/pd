# v0: build the whole front end in one chat

Use this instead of the 12 separate chats in docs/v0-prompts.md. It needs branch `v0-ui` at a469b59 or later, which holds the contracts, the prompts and the shadcn components. If v0 stops before the end, open a new chat and paste the same prompt; it resumes at the first unfinished screen.

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

TASK: Build every remaining screen of the PD web app in shadcn/ui + Tailwind, as presentational components, in one run.

WHERE
- Branch v0-ui only. Write only under design/v0/<folder>/, one folder per screen group. Never touch apps/, docs/, packages/, config files, AGENTS.md, design/v0/README.md, design/v0/auth/.
- Folders, in the order of docs/v0-prompts.md sections 1 to 12: shell; common; bids (update the existing folder); compliance; overview; documents and settings; organization, account and privacy; outline; resumes; reviews; production and orals; lessons. Use exactly the folder and file names each section's WHERE gives.

HOW
1. Read first: AGENTS.md; design/v0/README.md (where it differs from docs/plans/09-ui-workflow.md section 5, section 5 wins); docs/plans/05-ui.md in full; docs/plans/09-ui-workflow.md sections 4, 5 and 6; docs/v0-prompts.md in full. design/v0/auth/ is a finished screen: match its quality, structure and style.
2. docs/v0-prompts.md has one numbered section per screen group (1 to 12). Work through them in order. For each group, follow its WHERE, HOW and WHAT exactly, as if it had been pasted on its own. Its WHAT section is the spec for that screen: labels, columns, button text, messages, states and sample data.
3. Contracts: implement the 09 section 5 contract for each component exactly. Keep the component names, prop names, types and callback signatures. Do not add, rename or make optional any prop.
4. Types: Tab and AuthStatus come from @/types. Every other contract type is not in @/types yet. Copy it word for word into the types.ts of the folder whose chat introduces it (the shared 5.12 types go in design/v0/common/types.ts, the shell types in design/v0/shell/types.ts). Later folders import those types and shared components relatively from design/v0/common/ and design/v0/shell/ (for example `import { TabFrame } from '../common/TabFrame'`, `import type { FormStatus } from '../common/types'`), not from @/ui or @/types. The per-chat prompts say @/ui/common and @/ui/shell; in this run, use the relative design/v0 paths instead. Never redefine a type that an earlier folder already defines.
5. shadcn: import from @/components/ui/<name>. Available: button input label select checkbox table dialog sheet tabs badge dropdown-menu tooltip sonner alert-dialog textarea switch progress skeleton separator. If a screen truly needs another one, use the closest available one and list the missing one in your final summary. Do not add files under apps/.
6. Each folder gets a Preview.tsx that renders every component in every state listed in its prompt, with sample data from sample-data.ts, at desktop, tablet and phone widths. Callbacks log to the console.
7. Every screen meets 05 section 5: keyboard reachable with a visible focus ring, WCAG AA contrast, labels on every input, Esc closes overlays and returns focus, crossed-out rows also carry a text label, tables scroll inside their own container, and no horizontal page scroll at 320 px. Dates arrive as ISO strings and are formatted in the component. Every AI-extracted row shows a source control.
8. The Schedule tab is not part of this run (Claude Code ports it). The shell must give it the full content width and height.
9. Commit and push to v0-ui after EACH numbered section is complete, with the message "design(v0): <folders>". Do not wait until the end.
10. Before starting, check which sections' folders already exist on v0-ui with a Preview.tsx and match their prompt. Skip those and continue with the first one that is missing or incomplete. That lets this prompt resume in a new chat.

WHAT
Exactly what docs/v0-prompts.md sections 1 to 12 specify, read with the changes in HOW above. Copy: sentence case, verb-first buttons, no exclamation marks. Where a value is still open in the plans (prices, archive lifetime, restore window), show "To be confirmed" or make no claim. Never invent numbers.

When done (or if you must stop): push to branch v0-ui only. Then list every folder you built, the components in each, the types file that holds each contract, any shadcn component you needed but did not have, and which numbered sections of docs/v0-prompts.md are still not built.
````
