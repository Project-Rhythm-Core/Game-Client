import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NoteState, PlayableChart } from './playable-chart.ts';
import type { Chart, Note } from './types.ts';

function chartOf(notes: Note[], columnCount = 4): Chart {
  return {
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
}

test('lanes keep note indices in time order', () => {
  const playable = new PlayableChart(chartOf([
    { timeMs: 0, column: 0 },
    { timeMs: 100, column: 2 },
    { timeMs: 200, column: 0 },
    { timeMs: 300, column: 2 },
  ]));

  assert.deepEqual(Array.from(playable.columnNotes[0]), [0, 2]);
  assert.deepEqual(Array.from(playable.columnNotes[2]), [1, 3]);
  assert.equal(playable.columnNotes[1].length, 0);
});

test('a lane offers only its own earliest unjudged note', () => {
  const playable = new PlayableChart(chartOf([
    { timeMs: 0, column: 0 },
    { timeMs: 50, column: 1 },
    { timeMs: 100, column: 0 },
  ]));

  assert.equal(playable.nextJudgeable(0), 0);
  assert.equal(playable.nextJudgeable(1), 1);
  // An empty lane has nothing to offer.
  assert.equal(playable.nextJudgeable(3), -1);

  playable.noteStates[0] = NoteState.Hit;
  assert.equal(playable.nextJudgeable(0), 2, 'the cursor should step past a judged note');

  playable.noteStates[2] = NoteState.Missed;
  assert.equal(playable.nextJudgeable(0), -1, 'the lane is exhausted');
});

test('expiry is decided by time, never by position', () => {
  const playable = new PlayableChart(chartOf([
    { timeMs: 0, column: 0 },
    { timeMs: 100, column: 1 },
    { timeMs: 5000, column: 0 },
  ]));

  assert.equal(playable.retireExpired(50, 20), 1);
  assert.equal(playable.noteStates[0], NoteState.Missed);
  assert.equal(playable.noteStates[1], NoteState.Pending);

  // The lane's cursor moved with it.
  assert.equal(playable.nextJudgeable(0), 2);

  assert.equal(playable.retireExpired(50, 20), 0, 'retiring twice must not double-count');
});

test('a note already hit is not retired as missed', () => {
  const playable = new PlayableChart(chartOf([{ timeMs: 0, column: 0 }]));

  playable.noteStates[0] = NoteState.Hit;
  assert.equal(playable.retireExpired(1000, 20), 0);
  assert.equal(playable.noteStates[0], NoteState.Hit);
});

test('the visible window is the contiguous range the scroll covers', () => {
  const notes: Note[] = Array.from({ length: 20 }, (_, i) => ({ timeMs: i * 100, column: i % 4 }));
  const playable = new PlayableChart(chartOf(notes));

  // At 120 bpm with no velocity changes, position equals time.
  const { start, end } = playable.visibleRange(0, 500, 0);
  assert.equal(start, 0);
  assert.equal(end, 6, 'notes at 0..500 ms inclusive');

  const later = playable.visibleRange(1000, 500, 0);
  assert.equal(later.start, 10);
  assert.equal(later.end, 16);
});

test('the render cursor recovers when time jumps backwards', () => {
  const notes: Note[] = Array.from({ length: 20 }, (_, i) => ({ timeMs: i * 100, column: i % 4 }));
  const playable = new PlayableChart(chartOf(notes));

  playable.visibleRange(1500, 500, 0);
  const afterSeek = playable.visibleRange(0, 500, 0);

  assert.equal(afterSeek.start, 0, 'a seek back to the start must show the start');
  assert.equal(afterSeek.end, 6);
});

test('a hold stays visible while any part of it is on screen', () => {
  const playable = new PlayableChart(chartOf([
    { timeMs: 0, column: 0, endMs: 2000 },
    { timeMs: 2500, column: 1 },
  ]));

  // The head is long behind, but the tail has not passed yet.
  const range = playable.visibleRange(1000, 500, 0);
  assert.equal(range.start, 0, 'the hold must still be drawn');
});

test('reset puts every cursor and note back', () => {
  const playable = new PlayableChart(chartOf([
    { timeMs: 0, column: 0 },
    { timeMs: 100, column: 0 },
  ]));

  playable.retireExpired(1000, 20);
  assert.equal(playable.pendingCount, 0);

  playable.reset();
  assert.equal(playable.pendingCount, 2);
  assert.equal(playable.nextJudgeable(0), 0);
  assert.equal(playable.visibleRange(0, 50, 0).start, 0);
});
