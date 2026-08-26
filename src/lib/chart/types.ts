/**
 * The chart format the game plays.
 *
 * Mirrors what `rust-core` writes at import time. Source formats — osu!mania today, BMS
 * and o2jam later — never reach the renderer.
 */

export type ColumnRole = 'note' | 'scratch';

export interface Column {
  /** A turntable is judged and drawn differently from a note lane. */
  role: ColumnRole;
}

export interface ChartMetadata {
  title: string;
  titleUnicode: string;
  artist: string;
  artistUnicode: string;
  /** Who made the chart, as opposed to the music. */
  charter: string;
  difficultyName: string;
  source: string;
  tags: string[];
}

export interface ChartOrigin {
  format: string;
  formatVersion?: number;
  ids: Record<string, number>;
  values: Record<string, number>;
}

export interface AudioTrack {
  /** Path relative to the chart file. */
  file: string;
  /**
   * Correction between the chart's authored timing and how this engine decodes the
   * audio. Has to be measured against real playback, not assumed.
   */
  offsetMs: number;
  previewMs?: number;
  leadInMs: number;
}

export interface Sample {
  /**
   * Filename relative to the chart. It may legitimately not exist: charts reference
   * sounds they expect a skin to supply, so loading has to tolerate a miss.
   */
  file: string;
}

export interface BgmEvent {
  timeMs: number;
  /** Index into `Chart.samples`. */
  sample: number;
  /** 0 to 100. Absent means full. */
  volume?: number;
}

export interface TempoPoint {
  timeMs: number;
  bpm: number;
  /** Beats per measure. */
  meter: number;
}

export interface ScrollPoint {
  timeMs: number;
  /** Velocity multiplier applied on top of the tempo. */
  multiplier: number;
}

/** A scroll freeze. Musical time keeps running underneath it. */
export interface StopPoint {
  timeMs: number;
  durationMs: number;
}

export interface Timing {
  tempo: TempoPoint[];
  scroll: ScrollPoint[];
  stops: StopPoint[];
}

export type NoteKind = 'mine';

export interface Note {
  /** Absolute milliseconds from the start of the audio. This is what judgement uses. */
  timeMs: number;
  /** Index into `Chart.columns`. */
  column: number;
  /** Present means this is a hold note. */
  endMs?: number;
  /** Absent for ordinary notes. */
  kind?: NoteKind;
  /** Indices into `Chart.samples`, played together. */
  samples?: number[];
  /** 0 to 100. Absent means full. */
  volume?: number;
}

export type EffectKind = 'kiai';

export interface Effect {
  startMs: number;
  endMs: number;
  kind: EffectKind;
}

export interface Span {
  startMs: number;
  endMs: number;
}

export interface Chart {
  formatVersion: number;
  id: string;
  metadata: ChartMetadata;
  origin: ChartOrigin;
  columns: Column[];
  /** Absent for charts whose sound comes entirely from samples. */
  audio?: AudioTrack;
  samples: Sample[];
  bgmEvents: BgmEvent[];
  timing: Timing;
  notes: Note[];
  effects: Effect[];
  breaks: Span[];
}
