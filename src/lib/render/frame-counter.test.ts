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

  let now = run(counter, 0, 120, 1000 / 60);
  assert.equal(counter.longFrames, 0, 'steady frames are never long');
  assert.ok(Math.abs(counter.shortestFrameMs - 1000 / 60) < 0.001);

  // Three frames at twice the period.
  run(counter, now, 3, 1000 / 30);
  assert.equal(counter.longFrames, 3);
});

test('a hitch in the first half second is not missed', () => {
  const counter = new FrameCounter();
  counter.update(0);

  // Only a handful of frames, so no averaging window has closed yet.
  let now = run(counter, 0, 5, 1000 / 60);
  now += 50;
  counter.update(now);

  assert.equal(counter.fps, 0, 'no window has completed');
  assert.equal(counter.longFrames, 1, 'the hitch still has to be counted');
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
