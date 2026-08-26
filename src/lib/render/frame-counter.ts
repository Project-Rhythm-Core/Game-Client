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

/** How many recent frame periods the refresh estimate is taken from. */
const PERIOD_SAMPLE_COUNT = 128;

/** Samples needed before frames are classified at all. */
const MIN_SAMPLES = 15;

export class FrameCounter {
  /** Frames per second, averaged over the last window. */
  fps = 0;

  /**
   * Wall time since the previous frame, in milliseconds.
   *
   * With vsync on this is pinned to the display's refresh period and says nothing about
   * how much headroom there is — a 144 Hz display reads 6.94 ms whether the work took
   * one millisecond or six. Use {@link updateMs} for that.
   */
  frameMs = 0;

  /** Worst frame period in the last completed window, in milliseconds. */
  worstMs = 0;

  /**
   * Time spent producing the most recent frame, in milliseconds.
   *
   * This is the number that reflects effort, and the one worth watching: it is the
   * budget being consumed out of each frame period. It covers the caller's own update
   * and draw work, not the GPU submission that follows.
   */
  updateMs = 0;

  /** Worst update time in the last completed window, in milliseconds. */
  worstUpdateMs = 0;

  /** Frames that ran long since the last {@link reset}. */
  longFrames = 0;

  /**
   * The display's refresh period, taken as the median of recent frames.
   *
   * The median is the point here. An average is dragged upwards by the very stutters it
   * is meant to detect, and the shortest frame seen is worse still: one anomalously
   * short sample — a catch-up tick, a coarsened clock reading — poisons the estimate for
   * the rest of the session, after which every ordinary frame reads as dropped.
   * A median shrugs off outliers at both ends.
   */
  private refreshPeriodMs = 0;

  /** Recent frame periods, newest overwriting oldest. */
  private readonly periodSamples = new Float64Array(PERIOD_SAMPLE_COUNT);
  private readonly sortScratch = new Float64Array(PERIOD_SAMPLE_COUNT);
  private sampleWriteIndex = 0;
  private sampleCount = 0;

  private lastFrameAtMs = 0;
  private windowStartMs = 0;
  private framesInWindow = 0;
  private worstInWindowMs = 0;
  private worstUpdateInWindowMs = 0;

  /**
   * Call once per frame.
   *
   * `nowMs` should be the frame's **presentation** timestamp — what
   * `requestAnimationFrame` hands its callback, which Pixi exposes as `ticker.lastTime`.
   * Reading the clock inside the callback instead measures when the callback happened to
   * be scheduled, and that jitter is not a dropped frame: the picture still appeared on
   * time. Using it inflates the dropped count by a couple of percent on a machine that
   * is not dropping anything at all.
   */
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
    this.periodSamples[this.sampleWriteIndex] = this.frameMs;
    this.sampleWriteIndex = (this.sampleWriteIndex + 1) % PERIOD_SAMPLE_COUNT;
    if (this.sampleCount < PERIOD_SAMPLE_COUNT) this.sampleCount++;

    // Judged against this display's own period, so the count means the same thing on a
    // 60 Hz panel and a 144 Hz one.
    if (this.refreshPeriodMs > 0 && this.frameMs > LONG_FRAME_FACTOR * this.refreshPeriodMs) {
      this.longFrames++;
    }

    const elapsed = nowMs - this.windowStartMs;
    if (elapsed >= WINDOW_MS) {
      this.refreshPeriodMs = this.medianPeriod();
      this.fps = (this.framesInWindow * 1000) / elapsed;
      this.worstMs = this.worstInWindowMs;
      this.worstUpdateMs = this.worstUpdateInWindowMs;
      this.windowStartMs = nowMs;
      this.framesInWindow = 0;
      this.worstInWindowMs = 0;
      this.worstUpdateInWindowMs = 0;
    }
  }

  /**
   * Records how long this frame's work took. Call at the end of the frame.
   *
   * Kept separate from {@link update} so the caller decides what counts as work.
   */
  recordUpdate(durationMs: number): void {
    this.updateMs = durationMs;
    if (durationMs > this.worstUpdateInWindowMs) this.worstUpdateInWindowMs = durationMs;
  }

  /** Share of the frame period spent working, as a fraction. Zero if not yet known. */
  get load(): number {
    return this.refreshPeriodMs > 0 ? this.updateMs / this.refreshPeriodMs : 0;
  }

  /** The display's refresh period in milliseconds, or `0` before enough frames. */
  get displayPeriodMs(): number {
    return this.refreshPeriodMs;
  }

  /** Median of the recent frame periods, or `0` while there are too few samples. */
  private medianPeriod(): number {
    if (this.sampleCount < MIN_SAMPLES) return 0;

    const scratch = this.sortScratch.subarray(0, this.sampleCount);
    scratch.set(this.periodSamples.subarray(0, this.sampleCount));
    scratch.sort();

    return scratch[this.sampleCount >> 1];
  }

  /** Clears the long-frame tally without disturbing the running average. */
  reset(): void {
    this.longFrames = 0;
  }
}
