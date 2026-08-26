/**
 * What gameplay needs from a clock.
 *
 * Everything downstream — where notes are drawn, when they are judged, when they are
 * written off — is a function of this one number, so a chart with no clock does not play
 * at all rather than playing badly.
 *
 * There are two implementations because there are two situations. Most charts have a
 * background track, and then the audio device is the authority: the picture follows the
 * sound. A fully keysounded chart has no track to follow, and until the engine can mix
 * its samples there is nothing to anchor to, so time simply runs.
 */
export interface PlaybackClock {
  /** Current position in the chart, in milliseconds. */
  positionMs(): number;

  /** Whether the clock is running. Position reads 0 when it is not. */
  readonly isRunning: boolean;
}

/**
 * A clock that runs on its own, for charts with no audio to follow.
 *
 * Free-running rather than anchored, so nothing keeps it honest — which is exactly why
 * it is the fallback and not the default. Once the engine can play a sample bank, a
 * keysounded chart should be driven by the audio device like any other, because the
 * samples have to land where the notes say they do.
 */
export class SystemClock implements PlaybackClock {
  private startedAtMs = 0;
  private running = false;

  start(fromMs = 0): void {
    this.startedAtMs = performance.now() - fromMs;
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  positionMs(): number {
    return this.running ? performance.now() - this.startedAtMs : 0;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
