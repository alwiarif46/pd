# 06: Accounts, Tenants, Plans, and Billing

**Status:** Draft v2 · 17 Oct 2026

E2E absorbs PD. Rules marked "from PD" carry over from PD's 06-accounts-billing.md. They hold unless the Owner changes them here.

## 1. Signup and tenants

**Sign-up and sign-in.** The identity service owns both (09 s4.2). It wraps self-hosted Zitadel, which holds passwords, MFA factors, passkeys, and the Google, Microsoft, and SAML providers. Our code keeps tenants, memberships, invites, and roles. The flow follows current multi-tenant practice.
1. The user enters a work email and name. Free email domains (gmail.com, outlook.com, yahoo.com, and a maintained list) get a refusal that asks for a work email, as in PD.
2. The tool emails a verification link, valid 24 hours.
3. The user sets a password and adds MFA: an authenticator app (TOTP) or a passkey. A passkey alone can replace the password and the second factor.
4. Google and Microsoft SSO are open on every plan. A Google or Microsoft work account replaces the email link and the password. The tool still requires MFA, which the provider's sign-in can satisfy.
5. Enterprise tenants can add SAML SSO and make it the only sign-in for their domain.
6. On success the user creates a tenant or joins one through an invite.

SMS verification is not required. PD's Telnyx step and its SMS pumping controls are dropped.

**Tenant creation.** The first user creates the tenant for their firm and becomes its Admin. The identity service issues its `tenant_id`; every other service keys its rows on it. Creating a tenant provisions everything it owns, scoped to it alone:

| Provisioned | Notes |
|---|---|
| Evidence store | Empty at start. Fills from uploads and filled NEEDs (03 s7) |
| Repository | Past sections, designs, graphics, and other proposal parts (02 s6) |
| Format specs and fonts | Preinstalled fonts available at once. Requested fonts belong to this tenant only |
| Shaavir Drive folder | Shared only with this tenant's users (02 s7) |
| Inbound eBuy address | For example `tenantname@in.<tool domain>` (02 s7) |
| Users | Admin plus invited Members |

Nothing in this list crosses tenants (07 s1). One user account belongs to one tenant, as in PD.

## 2. Roles

PD calls its top role "Owner". Here it is "Admin", so "Owner" in these plans means only the product owner.

| Role | Can |
|---|---|
| Admin | Everything a Member can, plus billing, plan changes, recharge approval, font requests, member invites and removal, email connections, Drive folder sharing, portal settings, tenant deletion |
| Member | Create bids, upload files, start runs inside the allowance, act at gates, review and send Q&A, send requests, download packages |

- Anything that charges money needs an Admin: a plan change, a recharge, or a font request.
- The Admin can hand the role to another Member (from PD).
- `audit_log` records every vendor support change to plans, allowances, or caps (from PD).
- 🟨 **OPEN:** whether Gate 1 and Gate 2 need a separate reviewer or approver role. The alternative is that any Member can act at a gate.
- 🟨 **OPEN:** whether a tenant can have more than one Admin.

## 3. Plans

| | Free proposal | Plan 3 | Plan 4 | Plan 5 | Enterprise |
|---|---|---|---|---|---|
| Price per month | 0 | 1800 | 2200 | 2500 | By discussion |
| Proposals | 1, once per tenant, never renewed | 3 a month | 4 a month | 5 a month | By discussion |
| Price per proposal (arithmetic) | 0 | 600 | 550 | 500 | n/a |
| Drafted pages per proposal | Up to 50 | Up to 100 | Up to 100 | Up to 100 | By discussion |
| Review rounds | All, inside the run | All, inside the run | All, inside the run | All, inside the run | Same |
| Pages beyond the cap | No recharge. The run drafts 50 pages and holds the rest until the tenant subscribes (Proposed) | Recharge (section 5) | Recharge | Recharge | By discussion |
| Unused proposals | Kept until used | Reset each month | Reset each month | Reset each month | By discussion |
| Users | 🟨 **OPEN** | 🟨 **OPEN** | 🟨 **OPEN** | 🟨 **OPEN** | By discussion |

