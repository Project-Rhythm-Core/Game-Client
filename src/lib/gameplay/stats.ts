/**
 * Statistics over a play, shared by every ruleset.
 *
 * These describe the *timing errors* a judge collected, not the results it handed out, so
 * they say the same thing whatever scale those results were graded on.
 */

/**
 * Unstable rate: ten times the standard deviation of the timing errors.
 *
 * The factor of ten is osu's convention, and the number is a better description of how
 * consistently someone is playing than accuracy is.
 */
export function unstableRate(errors: readonly number[]): number {
  if (errors.length < 2) return 0;

  let mean = 0;
  for (const error of errors) mean += error;
  mean /= errors.length;

  let variance = 0;
  for (const error of errors) variance += (error - mean) ** 2;
  variance /= errors.length;

  return Math.sqrt(variance) * 10;
}

/**
 * Mean timing error, in milliseconds. Negative means consistently early.
 *
 * The companion to the unstable rate, and the one that says what to *do*. Spread is skill;
 * a mean sitting well away from zero is calibration, and no amount of practice moves it —
 * it moves when the offset does.
 */
export function meanError(errors: readonly number[]): number {
  if (errors.length === 0) return 0;

  let total = 0;
  for (const error of errors) total += error;
  return total / errors.length;
}
