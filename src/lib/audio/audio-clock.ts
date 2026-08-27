import type { PlaybackClock } from './playback-clock.ts';
import type { AudioInfo, ChartAudioRequest, PlaybackStats } from './types.ts';

/**
 * Playback position, local to the renderer.
 *
 * The authoritative clock lives in the native audio thread, but reaching it costs an IPC
 * round trip — and awaiting one inside the render loop means the frame is always drawn
 * one frame late.
 *
 * So this never asks per frame. It estimates once, via an NTP-style handshake, the
 * `performance.now()` value at which the track was at position 0. From then on, position
 * is local arithmetic. Every half second it re-compares in the background and absorbs the
 * difference gradually.
 */

/** Probes taken when latching on. The lowest round trip wins. */
const HANDSHAKE_PROBE_COUNT = 8;

/** Probes taken by each background re-comparison. */
const RESYNC_PROBE_COUNT = 3;

/** How often the local clock is re-compared against the native one. */
const RESYNC_INTERVAL_MS = 500;

/**
 * Fastest the local clock is allowed to be corrected, in milliseconds of correction per
 * second. Low enough that a correction is never visible on screen.
 */
const MAX_SLEW_MS_PER_SECOND = 20;

/** Past this, assume a real jump (a restart or seek) and snap instead of slewing. */
const SNAP_THRESHOLD_MS = 80;

/**
 * How long to wait for the first sample to become audible. With the device warm this is
 * a few milliseconds; from cold it can be a couple of hundred. Beyond this, something is
 * wrong.
 */
const PLAYBACK_START_TIMEOUT_MS = 3000;

/** How often to poll while waiting for the device to come up to speed. */
const READY_POLL_INTERVAL_MS = 20;

/** A single measurement of the native clock. */
interface ClockProbe {
  /** Round-trip time of the IPC call, in milliseconds. */
  roundTripMs: number;
  /** The `performance.now()` value at which playback position was 0. */
  originMs: number;
  /** What the engine reported, kept to tell a running track from a finished one. */
  positionMs: number;
}

export class AudioClock implements PlaybackClock {
  /** The `performance.now()` value at which playback position was 0. */
  private originMs = 0;

  /** Where `originMs` is being slewed towards. */
  private targetOriginMs = 0;

  private lastSlewAtMs = 0;
  private running = false;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;

  /** Stream description from the last successful `load()`. */
  info: AudioInfo | null = null;

  /** Playback snapshot, refreshed by the background resync. */
  stats: PlaybackStats | null = null;

  /** Last observed difference between the local and native clocks, in milliseconds. */
  syncErrorMs = 0;

  /** Round trip of the accepted handshake probe, in milliseconds. */
  roundTripMs = 0;

  private get bridge() {
    return window.electronAPI.audio;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Decodes the file and opens the device.
   *
   * Call this as early as the application can — on entering a screen, not next to the
   * `play()` — because all of the start-up cost is paid here.
   */
  async load(filePath: string): Promise<AudioInfo> {
    this.info = await this.bridge.load(filePath);
    return this.info;
  }

  /**
   * Decodes a chart's music and its whole sample bank, and opens the device.
   *
   * Everything ends up in one stream, so a keysound and the music share a latency. It
   * also gives a chart with no music a real clock: the device still runs, so position
   * still advances.
   */
  async loadChart(request: ChartAudioRequest): Promise<AudioInfo> {
    this.info = await this.bridge.loadChart(request);
    return this.info;
  }

  /** True once the device is up to speed and starting playback is heard immediately. */
  isReady(): Promise<boolean> {
    return this.bridge.isReady();
  }

  /**
   * Waits for the device to come up to speed.
   *
   * Bringing the stream up takes a couple of hundred milliseconds and is the reason a
   * cold `play()` is heard late; doing it here takes it off the critical path. Returns
   * `false` if the deadline passes.
   */
  async waitUntilReady(timeoutMs = 5000): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;

    while (!(await this.isReady())) {
      if (performance.now() > deadline) return false;
      await delay(READY_POLL_INTERVAL_MS);
    }

    return true;
  }

  async play(): Promise<void> {
    await this.bridge.play();
    await this.latchOntoNativeClock();
  }

  /** Restarts from the beginning without reopening the device. */
  async restart(): Promise<void> {
    await this.bridge.restart();
    await this.latchOntoNativeClock();
  }

  /** Stops tracking and releases the device. The track must be loaded again after this. */
  async unload(): Promise<void> {
    this.running = false;

    if (this.resyncTimer !== null) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }

