import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NoteState, PlayableChart } from '../../chart/playable-chart.ts';
import type { Chart, Note } from '../../chart/types.ts';
import { ManiaJudge } from './judge.ts';
import { ManiaHitWindows, RELEASE_WINDOW_LENIENCE } from './hit-windows.ts';
import { unstableRate } from '../stats.ts';

const OD = 8;

function judgeOf(notes: Note[], columnCount = 4): ManiaJudge {
  const chart: Chart = {
    formatVersion: 1,
    id: 'test',
    metadata: {
      title: '', titleUnicode: '', artist: '', artistUnicode: '',
      charter: '', difficultyName: '', source: '', tags: [],
    },
    origin: { format: 'test', ids: {}, values: {} },
    columns: Array.from({ length: columnCount }, () => ({ role: 'note' as const })),
    samples: [],
    bgmEvents: [],
    timing: {
      tempo: [{ timeMs: 0, bpm: 120, meter: 4 }],
      scroll: [{ timeMs: 0, multiplier: 1 }],
      stops: [],
    },
    notes,
    effects: [],
    breaks: [],
  };

  return new ManiaJudge(new PlayableChart(chart), OD);
}

const windows = new ManiaHitWindows(OD);

// --- taps ------------------------------------------------------------------

test('a press on time is a PERFECT', () => {
  const judge = judgeOf([{ timeMs: 1000, column: 0 }]);
  const event = judge.press(0, 1000);

  assert.equal(event?.judgement, 'perfect');
  assert.equal(event?.errorMs, 0);
  assert.equal(judge.combo, 1);
  assert.equal(judge.accuracy, 1);
});

test('a press far too early reaches nothing and is not a miss', () => {
  const judge = judgeOf([{ timeMs: 1000, column: 0 }]);

  assert.equal(judge.press(0, 1000 - windows.windowFor('miss') - 10), null);
  assert.equal(judge.counts.miss, 0, 'the note is untouched');
  assert.equal(judge.press(0, 1000)?.judgement, 'perfect', 'and can still be hit properly');
});

test('a press only reaches its own lane', () => {
  const judge = judgeOf([{ timeMs: 1000, column: 0 }]);

  assert.equal(judge.press(1, 1000), null, 'the wrong lane judges nothing');
  assert.equal(judge.press(0, 1000)?.judgement, 'perfect');
});

test('a lane offers its notes one at a time, in order', () => {
  const judge = judgeOf([
    { timeMs: 1000, column: 0 },
    { timeMs: 1200, column: 0 },
  ]);

  assert.equal(judge.press(0, 1000)?.judgement, 'perfect');
  assert.equal(judge.press(0, 1200)?.judgement, 'perfect');
  assert.equal(judge.press(0, 1400), null, 'the lane is exhausted');
});

test('a note is written off once the MEH window closes', () => {
  const judge = judgeOf([{ timeMs: 1000, column: 0 }]);

  assert.deepEqual(judge.update(1000 + windows.windowFor('meh')), [], 'still reachable');

  const events = judge.update(1000 + windows.windowFor('meh') + 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].judgement, 'miss');
  assert.equal(events[0].errorMs, null, 'a note never touched has no timing error');
});

test('only a miss breaks combo', () => {
  const judge = judgeOf([
    { timeMs: 1000, column: 0 },
    { timeMs: 2000, column: 0 },
    { timeMs: 3000, column: 0 },
  ]);

  judge.press(0, 1000);
  judge.press(0, 2000 + windows.windowFor('ok'));   // an OK
  assert.equal(judge.counts.ok, 1);
  assert.equal(judge.combo, 2, 'a poor judgement still continues the combo');

  judge.update(3000 + windows.windowFor('meh') + 1);
  assert.equal(judge.combo, 0);
  assert.equal(judge.maxCombo, 2);
});

test('accuracy weights PERFECT above GREAT, as ScoreV2 does', () => {
  const judge = judgeOf([{ timeMs: 1000, column: 0 }]);
  judge.press(0, 1000 + windows.windowFor('great'));

  assert.equal(judge.counts.great, 1);
  assert.ok(Math.abs(judge.accuracy - 300 / 305) < 1e-9, `got ${judge.accuracy}`);
});

// --- hold notes ------------------------------------------------------------

test('a hold is two judgements, not one', () => {
  const judge = judgeOf([{ timeMs: 1000, column: 0, endMs: 2000 }]);

  const head = judge.press(0, 1000);
  assert.equal(head?.judgement, 'perfect');
  assert.equal(head?.isTail, false);
  assert.ok(judge.isHolding(0));

  const tail = judge.release(0, 2000);
  assert.equal(tail?.judgement, 'perfect');
  assert.equal(tail?.isTail, true);
  assert.equal(judge.combo, 2, 'head and tail each advance the combo');
});

