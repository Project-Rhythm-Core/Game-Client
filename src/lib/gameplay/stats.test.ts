import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  meanError,
  offsetIsWorthMoving,
  suggestedOffsetMs,
  summariseErrors,
  unstableRate,
} from './stats.ts';

test('the halves separate spread from bias, which one mean cannot', () => {
  // Both plays average to zero. The first is inconsistent; the second is perfect. Telling
  // them apart is the whole reason the halves are reported.
  const scattered = summariseErrors([-20, 20, -20, 20]);
  const exact = summariseErrors([0, 0, 0, 0]);

  assert.equal(scattered.mean, 0);
  assert.equal(exact.mean, 0);

  assert.equal(scattered.earlyMean, -20);
  assert.equal(scattered.lateMean, 20);
  assert.equal(exact.earlyCount, 0);
  assert.equal(exact.lateCount, 0);
});

test('a play pulled to one side shows it in both halves', () => {
  const summary = summariseErrors([-40, -30, -35, 5]);

  assert.ok(summary.mean < 0, 'early overall');
  assert.equal(summary.earlyCount, 3);
  assert.equal(summary.lateCount, 1);
  assert.ok(Math.abs(summary.earlyMean) > Math.abs(summary.lateMean));
});

test('an exact hit belongs to neither half but still counts', () => {
  const summary = summariseErrors([0, -10, 10]);

  assert.equal(summary.total, 3);
  assert.equal(summary.earlyCount, 1);
  assert.equal(summary.lateCount, 1);
  assert.equal(summary.mean, 0);
});

test('nothing played reads as zero rather than as a number of no meaning', () => {
  const summary = summariseErrors([]);

  assert.equal(summary.mean, 0);
  assert.equal(summary.earlyMean, 0);
  assert.equal(summary.lateMean, 0);
  assert.equal(summary.total, 0);
});

test('the suggested offset moves by the mean, from wherever it already was', () => {
  // Hitting 12 ms early with no offset set wants the offset taken 12 ms down.
  assert.equal(suggestedOffsetMs(0, summariseErrors([-12, -12])), -12);
  // The same play with +20 already dialled in lands on +8, not on -12.
  assert.equal(suggestedOffsetMs(20, summariseErrors([-12, -12])), 8);
  // A centred play asks for no change.
  assert.equal(suggestedOffsetMs(7, summariseErrors([-5, 5])), 7);
});

test('the unstable rate is ten times the standard deviation', () => {
  assert.equal(unstableRate([10, 10, 10]), 0, 'no spread at all');
  assert.ok(Math.abs(unstableRate([-10, 10]) - 100) < 1e-9);
  assert.equal(unstableRate([5]), 0, 'one error has no spread to measure');
});

test('the mean is the plain average', () => {
  assert.equal(meanError([]), 0);
  assert.equal(meanError([-30, 10]), -10);
});

// --- is this play worth calibrating from? -----------------------------------

test('a wild play does not get to recommend an offset', () => {
  // Taken from a real run of random mashing: the halves came out near-symmetric at about
  // 85 ms each and the mean landed at +15 only because more presses fell late than early.
  // With that much scatter the mean is noise, and acting on it would be superstition.
  const wild: number[] = [];
  for (let i = 0; i < 60; i++) wild.push(i % 2 === 0 ? -85 : 90);

  const summary = summariseErrors(wild);

  assert.ok(Math.abs(summary.mean) > 2, `precondition: off centre, got ${summary.mean}`);
  assert.equal(offsetIsWorthMoving(summary, 5), false, 'too scattered to read anything from');
});

test('a tight play with the same mean does get to', () => {
  // The same bias, but consistent: every hit late by about the same amount.
  const tight = new Array(60).fill(0).map((_, i) => (i % 2 === 0 ? 14 : 16));

  const summary = summariseErrors(tight);

  assert.ok(Math.abs(summary.mean - 15) < 1e-9);
  assert.equal(offsetIsWorthMoving(summary, 5), true);
});

test('a centred play never asks for a change however tight it is', () => {
  const summary = summariseErrors(new Array(200).fill(0).map((_, i) => (i % 2 ? 1 : -1)));

  assert.equal(offsetIsWorthMoving(summary, 5), false);
});

test('one hit is never evidence', () => {
  assert.equal(offsetIsWorthMoving(summariseErrors([-50]), 5), false);
  assert.equal(offsetIsWorthMoving(summariseErrors([]), 5), false);
});
