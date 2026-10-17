# Final review of the plan set (docs/00 to 09)

**Date:** 17 Oct 2026. Sources checked in order: DECISIONS-LATER.md, then PLAN-BRIEF.md, then every file in docs/.

**Verdict:** Fit to build. A Claude Code session can start Phase 0 and Phase 1 from these files alone. Every decision in DECISIONS-LATER.md appears in each file it touches, with no contradiction left. Inventions carry "Proposed" and an OPEN item. `plan/check.py` reports zero problems: no em dashes, no sentence over 30 words, every cross-reference resolves, every title in the "# NN: Title" form. No Shaavir staff is named; the GitHub account handle is gone too.

## What this pass found

The earlier passes had applied the Zitadel decision in 09 only. 00 still showed item 61 half closed, 03 kept PD's `sessions`, `auth_tokens`, and a home-grown `mfa_factors` table, and 01, 02, 05, 06, 07, and 08 said nothing about Zitadel. The credit release on failure or cancel was missing from 03 s9, 06 s8, and 08 Phase 2. "Render server" survived in 04 and 07 after the service rename. 09 s2 still carried the "Shared platform" heading the owner dropped. Redis Streams durability read as absolute. Nothing covered env vars, the local stack command, or migration order.

## Changes per file

| File | Changes in this pass |
|---|---|
| 00 | 09 row in the file table renamed and extended. Identity decision row names Zitadel. Item 61 set to the CLOSED form with references. Items 67 (Zitadel versus identity schema split) and 68 (Redis AOF loss window) added. Tabs reference fixed to 09 s7. GitHub handle replaced by neutral wording. Decision log entry |
| 01 | Zitadel container and its database added to the app role tree, the role table, and the backup row. Redis line gains `appendfsync everysec` and `noeviction`. Durability row now states the one-second loss window, the outbox as safety net, `XACK` after commit, reclaim of dead consumers, and `MAXLEN` trimming. python-docx floor set to 1.1 |
| 02 | Stack table gains an Identity row. Service diagram and PD reuse map say Zitadel replaces PD's password and session code. Auth routes become an OIDC flow with Zitadel-hosted screens. Code layout points to 09 s9 |
| 03 | `sessions`, `auth_tokens`, and `mfa_factors` dropped. `users` becomes a mirror keyed by Zitadel user id; `tenants` gains `zitadel_org_id`; `sso_connections` points at a Zitadel IdP. Split marked Proposed, item 67. `row_history` moved back to intel. Credit rule in s9 names the failure and cancel release |
| 04 | "Render server" renamed render service in three places |
| 05 | Sign-in row: Zitadel's hosted login serves the screens, Proposed |
| 06 | s1 states the identity service wraps Zitadel. Metering row names the failure and cancel release. "Owner first" reworded to the Admin |
| 07 | Render service row renamed. Sign-in row says Zitadel holds credentials and no E2E service stores a password. s11 adds the Zitadel AGPL note with a hedge to confirm the pinned release's license |
| 08 | Phase 0 lists Zitadel and MinIO in the local stack, a one-command boot, and the migration order. Phase 1 deploys Zitadel and retires PD's password code. Phase 2 release rule names failure and cancel. Identity row added to the testing table |
| 09 | s2 renamed Platform rules; Zitadel's database in the cluster; event acknowledgment, reclaim, and loss window stated; `e2e.` prefix convention noted. Service 2 row, 4.2 contract, and 4.8 stage list corrected. Gateway event names fixed. `infra/zitadel/` in the layout. New s9: local stack, environment variables, migration order, contracts and tests (Proposed) |

## OPEN items that block Phase 0 or Phase 1

None. Phase 0 and Phase 1 proceed on the decisions as written. Two items should settle before Phase 1 code lands, because they shape the identity schema and the event relay:

- Item 67: confirm the Proposed split between Zitadel's database and the identity schema (03 s2; 09 s4.2).
- Item 68: accept the one-second Redis loss window with the outbox relay as the safety net, or set `appendfsync always` and take the write cost (01 s4; 09 s2).

## Residual risks

- **Zitadel license.** Current releases carry AGPL-3.0. The plan pins a release and says to confirm its license file. Unmodified use behind our API carries no source duty; any patch does, and the Owner has agreed to publish.
- **Zitadel organization per tenant.** The mapping is one Zitadel organization to one `tenant_id`. Seat and invite logic stays in our schema, so two sources describe a user. The mirror must follow Zitadel events, or roles drift.
- **Redis Streams as the only bus.** Streams give no dead-letter queue and no schema registry. The plan covers both by convention (outbox, `XACK` after commit, reclaim, JSON schemas in `packages/contracts`). A missed convention shows up as a stuck consumer, which 01 s10 alerts on.
- **Field results in Word output.** Code computes numbering and writes results into the DOCX. A tenant who opens the DOCX in Word and presses F9 gets Word's recount, which should match but is not verified by the tool.
- **Metric-compatible fonts.** Line breaks hold in most cases, not all. A solicitation that names Times New Roman outright shows a substitute in the PDF font list (item 63).
- **Portal MFA assumptions.** login.gov on SAM.gov is known; PIEE and eBuy stay OPEN (item 52).
- **eBuy daily check** still needs a per-tenant login route without stored credentials (item 23).
- **Free proposal abuse controls** remain Proposed (item 66). The daily vendor review in 06 s3 is the backstop until they settle.
