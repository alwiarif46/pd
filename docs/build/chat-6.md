# Chat 6: Reviews, gates, locks, package

**Builds:** plan phase 5. **Read:** BUILD-PLAN.md, handoffs/chat-5.md, `design/e2e/INVENTORY.md`, 04 s5.16 to s5.22, s6 to s8, 05 s4.7 to s4.10, 06 s4, 09 s4.9, 08 Phase 5.

## Goal
One full run from upload to a downloadable package, with only gate actions from a person.

## PR list (proposed)
1. Contracts: review events and endpoints (09 s4.9); `review.red.delivered`.
2. Red review by a separate reviewer model; side-by-side test on the sample RFPs to propose the model. The reviewer-differs-from-drafter check in the model gateway (09 s4.7).
3. Gate 1 screen: findings, NEEDs ranked by score impact, predicted rating per factor, dispositions. From `design/e2e/` per BUILD-PLAN s10.
4. Credit consumed when the Red draft reaches the tenant. (fable-reviewer)
5. Locks: every human-edited block locked; re-drafts write around it; model changes arrive as proposals; the sweep obeys locks; the database trigger in 03 s5. (fable-reviewer: data integrity)
6. Apply dispositions, re-draft flagged pages, re-gate, cross-volume sweep, assembly.
7. Gold Team and White Glove review; Gate 2 screen with the round diff. From `design/e2e/` per BUILD-PLAN s10.
8. Final package: Word and PDF volumes, forms, attachments, compliance matrix, submission checklist, file naming; signature and review notice; Word-only page-limit note; uncited claims block assembly. Package screen from `design/e2e/`.

## Done when (08 Phase 5)
- One full run goes from upload to package with only gate actions from a person.
- The credit moves from reserved to consumed at Gate 1, and not before.
- A locked block survives a re-draft unchanged, and a model change to it appears as a proposal.
- An uncited claim stops assembly.
- The package names files by the solicitation's rule.

## Expected end-of-chat question
The reviewer model, with the side-by-side results. Until the owner answers, the reviewer model is the one that scored best in the side-by-side, recorded in `app_settings`.
