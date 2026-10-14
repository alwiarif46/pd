import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  addMonthsClamped,
  consumeCredit,
  fitsBidCap,
  freeAllowance,
  releaseCredit,
  reserveCredit,
} from './credits.ts';

const open = { allowed: 2, used: 0, reserved: 0 };

test('the first free period allows 2 and a return to free allows 1', () => {
  assert.equal(freeAllowance({ isFirstPeriod: true, returningToFree: false }), 2);
  assert.equal(freeAllowance({ isFirstPeriod: false, returningToFree: false }), 1);
  assert.equal(freeAllowance({ isFirstPeriod: true, returningToFree: true }), 1);
});

test('a 31st anchor clamps to the last day of a short month', () => {
  const next = addMonthsClamped(new Date(Date.UTC(2026, 0, 31)), 1);
  assert.equal(next.toISOString().slice(0, 10), '2026-02-28');
});

test('the first solicitation reserves a credit and a repeat sha256 does not', () => {
  const reserved = reserveCredit(open, {
    kind: 'solicitation',
    sameSha256: false,
    isFirstSolicitation: true,
    bidKey: null,
    fileKey: 'ABC-26-001',
  });
  assert.equal(reserved.ok, true);
  if (reserved.ok) {
    assert.equal(reserved.reserved, true);
    assert.equal(reserved.state.reserved, 1);
  }

  const again = reserveCredit(open, {
    kind: 'solicitation',
    sameSha256: true,
    isFirstSolicitation: false,
    bidKey: 'ABC26001',
    fileKey: 'ABC-26-001',
  });
  assert.equal(again.ok, true);
  if (again.ok) {
    assert.equal(again.reserved, false);
    assert.equal(again.state.reserved, 0);
  }
});

test('a different solicitation key is refused and an attachment is free', () => {
  const mismatch = reserveCredit(open, {
    kind: 'solicitation',
    sameSha256: false,
    isFirstSolicitation: false,
    bidKey: 'AAA',
    fileKey: 'BBB',
  });
  assert.deepEqual(mismatch, { ok: false, reason: 'key_mismatch' });

  const attachment = reserveCredit(open, {
    kind: 'attachment',
    sameSha256: false,
    isFirstSolicitation: false,
    bidKey: 'AAA',
    fileKey: null,
  });
  assert.equal(attachment.ok, true);
  if (attachment.ok) {
    assert.equal(attachment.reserved, false);
  }
});

test('consume and release move a reserved credit', () => {
  const reserved = { allowed: 2, used: 0, reserved: 1 };
  assert.deepEqual(consumeCredit(reserved), { allowed: 2, used: 1, reserved: 0 });
  assert.deepEqual(releaseCredit(reserved), { allowed: 2, used: 0, reserved: 0 });
});

test('an upload that would pass the plan MB cap is refused', () => {
  assert.equal(fitsBidCap('free', 40 * 1024 * 1024, 20 * 1024 * 1024), false);
  assert.equal(fitsBidCap('starter', 40 * 1024 * 1024, 20 * 1024 * 1024), true);
});
