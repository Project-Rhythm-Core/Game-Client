import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LEAD_IN_MS, LeadInClock, leadInFor } from './lead-in-clock.ts';
import type { PlaybackClock } from './playback-clock.ts';

/** A clock whose position and running state the test sets directly. */
class FakeClock implements PlaybackClock {
  position = 0;
  running = false;

  positionMs(): number {
    return this.position;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

test('a chart with room in its intro waits for nothing', () => {
  // The first note is well past the two seconds, so the music starts at once and the
  // approach happens over the chart's own opening.
  assert.equal(leadInFor(5000), 0);
  assert.equal(leadInFor(DEFAULT_LEAD_IN_MS), 0);
});

test('a chart that opens abruptly buys exactly the silence it is short by', () => {
  assert.equal(leadInFor(0), DEFAULT_LEAD_IN_MS);
  assert.equal(leadInFor(500), DEFAULT_LEAD_IN_MS - 500);
  assert.equal(leadInFor(1999), 1);
});

test("the chart's own request can lengthen the wait but never shorten it", () => {
  // osu's AudioLeadIn, which is applied with a Math.min against the default start time —
  // so it only ever moves the start earlier.
  assert.equal(leadInFor(0, 5000), 5000);
  assert.equal(leadInFor(0, 100), DEFAULT_LEAD_IN_MS, 'a smaller request is ignored');
  assert.equal(leadInFor(3000, 5000), 2000);
});

test('the approach runs in negative time and reaches zero when the music is due', () => {
  const inner = new FakeClock();
  const clock = new LeadInClock(inner);

  clock.begin(2000);

  // Straight after begin() the chart sits at roughly minus the whole lead-in.
  const atStart = clock.positionMs();
  assert.ok(atStart <= 0 && atStart > -2001, `got ${atStart}`);
  assert.ok(clock.remainingMs() > 1990, `got ${clock.remainingMs()}`);
});

test('the handover waits for the music to actually be running', () => {
  const inner = new FakeClock();
  const clock = new LeadInClock(inner);

  clock.begin(0);

  // The audio has been asked for but is not audible yet, so the countdown keeps running
  // rather than latching onto a clock that still reads zero.
  assert.equal(inner.isRunning, false);
  const before = clock.positionMs();

  inner.running = true;
  inner.position = 1234;
  clock.handOver();

  assert.equal(clock.positionMs(), 1234, 'once it runs, it is the authority');
  assert.equal(clock.remainingMs(), 0);
  assert.ok(before < 1234);
});

test('restarting gets a full approach even though the audio never stopped', () => {
  // The bug this pins down: handing over on `inner.isRunning` alone ended the second
  // attempt's approach immediately, because the audio clock was still running from the
  // first one.
  const inner = new FakeClock();
  const clock = new LeadInClock(inner);

  clock.begin(0);
  inner.running = true;
  inner.position = 50_000;
  clock.handOver();
  assert.equal(clock.positionMs(), 50_000);

  clock.begin(2000);

  assert.ok(clock.positionMs() < 0, `a fresh approach, got ${clock.positionMs()}`);
  assert.ok(clock.remainingMs() > 1990);
});

test('a stopped clock reads zero, like every other playback clock', () => {
  const clock = new LeadInClock(new FakeClock());

  assert.equal(clock.isRunning, false);
  assert.equal(clock.positionMs(), 0);

  clock.begin(500);
  assert.equal(clock.isRunning, true);

  clock.stop();
  assert.equal(clock.positionMs(), 0);
});
