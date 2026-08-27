import type { PlaybackClock } from './playback-clock.ts';

/**
 * The pause before the music starts.
 *
 * A chart whose first note lands a fraction of a second in is unplayable without one: the
 * note is on the receptor before the player has read anything. osu solves this by starting
 * gameplay at a **negative** time — `DrawableRuleset.GameplayStartTime` is
 * `first.StartTime - 2000`, and the clock runs from there — so the audio itself is delayed
 * when it has to be, and the player always gets the same two seconds.
 *
 * That is what this reproduces. Before zero it counts up on the wall clock, since there is
 * no audio to follow yet; from zero on it hands over to whatever clock is really timing
 * the chart. Nothing downstream has to know: a negative position is just a position, and
 * notes at negative times do not exist, so the playfield draws an empty approach.
 */

/**
 * How long before the first note the chart begins, in milliseconds.
 *
 * osu's own figure. It is not a guess about human reaction time — it is the number every
 * osu player's timing was built against, so matching it is what makes a chart imported
 * from osu open the way it does there.
 */
export const DEFAULT_LEAD_IN_MS = 2000;

/**
 * How long a chart should wait before its music starts, given when its first note is.
 *
 * Zero whenever the audio already has room: the music starts immediately and the approach
 * happens over the chart's own intro. Only a chart that opens too abruptly buys silence,
 * and only as much as it needs.
 *
 * `chartLeadInMs` is the chart's own request — osu's `AudioLeadIn` — which can ask for
 * more than the default but never for less.
 */
export function leadInFor(firstNoteMs: number, chartLeadInMs = 0): number {
  const wanted = Math.max(DEFAULT_LEAD_IN_MS, chartLeadInMs);
  return Math.max(0, wanted - firstNoteMs);
}

export class LeadInClock implements PlaybackClock {
  /** The clock that takes over once the music is running. */
  private readonly inner: PlaybackClock;

  private leadInMs = 0;
  private startedAtMs = 0;
  private running = false;

  /**
   * Whether the music has been started *for this attempt*.
   *
   * Handing over on `inner.isRunning` alone is not enough, and restarting is what shows it:
   * the audio clock is still running from the previous attempt, so a fresh approach would
   * end the instant it began. This is only ever set by whoever actually started the music.
   */
  private handedOver = false;

  constructor(inner: PlaybackClock) {
    this.inner = inner;
  }

  /**
   * Begins the approach. `leadInMs` is how long until the music should start.
   *
   * Starting the music is the caller's job, because only it knows how: this clock does not
   * own the audio, it only describes where the chart is.
   */
  begin(leadInMs: number): void {
    this.leadInMs = Math.max(0, leadInMs);
    this.startedAtMs = performance.now();
    this.running = true;
    this.handedOver = false;
  }

  /**
   * The music has been started; the inner clock is the authority from here.
   *
   * Called by whoever started it rather than inferred, so that restarting a chart whose
   * audio never stopped still gets its full approach.
   */
  handOver(): void {
    this.handedOver = true;
  }

  stop(): void {
    this.running = false;
  }

  /**
   * Position in the chart, negative during the approach.
   *
   * The handover needs both a caller that started the music and an inner clock that is
   * actually running — never the countdown reaching zero. The audio takes a moment to
   * become audible and its clock only latches once it has, so counting on until that
   * really happens is what keeps the two from disagreeing about where zero was.
   */
  positionMs(): number {
    if (!this.running) return 0;
    if (this.handedOver && this.inner.isRunning) return this.inner.positionMs();

    return performance.now() - this.startedAtMs - this.leadInMs;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** How long is left before the music starts. Zero once it has. */
  remainingMs(): number {
    if (!this.running || (this.handedOver && this.inner.isRunning)) return 0;
    return Math.max(0, -this.positionMs());
  }
}