- Plan names are working names. The product's working name is E2E Proposal; the final name is still open (00 s7).
- PD's Free, Starter, and Growth plans are dropped. E2E's plans replace them for every tenant, including PD's current organizations.
- 🟨 **OPEN:** currency. The plans assume USD. PD's Stripe account takes USD subscriptions and US card payments.
- 🟨 **OPEN:** Enterprise terms: price, allowance, page limit, seats, and any contract terms.
- **Free proposal.** Owner decision: every tenant gets one free proposal, once only, capped at 50 drafted pages. The proposal definition is otherwise the same (section 4). PD's Free plan does not carry over.

**Once-per-tenant controls for the free proposal.** All Proposed; details 🟨 **OPEN** (00 s7):

| Control | Rule |
|---|---|
| Verified domain | The free proposal belongs to the verified work-email domain, not to the tenant record. A second tenant on the same domain gets none. Free email domains never qualify (section 1) |
| Domain proof | The Admin's email link verifies the address. Proposed: an Admin can also prove the domain with a DNS TXT record, which merges tenants that share it |
| No payment needed | Signup needs no card. Proposed: a cap of 3 free-proposal signups per IP address and per /24 network a day |
| MFA | MFA by authenticator app or passkey is set before the free run starts, which raises the cost of throwaway accounts |
| One run | The free credit is reserved at run start like any credit. No-bid at Gate 0b releases it once. A second no-bid uses it up (Proposed) |
| Cost cap | The free run takes the per-run cost cap scaled to 50 pages (Proposed) |
| Review | The vendor sees every free run in a daily list and can revoke a credit the controls missed |

