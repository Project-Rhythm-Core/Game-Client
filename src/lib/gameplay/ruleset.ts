import type { PlayableChart } from '../chart/playable-chart.ts';

/**
 * What a source format decides about play.
 *
 * The chart model is deliberately format-agnostic — notes, columns, scroll, samples — but
 * *judging* one is not. Every format brings its own vocabulary of results, its own windows,
 * its own rule for what breaks a combo and its own idea of what accuracy means. osu!mania
 * grades six results and lets everything but a miss continue a combo; BMS grades five and
 * breaks on the bottom two; both are right for their own charts.
 *
 * So none of that lives in the renderer or the shell. They ask a ruleset instead, and a
 * new format is a new implementation of this interface rather than an edit spread across
 * the playfield, the HUD and the skin loader.
 *
 * Judgement names are plain strings here on purpose. A ruleset keeps its own union
 * internally, where exhaustiveness is worth having; by the time a name reaches the
 * renderer all that is wanted is a key to look a label and a colour up by, and a union
 * would only force every generic layer to be generic over it too.
 */

/** How a judgement is presented, and what it does to a combo. */
export interface JudgementStyle {
  /** Drawn when the skin ships no graphic for this judgement. */
  label: string;
  /** Lane flash and HUD tally, as a Pixi colour. */
  colour: number;
  /**
   * Whether this result breaks the combo.
   *
   * A property of the ruleset rather than of the name: osu!mania's MEH keeps a combo
   * alive, while BMS's BAD — a comparable result — ends it.
   */
  breaksCombo: boolean;
}

/** One result handed out, whether by a key or by a note running out of time. */
export interface JudgementEvent {
  /** Index into `chart.notes`. */
  noteIndex: number;
  column: number;
  /** One of the ruleset's own {@link Ruleset.judgements}. */
  judgement: string;
  /** Signed timing error in milliseconds; negative is early. `null` when never touched. */
  errorMs: number | null;
  /** Whether this judged the release of a hold rather than a press. */
  isTail: boolean;
}

/**
 * The running state of one attempt.
 *
 * Everything here is driven by time and input. Nothing consults the renderer, because a
 * chart can legitimately hide a note or freeze it in place and it still has to be judged.
 */
export interface Judge {
  /** A key going down in `column` at `timeMs` of song time. */
  press(column: number, timeMs: number): JudgementEvent | null;
  /** A key coming up. Only meaningful while a hold is in progress. */
  release(column: number, timeMs: number): JudgementEvent | null;
  /** Writes off whatever ran out of time. Call once per frame with the song position. */
  update(timeMs: number): JudgementEvent[];
  /** Back to the start of the attempt. */
  reset(): void;

  /** Tally per judgement name. Every one of the ruleset's names is present. */
  readonly counts: Readonly<Record<string, number>>;
  readonly combo: number;
  readonly maxCombo: number;
  /** 0 to 1, by whatever the ruleset counts as accuracy. Reads 1 before anything lands. */
  readonly accuracy: number;
  /**
   * Signed timing errors from key presses, oldest first.
   *
   * Presses and releases are kept apart rather than pooled, and the reason is not tidiness:
   * a ruleset that judges a release at all tends to judge it more leniently — osu!mania
   * widens the window by half again — so the two populations have genuinely different
   * spreads. Averaging them together produces a mean that describes neither, which matters
   * because that mean is what an offset is calibrated from. A chart that is three-quarters
   * hold notes would calibrate mostly on releases.
   */
  readonly pressErrors: readonly number[];

  /** Signed timing errors from releases. Empty for a chart with no holds. */
  readonly releaseErrors: readonly number[];
  /** Whether `column` currently has a hold in progress. */
  isHolding(column: number): boolean;

  /**
   * The longest a note stays reachable after its own time, in milliseconds.
   *
   * The renderer needs this and cannot work it out: how long a note is worth drawing past
   * the judgement line is a question about when it stops being hittable, not about how
   * fast the chart happens to be scrolling. Take the widest case the ruleset has — in
   * osu!mania that is a hold tail, with its release lenience.
   */
  readonly latestHitMs: number;
}

export interface Ruleset {
  /** Stable identifier, for settings and for reporting which ruleset played a score. */
  readonly id: string;
  /**
   * Source formats this plays, spelled as `chart.origin.format` writes them.
   *
   * A list rather than one value because a ruleset can outlive the format that named it:
   * osu!mania rules are what a converted chart should be judged by too.
   */
  readonly formats: readonly string[];
  /** Judgement names, best first. The order the HUD tallies them in. */
  readonly judgements: readonly string[];
  /** Presentation and combo behaviour for one of {@link judgements}. */
  styleFor(judgement: string): JudgementStyle;
  /**
   * Builds a judge for one chart.
   *
   * The ruleset reads whatever it needs out of `playable.chart.origin` — osu!mania wants
   * an overall difficulty, BMS a `#RANK` — so nothing upstream has to know which fields a
   * format carries.
   */
  createJudge(playable: PlayableChart): Judge;
}

/** Rulesets that can be chosen, in registration order. */
const registry: Ruleset[] = [];

/**
 * Makes a ruleset selectable.
 *
 * Registration happens where the ruleset is defined rather than in a central list, so
 * adding a format touches its own directory and nothing else.
 */
export function registerRuleset(ruleset: Ruleset): void {
  registry.push(ruleset);
}

/** Everything registered, for settings screens and diagnostics. */
export function rulesets(): readonly Ruleset[] {
  return registry;
}

/**
 * The ruleset that plays `format`, or `null` when nothing claims it.
 *
 * `null` rather than a fallback: guessing would judge a chart by rules its charter never
 * had in mind, and silently. Refusing to start says what is wrong.
 */
export function rulesetFor(format: string): Ruleset | null {
  return registry.find((ruleset) => ruleset.formats.includes(format)) ?? null;
}
