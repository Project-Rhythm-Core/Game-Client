import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScrollTimeline, mostCommonBpm } from './scroll-timeline.ts';
import type { Chart, Note, ScrollPoint, TempoPoint } from './types.ts';

/** A chart with only the fields the timeline reads. */
function chartWith(tempo: TempoPoint[], scroll: ScrollPoint[], noteTimes: number[] = []): Chart {
  const notes: Note[] = noteTimes.map((timeMs) => ({ timeMs, column: 0 }));
  return {
    formatVersion: 1,
    id: 'test',
    metadata: {
      title: '', titleUnicode: '', artist: '', artistUnicode: '',
      charter: '', difficultyName: '', source: '', tags: [],
    },
    origin: { format: 'test', ids: {}, values: {} },
    columns: [{ role: 'note' }],
    samples: [],
    bgmEvents: [],
    timing: { tempo, scroll, stops: [] },
    notes,
    effects: [],
    breaks: [],
  };
}

const steady = (bpm: number): TempoPoint[] => [{ timeMs: 0, bpm, meter: 4 }];

test('at the reference tempo and no velocity changes, position tracks time', () => {
  const timeline = new ScrollTimeline(chartWith(steady(120), [{ timeMs: 0, multiplier: 1 }]));

  assert.equal(timeline.positionAt(0), 0);
  assert.equal(timeline.positionAt(1000), 1000);
  assert.equal(timeline.velocityAt(500), 1);
});

test('a velocity multiplier scales distance from the point it takes effect', () => {
  const timeline = new ScrollTimeline(
    chartWith(steady(120), [
      { timeMs: 0, multiplier: 1 },
      { timeMs: 1000, multiplier: 2 },
    ]),
  );

  assert.equal(timeline.positionAt(1000), 1000);
  // The second half covers twice the ground.
  assert.equal(timeline.positionAt(2000), 3000);
});

test('tempo drives scrolling as well, not only the multiplier', () => {
  // Doubling the BPM doubles the velocity even with the multiplier untouched. This is
  // the behaviour SV charts rely on, and reading only the multiplier misses it.
  const timeline = new ScrollTimeline(
    chartWith(
      [
        { timeMs: 0, bpm: 120, meter: 4 },
        { timeMs: 1000, bpm: 240, meter: 4 },
      ],
      [
        { timeMs: 0, multiplier: 1 },
        { timeMs: 1000, multiplier: 1 },
      ],
    ),
  );

  assert.equal(timeline.velocityAt(500), 1);
  assert.equal(timeline.velocityAt(1500), 2);
  assert.equal(timeline.positionAt(2000), 3000);
});

test('tempo and multiplier compound', () => {
  const timeline = new ScrollTimeline(
    chartWith(
      [{ timeMs: 0, bpm: 100, meter: 4 }, { timeMs: 1000, bpm: 300, meter: 4 }],
      [{ timeMs: 0, multiplier: 1 }, { timeMs: 1000, multiplier: 0.5 }],
    ),
  );

  // Three times the tempo at half the multiplier.
  assert.equal(timeline.velocityAt(1500), 1.5);
});

test('a frozen section leaves notes at the same position', () => {
  const timeline = new ScrollTimeline(
    chartWith(steady(120), [
      { timeMs: 0, multiplier: 1 },
      { timeMs: 1000, multiplier: 0 },
      { timeMs: 5000, multiplier: 1 },
    ]),
  );

  // Four seconds of music pass without the note moving at all.
  assert.equal(timeline.positionAt(1000), 1000);
  assert.equal(timeline.positionAt(3000), 1000);
  assert.equal(timeline.positionAt(5000), 1000);
  assert.equal(timeline.positionAt(6000), 2000);
});

test('note positions match a direct query at the same time', () => {
  const times = [0, 500, 1000, 1500, 3000];
  const chart = chartWith(
    steady(120),
    [
      { timeMs: 0, multiplier: 1 },
      { timeMs: 1000, multiplier: 4 },
      { timeMs: 2000, multiplier: 0.25 },
    ],
    times,
  );
  const timeline = new ScrollTimeline(chart);
  const positions = timeline.positionsForNotes(chart.notes);

  times.forEach((timeMs, index) => {
    assert.equal(positions[index], timeline.positionAt(timeMs));
  });
});