🟨 **OPEN:** domains that host many firms (shared hosting, consultants' umbrella domains), parent firms with several domains, and whether a free run ever needs a card on file.
- Periods follow the Stripe billing cycle (from PD).
- Unused proposals never carry into the next period.

## 4. Proposal credit rule

**One proposal** is one solicitation set: the solicitation, its amendments, and its attachments. It covers up to 100 drafted pages, with all review rounds inside the run.

What a proposal includes at no extra charge:
- Every amendment that matches the bid's solicitation key, and its re-entry into the run (04 s9).
- All review rounds: Red, re-draft, re-gate, Gold Team, and White Glove.
- Q&A drafting and request and collect for that bid.
- Re-uploading a file with the same sha256 to the same bid (from PD).

**Solicitation key (from PD):**
- A bid holds one `solicitation_key`, set from its first solicitation file.
- Another solicitation file must carry the same key. The tool refuses a file with a different key and asks the user to start a new bid.
- An amendment counts only when its solicitation number matches the key.
- For SLED addenda that omit the number, an Admin can accept the file anyway with a written reason. `audit_log` records the override. 🟨 **OPEN:** overrides allowed per bid (PD proposed 2).
- These rules stop anyone swapping a new RFP into an old bid for free.

**When the run uses a proposal.** PD reserves a credit at upload and consumes it when the compliance matrix succeeds. The tool's run is far longer, so the Owner set its own points:
- **Reserve** when the user starts the run, after the estimate (section 7).
- **Release** if the human picks no-bid at Gate 0b.
- **Release** if the run fails or is cancelled before the Red draft. Billing acts on `orchestrator.run.failed` or `orchestrator.run.cancelled`.
- **Consume** when the Red draft reaches the tenant at Gate 1. The review service emits `review.red.delivered`, and billing consumes the credit.

🟨 **OPEN:** a run that starts in one period and ends in the next. Proposed: it uses a proposal from the period in which it started.

The tenant's free proposal, if unused, is the first credit a run reserves. If no proposal is free when a run starts, the tool refuses the start. The message offers an upgrade or a wait for the next period.

## 5. Page allowance and recharge

- The 100-page allowance counts pages in the drafted volumes of one proposal, all volumes added together.
- A page re-drafted after Red, after an amendment, or in the sweep does not count again. Review rounds sit inside the run.
- Beyond 100 drafted pages, the proposal takes an additional recharge.
- An amendment that raises the page total above 100 triggers the same recharge.
- 🟨 **OPEN:** recharge rate, and its unit (per page or per block of pages).
- 🟨 **OPEN:** whether completed forms (SF 33, SF 1449, reps and certs, pricing sheets) and attachments (resumes, past performance forms, commitment letters, certificates) count toward the 100 pages.

**Approval.** A recharge charges money, so an Admin approves it (section 2).
- When the estimate shows more than 100 pages, the recharge appears as its own line. The run starts only after Admin approval.
- 🟨 **OPEN:** what happens when the outline or an amendment pushes the total past 100 mid-run. Proposed: the run drafts the first 100 pages and holds the rest until an Admin approves.

## 6. Font request fee

- Preinstalled fonts cost nothing. The Linux render service ships metric-compatible open fonts in place of Microsoft fonts, plus an open-licensed set (01 s5.4).
- Any other font comes through "request a font". Shaavir charges the tenant once for each request.
- A commercial font such as Times New Roman, Calibri, Cambria, or Garamond needs the tenant's own license. The request takes a font upload plus the tenant's license confirmation.
- The fee covers the request. It does not license the font.
- The vendor installs a requested font for that tenant only. Other tenants never see it.
- An Admin makes the request, since it carries a charge.
- 🟨 **OPEN:** fee amount.

## 7. Estimate before a run

Before a run starts, the tool shows a cost and time estimate. It works from the page count and the volume count.

| Line | Source |
|---|---|
| Volumes | The solicitation's submission instructions, read at intake with PD's extraction |
| Pages | The page limits per volume from the same instructions |
| Proposals used | One from the period's allowance |
| Recharge | Shown only when pages exceed 100 (section 5) |
| Expected run time | From page count and volume count (04 s12) |

- The estimate also checks expected model and image cost against the run's cost cap (section 8).
- The user sees the charge in proposals and any recharge. Internal model cost stays a vendor figure.
- 🟨 **OPEN:** how to estimate when the solicitation sets no page limit.
- 🟨 **OPEN:** whether the user sees the estimate again after an amendment changes page limits.

## 8. Cost cap and usage metering

**Cost cap.** Each run has a cost cap (01 s8). Model cost and image cost both count against it. That covers the drafter, the separate Red reviewer, the vision page check, the browser agent, and image provider calls.
- Cap value: set from the 10-RFP test (08 Phase 9).
- 🟨 **OPEN:** who may raise the cap. Proposed behavior at the cap (01 s8): the call that would pass the cap does not start. The run pauses with state saved, and the vendor and the Admin get an alert.
- 🟨 **OPEN:** whether the cap scales with the page count or a recharge.

**Usage metering.** The tool records usage per run, per stage, so it can check the cap, bill, and set prices from real cost (03 s9).

| Metered | Unit | Used for |
|---|---|---|
| Model calls | Input and output tokens, by model and stage | Cost cap, cost per proposal |
| Image calls | Images generated, by provider | Cost cap |
| Browser agent | Agent steps and tokens | Cost cap |
| Render and page verify | Pages rendered and checked | Capacity planning |
| Drafted pages | Pages per volume, per run | 100-page allowance, recharge |
| Proposals | Reserved at run start, consumed at the Red draft, released on no-bid or on a run that fails or is cancelled before the Red draft | Monthly allowance |
| Font requests | Requests per tenant | One-time fee |

- Metering rows belong to the tenant and the run. They never mix tenants.
- The Admin sees proposals used this period, pages per run, and any recharges. Token counts stay internal.

## 9. Stripe

Carried over from PD:
- Account: USD subscriptions and US card payments.
- Upgrade: Stripe Checkout. Plan changes and cancellation: Stripe Customer Portal. Downgrades and cancellations take effect at period end.
- Webhooks handled: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
- The tool checks the webhook signature on every call. Event IDs go in `stripe_events`, and the tool ignores duplicates.
- On every webhook the tool fetches the current subscription from Stripe. It derives plan and status from `subscription.status` plus the price, never from the event type alone. Events can arrive out of order.
- Moving up a plan mid-period: Stripe prorates the price. The allowance rises to the new plan's count, minus proposals already used in the period.
- `past_due`: access continues while Stripe retries.
- US sales tax: a quarterly check against each state's economic-nexus thresholds. 🟨 **OPEN:** whether to turn on Stripe Tax, from launch or once sales cross a threshold.

New for the tool:
- **Products.** Three monthly prices: Plan 3, Plan 4, Plan 5. Enterprise gets a custom price per tenant.
- **One-time charges.** The page recharge and the font request fee are one-time Stripe charges on the tenant's customer record.
- **Status after payment ends.** PD moved a lapsed organization to its free plan. E2E has no free plan, only the one free proposal, so `unpaid` or `canceled` stops new runs.
- 🟨 **OPEN:** what a lapsed tenant keeps: read access to bids, packages, and the repository, and for how long (07 s7).
- 🟨 **OPEN:** a run in flight when the subscription lapses. Proposed: it finishes, since its proposal is already reserved.
- 🟨 **OPEN:** seats after a downgrade. PD keeps its top role first, then members by join date; here that is the Admin. That rule fits once seat limits are set.

## Decision log

| Date | Decision |
|---|---|
| 17 Oct 2026 | Monthly plans: 1800 for 3 proposals, 2200 for 4, 2500 for 5. Enterprise by discussion. USD assumed |
| 17 Oct 2026 | Unused proposals reset every month |
| 17 Oct 2026 | One proposal is one solicitation set, up to 100 drafted pages, with all review rounds inside the run. Beyond 100 pages, a recharge |
| 17 Oct 2026 | Font request: one-time charge per request. A commercial font needs the tenant's license and a font upload. The fee does not license the font |
| 17 Oct 2026 | Cost and time estimate shown before a run, from page count and volume count |
| 17 Oct 2026 | Image and model cost count against the run's cost cap |
| 17 Oct 2026 | Signup, SMS controls, solicitation key rule, same-file rule, and Stripe webhook handling carry over from PD (signup and SMS later replaced, below) |
| 17 Oct 2026 | Tenant roles named Admin and Member. Anything that charges money needs an Admin |
| 17 Oct 2026 | Tenant creation provisions the tenant's own evidence store, repository, fonts, Drive folder, and inbound eBuy address |
| 17 Oct 2026 | Review pass: cost cap behavior aligned with 01 s8; font fee wording matched to the brief |
| 17 Oct 2026 | Owner decision: sign-in by work email with authenticator app or passkey MFA; Google and Microsoft SSO; SAML SSO for Enterprise. SMS and Telnyx dropped |
| 17 Oct 2026 | Owner decision: the identity service owns `tenant_id` |
| 17 Oct 2026 | Owner decision: a proposal credit is reserved at run start, released on no-bid, and consumed when the Red draft reaches the tenant |
| 17 Oct 2026 | Owner decision: the per-run cost cap comes from the 10-RFP test |
| 17 Oct 2026 | Owner decision: preinstalled fonts are metric-compatible open fonts on the Linux render service |
| 17 Oct 2026 | Owner update: E2E absorbs PD. PD's Free, Starter, and Growth plans are dropped for E2E's plans |
| 17 Oct 2026 | Owner decision: one free proposal per tenant, once only, capped at 50 drafted pages; once-per-tenant ties to the verified work-email domain; control details Proposed and OPEN |
| 17 Oct 2026 | Owner decision: a run that fails or is cancelled before the Red draft releases its credit (item 62 closed) |
| 17 Oct 2026 | Owner decision: self-hosted Zitadel behind the identity service holds credentials and MFA (item 61 closed) |
