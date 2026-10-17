# Chat 9: 10-RFP test and launch readiness

**Builds:** plan phases 9 and 10. **Read:** BUILD-PLAN.md, handoffs/chat-8.md, 08 Phases 9 and 10, 01 s1, s8 and s11 to s13, 06 s8, 07 s9, 09 s5 (`evals/`).

## Goal
At least 10 RFPs run end to end and meet the pass bar; the tool is ready to deploy.

## PR list (proposed)
1. Test harness in `evals/`: run the set, collect cost, time to each gate, pages at 90%, Red findings accepted, uncited claims caught, page count accuracy. The RFP set stays outside git; the harness reads it from a path in the environment.
2. Writer review sheet per package (submittable after review: yes or no, notes).
3. Fixes from the test, one PR each; rerun failing RFPs.
4. Cost cap value written into `app_settings` from measured cost. (fable-reviewer: money)
5. Deploy scripts against the chosen provider through PD's adapters (dry run only until the owner approves). (fable-reviewer)
6. Restore drill on the target host. (fable-reviewer)
7. Launch checklist: provider terms, hosting, beta, prices, final name, each with its status.

## Pass bar (decided)
Every package complete and page-verified, zero uncited claims, zero cross-tenant reads, and at least 8 of 10 rated submittable after review.

## Done when (08 Phase 9)
- At least 10 RFPs complete, and the pass bar holds.
- The cost cap value is written into `app_settings`.

## Done when (08 Phase 10; each waits on an owner step)
- The provider terms are in writing.
- Production runs on the chosen host, and the restore drill passes there.
- Beta runs reach the package, and measured cost per run fits under the plan prices.
- Prices are live in Stripe.

Phase 10 checks cannot pass inside the session. Build everything they need (deploy scripts, drill scripts, price records in Stripe test mode), mark each "unverified: waits on <owner step>", and list it in the last handoff.

## Owner steps
The test set with permission; writer reviews; zero-retention terms in writing; hosting choice; beta firms. Without the test set, the harness runs on the public fixtures only, and the Phase 9 checks are marked "unverified".

## End of the build
The last handoff lists what stays open for launch: provider terms, hosting, beta, prices, final name.
