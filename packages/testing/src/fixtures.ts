// Two tenants with fixed ids, for tests and for `pnpm seed`. These hold no client documents.

declare const brand: unique symbol;
type Brand<T extends string> = string & { readonly [brand]?: T };

export type TenantId = Brand<'TenantId'>;
export type UserId = Brand<'UserId'>;
export type BidId = Brand<'BidId'>;
export type MembershipId = Brand<'MembershipId'>;

export interface TenantFixture {
  /** The tenant id. PD stores the same value as `org_id` (09 s2). */
  id: TenantId;
  name: string;
  /** PD plan values (`free | starter | growth`) and plan status; tenants start unlocked. */
  plan: 'free' | 'starter' | 'growth';
  planStatus: 'active' | 'past_due' | 'free';
  admin: { id: UserId; email: string; name: string };
  membershipId: MembershipId;
  bid: {
    id: BidId;
    name: string;
    agency: string;
    bidType: 'federal' | 'sled';
    solicitationNumber: string;
    /** Normalized the way PD does: upper case, letters and digits only. */
    solicitationKey: string;
  };
}

/** When the admins' emails count as verified. A fixed date keeps the seed idempotent. */
export const VERIFIED_AT = new Date('2026-01-01T00:00:00.000Z');

export const TENANT_A: TenantFixture = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Tenant A',
  plan: 'growth',
  planStatus: 'active',
  admin: { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'admin-a@example.test', name: 'Admin A' },
  membershipId: 'aaaaaaaa-0000-4000-8000-000000000003',
  bid: {
    id: 'aaaaaaaa-0000-4000-8000-000000000002',
    name: 'DFC ISSO RFQ',
    agency: 'Development Finance Corporation (DFC)',
    bidType: 'federal',
    solicitationNumber: '77344426Q0100',
    solicitationKey: '77344426Q0100',
  },
};

export const TENANT_B: TenantFixture = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Tenant B',
  plan: 'growth',
  planStatus: 'active',
  admin: { id: 'bbbbbbbb-0000-4000-8000-000000000001', email: 'admin-b@example.test', name: 'Admin B' },
  membershipId: 'bbbbbbbb-0000-4000-8000-000000000003',
  bid: {
    id: 'bbbbbbbb-0000-4000-8000-000000000002',
    name: 'Tenant B Sample RFQ',
    agency: 'General Services Administration (GSA)',
    bidType: 'federal',
    solicitationNumber: 'TENANT-B-0001',
    solicitationKey: 'TENANTB0001',
  },
};

export const TENANTS: ReadonlyArray<TenantFixture> = [TENANT_A, TENANT_B];

export interface TenantPair {
  a: TenantFixture;
  b: TenantFixture;
}

export const FIXTURES: TenantPair = { a: TENANT_A, b: TENANT_B };
