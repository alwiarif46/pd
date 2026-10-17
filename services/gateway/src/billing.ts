import Stripe from 'stripe';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { addMonthsClamped, getDb, isUuid, PLAN_LIMITS, periodAllowance, type Plan, schema, withOrg } from '@pd/core';
import { BODY_REQUIRED, readBody, text } from './body.js';
import { requireAuth } from './context.js';
import { currentCreditPeriod, lockOrg } from './credits.js';
import { apiError } from './errors.js';
import type { Db } from './scope.js';

/*
 * Stripe billing (06 s5): Checkout to upgrade, the Customer Portal for changes and
 * cancellation, and a webhook that keeps the organization's plan, status, cycle cache, and
 * RFP credit periods in step with the subscription.
 *
 * The webhook never acts on the event type alone: for every handled event it fetches the
 * current subscription and applies that state, so events that arrive late or out of order end
 * in the same place. Every step compares against stored state, so a replay changes nothing.
 * Lock order: organizations (lockOrg) -> rfp_credits, as everywhere else (credits.ts).
 *
 * Never log secrets, signatures, or event payloads; event id and type are enough.
 */

/** The Stripe API version this code is written against; pinned with the `stripe` package. */
export const STRIPE_API_VERSION = '2026-08-26.dahlia' as const;

export const HANDLED_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

type PaidPlan = Exclude<Plan, 'free'>;
type OrgRow = typeof schema.organizations.$inferSelect;

export const BILLING_UNAVAILABLE = {
  error: 'Billing is not available yet.',
  code: 'billing_unavailable',
} as const;

export interface BillingConfig {
  secretKey: string;
  webhookSecret: string | null;
  prices: Record<PaidPlan, string>;
  /** The web app's origin, for Checkout and Portal return links. No trailing slash. */
  appUrl: string;
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * Billing settings from the environment, or null when Checkout cannot work: the secret key,
 * both price ids, and APP_URL are all needed. The webhook also needs STRIPE_WEBHOOK_SECRET.
 */
export function billingConfig(): BillingConfig | null {
  const secretKey = env('STRIPE_SECRET_KEY');
  const starter = env('STRIPE_PRICE_STARTER');
  const growth = env('STRIPE_PRICE_GROWTH');
  const appUrl = env('APP_URL').replace(/\/+$/, '');
  if (!secretKey || !starter || !growth || !appUrl) {
    return null;
  }
  return {
    secretKey,
    webhookSecret: env('STRIPE_WEBHOOK_SECRET') || null,
    prices: { starter, growth },
    appUrl,
  };
}

/** True when the owner can open Checkout and the Portal. Shown on GET /api/org. */
export function billingAvailable(): boolean {
  return billingConfig() !== null;
}

// ---------------------------------------------------------------------------
// The Stripe calls billing makes. Tests replace them with setBillingStripe().
// ---------------------------------------------------------------------------

export interface SubscriptionItemLike {
  price: { id: string };
  current_period_start?: number;
  current_period_end?: number;
}

export interface SubscriptionLike {
  id: string;
  status: string;
  customer: string | { id: string };
  metadata?: Record<string, string> | null;
  /** On older API versions; recent ones carry the period on each item instead. */
  current_period_start?: number;
  current_period_end?: number;
  items: { data: SubscriptionItemLike[] };
}

export interface EventLike {
  id: string;
  type: string;
  data: { object: unknown };
}

export interface CustomerLike {
  id: string;
  deleted?: boolean;
  metadata?: Record<string, string> | null;
}

export interface CheckoutInput {
  customerId: string;
  orgId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingStripe {
  /** Verifies the signature and parses the event; throws when the signature is bad. */
  constructEvent(payload: Buffer, signature: string, secret: string): EventLike;
  retrieveSubscription(id: string): Promise<SubscriptionLike>;
  retrieveCustomer(id: string): Promise<CustomerLike>;
  /**
   * The organization's customer. Two calls for one organization within Stripe's idempotency
   * window return the same customer.
   */
  createCustomer(input: { orgId: string; name: string }): Promise<{ id: string }>;
  /** True when the customer has a subscription that is not over (active, trialing, past_due, unpaid). */
  hasLiveSubscription(customerId: string): Promise<boolean>;
  /** Expires the customer's open Checkout Sessions, so an older tab cannot complete too. */
  expireOpenCheckoutSessions(customerId: string): Promise<number>;
  createCheckoutSession(input: CheckoutInput): Promise<{ url: string | null }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}

const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

function stripeAdapter(secretKey: string): BillingStripe {
  // Webhook work: Stripe retries the event anyway, so a few client retries are fine.
  const background = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 20_000 });
  // A person is waiting on Checkout and the Portal: fail fast, no retries.
  const interactive = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: 8_000 });
  return {
    constructEvent: (payload, signature, secret) => background.webhooks.constructEvent(payload, signature, secret),
    retrieveSubscription: async (id) => background.subscriptions.retrieve(id),
    retrieveCustomer: async (id) => {
      const customer = await background.customers.retrieve(id);
      return customer.deleted
        ? { id: customer.id, deleted: true, metadata: null }
        : { id: customer.id, deleted: false, metadata: customer.metadata };
    },
    createCustomer: async ({ orgId, name }) => {
      // Only fixed parameters go under the idempotency key (a renamed organization would
      // otherwise be refused as a key reuse with different parameters); the name follows.
      const customer = await interactive.customers.create(
        { metadata: { org_id: orgId } },
        { idempotencyKey: `pd-org-customer-${orgId}` },
      );
      await interactive.customers.update(customer.id, { name });
      return { id: customer.id };
    },
    hasLiveSubscription: async (customerId) => {
      const list = await interactive.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
      return list.data.some((subscription) => LIVE_STATUSES.has(subscription.status));
    },
    expireOpenCheckoutSessions: async (customerId) => {
      const open = await interactive.checkout.sessions.list({ customer: customerId, status: 'open', limit: 20 });
      for (const session of open.data) {
        await interactive.checkout.sessions.expire(session.id);
      }
      return open.data.length;
    },
    createCheckoutSession: async (input) => interactive.checkout.sessions.create({
      mode: 'subscription',
      customer: input.customerId,
      client_reference_id: input.orgId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      subscription_data: { metadata: { org_id: input.orgId } },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    }),
    createPortalSession: async ({ customerId, returnUrl }) => interactive.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    }),
  };
}

