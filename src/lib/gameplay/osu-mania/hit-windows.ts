/**
 * osu!mania hit windows, as **lazer** implements them.
 *
 * Lazer is the target, and it is not the same thing as stable's ScoreV2 mod even though
 * the two agree on most of this. Where they part company is worth stating, because the
 * difference reads like a bug from either side:
 *
 * - **Stable** — both ScoreV1 and its ScoreV2 mod — makes a late MEH impossible. A note
 *   is written off once the OK window passes, and a press past it is a miss.
 * - **Lazer** is symmetric. `HitWindows.ResultFor` opens with `Math.Abs(timeOffset)`,
 *   `CanBeHit` keeps a note alive to the MEH window, and mania overrides neither, so a
 *   late press earns exactly what the same error would earn early.
 *
 * The values themselves are common ground: every osu!mania variant agrees on the windows
 * below GREAT — lazer's ranges interpolate to exactly `64 - 3 x OD` and so on — and only
 * PERFECT differs, where stable's ScoreV1 pins a flat 16 ms and everything else scales it
 * with difficulty.
 *
 * Hold notes are the other place stable's ScoreV1 stands alone: it gives a hold a single
 * judgement from the *combined* head and tail error against roughly doubled windows,
 * where ScoreV2 and lazer both judge head and tail separately. `ManiaJudge` follows lazer.
 *
 * Values are half-widths: a window of 40 ms means +/- 40 ms around the note.
 */

import { JUDGEMENTS, type Judgement } from './judgements.ts';

export type { Judgement };

/**
 * Window half-widths at OD 0, OD 5 and OD 10, taken from lazer's `ManiaHitWindows`.
 * Everything in between is interpolated linearly through the midpoint.
 */
const WINDOW_RANGES: Readonly<Record<Judgement, readonly [number, number, number]>> = {
  perfect: [22.4, 19.4, 13.9],
  great: [64, 49, 34],
  good: [97, 82, 67],
  ok: [127, 112, 97],
  meh: [151, 136, 121],
  miss: [188, 173, 158],
};

/** Tail windows are this much more forgiving than a note's. */
export const RELEASE_WINDOW_LENIENCE = 1.5;

/**
 * Maps an overall difficulty onto a two-piece linear range.
 *
 * The halves are separate because OD 5 is the midpoint by definition rather than the
 * average of the endpoints.
 */
export function difficultyRange(
  overallDifficulty: number,
  [atZero, atFive, atTen]: readonly [number, number, number],
): number {
  const t = (overallDifficulty - 5) / 5;
  if (overallDifficulty > 5) return atFive + (atTen - atFive) * t;
  if (overallDifficulty < 5) return atFive + (atFive - atZero) * t;
  return atFive;
}

export class ManiaHitWindows {
  readonly overallDifficulty: number;
  private readonly windows: Record<Judgement, number>;

  constructor(overallDifficulty: number) {
    this.overallDifficulty = overallDifficulty;

    // The floor-then-add-a-half is osu's own, and is why a window quoted as 40 ms
    // actually accepts up to 40.5 ms on each side.
    const windows = {} as Record<Judgement, number>;
    for (const judgement of JUDGEMENTS) {
      windows[judgement] =
        Math.floor(difficultyRange(overallDifficulty, WINDOW_RANGES[judgement])) + 0.5;
    }

    this.windows = windows;
  }

  /** Half-width of `judgement`'s window, in milliseconds. */
  windowFor(judgement: Judgement): number {
    return this.windows[judgement];
  }

  /**
   * The judgement a timing error earns, or `null` when the note cannot be touched at all.
   *
   * `errorMs` is signed — negative is early — but only its magnitude decides the result.
   * Every window is symmetric about the note, because osu's own `HitWindows.ResultFor`
   * opens with `Math.Abs(timeOffset)` and nothing in mania's drawables reintroduces a
   * side. An earlier version of this cut the MEH and MISS bands off the late side, which
   * cost the player a 24 ms band where osu awards a MEH and keeps their combo.
   *
   * `null` is not a miss. A press outside even the MISS window is not about this note at
   * all: it passes straight through and the note stays where it is.
   */
  judge(errorMs: number, lenience = 1): Judgement | null {
    const magnitude = Math.abs(errorMs / lenience);

    for (const judgement of JUDGEMENTS) {
      if (magnitude <= this.windows[judgement]) return judgement;
    }

    return null;
  }

  /**
   * How late a note may be before it is written off as missed.
   *
   * The MEH window, which is what osu's `CanBeHit` compares against: it asks for the
   * window of the lowest *successful* result, and in mania that is MEH. MISS is wider
   * still, but it never keeps a note alive — it only exists to catch a press that
   * arrived far enough out to be worth calling a miss.
   */
  missAfterMs(lenience = 1): number {
    return this.windows.meh * lenience;
  }

  /** Earliest a press can interact with a note at all, as a negative offset. */
  earliestTouchMs(lenience = 1): number {
    return -this.windows.miss * lenience;
  }
}