test('the tail window is half again as wide as a note\'s', () => {
  const judge = judgeOf([{ timeMs: 1000, column: 0, endMs: 2000 }]);
  judge.press(0, 1000);

  // An error that would only be a GOOD on a tap is still a GREAT on a release.
  const offset = windows.windowFor('great') * RELEASE_WINDOW_LENIENCE;
  assert.equal(windows.judge(offset), 'good', 'precondition: a tap would grade this lower');
  assert.equal(judge.release(0, 2000 + offset)?.judgement, 'great');
});

test('letting go early breaks the hold and the tail is written off', () => {
  const judge = judgeOf([{ timeMs: 1000, column: 0, endMs: 2000 }]);
  judge.press(0, 1000);

  assert.equal(judge.release(0, 1500), null, 'nothing is judged at the moment of release');
  assert.equal(judge.playable.holdBroken[0], 1);
  assert.ok(!judge.isHolding(0));

  const events = judge.update(2000 + windows.missAfterMs(RELEASE_WINDOW_LENIENCE) + 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].judgement, 'miss');
  assert.equal(events[0].isTail, true);
});

test('a missed head caps the tail at MEH however well it is released', () => {
  const judge = judgeOf([{ timeMs: 1000, column: 0, endMs: 2000 }]);

  // Never press the head; let it expire.
  judge.update(1000 + windows.missAfterMs() + 1);
  assert.equal(judge.counts.miss, 1);

  // Grab the note late, then release exactly on the tail.
  judge.press(0, 1500);
  assert.ok(judge.isHolding(0), 'a hold can still be grabbed after its head is gone');

  const tail = judge.release(0, 2000);
  assert.equal(tail?.judgement, 'meh', 'a perfect release cannot rescue a missed head');
});

test('a hold cannot be picked up inside the tail\'s release lenience', () => {
  // The lenience widens the window the tail is judged in and delays its miss, but osu
  // will not start a hold in that extra time: DrawableHoldNote.OnPressed tests the tail's
  // plain CanBeHit, without the lenience.
  const judge = judgeOf([{ timeMs: 1000, column: 0, endMs: 2000 }]);
  judge.update(1000 + windows.missAfterMs() + 1);
  assert.equal(judge.counts.miss, 1, 'precondition: the head is gone');

  const tooLate = 2000 + windows.missAfterMs() + 1;
  assert.ok(
    tooLate < 2000 + windows.missAfterMs(RELEASE_WINDOW_LENIENCE),
    'precondition: the tail itself has not expired yet',
  );

  judge.press(0, tooLate);
  assert.ok(!judge.isHolding(0), 'too late to pick the hold up');

  const inTime = judgeOf([{ timeMs: 1000, column: 0, endMs: 2000 }]);
  inTime.update(1000 + windows.missAfterMs() + 1);
  inTime.press(0, 2000 + windows.missAfterMs() - 1);
  assert.ok(inTime.isHolding(0), 'a moment earlier it is still reachable');
});

test('a hold keeps its lane parked until the release is judged', () => {
  const judge = judgeOf([
    { timeMs: 1000, column: 0, endMs: 3000 },
    { timeMs: 4000, column: 0 },
  ]);

  judge.press(0, 1000);
  // Time passes well beyond the head's own deadline, but the hold is not finished.
  assert.deepEqual(judge.update(2000), []);
  assert.equal(judge.playable.nextJudgeable(0), 0, 'still the hold');

  judge.release(0, 3000);
  assert.equal(judge.playable.nextJudgeable(0), 1, 'now the lane moves on');
});

test('holding past the tail window writes the tail off', () => {
  const judge = judgeOf([{ timeMs: 1000, column: 0, endMs: 2000 }]);
  judge.press(0, 1000);

  const events = judge.update(2000 + windows.missAfterMs(RELEASE_WINDOW_LENIENCE) + 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].judgement, 'miss');
  assert.ok(!judge.isHolding(0), 'the hold is abandoned once its tail is gone');
});

test('a release with no hold in progress judges nothing', () => {
  const judge = judgeOf([{ timeMs: 1000, column: 0 }]);
  assert.equal(judge.release(0, 1000), null);
});

// --- bookkeeping -----------------------------------------------------------

test('reset returns everything to the start', () => {
  const judge = judgeOf([{ timeMs: 1000, column: 0, endMs: 2000 }]);
  judge.press(0, 1000);
  judge.release(0, 2000);

  judge.reset();

  assert.equal(judge.combo, 0);
  assert.equal(judge.maxCombo, 0);
  assert.equal(judge.accuracy, 1);
  assert.equal(judge.errors.length, 0);
  assert.equal(judge.playable.headStates[0], NoteState.Pending);
  assert.equal(judge.press(0, 1000)?.judgement, 'perfect');
});

test('unstable rate is ten times the spread of the timing errors', () => {
  assert.equal(unstableRate([]), 0);
  assert.equal(unstableRate([5]), 0);
  assert.equal(unstableRate([10, 10, 10]), 0, 'consistently late is still consistent');

  // Errors of -10 and +10 have a standard deviation of 10.
  assert.ok(Math.abs(unstableRate([-10, 10]) - 100) < 1e-9);
});
