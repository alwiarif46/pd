import { asc, eq } from 'drizzle-orm';
import type { AppDatabase } from './db';
import * as schema from './db/schema';
import { PLAN_LIMITS, type Plan } from './limits';

/** One membership and whether it holds a seat on the organization's current plan. */
export interface SeatHolder {
  userId: string;
  role: 'owner' | 'member';
  joinedAt: Date;
  /** True when the plan has no seat left for this member (06 s5). Never true for an owner. */
  seatLocked: boolean;
}

/** The plan's seat limit (06 s2); an unknown or missing plan counts as free. */
export function seatLimitFor(plan: string | null | undefined): number {
  const limits = PLAN_LIMITS[(plan ?? 'free') as Plan] as { maxUsers: number } | undefined;
  return limits?.maxUsers ?? PLAN_LIMITS.free.maxUsers;
}

/**
 * Who holds a seat (06 s5, seats after a move to free): every owner always does, and owners
 * take their seats first; members then fill what is left of `maxUsers` in the order they joined
 * (created_at, then id). The rest are seat-locked until the owner removes members or upgrades.
 * Nothing is stored: removing a member or changing the plan applies on the next request.
 *
 * One query (memberships joined to the organization's plan). Run it inside withOrg(orgId): both
 * tables have row-level security. Returns the memberships oldest first.
 */
export async function seatHolders(db: Pick<AppDatabase, 'select'>, orgId: string): Promise<SeatHolder[]> {
  const rows = await db.select({
    userId: schema.memberships.userId,
    role: schema.memberships.role,
    joinedAt: schema.memberships.createdAt,
    plan: schema.organizations.plan,
  }).from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
    .where(eq(schema.memberships.orgId, orgId))
    .orderBy(asc(schema.memberships.createdAt), asc(schema.memberships.id));
  return assignSeats(rows, seatLimitFor(rows[0]?.plan));
}

/** The seat rule on memberships already ordered by (created_at, id). Exported for unit tests. */
export function assignSeats<T extends { userId: string; role: 'owner' | 'member'; joinedAt: Date }>(
  rows: T[],
  limit: number,
): SeatHolder[] {
  const owners = rows.filter((row) => row.role === 'owner').length;
  let memberSeats = Math.max(0, limit - owners);
  return rows.map((row) => {
    if (row.role === 'owner') {
      return { userId: row.userId, role: row.role, joinedAt: row.joinedAt, seatLocked: false };
    }
    const seated = memberSeats > 0;
    if (seated) {
      memberSeats -= 1;
    }
    return { userId: row.userId, role: row.role, joinedAt: row.joinedAt, seatLocked: !seated };
  });
}
