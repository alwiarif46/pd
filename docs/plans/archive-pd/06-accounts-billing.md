# 06 — Accounts, Organizations, Plans, and Billing

**Status:** Draft v2 · 13 Oct 2026

## 1. Signup

1. User enters work email, name, password (12 characters or more), and mobile number.
2. Free email domains (gmail.com, outlook.com, yahoo.com, and a maintained list) are rejected with a message asking for a work email.
3. The app emails a verification link (valid 24 hours).
4. The app texts a 6-digit code through Telnyx (valid 10 minutes, 5 attempts, 3 sends per hour per number). US carriers require 10DLC campaign registration, or a verified toll-free number, before an app can send these. Registration takes days to weeks and must start in Phase 0. 🟨 **OPEN:** 10DLC campaign or toll-free number.
5. One phone number can verify one user account.
6. On success the user creates an organization or joins one through an invite.

**SMS pumping controls**, in addition to the per-number limit:
- Only +1 (US) numbers at launch.
- Daily send caps per IP address and per account. 🟨 **OPEN:** proposed 10 a day per IP address and 5 a day per account.
- Daily Telnyx spend alert (01 s5).

🟨 **OPEN:** one free organization per company email domain. Proposed: yes. A second person from the same domain joins the existing organization by invite, or upgrades.

## 2. Organizations and roles

| Role | Can |
|---|---|
| Owner | Everything, including billing, plan changes, member removal, organization deletion, amendment key overrides, file retention extensions |
| Member | Create and edit bids, upload documents, use tabs allowed by the plan |

- Seat limits: free 2, Starter 5, Growth 5. Invites beyond the limit are blocked with an upgrade message.
- The owner can transfer ownership to another member.
- Admin tooling is post-v1. In v1 Amaan adjusts plans, credits, and caps directly in the database when support needs it, and records each change in `audit_log`.

## 3. Plans

| | Free | Starter | Growth |
|---|---|---|---|
| RFPs per period | 2 in the first month, then 1 | 10 | 20 |
| Files per bid (all files added together) | 50 MB | 300 MB | 300 MB |
| Users | 2 | 5 | 5 |
| Tabs | Overview, Schedule, Compliance matrix | All | All |
| Files live on the server | 90 days from upload | Until the later of upload + 90 days and due date + 90 days; the owner can extend | Same as Starter |
| Archive after that | 🟨 **OPEN:** proposed 12 months, then deleted | 🟨 **OPEN:** proposed until the bid or organization is deleted | Same as Starter |
| Live storage quota per organization | 🟨 **OPEN:** proposed 200 MB | 🟨 **OPEN:** proposed 9 GB | 🟨 **OPEN:** proposed 18 GB |
| Unused RFPs | Reset | Reset | Reset |
| Price | ₹0 | 🟨 **OPEN** (provisional until Phase 6) | 🟨 **OPEN** (provisional until Phase 6) |

- There is no page cap. The MB cap per bid is the limit on files; the AI token budget per RFP is a second net (04 s6).
- Resumes are always deleted 90 days after upload and never archived (07 s2).
- The proposed storage quota is the bid cap times the RFPs that fit in the 90-day live window (Free 4 × 50 MB, Starter 30 × 300 MB, Growth 60 × 300 MB). Archived files do not count against it. It keeps one organization from filling the server disk (01 s5).
- Prices are set from measured cost per RFP. Any price drawn up after the model test is provisional until Phase 6 sets final prices (08).

**Periods:**
- Free: monthly periods from a start date. The first period starts at signup and allows 2 RFPs. Every later period allows 1.
- Return to free: when an organization moves back to the free plan (downgrade at period end, or final payment failure), a new free period starts on that date with an allowance of 1. It never gets the first-month 2 again.
- Day of month: when the start day does not exist in a month (29th to 31st), the period starts on that month's last day.
- Paid: the Stripe billing cycle.
- `rfp_credits` rows are the single source of truth for periods and credits. `organizations.cycle_start` and `cycle_end` are a cache.

## 4. RFP credit rule

