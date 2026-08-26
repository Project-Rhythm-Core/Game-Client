import type { Chart, Note } from './types';

/**
 * Where notes are drawn, as opposed to when they are judged.
 *
 * A note's judgement time is `note.timeMs` and nothing changes that. Its position on
 * screen is something else entirely: the accumulated scroll distance between now and
 * then, which depends on every velocity change in between.
 *
 * Velocity comes from **both** timelines. The obvious reading — that `timing.scroll`
 * alone decides how fast notes move — is wrong for osu!mania, where mappers drive effects
 * through tempo changes. One reference chart ships an SV and a no-SV version with
 * identical note times whose only real difference is 1528 tempo points spanning BPMs from
 * 140 to 6 942 069. Reading only the multiplier renders it as if it had no effects.
 *
 * Positions are in **reference milliseconds**: a note 1000 units away is one second away
 * at the chart's base tempo and unmodified velocity. The renderer scales that to pixels
 * with the player's speed setting.
 */

/** A stretch of time over which velocity is constant. */
interface ScrollSegment {
  startTimeMs: number;
  /** Reference milliseconds of scroll accumulated before this segment begins. */
  startPosition: number;
  /** Reference milliseconds of scroll per millisecond of real time. */
  velocity: number;
}

export interface ScrollTimelineOptions {
  /**
   * Tempo that counts as unmodified. Defaults to the first tempo point, which is what
   * makes a chart's opening section scroll at exactly the player's chosen speed.
   */
  referenceBpm?: number;
  /**
   * Ignore authored velocity and scroll at a constant rate — the "no SV" mod. Because
   * positions are derived rather than stored, this needs no second copy of the chart.
   */
  constantVelocity?: boolean;
}

export class ScrollTimeline {
  private readonly segments: ScrollSegment[];

  /** Cursor into `segments`, since playback time normally advances. */
  private cursor = 0;

  readonly referenceBpm: number;

  constructor(chart: Chart, options: ScrollTimelineOptions = {}) {
    this.referenceBpm = options.referenceBpm ?? chart.timing.tempo[0]?.bpm ?? 60;
    this.segments = options.constantVelocity
      ? [{ startTimeMs: -Infinity, startPosition: -Infinity, velocity: 1 }]
      : buildSegments(chart, this.referenceBpm);
  }

  /** Accumulated scroll distance at `timeMs`, in reference milliseconds. */
  positionAt(timeMs: number): number {
    if (this.segments.length === 1 && this.segments[0].startTimeMs === -Infinity) {
      return timeMs;
    }

    const segment = this.segments[this.findSegment(timeMs)];
    return segment.startPosition + (timeMs - segment.startTimeMs) * segment.velocity;
  }

  /** Velocity in force at `timeMs`. Useful for diagnostics and debug overlays. */
  velocityAt(timeMs: number): number {
    if (this.segments.length === 1 && this.segments[0].startTimeMs === -Infinity) {
      return 1;
    }
    return this.segments[this.findSegment(timeMs)].velocity;
  }

  /**
   * Scroll positions for every note, in the same order as `chart.notes`.
   *
   * Computed once at load. Notes are already sorted by time, so this walks the segments
   * rather than searching for each one.
   */
  positionsForNotes(notes: readonly Note[]): Float64Array {
    const positions = new Float64Array(notes.length);
    let segment = 0;

    for (let i = 0; i < notes.length; i++) {
      const timeMs = notes[i].timeMs;
      while (
        segment + 1 < this.segments.length &&
        this.segments[segment + 1].startTimeMs <= timeMs
      ) {
        segment++;
      }
      const current = this.segments[segment];
      positions[i] = current.startPosition + (timeMs - current.startTimeMs) * current.velocity;
    }

    return positions;
  }

  /**
   * Index of the segment covering `timeMs`.
   *
   * Playback advances, so the previous answer is usually right or one step behind. A
   * seek falls back to a binary search rather than walking thousands of segments.
   */
  private findSegment(timeMs: number): number {
    const segments = this.segments;

    if (timeMs >= segments[this.cursor].startTimeMs) {
      let index = this.cursor;
      let steps = 0;
      while (index + 1 < segments.length && segments[index + 1].startTimeMs <= timeMs) {
        index++;
        if (++steps > 8) {
          index = binarySearch(segments, timeMs);
          break;
        }
      }
      this.cursor = index;
      return index;
    }

    this.cursor = binarySearch(segments, timeMs);
    return this.cursor;
  }
}

/** Last index whose `startTimeMs` is at or before `timeMs`. */
function binarySearch(segments: readonly ScrollSegment[], timeMs: number): number {
  let low = 0;
  let high = segments.length - 1;

  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (segments[middle].startTimeMs <= timeMs) low = middle;
    else high = middle - 1;
  }

  return low;
}

/**
 * Merges the tempo and velocity timelines into stretches of constant velocity.
 *
 * Both arrays are sorted, so this is a single merge walk. Consecutive segments that end
 * up at the same velocity are collapsed — charts routinely emit a velocity reset
 * alongside every tempo point, and half of those change nothing.
 */
function buildSegments(chart: Chart, referenceBpm: number): ScrollSegment[] {
  const { tempo, scroll } = chart.timing;

  // Velocity before the first point of either kind: the chart's own opening values.
  let currentBpm = tempo[0]?.bpm ?? referenceBpm;
  let currentMultiplier = scroll[0]?.multiplier ?? 1;

  const firstTimeMs = Math.min(
    tempo[0]?.timeMs ?? Infinity,
    scroll[0]?.timeMs ?? Infinity,
    0,
  );

  const segments: ScrollSegment[] = [];
  let position = 0;
  let timeMs = firstTimeMs;
  let velocity = (currentBpm / referenceBpm) * currentMultiplier;
  segments.push({ startTimeMs: timeMs, startPosition: position, velocity });

  let tempoIndex = 0;
  let scrollIndex = 0;

  while (tempoIndex < tempo.length || scrollIndex < scroll.length) {
    const nextTempoMs = tempoIndex < tempo.length ? tempo[tempoIndex].timeMs : Infinity;
    const nextScrollMs = scrollIndex < scroll.length ? scroll[scrollIndex].timeMs : Infinity;
    const nextMs = Math.min(nextTempoMs, nextScrollMs);

    // Apply every change landing on this instant before measuring the new velocity, so
    // a tempo point and the velocity reset beside it become one segment, not two.
    while (tempoIndex < tempo.length && tempo[tempoIndex].timeMs === nextMs) {
      currentBpm = tempo[tempoIndex].bpm;
      tempoIndex++;
    }
    while (scrollIndex < scroll.length && scroll[scrollIndex].timeMs === nextMs) {
      currentMultiplier = scroll[scrollIndex].multiplier;
      scrollIndex++;
    }

    position += (nextMs - timeMs) * velocity;
    timeMs = nextMs;
    velocity = (currentBpm / referenceBpm) * currentMultiplier;

    const previous = segments[segments.length - 1];
    if (previous.velocity === velocity) continue;
    if (previous.startTimeMs === timeMs) {
      previous.velocity = velocity;
      continue;
    }

    segments.push({ startTimeMs: timeMs, startPosition: position, velocity });
  }

  return segments;
}
