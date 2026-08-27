import { NoteState, type PlayableChart } from '../../chart/playable-chart.ts';
import type { Judge, JudgementEvent } from '../ruleset.ts';
import { ManiaHitWindows, RELEASE_WINDOW_LENIENCE } from './hit-windows.ts';
import {
  JUDGEMENTS,
  JUDGEMENT_BREAKS_COMBO,
  JUDGEMENT_WEIGHT,
  MAX_JUDGEMENT_WEIGHT,
  type Judgement,
} from './judgements.ts';

/**
 * osu!mania judgement, following the lazer / ScoreV2 model.
 *
 * A hold note is two independent judgements — a head that behaves exactly like a tap and
 * a tail judged on release with windows half again as wide. Letting go early, or never
 * hitting the head, caps the tail at MEH.
 *
 * Everything here is driven by time. Nothing consults the renderer, because a chart can
 * legitimately hide a note entirely or freeze it in place and it still has to be judged.
 */

export class ManiaJudge implements Judge {
  readonly playable: PlayableChart;
  readonly windows: ManiaHitWindows;

  readonly counts: Record<Judgement, number>;
  combo = 0;
  maxCombo = 0;

  /** Signed timing errors, oldest first. Both presses and releases contribute. */
  readonly errors: number[] = [];

  /** Note index each column is currently holding, or `-1`. */
  private readonly activeHold: Int32Array;

  private weightedTotal = 0;
  private judgedCount = 0;

  constructor(playable: PlayableChart, overallDifficulty: number) {
    this.playable = playable;
    this.windows = new ManiaHitWindows(overallDifficulty);
    this.activeHold = new Int32Array(playable.chart.columns.length).fill(-1);
    this.counts = emptyCounts();
  }

  reset(): void {
    this.playable.reset();
    this.activeHold.fill(-1);
    for (const judgement of JUDGEMENTS) this.counts[judgement] = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.errors.length = 0;
    this.weightedTotal = 0;
    this.judgedCount = 0;
  }

  /** Accuracy so far, 0 to 1. */
  get accuracy(): number {
    if (this.judgedCount === 0) return 1;
    return this.weightedTotal / (this.judgedCount * MAX_JUDGEMENT_WEIGHT);
  }

  /** Whether `column` currently has a hold in progress. */
  isHolding(column: number): boolean {
    return this.activeHold[column] >= 0;
  }

