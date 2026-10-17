import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { closeDb, getDb, getPool, schema, withOrg } from '@pd/core';
import {
  type BillingStripe,
  type CheckoutInput,
  type CustomerLike,
  type EventLike,
  setBillingStripe,
  type SubscriptionLike,
} from '../src/billing.js';
import { as, createUser } from './helpers.js';

const unavailable = inject('dbUnavailable');
const DAY = 24 * 60 * 60 * 1000;
const WEBHOOK_SECRET = 'whsec_test_secret';
const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_GROWTH: 'price_growth',
  APP_URL: 'https://app.example.com/',
} as const;

// The real SDK signs and verifies, so the test proves the webhook gets Stripe's exact bytes.
const sdk = new Stripe('sk_test_x');

/** Stripe stand-in: subscriptions and customers held in memory, real signature checks. */
class FakeStripe implements BillingStripe {
  subscriptions = new Map<string, SubscriptionLike>();
  customers = new Map<string, CustomerLike>();
  checkouts: CheckoutInput[] = [];
  portals: { customerId: string; returnUrl: string }[] = [];
  live = new Set<string>();
  failNextRetrieve = false;

  constructEvent(payload: Buffer, signature: string, secret: string): EventLike {
    return sdk.webhooks.constructEvent(payload, signature, secret) as unknown as EventLike;
  }

  async retrieveSubscription(id: string): Promise<SubscriptionLike> {
    if (this.failNextRetrieve) {
      this.failNextRetrieve = false;
      throw new Error('Stripe is down');
    }
    const subscription = this.subscriptions.get(id);
    if (!subscription) {
      throw new Error(`No such subscription: ${id}`);
    }
    return structuredClone(subscription);
  }

  async retrieveCustomer(id: string): Promise<CustomerLike> {
    return this.customers.get(id) ?? { id, deleted: true };
  }

  /** Runs inside createCustomer, after Stripe "created" it (to stage a race). */
  onCreateCustomer: ((orgId: string) => Promise<void>) | null = null;
  /** Stripe calls in order, for checking what happens before what. */
  calls: string[] = [];

  async createCustomer(input: { orgId: string; name: string }): Promise<{ id: string }> {
    const id = `cus_${randomBytes(6).toString('hex')}`;
    this.customers.set(id, { id, metadata: { org_id: input.orgId } });
    this.calls.push('createCustomer');
    await this.onCreateCustomer?.(input.orgId);
    return { id };
  }

  async hasLiveSubscription(customerId: string): Promise<boolean> {
    this.calls.push('hasLiveSubscription');
    return this.live.has(customerId);
  }

  async expireOpenCheckoutSessions(customerId: string): Promise<number> {
    this.calls.push(`expire:${customerId}`);
    return 0;
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string | null }> {
    this.calls.push(`checkout:${input.customerId}`);
    this.checkouts.push(input);
    return { url: `https://checkout.stripe.test/${this.checkouts.length}` };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    this.portals.push(input);
    return { url: 'https://billing.stripe.test/portal' };
  }
}

function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

interface SubInput {
  status: string;
  price: 'price_starter' | 'price_growth' | string;
  customer: string;
  orgId?: string | null;
  start?: Date;
  end?: Date;
  /** Older API versions: the period on the subscription instead of its items. */
  legacyPeriod?: boolean;
}

function subscription(id: string, input: SubInput): SubscriptionLike {
  const start = input.start ?? new Date(Date.now() - 60_000);
  const end = input.end ?? new Date(Date.now() + 30 * DAY);
  const period = { current_period_start: unix(start), current_period_end: unix(end) };
  return {
    id,
    status: input.status,
    customer: input.customer,
    metadata: input.orgId === null ? {} : { org_id: input.orgId ?? '' },
    ...(input.legacyPeriod ? period : {}),
    items: { data: [{ price: { id: input.price }, ...(input.legacyPeriod ? {} : period) }] },
  };
}