let override: BillingStripe | null = null;
let cached: { key: string; client: BillingStripe } | null = null;

/** Replaces the Stripe client (tests). Pass null to go back to the real one. */
export function setBillingStripe(client: BillingStripe | null): void {
  override = client;
}

function stripeClient(config: BillingConfig): BillingStripe {
  if (override) {
    return override;
  }
  if (cached?.key !== config.secretKey) {
    cached = { key: config.secretKey, client: stripeAdapter(config.secretKey) };
  }
  return cached.client;
}

// ---------------------------------------------------------------------------
// Subscription state -> plan, status, cycle
// ---------------------------------------------------------------------------

export type Target =
  | { kind: 'paid'; plan: PaidPlan; status: 'active' | 'past_due'; periodStart: Date | null; periodEnd: Date | null }
  | { kind: 'free' }
  /** Live, but on a price this deployment does not know: leave the organization as it is. */
  | { kind: 'unknown_price'; priceIds: string[] }
  /** Not settled yet (incomplete): leave the organization as it is. */
  | { kind: 'none' };

function fromUnix(seconds: number | undefined): Date | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

/** The current period, from the subscription or, on recent API versions, its first item. */
export function subscriptionPeriod(subscription: SubscriptionLike): { start: Date | null; end: Date | null } {
  const item = subscription.items.data.find((entry) => entry.current_period_end !== undefined) ?? subscription.items.data[0];
  return {
    start: fromUnix(subscription.current_period_start ?? item?.current_period_start),
    end: fromUnix(subscription.current_period_end ?? item?.current_period_end),
  };
}

