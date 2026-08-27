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

/** How a play's timing errors were distributed, in milliseconds. */
export interface ErrorSummary {
  /** Mean of every error. Negative is early. */
  mean: number;
  /** Mean of the errors that were early, and how many there were. */
  earlyMean: number;
  earlyCount: number;
  /** Mean of the errors that were late. */
  lateMean: number;
  lateCount: number;
  /** Every error, exact hits included. */
  total: number;
  /**
   * How far the mean itself is expected to wander, in milliseconds.
   *
   * The standard error: the spread divided by the square root of how many hits it came
   * from. A mean of 15 ms means nothing if it was drawn from wild scatter over a handful of
   * notes, and everything if it came from a tight play over hundreds. Without this the
   * summary would confidently recommend chasing noise.
   */
  standardError: number;
}

/**
 * Splits the timing errors into the early and late halves and averages each.
 *
 * The overall mean alone hides the case that matters most. Being 20 ms early half the time
 * and 20 ms late the other half averages to zero, and so does hitting everything perfectly;
 * the two need completely different responses. Seeing the halves separates them: two
 * roughly equal averages of opposite sign is spread, which is practice, while both halves
 * pulled to one side is calibration, which is the offset.
 *
 * An error of exactly zero belongs to neither half — it is not evidence in either
 * direction — but it does count towards the overall mean.
 */
export function summariseErrors(errors: readonly number[]): ErrorSummary {
  let earlyTotal = 0;
  let earlyCount = 0;
  let lateTotal = 0;
  let lateCount = 0;

  for (const error of errors) {
    if (error < 0) {
      earlyTotal += error;
      earlyCount++;
    } else if (error > 0) {
      lateTotal += error;
      lateCount++;
    }
  }

  const spread = unstableRate(errors) / 10;

  return {
    mean: meanError(errors),
    standardError: errors.length > 1 ? spread / Math.sqrt(errors.length) : Infinity,
    earlyMean: earlyCount === 0 ? 0 : earlyTotal / earlyCount,
    earlyCount,
    lateMean: lateCount === 0 ? 0 : lateTotal / lateCount,
    lateCount,
    total: errors.length,
  };
}

/**
 * Whether this play says anything about the offset at all.
 *
 * Two things have to hold. The mean has to be far enough from zero to be worth acting on,
 * and it has to be far enough from zero *relative to how much it could have wandered* —
 * two standard errors, the ordinary bar for "not just noise". A scattered play over a few
 * notes fails the second even when it passes the first, which is exactly the case that
 * would otherwise send a player recalibrating after every attempt.
 */
export function offsetIsWorthMoving(summary: ErrorSummary, thresholdMs: number): boolean {
  return (
    Math.abs(summary.mean) > thresholdMs && Math.abs(summary.mean) > 2 * summary.standardError
  );
}

/**
 * The offset that would have centred this play, given the one it was played with.
 *
 * A positive audio offset means the sound is heard later than the clock reports, so the
 * reported position is pulled back — which makes every error smaller. Hitting early is the
 * opposite case and wants the offset moved the other way, so the correction is simply the
 * mean added to what was already set.
 */
export function suggestedOffsetMs(currentOffsetMs: number, summary: ErrorSummary): number {
  return currentOffsetMs + summary.mean;
}
