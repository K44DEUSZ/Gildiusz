import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRecoveryArchiveAge,
  maximumRecoveryArchiveAgeMs,
} from "../dist/storage/recovery/age.js";

const now = Date.parse("2026-11-10T12:00:00Z");

test("recovery cannot reactivate an archive when its 35-day deletion fences can expire", () => {
  assert.equal(maximumRecoveryArchiveAgeMs, 35 * 86400000);
  assert.equal(assertRecoveryArchiveAge(now, { now }), now);
  assert.equal(assertRecoveryArchiveAge(now - maximumRecoveryArchiveAgeMs + 1, { now }), now);
  for (const createdAt of [
    now - maximumRecoveryArchiveAgeMs,
    now - maximumRecoveryArchiveAgeMs - 1,
    now + 1,
  ])
    assert.throws(
      () => assertRecoveryArchiveAge(createdAt, { now }),
      /expired or dated in the future/,
    );
});

test("an operator may shorten the restore window but cannot silently extend it", () => {
  assert.equal(assertRecoveryArchiveAge(now - 999, { now, maxArchiveAgeMs: 1000 }), now);
  assert.throws(
    () => assertRecoveryArchiveAge(now - 1000, { now, maxArchiveAgeMs: 1000 }),
    /expired/,
  );
  for (const maxArchiveAgeMs of [0, -1, NaN, Infinity, 1.5, maximumRecoveryArchiveAgeMs + 1])
    assert.throws(() => assertRecoveryArchiveAge(now, { now, maxArchiveAgeMs }), /age policy/);
  for (const invalidNow of [-1, NaN, Infinity, 1.5])
    assert.throws(() => assertRecoveryArchiveAge(now, { now: invalidNow }), /age policy/);
});