/** Plan and status from `subscription.status` plus the price (06 s5). */
export function deriveTarget(subscription: SubscriptionLike, prices: Record<PaidPlan, string>): Target {
  switch (subscription.status) {
    case 'active':
    case 'trialing':
    case 'past_due': {
      const plan = subscription.items.data
        .map((item) => (item.price.id === prices.growth ? 'growth' : item.price.id === prices.starter ? 'starter' : null))
        .find((value): value is PaidPlan => value !== null);
      if (!plan) {
        // A price this deployment does not know (a new price in the dashboard, or a wrong env).
        // Retrying would not help; it is recorded for a person to fix.
        return { kind: 'unknown_price', priceIds: subscription.items.data.map((item) => item.price.id) };
      }
      const period = subscriptionPeriod(subscription);
      return {
        kind: 'paid',
        plan,
        status: subscription.status === 'past_due' ? 'past_due' : 'active',
        periodStart: period.start,
        periodEnd: period.end,
      };
    }
    case 'unpaid':
    case 'canceled':
    case 'incomplete_expired':
    case 'paused':
      return { kind: 'free' };
    default:
      return { kind: 'none' };
  }
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value) {
    return value;
  }
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

/** The subscription an event is about, or null when it is about none. */
export function subscriptionIdOf(event: EventLike): string | null {
  const object = (event.data?.object ?? {}) as Record<string, unknown>;
  if (event.type.startsWith('customer.subscription.')) {
    return idOf(object.id);
  }
  if (event.type === 'checkout.session.completed') {
    return idOf(object.subscription);
  }
  if (event.type.startsWith('invoice.')) {
    // Recent API versions move it to parent.subscription_details.subscription.
    const parent = object.parent as { subscription_details?: { subscription?: unknown } } | null | undefined;
    return idOf(object.subscription) ?? idOf(parent?.subscription_details?.subscription);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Applying a subscription to an organization
// ---------------------------------------------------------------------------

/** Ends the credit period that holds `now` at `now`. The caller holds lockOrg. */
async function closeCurrentPeriod(db: Db, orgId: string, now: Date): Promise<void> {
  await db.update(schema.rfpCredits).set({ periodEnd: now, updatedAt: now }).where(and(
    eq(schema.rfpCredits.orgId, orgId),
    lt(schema.rfpCredits.periodStart, now),
    gt(schema.rfpCredits.periodEnd, now),
  ));
}

export type ApplyResult =
  | 'applied'
  | 'unchanged'
  | 'org_not_found'
  | 'customer_mismatch'
  | 'stale_subscription'
  | 'second_live_subscription'
  | 'unknown_price'
  | 'not_settled';

/** The organization's stored subscription as Stripe reported it, fetched before the lock. */
export interface StoredSubscriptionCheck {
  id: string;
  /** Active, trialing, or past_due: it still gives the organization a paid plan. */
  live: boolean;
}

/** Thrown when the stored subscription changed between the check and the lock; Stripe retries. */
export class StoredSubscriptionChanged extends Error {}

/**
 * Brings the organization in line with one subscription's current state. Runs in withOrg
 * for `orgId`; locks the organization first, then touches rfp_credits. Makes no network calls:
 * anything it needs from Stripe is fetched before (`stored`).
 */
export async function applySubscription(
  db: Db,
  orgId: string,
  subscription: { id: string; customerId: string | null },
  target: Target,
  now: Date,
  stored: StoredSubscriptionCheck | null = null,
): Promise<ApplyResult> {
  const org = await lockOrg(db, orgId);
  if (!org) {
    return 'org_not_found';
  }
  if (!org.stripeCustomerId || org.stripeCustomerId !== subscription.customerId) {
    return 'customer_mismatch';
  }
  if (target.kind === 'none') {
    return 'not_settled';
  }
  if (target.kind === 'unknown_price') {
    await audit(db, orgId, 'billing.unknown_price', { subscriptionId: subscription.id, priceIds: target.priceIds });
    return 'unknown_price';
  }
  const other = org.stripeSubscriptionId && org.stripeSubscriptionId !== subscription.id ? org.stripeSubscriptionId : null;
  if (other && target.kind === 'free') {
    // An older subscription ended while the organization has another one: nothing to do.
    return 'stale_subscription';
  }
  if (other && target.kind === 'paid') {
    if (stored?.id !== other) {
      throw new StoredSubscriptionChanged('The stored subscription changed while the event was processed');
    }
    if (stored.live) {
      // Two live subscriptions on one customer. Cancelling one is a money decision for a person:
      // keep the stored one, record both, and leave Stripe alone.
      await audit(db, orgId, 'billing.second_live_subscription', { stored: other, incoming: subscription.id });
      return 'second_live_subscription';
    }
    // The stored one is over (its own event has not arrived yet): the new one takes its place.
  }
  const fromPaid = org.plan !== 'free';
  if (target.kind === 'free') {
    if (!fromPaid) {
      if (org.stripeSubscriptionId === subscription.id || org.planStatus !== 'free') {
        await updateOrg(db, org, { planStatus: 'free', stripeSubscriptionId: null }, now);
        return 'applied';
      }
      return 'unchanged';
    }
    // Paid -> free (06 s3 "Return to free"): the paid period ends now and a free period with an
    // allowance of 1 starts now. Its monthly periods count from now.
    const freeEnd = addMonthsClamped(now, 1);
    await closeCurrentPeriod(db, orgId, now);
    await db.insert(schema.rfpCredits).values({
      orgId,
      periodStart: now,
      periodEnd: freeEnd,
      allowed: periodAllowance('free', { isFirstPeriod: false, returningToFree: true }),
    });
    await updateOrg(db, org, {
      plan: 'free',
      planStatus: 'free',
      stripeSubscriptionId: null,
      cycleStart: now,
      cycleEnd: freeEnd,
    }, now);
    return 'applied';
  }

  const allowance = PLAN_LIMITS[target.plan].rfpCreditsPerMonth;
  if (!fromPaid) {
    // Free -> paid: a new paid period from now to the end of the Stripe cycle with the full
    // allowance. Credits used on the free plan do not count against it.
    await closeCurrentPeriod(db, orgId, now);
    if (target.periodEnd && target.periodEnd > now) {
      await db.insert(schema.rfpCredits).values({
        orgId,
        periodStart: now,
        periodEnd: target.periodEnd,
        allowed: allowance,
      });
    }
  } else if (org.plan !== target.plan) {
    // Plan change inside the period (Starter -> Growth): the current period's allowance becomes
    // the new plan's; credits already used stay used.
    const current = await currentCreditPeriod(db, orgId, now);
    if (current && current.allowed !== allowance) {
      await db.update(schema.rfpCredits).set({ allowed: allowance, updatedAt: now }).where(and(
        eq(schema.rfpCredits.id, current.id),
        eq(schema.rfpCredits.orgId, orgId),
      ));
    }
  }
  // Renewals only move the cycle cache; ensureCreditPeriod creates the next row when needed.
  const changed = await updateOrg(db, org, {
    plan: target.plan,
    planStatus: target.status,
    stripeSubscriptionId: subscription.id,
    cycleStart: target.periodStart ?? org.cycleStart,
    cycleEnd: target.periodEnd ?? org.cycleEnd,
  }, now);
  return changed || !fromPaid ? 'applied' : 'unchanged';
}

async function audit(db: Db, orgId: string, action: string, detail: Record<string, unknown>): Promise<void> {
  await db.insert(schema.auditLog).values({ orgId, action, targetType: 'stripe_subscription', detail });
}

type OrgPatch = Partial<Pick<OrgRow, 'plan' | 'planStatus' | 'stripeSubscriptionId' | 'cycleStart' | 'cycleEnd'>>;

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

/** Writes only the fields that differ; returns whether anything was written. */
async function updateOrg(db: Db, org: OrgRow, patch: OrgPatch, now: Date): Promise<boolean> {
  const changes = Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => !same(org[key as keyof OrgPatch], value)),
  ) as OrgPatch;
  if (Object.keys(changes).length === 0) {
    return false;
  }
  await db.update(schema.organizations).set({ ...changes, updatedAt: now }).where(eq(schema.organizations.id, org.id));
  return true;
}