  /** A hold tail outlives a note's own window by the release lenience, so it sets this. */
  get latestHitMs(): number {
    return this.windows.missAfterMs(RELEASE_WINDOW_LENIENCE);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * A key going down in `column` at `timeMs` of song time.
   *
   * Returns what it judged, or `null` when the press reached nothing — which is the
   * correct outcome for a press with no note anywhere near it, and is not a miss.
   */
  press(column: number, timeMs: number): JudgementEvent | null {
    if (this.activeHold[column] >= 0) return null;

    const noteIndex = this.playable.nextJudgeable(column);
    if (noteIndex < 0) return null;

    const note = this.playable.chart.notes[noteIndex];
    const isHold = note.endMs !== undefined;

    if (this.playable.headStates[noteIndex] === NoteState.Pending) {
      const errorMs = timeMs - note.timeMs;
      const judgement = this.windows.judge(errorMs);

      // Too early to be about this note at all: the press passes through untouched.
      if (judgement === null) return null;

      this.playable.headStates[noteIndex] =
        judgement === 'miss' ? NoteState.Missed : NoteState.Hit;

      // A hold begins even when its head was late enough to miss, matching lazer:
      // the tail is still there to be released, capped at MEH.
      if (isHold) this.activeHold[column] = noteIndex;

      return this.record(noteIndex, column, judgement, errorMs, false);
    }

    // The head has already been judged — missed, since a hit head would be holding.
    // Grabbing the note late is allowed as long as the tail is still to come.
    //
    // The release lenience deliberately does *not* apply here. It widens the window the
    // tail is judged in and delays its miss, but osu refuses to start a hold inside that
    // extra time: `DrawableHoldNote.OnPressed` tests the tail's plain `CanBeHit`. So the
    // tail can still be written off later than a hold can be picked up.
    if (isHold && this.playable.tailStates[noteIndex] === NoteState.Pending) {
      const grabDeadline = note.endMs! + this.windows.missAfterMs();
      if (timeMs <= grabDeadline) this.activeHold[column] = noteIndex;
    }

    return null;
  }

  /**
   * A key coming up in `column` at `timeMs` of song time.
   *
   * Only meaningful while a hold is in progress. Letting go before the tail's window is a
   * hold break: the tail is not judged now, it is left to be written off, and the note is
   * marked so nothing better than MEH can come of it.
   */
  release(column: number, timeMs: number): JudgementEvent | null {
    const noteIndex = this.activeHold[column];
    if (noteIndex < 0) return null;

    this.activeHold[column] = -1;

    const note = this.playable.chart.notes[noteIndex];
    if (note.endMs === undefined) return null;

    const errorMs = timeMs - note.endMs;
    const judgement = this.windows.judge(errorMs, RELEASE_WINDOW_LENIENCE);

    if (judgement === null) {
      // Released before the tail was reachable. The note survives to be missed.
      this.playable.holdBroken[noteIndex] = 1;
      return null;
    }

    const capped = this.capForBrokenHold(noteIndex, judgement);
    this.playable.tailStates[noteIndex] = capped === 'miss' ? NoteState.Missed : NoteState.Hit;

    return this.record(noteIndex, column, capped, errorMs, true);
  }

  // -------------------------------------------------------------------------
  // Time
  // -------------------------------------------------------------------------

  /**
   * Writes off everything whose window has closed, and returns what it judged.
   *
   * Call once per frame with the current song position. Without it the lane cursors never
   * move when the player does nothing.
   */
  update(timeMs: number): JudgementEvent[] {
    const events: JudgementEvent[] = [];
    const playable = this.playable;
    const headDeadline = this.windows.missAfterMs();
    const tailDeadline = this.windows.missAfterMs(RELEASE_WINDOW_LENIENCE);

    for (let column = 0; column < playable.columnNotes.length; column++) {
      for (;;) {
        const noteIndex = playable.nextJudgeable(column);
        if (noteIndex < 0) break;

        const note = playable.chart.notes[noteIndex];
        let progressed = false;

        if (
          playable.headStates[noteIndex] === NoteState.Pending &&
          timeMs > note.timeMs + headDeadline
        ) {
          playable.headStates[noteIndex] = NoteState.Missed;
          events.push(this.record(noteIndex, column, 'miss', null, false));
          progressed = true;
        }

        if (
          note.endMs !== undefined &&
          playable.headStates[noteIndex] !== NoteState.Pending &&
          playable.tailStates[noteIndex] === NoteState.Pending &&
          timeMs > note.endMs + tailDeadline
        ) {
          playable.tailStates[noteIndex] = NoteState.Missed;
          if (this.activeHold[column] === noteIndex) this.activeHold[column] = -1;
          events.push(this.record(noteIndex, column, 'miss', null, true));
          progressed = true;
        }

        // Nothing expired, so nothing further along this lane can have either.
        if (!progressed) break;
      }
    }

    return events;
  }

  // -------------------------------------------------------------------------

  /** A tail cannot beat MEH once the head was missed or the body was let go. */
  private capForBrokenHold(noteIndex: number, judgement: Judgement): Judgement {
    const broken =
      this.playable.headStates[noteIndex] !== NoteState.Hit ||
      this.playable.holdBroken[noteIndex] === 1;

    if (!broken || judgement === 'meh' || judgement === 'miss') return judgement;
    return 'meh';
  }

  private record(
    noteIndex: number,
    column: number,
    judgement: Judgement,
    errorMs: number | null,
    isTail: boolean,
  ): JudgementEvent {
    this.counts[judgement]++;
    this.weightedTotal += JUDGEMENT_WEIGHT[judgement];
    this.judgedCount++;

    if (errorMs !== null) this.errors.push(errorMs);

    if (JUDGEMENT_BREAKS_COMBO[judgement]) {
      this.combo = 0;
    } else {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    }

    return { noteIndex, column, judgement, errorMs, isTail };
  }
}

function emptyCounts(): Record<Judgement, number> {
  const counts = {} as Record<Judgement, number>;
  for (const judgement of JUDGEMENTS) counts[judgement] = 0;
  return counts;
}
