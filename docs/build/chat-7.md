# Chat 7: Mid-run integrations

**Builds:** plan phase 6. **Read:** BUILD-PLAN.md, handoffs/chat-6.md, `design/e2e/INVENTORY.md`, 02 s7, 04 s9 to s11, 05 s4.4 to s4.6, 05 s7, 07 s2 and s8, 09 s4.12 to s4.15, 08 Phase 6.

## Goal
Amendments, Q&A, request and collect, Drive, eBuy, the portal agent, and notifications work mid-run.

## PR list (proposed)
1. Contracts: comms, portal, drive, notify events and endpoints (09 s4.12 to s4.15).
2. Amendment re-entry: diff, reopen affected pages, re-gate, proposals for locked blocks. Screen from `design/e2e/` per BUILD-PLAN s10 (05 s4.4).
3. Comms: Gmail and Microsoft 365 connections per tenant; token storage per 07 s2. (fable-reviewer)
4. Q&A: questions in the required format, questionnaire fill, email draft, deadline alert, review both, send from the tenant mailbox. Screen from `design/e2e/` (05 s4.5).
5. Request and collect: format sent to the requestee, replies collected through the mailbox, upload option, status per item. Screen from `design/e2e/` (05 s4.6).
6. Drive: one folder per tenant, shared only with its users. (fable-reviewer)
7. eBuy watcher: inbound address per tenant, RFQ parse, bid opened, daily check. Inbound mail to an unknown address is dropped. (fable-reviewer)
8. Portal agent on its own host: human-approved login and MFA, no stored credentials, session wiped at end; SAM.gov upload or checklist only. (fable-reviewer)
9. Notifications and audit log. Notification screens from `design/e2e/` (05 s7).

## Done when (08 Phase 6)
- An amendment uploaded mid-draft reopens only the pages it touches.
- A Q&A email reaches a test inbox from a connected tenant mailbox after a user checks both review boxes.
- A request reply returns through the mailbox and marks its item received.
- One test tenant's eBuy notice opens a bid.
- The agent downloads a document from one portal with a human at the MFA step and leaves no stored credential.

The portal check needs a human at the MFA step, so it cannot complete inside the session. Build it against a local test portal in `packages/testing`, mark the real check "unverified: needs a human at MFA", and list it in the handoff.

## Owner steps
Test Gmail and Microsoft 365 mailboxes; one test eBuy tenant. Until they exist, the mailbox and eBuy checks run against a local SMTP and IMAP test double and are marked "unverified".
