# Chat 5: Drafting

**Builds:** plan phase 4. **Read:** BUILD-PLAN.md, handoffs/chat-4.md, `design/e2e/INVENTORY.md`, 04 s3, s5.5 to s5.15, s7.1, 07 s5, 09 s4.8, 08 Phase 4. The stripped skill copies and their review are reference only; the owner rebuilds stage skills later, so keep every skill behind the stage interface.

## Goal
Every volume drafts with page gates at 90%, citations or NEEDs on every claim, and graphics.

## PR list (proposed)
1. Contracts: drafting events and endpoints (09 s4.8).
2. Worksheet and outline stages inside the locked format and shells.
3. Evidence pull, case vignettes, agency intel stages.
4. Page-gated drafting in parallel by volume and section; re-draft and re-gate on failure.
5. Prose checks before each gate score: kill words, plain language, term mirror, customer focus, strength test, story placement.
6. NEED register; drafting never waits on the user; the model never fills a NEED.
7. Claims and citations; uncited claim detection.
8. Graphics: SVG through render; image provider for illustrative art only.
9. Executive summary; pricing narrative (skill suggests, human approves).
10. Pink review document download from the run monitor. Screen changes from `design/e2e/` per BUILD-PLAN s10.

## Done when (08 Phase 4)
- On two test RFPs every page reaches 90% or carries a reason.
- Every claim has a citation or a NEED.
- A page that fails the gate re-drafts and re-gates on its own.

Two test RFPs means the sample in `evals/fixtures/sample-rfp-77344426Q0100/` plus one more public RFP added in this chat. Live model calls need the Anthropic key; without it, the checks run on the recorded stub and are marked "unverified".

## Owner step
Image provider key. Until then, graphics use SVG only and log the gap.
