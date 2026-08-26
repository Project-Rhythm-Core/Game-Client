import type { PlaybackClock } from '../audio/playback-clock.ts';

/**
 * Keyboard input, timestamped against song position.
 *
 * The important part is that a press is timed by **when the event happened**, not by when
 * the handler ran. `KeyboardEvent.timeStamp` shares its clock with `performance.now()`,
 * which is the same clock `AudioClock` anchors to, so a keypress converts to a song
 * position by subtraction. Reading the clock inside the handler instead measures whenever
 * the browser got round to dispatching, and that jitter lands straight in the judgement.
 *
 * What this cannot see is the latency of the input stack itself — USB polling, the
 * kernel, the compositor. That is a property of the player's machine rather than of the
 * chart, so it belongs in settings as its own offset, separate from the audio one.
 */

/** Default lane bindings, indexed by key count. Only the ones a chart needs are used. */
const DEFAULT_LAYOUTS: Readonly<Record<number, readonly string[]>> = {
  1: ['Space'],
  2: ['KeyF', 'KeyJ'],
  3: ['KeyF', 'Space', 'KeyJ'],
  4: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  5: ['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK'],
  6: ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
  7: ['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
  8: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
  9: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
  10: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyV', 'KeyN', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
};

export function defaultLayout(columnCount: number): readonly string[] {
  return DEFAULT_LAYOUTS[columnCount] ?? DEFAULT_LAYOUTS[4];
}

export interface ColumnInputHandlers {
  onPress(column: number, songTimeMs: number): void;
  onRelease(column: number, songTimeMs: number): void;
}

/**
 * Turns key events into column presses timed in song milliseconds.
 *
 * Attach once and call {@link setLayout} whenever the chart's key count changes.
 */
export class ColumnInput {
  /** Whichever clock is driving the chart. Swapped when one without audio is loaded. */
  clock: PlaybackClock;

  private readonly handlers: ColumnInputHandlers;

  /** Key code to column index. */
  private bindings = new Map<string, number>();

  /** Which columns are currently held, so key repeat does not fire again. */
  private readonly held = new Set<number>();

  /** Player calibration for input latency, in milliseconds. Positive means late. */
  offsetMs = 0;

  constructor(clock: PlaybackClock, handlers: ColumnInputHandlers) {
    this.clock = clock;
    this.handlers = handlers;
  }

  setLayout(keys: readonly string[]): void {
    this.bindings = new Map(keys.map((key, column) => [key, column]));
    this.held.clear();
  }

  /** Columns currently held down, for lighting up receptors. */
  isHeld(column: number): boolean {
    return this.held.has(column);
  }

  releaseAll(): void {
    this.held.clear();
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    const column = this.bindings.get(event.code);
    if (column === undefined) return false;

    event.preventDefault();

    // Holding a key down repeats the event; only the first is a press.
    if (event.repeat || this.held.has(column)) return true;

    this.held.add(column);
    this.handlers.onPress(column, this.songTimeOf(event));

    return true;
  }

  handleKeyUp(event: KeyboardEvent): boolean {
    const column = this.bindings.get(event.code);
    if (column === undefined) return false;

    event.preventDefault();

    if (!this.held.delete(column)) return true;
    this.handlers.onRelease(column, this.songTimeOf(event));

    return true;
  }

  /**
   * Song position at the moment the event happened.
   *
   * `timeStamp` and `performance.now()` share a clock, so the difference between them is
   * how long ago the event was, and subtracting that from the current position gives the
   * position it happened at.
   */
  private songTimeOf(event: KeyboardEvent): number {
    const ageMs = performance.now() - event.timeStamp;
    return this.clock.positionMs() - ageMs - this.offsetMs;
  }
}
