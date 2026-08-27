/**
 * The osu!mania judgement vocabulary.
 *
 * Everything a format decides about *what results exist* rather than *when they are
 * earned*: the names, what they are called on screen, what they are worth, and which of
 * them ends a combo. `hit-windows.ts` decides the timing; this decides the scale it is
 * graded on.
 *
 * Kept apart because the two change for entirely different reasons, and because this is
 * the half another format replaces wholesale — BMS grades five results and breaks a combo
 * on the bottom two, which is not a different set of numbers but a different scale.
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
 * Colour of the lane flash and the HUD tally for each judgement.
 *
 * Lives with the vocabulary rather than in the playfield: a judgement's colour belongs to
 * the scale it is part of, and the renderer draws whatever scale it is handed.
 */
export const JUDGEMENT_COLOURS: Readonly<Record<Judgement, number>> = {
  perfect: 0xffe08a,
  great: 0x8ad7ff,
  good: 0x8affa0,
  ok: 0xd3b8ff,
  meh: 0xffb454,
  miss: 0xff6b6b,
};

/**
 * Which results end a combo.
 *
 * Only a miss, in osu!mania — a MEH still continues. Worth stating as data rather than as
 * a comparison buried in the judge, because it is exactly the kind of rule that differs:
 * BMS ends a combo on its BAD, which sits where MEH sits here.
 */
export const JUDGEMENT_BREAKS_COMBO: Readonly<Record<Judgement, boolean>> = {
  perfect: false,
  great: false,
  good: false,
  ok: false,
  meh: false,
  miss: true,
};
