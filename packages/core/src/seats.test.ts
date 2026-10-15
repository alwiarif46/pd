import { describe, expect, it } from 'vitest';
import { assignSeats, seatLimitFor } from './seats';

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