test('seeking backwards gives the same answer as arriving forwards', () => {
  const chart = chartWith(steady(120), [
    { timeMs: 0, multiplier: 1 },
    { timeMs: 1000, multiplier: 3 },
    { timeMs: 2000, multiplier: 0.5 },
    { timeMs: 3000, multiplier: 2 },
  ]);

  const forwards = new ScrollTimeline(chart);
  const samples = [250, 1250, 2250, 3250, 4000].map((t) => forwards.positionAt(t));

  const jumping = new ScrollTimeline(chart);
  const shuffled = [4000, 250, 3250, 1250, 2250].map((t) => jumping.positionAt(t));

  assert.deepEqual(shuffled, [samples[4], samples[0], samples[3], samples[1], samples[2]]);
});

test('constant velocity ignores everything the chart authored', () => {
  const chart = chartWith(
    [{ timeMs: 0, bpm: 120, meter: 4 }, { timeMs: 1000, bpm: 6_942_069, meter: 4 }],
    [{ timeMs: 0, multiplier: 1 }, { timeMs: 1000, multiplier: 10 }],
  );

  const timeline = new ScrollTimeline(chart, { constantVelocity: true });

  assert.equal(timeline.positionAt(2000), 2000);
  assert.equal(timeline.velocityAt(1500), 1);
});

test('extreme authored values stay finite', () => {
  // The shape of a real SV chart: a near-freeze next to a tempo used as a slingshot.
  const chart = chartWith(
    [{ timeMs: 0, bpm: 140, meter: 4 }, { timeMs: 1000, bpm: 6_942_069, meter: 4 }],
    [{ timeMs: 0, multiplier: 1 }, { timeMs: 1000, multiplier: 0 }, { timeMs: 1010, multiplier: 10 }],
    [0, 500, 1005, 1500, 2000],
  );

  const timeline = new ScrollTimeline(chart);
  const positions = timeline.positionsForNotes(chart.notes);

  assert.ok(positions.every(Number.isFinite), 'positions must stay finite');
  // Non-decreasing: velocity is never negative, so scroll never runs backwards.
  positions.forEach((p, i) => {
    if (i > 0) assert.ok(p >= positions[i - 1], `position ${i} went backwards`);
  });
});

test('an empty timing list does not throw', () => {
  const timeline = new ScrollTimeline(chartWith([], []));
  assert.ok(Number.isFinite(timeline.positionAt(1000)));
});

// --- the tempo the speed setting is measured against ------------------------

test('the reference tempo is the one the chart spends the most time at', () => {
  // The bug this pins down: a bundled chart opens on a 107.8 BPM point and then sits at
  // 215.6 for the rest of its length. Taking the first point made the same speed setting
  // scroll at exactly twice the rate it did on every other chart.
  const chart = chartWith(
    [
      { timeMs: 0, bpm: 107.8, meter: 4 },
      { timeMs: 2000, bpm: 215.6, meter: 4 },
    ],
    [],
    [1000, 60_000],
  );

  assert.equal(mostCommonBpm(chart), 215.6);
  assert.equal(new ScrollTimeline(chart).referenceBpm, 215.6);
});

test('weight is time spent, not how many points share a tempo', () => {
  // Fifty momentary points still lose to the one the chart actually plays at.
  const tempo: TempoPoint[] = [{ timeMs: 0, bpm: 180, meter: 4 }];
  for (let i = 0; i < 50; i++) tempo.push({ timeMs: 30_000 + i, bpm: 400, meter: 4 });

  assert.equal(mostCommonBpm(chartWith(tempo, [], [60_000])), 180);
});

test('the first point counts from zero however late it really is', () => {
  // osu forces this for stable compatibility and names mania's scroll speed as the reason.
  // Without it the opening tempo would be credited with no time at all.
  const chart = chartWith(
    [
      { timeMs: 9000, bpm: 100, meter: 4 },
      { timeMs: 10_000, bpm: 200, meter: 4 },
    ],
    [],
    [10_500],
  );

  // 100 BPM holds 0..10000, 200 BPM holds 10000..10500.
  assert.equal(mostCommonBpm(chart), 100);
});

test('a tempo point past the last note was never really in effect', () => {
  const chart = chartWith(
    [
      { timeMs: 0, bpm: 150, meter: 4 },
      { timeMs: 90_000, bpm: 300, meter: 4 },
    ],
    [],
    [1000, 20_000],
  );

  assert.equal(mostCommonBpm(chart), 150);
});

test('a chart with one tempo, or none, still answers', () => {
  assert.equal(mostCommonBpm(chartWith([{ timeMs: 0, bpm: 175, meter: 4 }], [], [1000])), 175);
  assert.equal(mostCommonBpm(chartWith([], [], [1000])), 60);
});