/**
 * Fetches the event's subscription and applies it. Returns what happened, for the log. Every
 * Stripe call happens before the organization row is locked.
 */
async function processEvent(
  stripe: BillingStripe,
  config: BillingConfig,
  event: EventLike,
  log: FastifyBaseLogger,
): Promise<string> {
  if (!HANDLED_EVENTS.has(event.type)) {
    return 'ignored_type';
  }
  const subscriptionId = subscriptionIdOf(event);
  if (!subscriptionId) {
    return 'no_subscription';
  }
  const subscription = await stripe.retrieveSubscription(subscriptionId);
  const customerId = idOf(subscription.customer);
  let orgId = subscription.metadata?.org_id ?? null;
  if (!orgId && customerId) {
    const customer = await stripe.retrieveCustomer(customerId);
    orgId = customer.deleted ? null : customer.metadata?.org_id ?? null;
  }
  if (!orgId || !isUuid(orgId)) {
    return 'no_org';
  }
  const target = deriveTarget(subscription, config.prices);
  const id = orgId;
  let stored: StoredSubscriptionCheck | null = null;
  if (target.kind === 'paid') {
    // A different stored subscription: is it still live? Asked now, not under the lock.
    const current = await withOrg(id, async (db) => {
      const [row] = await db.select({ subscriptionId: schema.organizations.stripeSubscriptionId })
        .from(schema.organizations).where(eq(schema.organizations.id, id));
      return row?.subscriptionId ?? null;
    });
    if (current && current !== subscription.id) {
      const other = await stripe.retrieveSubscription(current);
      stored = { id: current, live: other.status === 'active' || other.status === 'trialing' || other.status === 'past_due' };
    }
  }
  const outcome = await withOrg(id, (db) => applySubscription(db, id, { id: subscription.id, customerId }, target, new Date(), stored));
  if (outcome === 'unknown_price' && target.kind === 'unknown_price') {
    log.error({ eventId: event.id, subscriptionId: subscription.id, priceIds: target.priceIds }, 'stripe subscription has an unknown price');
  } else if (outcome === 'second_live_subscription') {
    log.error(
      { eventId: event.id, storedSubscriptionId: stored?.id, incomingSubscriptionId: subscription.id },
      'organization has two live Stripe subscriptions; cancel the extra one in Stripe',
    );
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function ownerOnly(request: FastifyRequest, reply: FastifyReply): FastifyReply | null {
  if (request.auth?.role !== 'owner') {
    return reply.code(403).send(apiError('owner_only'));
  }
  return null;
}

export async function registerBilling(app: FastifyInstance): Promise<void> {
  app.post('/api/billing/checkout', { preHandler: requireAuth }, async (request, reply) => {
    const denied = ownerOnly(request, reply);
    if (denied) {
      return denied;
    }
    const config = billingConfig();
    if (!config) {
      return reply.code(503).send(BILLING_UNAVAILABLE);
    }
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(BODY_REQUIRED);
    }
    const plan = text(body, 'plan');
    if (plan !== 'starter' && plan !== 'growth') {
      return reply.code(400).send({ error: 'Choose the Starter or Growth plan' });
    }
    const orgId = request.auth!.orgId!;
    const stripe = stripeClient(config);
    const exists = { error: 'This organization already has a subscription. Use Manage billing to change it.', code: 'subscription_exists' };
    // No Stripe call is made while the organization row is locked: read, call Stripe, then
    // store the customer id only if none was stored meanwhile.
    const org = await withOrg(orgId, async (db) => {
      const [row] = await db.select({
        name: schema.organizations.name,
        plan: schema.organizations.plan,
        planStatus: schema.organizations.planStatus,
        stripeCustomerId: schema.organizations.stripeCustomerId,
      }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
      return row ?? null;
    });
    if (!org) {
      return reply.code(404).send({ error: 'Organization not found' });
    }
    if (org.plan !== 'free' || org.planStatus !== 'free') {
      return reply.code(409).send(exists);
    }
    let customerId = org.stripeCustomerId;
    if (customerId) {
      if (await stripe.hasLiveSubscription(customerId)) {
        return reply.code(409).send(exists);
      }
    } else {
      const created = (await stripe.createCustomer({ orgId, name: org.name })).id;
      customerId = await withOrg(orgId, async (db) => {
        const [claimed] = await db.update(schema.organizations).set({ stripeCustomerId: created, updatedAt: new Date() })
          .where(and(eq(schema.organizations.id, orgId), isNull(schema.organizations.stripeCustomerId)))
          .returning({ id: schema.organizations.stripeCustomerId });
        if (claimed) {
          return created;
        }
        // Another request stored one first (the idempotency key makes it the same customer).
        const [row] = await db.select({ id: schema.organizations.stripeCustomerId })
          .from(schema.organizations).where(eq(schema.organizations.id, orgId));
        return row?.id ?? created;
      });
    }
    // An earlier tab or a stale session must not be able to complete as well.
    await stripe.expireOpenCheckoutSessions(customerId);
    const session = await stripe.createCheckoutSession({
      customerId,
      orgId,
      priceId: config.prices[plan],
      successUrl: `${config.appUrl}/#/org?billing=success`,
      cancelUrl: `${config.appUrl}/#/org?billing=cancelled`,
    });
    if (!session.url) {
      throw new Error('Stripe returned a Checkout Session without a url');
    }
    return { url: session.url };
  });

  app.post('/api/billing/portal', { preHandler: requireAuth }, async (request, reply) => {
    const denied = ownerOnly(request, reply);
    if (denied) {
      return denied;
    }
    const config = billingConfig();
    if (!config) {
      return reply.code(503).send(BILLING_UNAVAILABLE);
    }
    const orgId = request.auth!.orgId!;
    const customerId = await withOrg(orgId, async (db) => {
      const [org] = await db.select({ customerId: schema.organizations.stripeCustomerId })
        .from(schema.organizations).where(eq(schema.organizations.id, orgId));
      return org?.customerId ?? null;
    });
    if (!customerId) {
      return reply.code(409).send({ error: 'There is no billing account yet. Upgrade first.', code: 'no_billing_account' });
    }
    const session = await stripeClient(config).createPortalSession({ customerId, returnUrl: `${config.appUrl}/#/org` });
    return { url: session.url };
  });

  // The webhook needs the exact bytes Stripe signed, so JSON parsing is turned off for it alone,
  // inside its own encapsulated plugin.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
    scope.post('/api/billing/webhook', async (request, reply) => {
      const config = billingConfig();
      if (!config?.webhookSecret) {
        return reply.code(503).send(BILLING_UNAVAILABLE);
      }
      const signature = request.headers['stripe-signature'];
      if (typeof signature !== 'string' || !Buffer.isBuffer(request.body)) {
        return reply.code(400).send({ error: 'Invalid signature' });
      }
      const stripe = stripeClient(config);
      let event: EventLike;
      try {
        event = stripe.constructEvent(request.body, signature, config.webhookSecret);
      } catch {
        return reply.code(400).send({ error: 'Invalid signature' });
      }
      // stripe_events has no org_id and no row-level security.
      const db = getDb();
      await db.insert(schema.stripeEvents).values({ eventId: event.id, type: event.type, receivedAt: new Date() })
        .onConflictDoNothing({ target: schema.stripeEvents.eventId });
      const [stored] = await db.select({ processedAt: schema.stripeEvents.processedAt })
        .from(schema.stripeEvents).where(eq(schema.stripeEvents.eventId, event.id));
      if (stored?.processedAt) {
        return { received: true };
      }
      try {
        const outcome = await processEvent(stripe, config, event, request.log);
        await db.update(schema.stripeEvents).set({ processedAt: new Date(), updatedAt: new Date() }).where(and(
          eq(schema.stripeEvents.eventId, event.id),
          isNull(schema.stripeEvents.processedAt),
        ));
        request.log.info({ eventId: event.id, type: event.type, outcome }, 'stripe event');
        return { received: true };
      } catch (error) {
        // 500 so Stripe retries. The message only: no payload, no signature.
        request.log.error({ eventId: event.id, type: event.type, message: error instanceof Error ? error.message : 'unknown' }, 'stripe event failed');
        return reply.code(500).send({ error: 'The event could not be processed' });
      }
    });
  });
}
