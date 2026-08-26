import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FrameCounter } from './frame-counter.ts';

/** Feeds `count` frames of `frameMs` each, starting at `startMs`. */
function run(counter: FrameCounter, startMs: number, count: number, frameMs: number): number {
  let now = startMs;
  for (let i = 0; i < count; i++) {
    now += frameMs;
    counter.update(now);
  }
  return now;
}

test('the first frame only establishes a baseline', () => {
  const counter = new FrameCounter();
  counter.update(1000);

  assert.equal(counter.fps, 0);
  assert.equal(counter.frameMs, 0, 'there is nothing to measure against yet');
});

test('a steady 60 Hz reads as 60 fps', () => {
  const counter = new FrameCounter();
  counter.update(0);
  run(counter, 0, 120, 1000 / 60);

  assert.ok(Math.abs(counter.fps - 60) < 0.5, `got ${counter.fps}`);
  assert.ok(Math.abs(counter.frameMs - 1000 / 60) < 0.001);
});

test('a single hitch surfaces even though the average barely moves', () => {
  const counter = new FrameCounter();
  counter.update(0);

  // One clean window first, so there is an average to compare against.
  let now = run(counter, 0, 31, 1000 / 60);
  assert.ok(Math.abs(counter.worstMs - 1000 / 60) < 0.001, 'a clean window has no hitch');

  now += 40;
  counter.update(now);
  // Finish the window the hitch fell into.
  run(counter, now, 31, 1000 / 60);

  assert.ok(counter.worstMs >= 40, `the hitch should surface: got ${counter.worstMs}`);
  assert.ok(counter.fps > 50, `the average should stay near 60: got ${counter.fps}`);
});

test('the worst frame is rolling, so a hitch does not haunt the display forever', () => {
  const counter = new FrameCounter();
  counter.update(0);

  let now = run(counter, 0, 31, 1000 / 60);
  now += 40;
  counter.update(now);
  now = run(counter, now, 31, 1000 / 60);
  assert.ok(counter.worstMs >= 40);

  // Two clean windows later it is gone from the display, but still in the tally.
  run(counter, now, 60, 1000 / 60);
  assert.ok(counter.worstMs < 20, `got ${counter.worstMs}`);
  assert.equal(counter.longFrames, 1, 'the count is cumulative even when the peak is not');
});

test('long frames are counted against this display\'s own period', () => {
  const counter = new FrameCounter();
  counter.update(0);

  const now = run(counter, 0, 120, 1000 / 60);
  assert.equal(counter.longFrames, 0, 'steady frames are never long');
  assert.ok(Math.abs(counter.displayPeriodMs - 1000 / 60) < 0.001);

  // Three frames at twice the period.
  run(counter, now, 3, 1000 / 30);
  assert.equal(counter.longFrames, 3);
});

test('nothing is classified until the display period is known', () => {
  const counter = new FrameCounter();
  counter.update(0);

  // A handful of frames, so no estimate exists yet.
  let now = run(counter, 0, 5, 1000 / 60);
  now += 50;
  counter.update(now);

  assert.equal(counter.displayPeriodMs, 0);
  assert.equal(counter.longFrames, 0, 'guessing without an estimate is worse than waiting');
});

test('the refresh estimate is the median, not the shortest frame', () => {
  const counter = new FrameCounter();
  counter.update(0);

  // A 144 Hz display, with one anomalously short frame among the samples.
  let now = 0;
  for (let i = 0; i < 120; i++) {
    now += i === 40 ? 2 : 1000 / 144;
    counter.update(now);
  }

  assert.ok(
    Math.abs(counter.displayPeriodMs - 1000 / 144) < 0.1,
    `one short sample must not move the estimate: got ${counter.displayPeriodMs}`,
  );

  // The real payoff: ordinary frames after it are still ordinary.
  const before = counter.longFrames;
  run(counter, now, 120, 1000 / 144);
  assert.equal(counter.longFrames, before, 'steady frames must not read as dropped');
});

test('reset clears the tally but keeps the average', () => {
  const counter = new FrameCounter();
  counter.update(0);

  let now = run(counter, 0, 120, 1000 / 60);
  run(counter, now, 3, 100);
  assert.ok(counter.longFrames > 0);

  const fps = counter.fps;
  counter.reset();

  assert.equal(counter.longFrames, 0);
  assert.equal(counter.fps, fps);
});

test('a zero-length frame cannot poison the threshold', () => {
  const counter = new FrameCounter();
  counter.update(0);
  const now = run(counter, 0, 60, 1000 / 60);
  assert.equal(counter.longFrames, 0);

  // Browsers coarsen the clock, so two ticks can land on the same reading.
  counter.update(now);

  run(counter, now, 60, 1000 / 60);
  assert.ok(
    Math.abs(counter.displayPeriodMs - 1000 / 60) < 0.001,
    `got ${counter.displayPeriodMs}`,
  );
  assert.equal(counter.longFrames, 0, 'steady frames must not all read as stutters');
});

test('update time is tracked apart from the frame period', () => {
  const counter = new FrameCounter();
  counter.update(0);

  let now = 0;
  for (let i = 0; i < 31; i++) {
    now += 1000 / 60;
    counter.update(now);
    counter.recordUpdate(2);
  }

  // Vsync pins the period at the refresh rate; the work fits well inside it.
  assert.ok(Math.abs(counter.frameMs - 1000 / 60) < 0.001);
  assert.equal(counter.updateMs, 2);
  assert.equal(counter.worstUpdateMs, 2);
  assert.ok(Math.abs(counter.load - 2 / (1000 / 60)) < 0.001, `load ${counter.load}`);
});

test('a spike in work shows up even while the frame period stays flat', () => {
  const counter = new FrameCounter();
  counter.update(0);

  let now = 0;
  for (let i = 0; i < 31; i++) {
    now += 1000 / 60;
    counter.update(now);
    counter.recordUpdate(i === 10 ? 12 : 2);
  }

  assert.ok(Math.abs(counter.worstMs - 1000 / 60) < 0.001, 'the period never moved');
  assert.equal(counter.worstUpdateMs, 12, 'but the work spike is visible');
});
