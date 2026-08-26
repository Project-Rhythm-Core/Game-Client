import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SystemClock } from './playback-clock.ts';

test('a clock that has not started reports nothing', () => {
  const clock = new SystemClock();

  assert.equal(clock.isRunning, false);
  assert.equal(clock.positionMs(), 0);
});

test('position advances with real time once started', async () => {
  const clock = new SystemClock();
  clock.start();

  assert.equal(clock.isRunning, true);
  const first = clock.positionMs();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = clock.positionMs();

  assert.ok(second > first, 'time must move');
  assert.ok(second >= 35 && second < 200, `roughly the elapsed time, got ${second}`);
});

test('a clock can be started part-way through', () => {
  const clock = new SystemClock();
  clock.start(5000);

  assert.ok(clock.positionMs() >= 5000);
  assert.ok(clock.positionMs() < 5100);
});

test('restarting rewinds to the beginning', async () => {
  const clock = new SystemClock();
  clock.start();
  await new Promise((resolve) => setTimeout(resolve, 40));

  clock.start();
  assert.ok(clock.positionMs() < 10, `got ${clock.positionMs()}`);
});

test('stopping puts position back to zero', () => {
  const clock = new SystemClock();
  clock.start(1000);
  clock.stop();

  assert.equal(clock.isRunning, false);
  assert.equal(clock.positionMs(), 0);
});