describe.skipIf(Boolean(unavailable))('billing', () => {
  let app: FastifyInstance;
  let fake: FakeStripe;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of Object.keys(ENV)) {
      saved[key] = process.env[key];
    }
    getPool({ connectionString: inject('appUrl'), max: 6 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
  });

  beforeEach(() => {
    Object.assign(process.env, ENV);
    fake = new FakeStripe();
    setBillingStripe(fake);
  });

  afterEach(() => {
    setBillingStripe(null);
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await app?.close();
    await closeDb();
  });

  async function newOrg(label: string) {
    const owner = await createUser(`${label}-owner`);
    const call = as(app, owner.token);
    const created = await call('POST', '/api/org', { name: `Org ${label}` });
    expect(created.statusCode).toBe(201);
    const orgId = created.json<{ id: string }>().id;
    const member = await createUser(`${label}-member`);
    await withOrg(orgId, (db) => db.insert(schema.memberships).values({ orgId, userId: member.userId, role: 'member' }));
    return { orgId, call, memberCall: as(app, member.token), ownerToken: owner.token };
  }

  /** An organization whose owner went through Checkout, so it has a Stripe customer. */
  async function customerOrg(label: string) {
    const org = await newOrg(label);
    const response = await org.call('POST', '/api/billing/checkout', { plan: 'starter' });
    expect(response.statusCode).toBe(200);
    const customerId = await withOrg(org.orgId, async (db) => {
      const [row] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, org.orgId));
      return row.stripeCustomerId!;
    });
    return { ...org, customerId };
  }

  function send(
    event: { id?: string; type: string; object: Record<string, unknown> },
    signature?: string,
    options: { contentType?: string; signedAt?: number } = {},
  ) {
    const payload = JSON.stringify({
      id: event.id ?? `evt_${randomBytes(8).toString('hex')}`,
      object: 'event',
      type: event.type,
      data: { object: event.object },
    });
    return app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: {
        'content-type': options.contentType ?? 'application/json',
        'stripe-signature': signature ?? sdk.webhooks.generateTestHeaderString({
          payload,
          secret: WEBHOOK_SECRET,
          ...(options.signedAt === undefined ? {} : { timestamp: options.signedAt }),
        }),
      },
      payload,
    });
  }

  async function auditRows(orgId: string, action: string) {
    return withOrg(orgId, (db) => db.select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action))));
  }

  function subscriptionEvent(type: string, subscriptionId: string, id?: string) {
    return send({ id, type, object: { id: subscriptionId, object: 'subscription' } });
  }

  async function orgRow(orgId: string) {
    return withOrg(orgId, async (db) => {
      const [row] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
      return row;
    });
  }

  async function creditRows(orgId: string) {
    return withOrg(orgId, (db) => db.select().from(schema.rfpCredits)
      .where(eq(schema.rfpCredits.orgId, orgId)).orderBy(schema.rfpCredits.periodStart));
  }

  async function currentRow(orgId: string) {
    const now = Date.now();
    const rows = await creditRows(orgId);
    return rows.filter((row) => row.periodStart.getTime() <= now && row.periodEnd.getTime() > now).at(-1) ?? null;
  }

  async function seedFreePeriod(orgId: string, used: number) {
    await withOrg(orgId, (db) => db.insert(schema.rfpCredits).values({
      orgId,
      periodStart: new Date(Date.now() - DAY),
      periodEnd: new Date(Date.now() + 29 * DAY),
      allowed: 2,
      used,
    }));
  }

  async function processedAt(eventId: string) {
    const [row] = await getDb().select().from(schema.stripeEvents).where(eq(schema.stripeEvents.eventId, eventId));
    return row?.processedAt ?? null;
  }

  // -------------------------------------------------------------------------
  // Configuration and access
  // -------------------------------------------------------------------------

  it('answers 503 billing_unavailable and reports billingAvailable false when Stripe is not configured', async () => {
    const org = await newOrg('unconfigured');
    delete process.env.STRIPE_PRICE_GROWTH;
    const checkout = await org.call('POST', '/api/billing/checkout', { plan: 'starter' });
    expect(checkout.statusCode).toBe(503);
    expect(checkout.json()).toMatchObject({ code: 'billing_unavailable' });
    expect((await org.call('POST', '/api/billing/portal')).statusCode).toBe(503);
    const payload = (await org.call('GET', '/api/org')).json<{ billingAvailable: boolean }>();
    expect(payload.billingAvailable).toBe(false);

    process.env.STRIPE_PRICE_GROWTH = ENV.STRIPE_PRICE_GROWTH;
    expect((await org.call('GET', '/api/org')).json<{ billingAvailable: boolean }>().billingAvailable).toBe(true);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const webhook = await subscriptionEvent('customer.subscription.updated', 'sub_x');
    expect(webhook.statusCode).toBe(503);
  });

  it('lets only the owner open Checkout or the Portal', async () => {
    const org = await newOrg('member403');
    expect((await org.memberCall('POST', '/api/billing/checkout', { plan: 'starter' })).statusCode).toBe(403);
    expect((await org.memberCall('POST', '/api/billing/portal')).statusCode).toBe(403);
    expect(fake.checkouts).toHaveLength(0);
  });

  it('refuses an organization the caller does not belong to (X-Org-Id)', async () => {
    const mine = await newOrg('xorg-mine');
    const theirs = await customerOrg('xorg-theirs');
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/portal',
      headers: { authorization: `Bearer ${mine.ownerToken}`, 'x-org-id': theirs.orgId },
    });
    expect(response.statusCode).toBe(403);
    expect(fake.portals).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Checkout and Portal
  // -------------------------------------------------------------------------

  it('creates the customer once, stores it, and opens Checkout for the chosen plan', async () => {
    const org = await newOrg('checkout');
    expect((await org.call('POST', '/api/billing/checkout', { plan: 'gold' })).statusCode).toBe(400);
    const first = await org.call('POST', '/api/billing/checkout', { plan: 'growth' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ url: 'https://checkout.stripe.test/1' });
    const row = await orgRow(org.orgId);
    expect(row.stripeCustomerId).toMatch(/^cus_/);
    expect(fake.customers.get(row.stripeCustomerId!)?.metadata).toEqual({ org_id: org.orgId });
    expect(fake.checkouts[0]).toEqual({
      customerId: row.stripeCustomerId,
      orgId: org.orgId,
      priceId: 'price_growth',
      successUrl: 'https://app.example.com/#/org?billing=success',
      cancelUrl: 'https://app.example.com/#/org?billing=cancelled',
    });

    const second = await org.call('POST', '/api/billing/checkout', { plan: 'starter' });
    expect(second.statusCode).toBe(200);
    expect(fake.checkouts[1].customerId).toBe(row.stripeCustomerId);
    expect(fake.customers.size).toBe(1);
  });

  it('answers 409 when the organization already has a live subscription', async () => {
    const org = await customerOrg('checkout409');
    fake.live.add(org.customerId);
    const stripeSide = await org.call('POST', '/api/billing/checkout', { plan: 'growth' });
    expect(stripeSide.statusCode).toBe(409);

    fake.live.clear();
    await withOrg(org.orgId, (db) => db.update(schema.organizations).set({ plan: 'starter', planStatus: 'active' })
      .where(eq(schema.organizations.id, org.orgId)));
    const stored = await org.call('POST', '/api/billing/checkout', { plan: 'growth' });
    expect(stored.statusCode).toBe(409);
    expect(fake.checkouts).toHaveLength(1);
  });

  it('opens the Portal only once there is a customer', async () => {
    const org = await newOrg('portal');
    expect((await org.call('POST', '/api/billing/portal')).statusCode).toBe(409);
    await org.call('POST', '/api/billing/checkout', { plan: 'starter' });
    const response = await org.call('POST', '/api/billing/portal');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: 'https://billing.stripe.test/portal' });
    expect(fake.portals[0].returnUrl).toBe('https://app.example.com/#/org');
  });

  // -------------------------------------------------------------------------
  // Webhook
  // -------------------------------------------------------------------------

  it('rejects a bad or missing signature', async () => {
    const bad = await send({ type: 'customer.subscription.updated', object: { id: 'sub_bad' } }, 't=1,v1=deadbeef');
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(missing.statusCode).toBe(400);
  });

  it('moves free to Starter: closes the free period and starts a full paid one', async () => {
    const org = await customerOrg('free-starter');
    await seedFreePeriod(org.orgId, 1);
    const end = new Date(Date.now() + 30 * DAY);
    fake.subscriptions.set('sub_fs', subscription('sub_fs', { status: 'active', price: 'price_starter', customer: org.customerId, orgId: org.orgId, end }));

    const response = await send({ type: 'checkout.session.completed', object: { id: 'cs_1', subscription: 'sub_fs', customer: org.customerId } });
    expect(response.statusCode).toBe(200);

    const row = await orgRow(org.orgId);
    expect(row).toMatchObject({ plan: 'starter', planStatus: 'active', stripeSubscriptionId: 'sub_fs' });
    expect(row.cycleEnd?.getTime()).toBe(unix(end) * 1000);
    const rows = await creditRows(org.orgId);
    expect(rows).toHaveLength(2);
    expect(rows[0].periodEnd.getTime()).toBeLessThanOrEqual(Date.now());
    expect(rows[0].used).toBe(1);
    expect(rows[1]).toMatchObject({ allowed: 10, used: 0, reserved: 0 });
    expect(rows[1].periodEnd.getTime()).toBe(unix(end) * 1000);

    const payload = (await org.call('GET', '/api/org')).json<{ seatLimit: number; mbCap: number; credits: { allowed: number } }>();
    expect(payload).toMatchObject({ seatLimit: 5, mbCap: 300, credits: { allowed: 10 } });
  });

  it('ignores a duplicate event even when the subscription has changed since', async () => {
    const org = await customerOrg('duplicate');
    fake.subscriptions.set('sub_dup', subscription('sub_dup', { status: 'active', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    const eventId = `evt_dup_${randomUUID()}`;
    expect((await subscriptionEvent('customer.subscription.created', 'sub_dup', eventId)).statusCode).toBe(200);
    expect(await processedAt(eventId)).not.toBeNull();

    fake.subscriptions.set('sub_dup', subscription('sub_dup', { status: 'canceled', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    const again = await subscriptionEvent('customer.subscription.created', 'sub_dup', eventId);
    expect(again.statusCode).toBe(200);
    expect((await orgRow(org.orgId)).plan).toBe('starter');
    expect(await creditRows(org.orgId)).toHaveLength(1);
  });

  it('ends in the right state when updated arrives before created', async () => {
    const org = await customerOrg('out-of-order');
    await seedFreePeriod(org.orgId, 0);
    // By the time either event arrives, the subscription is Growth and past_due.
    fake.subscriptions.set('sub_ooo', subscription('sub_ooo', { status: 'past_due', price: 'price_growth', customer: org.customerId, orgId: org.orgId }));
    expect((await subscriptionEvent('customer.subscription.updated', 'sub_ooo')).statusCode).toBe(200);
    expect((await subscriptionEvent('customer.subscription.created', 'sub_ooo')).statusCode).toBe(200);
    expect((await subscriptionEvent('invoice.payment_failed', 'sub_ooo')).statusCode).toBe(200);

    expect(await orgRow(org.orgId)).toMatchObject({ plan: 'growth', planStatus: 'past_due', stripeSubscriptionId: 'sub_ooo' });
    const rows = await creditRows(org.orgId);
    expect(rows).toHaveLength(2);
    expect((await currentRow(org.orgId))?.allowed).toBe(20);
  });

  it('raises Starter to Growth inside the period to 20, keeping credits already used', async () => {
    const org = await customerOrg('upgrade');
    fake.subscriptions.set('sub_up', subscription('sub_up', { status: 'active', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    await subscriptionEvent('customer.subscription.created', 'sub_up');
    const current = await currentRow(org.orgId);
    await withOrg(org.orgId, (db) => db.update(schema.rfpCredits).set({ used: 3, reserved: 1 })
      .where(and(eq(schema.rfpCredits.id, current!.id), eq(schema.rfpCredits.orgId, org.orgId))));

    fake.subscriptions.set('sub_up', subscription('sub_up', { status: 'active', price: 'price_growth', customer: org.customerId, orgId: org.orgId }));
    expect((await subscriptionEvent('customer.subscription.updated', 'sub_up')).statusCode).toBe(200);
    expect((await orgRow(org.orgId)).plan).toBe('growth');
    expect(await currentRow(org.orgId)).toMatchObject({ id: current!.id, allowed: 20, used: 3, reserved: 1 });
    expect(await creditRows(org.orgId)).toHaveLength(1);
  });

  it('keeps the paid plan while past_due', async () => {
    const org = await customerOrg('past-due');
    fake.subscriptions.set('sub_pd', subscription('sub_pd', { status: 'active', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    await subscriptionEvent('customer.subscription.created', 'sub_pd');
    fake.subscriptions.set('sub_pd', subscription('sub_pd', { status: 'past_due', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    expect((await send({ type: 'invoice.payment_failed', object: { id: 'in_1', subscription: 'sub_pd' } })).statusCode).toBe(200);
    expect(await orgRow(org.orgId)).toMatchObject({ plan: 'starter', planStatus: 'past_due' });
    expect((await currentRow(org.orgId))?.allowed).toBe(10);
    expect(await creditRows(org.orgId)).toHaveLength(1);
  });

  it('moves canceled to free with a new period of 1, once', async () => {
    const org = await customerOrg('cancel');
    fake.subscriptions.set('sub_c', subscription('sub_c', { status: 'active', price: 'price_growth', customer: org.customerId, orgId: org.orgId }));
    await subscriptionEvent('customer.subscription.created', 'sub_c');
    fake.subscriptions.set('sub_c', subscription('sub_c', { status: 'canceled', price: 'price_growth', customer: org.customerId, orgId: org.orgId }));
    expect((await subscriptionEvent('customer.subscription.deleted', 'sub_c')).statusCode).toBe(200);
    // A second, different event for the same canceled subscription changes nothing.
    expect((await subscriptionEvent('customer.subscription.updated', 'sub_c')).statusCode).toBe(200);

    const row = await orgRow(org.orgId);
    expect(row).toMatchObject({ plan: 'free', planStatus: 'free', stripeSubscriptionId: null });
    const rows = await creditRows(org.orgId);
    expect(rows).toHaveLength(2);
    expect(rows[0].allowed).toBe(20);
    expect(rows[0].periodEnd.getTime()).toBeLessThanOrEqual(Date.now());
    expect(rows[1].allowed).toBe(1);
    expect(row.cycleStart?.getTime()).toBe(rows[1].periodStart.getTime());
    const payload = (await org.call('GET', '/api/org')).json<{ seatLimit: number; mbCap: number }>();
    expect(payload).toMatchObject({ seatLimit: 2, mbCap: 50 });
  });

  it('renews by moving the cycle cache only (invoice.paid on a recent API version)', async () => {
    const org = await customerOrg('renew');
    fake.subscriptions.set('sub_r', subscription('sub_r', { status: 'active', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    await subscriptionEvent('customer.subscription.created', 'sub_r');
    const nextStart = new Date(Date.now() + 30 * DAY);
    const nextEnd = new Date(Date.now() + 60 * DAY);
    fake.subscriptions.set('sub_r', subscription('sub_r', {
      status: 'active', price: 'price_starter', customer: org.customerId, orgId: org.orgId, start: nextStart, end: nextEnd,
    }));
    const response = await send({
      type: 'invoice.paid',
      object: { id: 'in_r', parent: { subscription_details: { subscription: 'sub_r' } } },
    });
    expect(response.statusCode).toBe(200);
    const row = await orgRow(org.orgId);
    expect(row.cycleStart?.getTime()).toBe(unix(nextStart) * 1000);
    expect(row.cycleEnd?.getTime()).toBe(unix(nextEnd) * 1000);
    expect(await creditRows(org.orgId)).toHaveLength(1);
  });

  it('reads the period from the subscription on older API versions, and the org from the customer', async () => {
    const org = await customerOrg('legacy');
    const end = new Date(Date.now() + 20 * DAY);
    fake.subscriptions.set('sub_l', subscription('sub_l', {
      status: 'trialing', price: 'price_starter', customer: org.customerId, orgId: null, end, legacyPeriod: true,
    }));
    expect((await subscriptionEvent('customer.subscription.created', 'sub_l')).statusCode).toBe(200);
    const row = await orgRow(org.orgId);
    expect(row).toMatchObject({ plan: 'starter', planStatus: 'active' });
    expect(row.cycleEnd?.getTime()).toBe(unix(end) * 1000);
  });

  it('ignores a subscription whose customer is not the organization\'s', async () => {
    const org = await customerOrg('mismatch');
    const other = await customerOrg('mismatch-other');
    fake.subscriptions.set('sub_m', subscription('sub_m', { status: 'active', price: 'price_growth', customer: other.customerId, orgId: org.orgId }));
    const eventId = `evt_m_${randomUUID()}`;
    expect((await subscriptionEvent('customer.subscription.created', 'sub_m', eventId)).statusCode).toBe(200);
    expect(await orgRow(org.orgId)).toMatchObject({ plan: 'free', planStatus: 'free', stripeSubscriptionId: null });
    expect(await orgRow(other.orgId)).toMatchObject({ plan: 'free', planStatus: 'free', stripeSubscriptionId: null });
    expect(await creditRows(org.orgId)).toHaveLength(0);
    expect(await processedAt(eventId)).not.toBeNull();
  });

  it('changes only the organization the subscription belongs to', async () => {
    const mine = await customerOrg('tenant-a');
    const theirs = await customerOrg('tenant-b');
    fake.subscriptions.set('sub_b', subscription('sub_b', { status: 'active', price: 'price_growth', customer: theirs.customerId, orgId: theirs.orgId }));
    await subscriptionEvent('customer.subscription.created', 'sub_b');
    expect((await orgRow(theirs.orgId)).plan).toBe('growth');
    expect(await orgRow(mine.orgId)).toMatchObject({ plan: 'free', stripeSubscriptionId: null });
    expect(await creditRows(mine.orgId)).toHaveLength(0);
  });

  it('ignores an older subscription ending while the organization has a newer one', async () => {
    const org = await customerOrg('stale');
    fake.subscriptions.set('sub_new', subscription('sub_new', { status: 'active', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    await subscriptionEvent('customer.subscription.created', 'sub_new');
    fake.subscriptions.set('sub_old', subscription('sub_old', { status: 'canceled', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    expect((await subscriptionEvent('customer.subscription.deleted', 'sub_old')).statusCode).toBe(200);
    expect(await orgRow(org.orgId)).toMatchObject({ plan: 'starter', planStatus: 'active', stripeSubscriptionId: 'sub_new' });
  });

  it('answers 500 and leaves the event unprocessed when it fails, then applies it on retry', async () => {
    const org = await customerOrg('retry');
    fake.subscriptions.set('sub_e', subscription('sub_e', { status: 'active', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    const eventId = `evt_e_${randomUUID()}`;
    fake.failNextRetrieve = true;
    expect((await subscriptionEvent('customer.subscription.created', 'sub_e', eventId)).statusCode).toBe(500);
    expect(await processedAt(eventId)).toBeNull();
    expect((await orgRow(org.orgId)).plan).toBe('free');
    expect((await subscriptionEvent('customer.subscription.created', 'sub_e', eventId)).statusCode).toBe(200);
    expect((await orgRow(org.orgId)).plan).toBe('starter');
    expect(await processedAt(eventId)).not.toBeNull();
  });

  it('acknowledges event types it does not handle without fetching anything', async () => {
    const eventId = `evt_other_${randomUUID()}`;
    const response = await send({ id: eventId, type: 'customer.created', object: { id: 'cus_x' } });
    expect(response.statusCode).toBe(200);
    expect(await processedAt(eventId)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Review follow-ups: races, money safety, transport details
  // -------------------------------------------------------------------------

  it('expires open Checkout Sessions before opening a new one', async () => {
    const org = await newOrg('expire');
    await org.call('POST', '/api/billing/checkout', { plan: 'starter' });
    const { stripeCustomerId } = await orgRow(org.orgId);
    expect(fake.calls).toEqual(['createCustomer', `expire:${stripeCustomerId}`, `checkout:${stripeCustomerId}`]);
    fake.calls = [];
    await org.call('POST', '/api/billing/checkout', { plan: 'growth' });
    expect(fake.calls).toEqual(['hasLiveSubscription', `expire:${stripeCustomerId}`, `checkout:${stripeCustomerId}`]);
  });

  it('keeps the customer id another request stored first', async () => {
    const org = await newOrg('customer-race');
    // While this request talks to Stripe, another one stores its customer.
    fake.onCreateCustomer = async (orgId) => {
      await withOrg(orgId, (db) => db.update(schema.organizations).set({ stripeCustomerId: 'cus_first' })
        .where(eq(schema.organizations.id, orgId)));
    };
    const response = await org.call('POST', '/api/billing/checkout', { plan: 'starter' });
    expect(response.statusCode).toBe(200);
    expect((await orgRow(org.orgId)).stripeCustomerId).toBe('cus_first');
    expect(fake.checkouts[0].customerId).toBe('cus_first');
  });

  it('does not return Stripe ids from GET /api/org to anyone', async () => {
    const org = await customerOrg('no-ids');
    for (const call of [org.call, org.memberCall]) {
      const payload = (await call('GET', '/api/org')).json<{ org: Record<string, unknown> }>();
      expect(payload.org).not.toHaveProperty('stripeCustomerId');
      expect(payload.org).not.toHaveProperty('stripeSubscriptionId');
      expect(payload.org).toHaveProperty('planStatus', 'free');
    }
  });

  it('records an unknown price, marks the event processed, and leaves the organization alone', async () => {
    const org = await customerOrg('unknown-price');
    fake.subscriptions.set('sub_u', subscription('sub_u', { status: 'active', price: 'price_enterprise', customer: org.customerId, orgId: org.orgId }));
    const eventId = `evt_u_${randomUUID()}`;
    expect((await subscriptionEvent('customer.subscription.created', 'sub_u', eventId)).statusCode).toBe(200);
    expect(await processedAt(eventId)).not.toBeNull();
    expect(await orgRow(org.orgId)).toMatchObject({ plan: 'free', planStatus: 'free', stripeSubscriptionId: null });
    expect(await creditRows(org.orgId)).toHaveLength(0);
    const audit = await auditRows(org.orgId, 'billing.unknown_price');
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toEqual({ subscriptionId: 'sub_u', priceIds: ['price_enterprise'] });
  });

  it('keeps the stored subscription when a second live one arrives, and records both', async () => {
    const org = await customerOrg('two-live');
    fake.subscriptions.set('sub_a', subscription('sub_a', { status: 'active', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    await subscriptionEvent('customer.subscription.created', 'sub_a');
    fake.subscriptions.set('sub_b', subscription('sub_b', { status: 'active', price: 'price_growth', customer: org.customerId, orgId: org.orgId }));
    const eventId = `evt_b_${randomUUID()}`;
    expect((await subscriptionEvent('customer.subscription.created', 'sub_b', eventId)).statusCode).toBe(200);
    expect(await processedAt(eventId)).not.toBeNull();
    expect(await orgRow(org.orgId)).toMatchObject({ plan: 'starter', stripeSubscriptionId: 'sub_a' });
    expect((await currentRow(org.orgId))?.allowed).toBe(10);
    const audit = await auditRows(org.orgId, 'billing.second_live_subscription');
    expect(audit.map((row) => row.detail)).toEqual([{ stored: 'sub_a', incoming: 'sub_b' }]);

    // Once the first one is over in Stripe, the second takes its place on its next event.
    fake.subscriptions.set('sub_a', subscription('sub_a', { status: 'canceled', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    expect((await subscriptionEvent('customer.subscription.updated', 'sub_b')).statusCode).toBe(200);
    expect(await orgRow(org.orgId)).toMatchObject({ plan: 'growth', stripeSubscriptionId: 'sub_b' });
    // The first one's late cancellation no longer moves the organization.
    expect((await subscriptionEvent('customer.subscription.deleted', 'sub_a')).statusCode).toBe(200);
    expect(await orgRow(org.orgId)).toMatchObject({ plan: 'growth', planStatus: 'active', stripeSubscriptionId: 'sub_b' });
  });

  it('starts exactly one paid period under concurrent duplicate and sibling deliveries', async () => {
    const org = await customerOrg('concurrent-up');
    await seedFreePeriod(org.orgId, 0);
    fake.subscriptions.set('sub_cu', subscription('sub_cu', { status: 'active', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    const eventId = `evt_cu_${randomUUID()}`;
    const responses = await Promise.all([
      subscriptionEvent('customer.subscription.created', 'sub_cu', eventId),
      subscriptionEvent('customer.subscription.created', 'sub_cu', eventId),
      subscriptionEvent('customer.subscription.created', 'sub_cu', eventId),
      send({ type: 'checkout.session.completed', object: { id: 'cs_cu', subscription: 'sub_cu' } }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    const rows = await creditRows(org.orgId);
    expect(rows.filter((row) => row.allowed === 10)).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(await orgRow(org.orgId)).toMatchObject({ plan: 'starter', stripeSubscriptionId: 'sub_cu' });
  });

  it('starts exactly one free period under concurrent cancel events', async () => {
    const org = await customerOrg('concurrent-cancel');
    fake.subscriptions.set('sub_cc', subscription('sub_cc', { status: 'active', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    await subscriptionEvent('customer.subscription.created', 'sub_cc');
    fake.subscriptions.set('sub_cc', subscription('sub_cc', { status: 'canceled', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    const responses = await Promise.all([
      subscriptionEvent('customer.subscription.deleted', 'sub_cc'),
      subscriptionEvent('customer.subscription.updated', 'sub_cc'),
      send({ type: 'invoice.payment_failed', object: { id: 'in_cc', subscription: 'sub_cc' } }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    const rows = await creditRows(org.orgId);
    expect(rows.filter((row) => row.allowed === 1)).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(await orgRow(org.orgId)).toMatchObject({ plan: 'free', planStatus: 'free' });
  });

  it('accepts application/json with a charset', async () => {
    const org = await customerOrg('charset');
    fake.subscriptions.set('sub_cs', subscription('sub_cs', { status: 'active', price: 'price_starter', customer: org.customerId, orgId: org.orgId }));
    const response = await send(
      { type: 'customer.subscription.created', object: { id: 'sub_cs' } },
      undefined,
      { contentType: 'application/json; charset=utf-8' },
    );
    expect(response.statusCode).toBe(200);
    expect((await orgRow(org.orgId)).plan).toBe('starter');
  });

  it('rejects a correctly signed event whose timestamp is outside the tolerance', async () => {
    const eventId = `evt_old_${randomUUID()}`;
    const response = await send(
      { id: eventId, type: 'customer.subscription.updated', object: { id: 'sub_old_ts' } },
      undefined,
      { signedAt: Math.floor(Date.now() / 1000) - 400 },
    );
    expect(response.statusCode).toBe(400);
    expect(await processedAt(eventId)).toBeNull();
  });
});
