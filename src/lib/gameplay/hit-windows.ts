/**
 * osu!mania hit windows.
 *
 * Replicates the lazer / ScoreV2 model, which is what osu is moving to. The note windows
 * below GREAT are identical in every osu!mania variant — lazer's own ranges interpolate
 * to exactly `64 - 3 x OD` and so on — so the only place the variants disagree on a plain
 * note is PERFECT: stable's ScoreV1 pins it at a flat 16 ms, while this model scales it
 * with difficulty.
 *
 * Values are half-widths: a window of 40 ms means +/- 40 ms around the note.
 */

export type Judgement = 'perfect' | 'great' | 'good' | 'ok' | 'meh' | 'miss';

/** Best to worst, which is the order windows are tested in. */
export const JUDGEMENTS: readonly Judgement[] = ['perfect', 'great', 'good', 'ok', 'meh', 'miss'];

/**
 * What each judgement is called on screen.
 *
 * The identifiers above are osu's internal `HitResult` names, which are shared across
 * every one of its rulesets and read a whole step too generous in mania: the result osu
 * calls GREAT is the one a mania player and every mania skin call PERFECT. The names here
 * are the ones the reference skin prints on its own judgement graphics, so the text the
 * game shows when a skin ships none agrees with the images when it does.
 */
export const JUDGEMENT_LABELS: Readonly<Record<Judgement, string>> = {
  perfect: 'max',
  great: 'perfect',
  good: 'great',
  ok: 'good',
  meh: 'bad',
  miss: 'miss',
};

/**
 * Accuracy weight of each judgement, and the divisor a perfect play would reach.
 *
 * ScoreV2 raises PERFECT above GREAT — under ScoreV1 the two are worth the same, so an
 * all-GREAT play reads as 100 % there and slightly under it here.
 */
export const JUDGEMENT_WEIGHT: Readonly<Record<Judgement, number>> = {
  perfect: 305,
  great: 300,
  good: 200,
  ok: 100,
  meh: 50,
  miss: 0,
};

/** Weight of a flawless judgement, which every judgement is measured against. */
export const MAX_JUDGEMENT_WEIGHT = JUDGEMENT_WEIGHT.perfect;

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
