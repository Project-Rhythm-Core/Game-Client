/**
 * Frame timing.
 *
 * An average frame rate hides the thing that actually matters here. A single 30 ms hitch
 * barely moves a 60 FPS average but is plainly visible as a stutter, and in a rhythm game
 * it desynchronises what the player sees from what they hear for exactly as long as it
 * lasts. So this reports the worst frame alongside the average, and counts the frames
 * that ran long.
 *
 * Allocation-free: it is called once per frame.
 */

/** How often the reported figures are refreshed. */
const WINDOW_MS = 500;

/** A frame is "long" past this multiple of the shortest frame seen. */
const LONG_FRAME_FACTOR = 1.5;

export class FrameCounter {
  /** Frames per second, averaged over the last window. */
  fps = 0;

  /** Duration of the most recent frame, in milliseconds. */
  frameMs = 0;

  /** Worst frame in the last completed window, in milliseconds. */
  worstMs = 0;

  /** Frames that ran long since the last {@link reset}. */
  longFrames = 0;

  /**
   * Shortest frame seen, which stands in for the display's refresh period.
   *
   * Deriving the threshold from this rather than from the average has two advantages:
   * stalls only ever make frames longer, so the estimate cannot be dragged upwards by
   * the very hitches it is meant to catch; and it is available from the second frame
   * onwards, so start-up stutter — usually the worst there is — is not missed while
   * waiting for a first average to settle.
   */
  private shortestMs = Infinity;

  private lastFrameAtMs = 0;
  private windowStartMs = 0;
  private framesInWindow = 0;
  private worstInWindowMs = 0;

  /** Call once per frame. `nowMs` should come from `performance.now()`. */
  update(nowMs: number): void {
    if (this.lastFrameAtMs === 0) {
      this.lastFrameAtMs = nowMs;
      this.windowStartMs = nowMs;
      return;
    }

    this.frameMs = nowMs - this.lastFrameAtMs;
    this.lastFrameAtMs = nowMs;

    this.framesInWindow++;
    if (this.frameMs > this.worstInWindowMs) this.worstInWindowMs = this.frameMs;

    // Judged against this display's own period, so the count means the same thing on a
    // 60 Hz panel and a 144 Hz one.
    if (this.frameMs > LONG_FRAME_FACTOR * this.shortestMs) this.longFrames++;
    if (this.frameMs < this.shortestMs) this.shortestMs = this.frameMs;

    const elapsed = nowMs - this.windowStartMs;
    if (elapsed >= WINDOW_MS) {
      this.fps = (this.framesInWindow * 1000) / elapsed;
      this.worstMs = this.worstInWindowMs;
      this.windowStartMs = nowMs;
      this.framesInWindow = 0;
      this.worstInWindowMs = 0;
    }
  }

  /** Shortest frame seen, in milliseconds. Approximates the display's refresh period. */
  get shortestFrameMs(): number {
    return Number.isFinite(this.shortestMs) ? this.shortestMs : 0;
  }

  /** Clears the long-frame tally without disturbing the running average. */
  reset(): void {
    this.longFrames = 0;
  }
}
