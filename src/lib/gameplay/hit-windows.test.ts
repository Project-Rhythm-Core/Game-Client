import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  JUDGEMENT_LABELS,
  JUDGEMENTS,
  ManiaHitWindows,
  RELEASE_WINDOW_LENIENCE,
  difficultyRange,
} from './hit-windows.ts';

test('the difficulty range hinges on OD 5, not on the midpoint of the ends', () => {
  const range = [22.4, 19.4, 13.9] as const;

  assert.ok(Math.abs(difficultyRange(0, range) - 22.4) < 1e-9);
  assert.ok(Math.abs(difficultyRange(5, range) - 19.4) < 1e-9);
  assert.ok(Math.abs(difficultyRange(10, range) - 13.9) < 1e-9);

  // Each half has its own slope: 0.6 per OD below 5, 1.1 above.
  assert.ok(Math.abs(difficultyRange(2, range) - (22.4 - 0.6 * 2)) < 1e-9);
  assert.ok(Math.abs(difficultyRange(8, range) - (24.9 - 1.1 * 8)) < 1e-9);
});

test('windows below PERFECT match the published osu!mania formulas', () => {
  // Every osu!mania variant agrees on these; only PERFECT differs between them.
  for (const od of [0, 3, 5, 6.5, 8, 10]) {
    const windows = new ManiaHitWindows(od);
    for (const [judgement, base] of [
      ['great', 64], ['good', 97], ['ok', 127], ['meh', 151], ['miss', 188],
    ] as const) {
      assert.equal(
        windows.windowFor(judgement),
        Math.floor(base - 3 * od) + 0.5,
        `${judgement} at OD ${od}`,
      );
    }
  }
});

test('PERFECT scales with OD, unlike stable ScoreV1', () => {
  assert.equal(new ManiaHitWindows(0).windowFor('perfect'), 22.5);
  assert.equal(new ManiaHitWindows(5).windowFor('perfect'), 19.5);
  assert.equal(new ManiaHitWindows(10).windowFor('perfect'), 13.5);
  // At OD 7.5 it happens to coincide with ScoreV1's flat 16.5.
  assert.equal(new ManiaHitWindows(7.5).windowFor('perfect'), 16.5);
});

test('a window quoted as a whole number accepts half a millisecond more', () => {
  const windows = new ManiaHitWindows(8);

  assert.equal(windows.windowFor('great'), 40.5);
  assert.equal(windows.judge(40.5), 'great');
  assert.equal(windows.judge(40.6), 'good');
});

test('judgements step down through the windows', () => {
  const windows = new ManiaHitWindows(8);

  assert.equal(windows.judge(0), 'perfect');
  assert.equal(windows.judge(-10), 'perfect');
  assert.equal(windows.judge(30), 'great');
  assert.equal(windows.judge(60), 'good');
  assert.equal(windows.judge(90), 'ok');
});

test('every window is symmetric about the note', () => {
  // osu's ResultFor opens with Math.Abs(timeOffset), so late reads exactly like early.
  // This used to cut MEH and MISS off the late side, costing a 24 ms band of combo.
  const windows = new ManiaHitWindows(8);

  for (const judgement of JUDGEMENTS) {
    const edge = windows.windowFor(judgement);
    assert.equal(windows.judge(edge), judgement, `${judgement}, late`);
    assert.equal(windows.judge(-edge), judgement, `${judgement}, early`);
  }
});

test('pressing before the MISS window does nothing rather than missing', () => {
  const windows = new ManiaHitWindows(8);
  const miss = windows.windowFor('miss');

  assert.equal(windows.judge(-(miss - 1)), 'miss', 'inside the window it is a miss');
  assert.equal(windows.judge(-(miss + 1)), null, 'outside it, the press is not for this note');
});

test('a note survives until the MEH window closes, not the MISS window', () => {
  // osu's CanBeHit asks for the window of the lowest *successful* result, which in mania
  // is MEH. MISS is wider, but it only ever turns a press into a miss.
  const windows = new ManiaHitWindows(8);

  assert.equal(windows.missAfterMs(), windows.windowFor('meh'));
  assert.ok(windows.missAfterMs() < windows.windowFor('miss'));
});

test('release lenience widens every tail window by half again', () => {
  const windows = new ManiaHitWindows(8);
  const great = windows.windowFor('great');

  assert.equal(windows.judge(great * RELEASE_WINDOW_LENIENCE, RELEASE_WINDOW_LENIENCE), 'great');
  assert.equal(windows.judge(great * RELEASE_WINDOW_LENIENCE + 1, RELEASE_WINDOW_LENIENCE), 'good');
  assert.equal(windows.missAfterMs(RELEASE_WINDOW_LENIENCE), windows.windowFor('meh') * 1.5);
});

test('judgement labels follow the mania scale, not osu!std', () => {
  // The identifiers are osu's cross-ruleset `HitResult` names and read a step too
  // generous in mania. What settles it is the reference skin's own artwork: its
  // `mania-hit300` says PERFECT, which is the result the code calls `great`.
  assert.deepEqual(JUDGEMENTS.map((j) => JUDGEMENT_LABELS[j]), [
    'max',
    'perfect',
    'great',
    'good',
    'bad',
    'miss',
  ]);
});

test('every judgement has a label', () => {
  for (const judgement of JUDGEMENTS) {
    assert.equal(typeof JUDGEMENT_LABELS[judgement], 'string', judgement);
  }
});
