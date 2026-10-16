import { describe, expect, it } from 'vitest';
import { assignSeats, newMemberHoldsSeat, seatLimitFor } from './seats';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute));
const row = (userId: string, role: 'owner' | 'member', minute: number) => ({ userId, role, joinedAt: at(minute) });
const locked = (rows: ReturnType<typeof assignSeats>) => rows.filter((item) => item.seatLocked).map((item) => item.userId);

describe('seat rule (06 s5)', () => {
  it('free keeps the owner and the earliest member', () => {
    expect(locked(assignSeats([row('o', 'owner', 0), row('m1', 'member', 1), row('m2', 'member', 2)], 2))).toEqual(['m2']);
  });

  it('an owner who joined last still takes a seat first', () => {
    expect(locked(assignSeats([row('m1', 'member', 0), row('m2', 'member', 1), row('o', 'owner', 2)], 2))).toEqual(['m2']);
  });

  it('owners are never locked, even past the limit', () => {
    expect(locked(assignSeats([row('o1', 'owner', 0), row('o2', 'owner', 1), row('o3', 'owner', 2), row('m', 'member', 3)], 2))).toEqual(['m']);
  });

  it('nobody is locked within the limit', () => {
    expect(locked(assignSeats([row('o', 'owner', 0), row('m1', 'member', 1), row('m2', 'member', 2)], 5))).toEqual([]);
  });

  it('an unknown or missing plan counts as free', () => {
    expect(seatLimitFor(null)).toBe(2);
    expect(seatLimitFor('enterprise')).toBe(2);
    expect(seatLimitFor('starter')).toBe(5);
  });
});

describe('a member who joins now (06 s5)', () => {
  it('free with the owner alone has a seat', () => {
    expect(newMemberHoldsSeat([row('o', 'owner', 0)], seatLimitFor('free'))).toBe(true);
  });

  it('free with the owner and one member has none', () => {
    expect(newMemberHoldsSeat([row('o', 'owner', 0), row('m1', 'member', 1)], seatLimitFor('free'))).toBe(false);
  });

  it('starter has a seat with 4 memberships and none with 5', () => {
    const four = [row('o', 'owner', 0), row('m1', 'member', 1), row('m2', 'member', 2), row('m3', 'member', 3)];
    expect(newMemberHoldsSeat(four, seatLimitFor('starter'))).toBe(true);
    expect(newMemberHoldsSeat([...four, row('m4', 'member', 4)], seatLimitFor('starter'))).toBe(false);
  });

  it('owners past the limit leave no seat', () => {
    expect(newMemberHoldsSeat([row('o1', 'owner', 0), row('o2', 'owner', 1), row('o3', 'owner', 2)], 2)).toBe(false);
  });

  it('joins last even after a member dated in the future, so it never takes a seat from anyone', () => {
    const future = { userId: 'm1', role: 'member' as const, joinedAt: new Date(Date.UTC(2100, 0, 1)) };
    expect(newMemberHoldsSeat([row('o', 'owner', 0), future], 2)).toBe(false);
  });

  it('an unknown plan counts as free', () => {
    expect(newMemberHoldsSeat([row('o', 'owner', 0)], seatLimitFor(null))).toBe(true);
    expect(newMemberHoldsSeat([row('o', 'owner', 0), row('m1', 'member', 1)], seatLimitFor(null))).toBe(false);
  });
});