- **Reserve, then consume.** Uploading a bid's first `solicitation` file reserves a credit (`rfp_credits.reserved`). The credit is consumed when the compliance matrix job succeeds; that is what "finishes processing" means. If processing fails, the reservation is released. If no credit is free to reserve, the upload is refused with the out-of-credits message.
- **One solicitation per bid.** A bid holds one `solicitation_key`, set from its first solicitation file. Another `solicitation` file must carry the same key. One with a different key is refused and the user is asked to start a new bid. A file with no number can be added as an attachment. This stops a new RFP being swapped into an old bid for free.
- **Same file, no charge.** Re-uploading a file with the same sha256 to the same bid never costs a credit.
- **Attachments and amendments are free.** They count against the bid's MB cap and the AI token budget per RFP (04 s6).
- **Amendment match.** The app compares the normalized solicitation number (`solicitation_key`) found in the amendment with the bid's key. If the number does not match or cannot be found, the app asks the user to start a new bid, which uses a credit.
- **Owner override.** For SLED addenda that omit the number, the bid owner can accept the amendment anyway with a written reason, logged in `audit_log`. Each bid allows a limited number of overrides. 🟨 **OPEN:** proposed 2 overrides per bid.
- Resumes and draft volumes for paid tabs do not use credits; they fall under the per-organization daily AI cap.
- A user can delete a bid. A consumed credit is not returned. A reserved credit is released.

## 5. Stripe

- Account: USD subscriptions, US card payments. Confirmed.
- Products: Starter and Growth, each with a monthly price in USD.
- Upgrade: Stripe Checkout. Plan changes and cancellation: Stripe Customer Portal, configured so downgrades and cancellations take effect at the end of the period.
- Webhooks handled: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
- Webhook signature checked on every call. Event IDs stored in `stripe_events`; duplicates are ignored.
- On every webhook the app fetches the current subscription from Stripe and derives plan and status from `subscription.status` plus the price. It never acts on the event type alone, because events can arrive out of order.
- Status rules: `active` = the paid plan. `past_due` = paid access continues while Stripe retries. `unpaid` or `canceled` = the free plan, with a new free period (section 3).
- Upgrade from free: a new paid period starts on the upgrade date with the full Starter or Growth allowance. Credits used on the free plan do not count against it.
- Starter to Growth mid-period: Stripe prorates the price, and the allowance rises to 20 for the current period, minus credits already used in it.
- Downgrade or cancellation: takes effect at the end of the paid period. Paid tabs become read-only; nothing is deleted.
- Seats after a move to free: the owner and the earliest-joined member keep access. Other members lose access until the owner removes members or upgrades again. In general, owners always hold a seat and take theirs first; members fill the rest of the plan's limit in the order they joined. Pending, unexpired invites count toward the limit when inviting.
- Failed payment: Stripe retries while the subscription is `past_due`. After the final failure the subscription becomes `unpaid` or `canceled` and the organization moves to the free plan.
- US sales tax: Shaavir checks its US sales against each state's economic-nexus thresholds every quarter. 🟨 **OPEN:** whether to turn on Stripe Tax, from launch or once a threshold is reached.

## Decision log

| Date | Decision |
|---|---|
| 13 Oct 2026 | Plans, seat limits, credit rule, Stripe monthly subscription per organization |
| 13 Oct 2026 | 10DLC registration added as a Phase 0 task |
| 13 Oct 2026 | MB cap per bid: 50 MB Free, 300 MB Starter and Growth; no page cap |
| 13 Oct 2026 | Attachments and amendments free, but count against the MB cap and token budget |
| 13 Oct 2026 | Credit reserved at upload, consumed when the compliance matrix succeeds, released on failure |
| 13 Oct 2026 | One solicitation_key per bid; same-sha256 re-upload never costs a credit |
| 13 Oct 2026 | Owner override for amendments without a number, reason logged, limited per bid |
| 13 Oct 2026 | Return to free starts a new period with 1 RFP; day of month clamped; `rfp_credits` is the source of truth |
| 13 Oct 2026 | Webhooks fetch the current subscription; `past_due` keeps paid access, `unpaid` or `canceled` moves to free; Portal downgrades at period end |
| 13 Oct 2026 | Stripe account (USD, US cards) confirmed |
| 13 Oct 2026 | SMS pumping controls: +1 numbers only, daily caps per IP and per account, Telnyx spend alert |
| 13 Oct 2026 | Sales tax: quarterly nexus check; Stripe Tax stays an open option |
| 13 Oct 2026 | Live file retention and archive per plan; prices provisional until Phase 6 |
| 13 Oct 2026 | Admin tooling post-v1; Amaan edits plans, credits, and caps in the database |
| 16 Oct 2026 | Seats: owners first, then members by join date; pending invites count toward the limit. Failed processing (scan, file, marking reject, classify, matrix) releases the reservation and leaves a retryable failed step; a file paused at the marking check keeps it until the user confirms or removes the file |
| 16 Oct 2026 | Invite accept (`POST /api/invites/accept`) checks the seat under the organization lock, reading memberships after the lock, so two accepts cannot take the last seat. Pending invites do not block an accept: the first to accept wins after a downgrade. A full organization answers 409 `seats_full` and the invite stays pending. One organization per account (409 `already_in_org`) |