    await this.bridge.unload();
  }

  // -------------------------------------------------------------------------
  // Reading the position
  // -------------------------------------------------------------------------

  /**
   * Current audible position in milliseconds.
   *
   * Called once per frame and does no IPC: a subtraction plus whatever correction is
   * still owed from the last resync.
   */
  positionMs(): number {
    if (!this.running) return 0;

    const now = performance.now();
    this.applySlew(now);

    const position = now - this.originMs;
    const duration = this.info?.durationMs ?? Infinity;

    return Math.min(Math.max(position, 0), duration);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Manual calibration. Positive means the audio is heard later than reported. */
  setOffsetMs(offsetMs: number): Promise<void> {
    return this.bridge.setOffsetMs(offsetMs);
  }

  // -------------------------------------------------------------------------
  // Synchronisation
  // -------------------------------------------------------------------------

  /** Waits for audio to actually start, then latches the local clock onto it. */
  private async latchOntoNativeClock(): Promise<void> {
    // After play() or restart() the engine reports 0 until the first sample is genuinely
    // audible. Latching before that would produce an origin that runs ahead of reality.
    const deadline = performance.now() + PLAYBACK_START_TIMEOUT_MS;

    while ((await this.bridge.position()) <= 0) {
      if (performance.now() > deadline) {
        throw new Error('audio did not start: the device is not playing');
      }
      await nextFrame();
    }

    const best = await this.probe(HANDSHAKE_PROBE_COUNT);

    this.originMs = best.originMs;
    this.targetOriginMs = best.originMs;
    this.roundTripMs = best.roundTripMs;
    this.syncErrorMs = 0;
    this.lastSlewAtMs = performance.now();
    this.running = true;

    if (this.resyncTimer === null) {
      this.resyncTimer = setInterval(() => void this.resync(), RESYNC_INTERVAL_MS);
    }
  }

  /**
   * Samples the native clock `count` times and keeps the fastest exchange.
   *
   * The reply corresponds to some instant between the two local timestamps, so the
   * midpoint is the best single guess and its error is bounded by half the round trip.
   * Taking the minimum therefore discards IPC scheduling noise rather than averaging it
   * in — the same reasoning NTP uses.
   */
  private async probe(count: number): Promise<ClockProbe> {
    let best: ClockProbe = { roundTripMs: Infinity, originMs: 0, positionMs: 0 };

    for (let i = 0; i < count; i++) {
      const sentAt = performance.now();
      const positionMs = await this.bridge.position();
      const receivedAt = performance.now();

      const roundTripMs = receivedAt - sentAt;
      if (roundTripMs < best.roundTripMs) {
        best = {
          roundTripMs,
          originMs: (sentAt + receivedAt) / 2 - positionMs,
          positionMs,
        };
      }
    }

    return best;
  }

  /** Background re-comparison. Never blocks the render loop. */
  private async resync(): Promise<void> {
    if (!this.running) return;

    const probe = await this.probe(RESYNC_PROBE_COUNT);

    // A probe much slower than the handshake is dominated by IPC jitter. Correcting
    // with it would be worse than not correcting at all.
    if (probe.roundTripMs > Math.max(this.roundTripMs * 4, 8)) return;

    // Past the end of the track the engine clamps its own position, so the origin this
    // arithmetic derives runs forward by a whole interval every interval while the track
    // stands still. Correcting from that is meaningless, and reporting it is worse than
    // meaningless: it reads as half a second of desync on a chart that played perfectly.
    // Stats still refresh, because voices and dropped samples are real either way.
    const durationMs = this.info?.durationMs ?? Infinity;
    if (probe.positionMs >= durationMs) {
      this.stats = await this.bridge.stats();
      return;
    }

    this.syncErrorMs = probe.originMs - this.originMs;

    if (Math.abs(this.syncErrorMs) > SNAP_THRESHOLD_MS) {
      // Too large to be drift: something really moved, so follow it immediately.
      this.originMs = probe.originMs;
      this.targetOriginMs = probe.originMs;
    } else {
      this.targetOriginMs = probe.originMs;
    }

    this.stats = await this.bridge.stats();
  }

  /**
   * Moves `originMs` towards `targetOriginMs` at a bounded rate.
   *
   * The correction is applied to the origin rather than to the reported position, so
   * position stays monotonic throughout: it simply advances at very slightly more or
   * less than one millisecond per millisecond until the error is gone.
   */
  private applySlew(now: number): void {
    const elapsedSeconds = (now - this.lastSlewAtMs) / 1000;
    this.lastSlewAtMs = now;

    const remaining = this.targetOriginMs - this.originMs;
    if (remaining === 0) return;

    const step = Math.min(Math.abs(remaining), MAX_SLEW_MS_PER_SECOND * elapsedSeconds);
    this.originMs += Math.sign(remaining) * step;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
