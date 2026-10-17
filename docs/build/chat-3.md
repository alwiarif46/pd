# Chat 3: Orchestrator, model gateway, evidence, credit ledger, intake

**Builds:** plan phase 2. **Read:** BUILD-PLAN.md, handoffs/chat-2.md, `design/e2e/INVENTORY.md`, 01 s3 and s8, 02 s4, 03 s4, s7 and s9. Also 04 s1 to s6 and s12, 05 s4.1 to s4.3, 06 s4, 07 s4, 08 Phase 2.

## Goal
A run starts from soft intake, flows through amendment gate, shred and compliance matrix as orchestrated stages, and holds at Gate 0b, with resume and the credit ledger working.

## PR list (proposed)
1. Contracts: run, stage, gate, ledger, evidence events (`orchestrator.run.*` and the rest in 09 s4.6, s4.7, s4.11, s4.3).
2. Orchestrator: run state machine, stage records, idempotency keys, leases, retries, resume, gates; outbox relay to Redis Streams with consumer groups, XACK after commit, reclaim (09 s2). (fable-reviewer: concurrency and tenant_id on events)
3. Stage interface with today's skills as placeholders (02 s4; format lock before outline, 04 s3). Amendment gate, shred, and compliance matrix run as orchestrated stages through it (04 s5.2, s5.3).
4. Model gateway: Anthropic adapter, rate buckets, metering, `ai_runs`, run budget, pause at the cap (high placeholder value in `app_settings`). (fable-reviewer: keys and money)
5. Evidence and repository: store and fetch by agency, factor, section type, contract, date; pgvector; past-proposal import. (fable-reviewer: tenant isolation)
6. Credit ledger without Stripe: reserve at run start; release on no-bid, failed run, cancelled run; consume at Red draft delivery (wired in chat 6). (fable-reviewer)
7. Soft intake screen: "We already have this", "We still need this", estimate panel, Start run; AI-ban flag that lets the run continue. From `design/e2e/` per BUILD-PLAN s10.
8. Bid/no-bid screen, run monitor, with the states in 05 s8. From `design/e2e/` per BUILD-PLAN s10.

## Done when (08 Phase 2)
- A tenant sees intake with items fetched from its repository.
- An AI-ban clause in a test solicitation raises the flag, and the run goes on to Gate 0b.
- The run reaches Gate 0b and holds. No-bid releases the reserved credit, and so does a cancelled run and a failed run.
- Killing the orchestrator mid-stage and restarting resumes from the saved stage with no duplicate output.
- Proposed: two tenants' runs never read each other's repository rows (test).

## Owner step
Anthropic API key in the cloud environment. Until then, the model gateway runs against a recorded-response stub (BUILD-PLAN s8, stub rule), and the intake and AI-ban checks are marked "unverified" if they needed a live call.
