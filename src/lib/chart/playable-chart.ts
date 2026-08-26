import { ScrollTimeline, type ScrollTimelineOptions } from './scroll-timeline.ts';
import type { Chart, Note } from './types.ts';

/**
 * A chart prepared for play.
 *
 * The file format stores notes flat and sorted by time, which is the right shape for
 * something written by a parser and read by a human. Playing needs two different views
 * of the same data, and both are built here, once, at load:
 *
 * - **Drawing** walks notes in time order and wants a contiguous window of them.
 * - **Judgement** is per column: a key press in one lane can only hit a note in that
 *   lane, so each lane tracks its own earliest unjudged note.
 *
 * Neither view copies a note. They hold indices into `chart.notes`, so there is one
 * source of truth for note state.
 */

/**
 * Judgement state of a note.
 *
 * A plain object rather than an `enum`: enums need transformation rather than plain type
 * stripping, which breaks both the test runner and bundlers that only erase types.
 */
export const NoteState = {
  Pending: 0,
  Hit: 1,
  Missed: 2,
  /** A hold whose head was hit and whose tail has not arrived yet. */
  Holding: 3,
} as const;

export type NoteState = (typeof NoteState)[keyof typeof NoteState];

export interface VisibleRange {
  /** First index into `chart.notes`, inclusive. */
  start: number;
  /** One past the last index, exclusive. */
  end: number;
}

export class PlayableChart {
  readonly chart: Chart;
  readonly scroll: ScrollTimeline;

  /** Scroll position of every note, parallel to `chart.notes`. */
  readonly notePositions: Float64Array;

  /** For a hold, the scroll position of its tail. Equal to the head for tap notes. */
  readonly noteEndPositions: Float64Array;

  /**
   * Judgement state of each note's head, parallel to `chart.notes`.
   *
   * For a tap this is the note's only state. For a hold it is the press.
   */
  readonly headStates: Uint8Array;

  /** Judgement state of each hold's release. Unused for taps. */
  readonly tailStates: Uint8Array;

  /** `1` where a hold was let go before its tail became reachable. */
  readonly holdBroken: Uint8Array;

  /** Indices into `chart.notes`, grouped by column and still in time order. */
  readonly columnNotes: readonly Int32Array[];

  /** Per column: how far into `columnNotes[column]` judgement has got. */
  private readonly judgementCursors: Int32Array;

  /** How far into `chart.notes` drawing has got. */
  private renderCursor = 0;

  constructor(chart: Chart, options: ScrollTimelineOptions = {}) {
    this.chart = chart;
    this.scroll = new ScrollTimeline(chart, options);

    const notes = chart.notes;
    this.notePositions = this.scroll.positionsForNotes(notes);
    this.headStates = new Uint8Array(notes.length);
    this.tailStates = new Uint8Array(notes.length);
    this.holdBroken = new Uint8Array(notes.length);

    this.noteEndPositions = new Float64Array(notes.length);
    for (let i = 0; i < notes.length; i++) {
      const endMs = notes[i].endMs;
      this.noteEndPositions[i] =
        endMs === undefined ? this.notePositions[i] : this.scroll.positionAt(endMs);
    }

    this.columnNotes = groupByColumn(notes, chart.columns.length);
    this.judgementCursors = new Int32Array(chart.columns.length);
  }

  /** Puts every cursor and every note back to the start. */
  reset(): void {
    this.headStates.fill(NoteState.Pending);
    this.tailStates.fill(NoteState.Pending);
    this.holdBroken.fill(0);
    this.judgementCursors.fill(0);
    this.renderCursor = 0;
  }

  /**
   * Whether nothing more can happen to this note.
   *
   * A hold is not finished until its release has been judged too, which is what keeps a
   * lane's cursor parked on it while the player is still holding it down.
   */
  isFullyJudged(index: number): boolean {
    if (this.headStates[index] === NoteState.Pending) return false;
    if (this.chart.notes[index].endMs === undefined) return true;
    return this.tailStates[index] !== NoteState.Pending;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /**
   * The notes worth drawing at `scrollPosition`.
   *
   * Velocity is never negative, so scroll position never decreases with time, so notes
   * sorted by time are also sorted by position. That is what makes the visible set a
   * contiguous range and lets a single cursor track it — worth keeping in mind, because
   * a format that allowed reverse scrolling would break the assumption.
   *
   * A hold is kept while any part of it is in view, which is why the far edge is tested
   * against the tail.
   */
  visibleRange(scrollPosition: number, unitsAhead: number, unitsBehind: number): VisibleRange {
    const positions = this.notePositions;
    const ends = this.noteEndPositions;
    const near = scrollPosition - unitsBehind;
    const far = scrollPosition + unitsAhead;

    // Advance past notes whose tail has fallen behind the window.
    let start = Math.min(this.renderCursor, positions.length);
    while (start < positions.length && ends[start] < near) start++;

    // A seek can move time backwards; fall back to a search rather than never recovering.
    if (start > 0 && ends[start - 1] >= near) {
      start = lowerBound(ends, near);
    }
    this.renderCursor = start;

    let end = start;
    while (end < positions.length && positions[end] <= far) end++;

    return { start, end };
  }

  // -------------------------------------------------------------------------
  // Judgement
  // -------------------------------------------------------------------------

  /**
   * The note a press or release in `column` resolves against, or `-1` if none is left.
   *
   * Only the earliest note in the lane with anything left to judge is reachable, so this
   * is a lookup rather than a search. Notes that have been fully judged are stepped over
   * once and never revisited.
   */
  nextJudgeable(column: number): number {
    const lane = this.columnNotes[column];
    if (lane === undefined) return -1;

    let cursor = this.judgementCursors[column];
    while (cursor < lane.length && this.isFullyJudged(lane[cursor])) cursor++;
    this.judgementCursors[column] = cursor;

    return cursor < lane.length ? lane[cursor] : -1;
  }

  /** How many judgements are still outstanding, counting a hold's head and tail apart. */
  get pendingCount(): number {
    let pending = 0;
    for (let i = 0; i < this.headStates.length; i++) {
      if (this.headStates[i] === NoteState.Pending) pending++;
      if (this.chart.notes[i].endMs !== undefined && this.tailStates[i] === NoteState.Pending) {
        pending++;
      }
    }
    return pending;
  }
}

/** Splits note indices into one array per column, preserving time order. */
function groupByColumn(notes: readonly Note[], columnCount: number): Int32Array[] {
  const counts = new Int32Array(columnCount);
  for (const note of notes) counts[note.column]++;

  const lanes = Array.from({ length: columnCount }, (_, c) => new Int32Array(counts[c]));
  const filled = new Int32Array(columnCount);

  for (let i = 0; i < notes.length; i++) {
    const column = notes[i].column;
    lanes[column][filled[column]++] = i;
  }

  return lanes;
}

/** First index whose value is at or above `target`, assuming ascending order. */
function lowerBound(values: Float64Array, target: number): number {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }

  return low;
}
