/**
 * Types for the audio bridge exposed by the preload script.
 *
 * These mirror the native engine's surface. The authoritative definitions are generated
 * from the Rust doc comments into `rust-core/index.d.ts`; this file restates them for
 * the renderer, which cannot reach across the process boundary to import them.
 */

/** Describes the stream as it was actually opened. */
export interface AudioInfo {
  durationMs: number;
  /**
   * Rate and layout the device was opened with. These can differ from the source file
   * when the PCM had to be remapped or resampled.
   */
  sampleRate: number;
  channels: number;
  deviceName: string;
  /** Frames per callback. `0` means the backend chose its own. */
  bufferFrames: number;
  /** Theoretical latency of one buffer at this rate, in milliseconds. */
  bufferMs: number;
  /** Samples that could not be decoded and were loaded as silence. */
  silentSamples: number;
}

/** A snapshot of playback state. */
export interface PlaybackStats {
  positionMs: number;
  durationMs: number;
  /** Output latency measured on the first armed callback. A snapshot, not live. */
  outputLatencyMs: number;
  /** Manual calibration currently applied, in milliseconds. */
  offsetMs: number;
  /** Real hardware sample rate over nominal. `1.0` until measured; diagnostic only. */
  rateRatio: number;
  playing: boolean;
  /** The device is up to speed, so starting playback will be heard immediately. */
  ready: boolean;
  /** Sample voices sounding right now. Non-zero means the bank really is playing. */
  activeVoices: number;
  /** Sounds dropped because the trigger queue backed up. Should stay at zero. */
  droppedSamples: number;
}

/** The audio surface exposed on `window.electronAPI.audio`. */
/** A sound the chart plays on its own, with no note to hit. */
export interface ScheduledSoundInput {
  timeMs: number;
  /** Index into `samplePaths`. */
  sample: number;
  /** 0 to 100. */
  volume: number;
}

/** Everything a chart needs in order to be heard. */
export interface ChartAudioRequest {
  /** Absent for a chart whose sound comes entirely from its samples. */
  musicPath?: string;
  /** Absolute paths, in the order the chart's sample indices refer to. */
  samplePaths: string[];
  scheduled: ScheduledSoundInput[];
  /** Chart length, used when there is no music to measure. */
  durationMs: number;
}

export interface AudioBridge {
  load(filePath: string): Promise<AudioInfo>;
  /** Decode a chart's music and sample bank together, and open the device. */
  loadChart(request: ChartAudioRequest): Promise<AudioInfo>;
  /** Fire a sound now. Not a promise: a keypress must not wait for a round trip. */
  playSample(sampleIndex: number, volume: number): void;
  droppedSamples(): Promise<number>;
  play(): Promise<void>;
  restart(): Promise<void>;
  unload(): Promise<void>;
  isReady(): Promise<boolean>;
  setOffsetMs(offsetMs: number): Promise<void>;
  position(): Promise<number>;
  stats(): Promise<PlaybackStats>;
}

/** A source chart discovered under the bundled assets. */
export interface BundledChart {
  path: string;
  name: string;
}

/** What an import produced: the chart itself, plus where its media lives. */
export interface ImportedChart {
  chart: import('../chart/types.ts').Chart;
  summary: ChartSummary;
  mediaDir: string;
  /** Absent for charts whose sound comes entirely from samples. */
  audioPath: string | null;
  /** Absolute paths for the sample bank, in the order note indices refer to. */
  samplePaths: string[];
}

export interface ChartSummary {
  id: string;
  title: string;
  artist: string;
  difficultyName: string;
  columns: number;
  noteCount: number;
  holdCount: number;
  lastNoteMs: number;
  tempoPoints: number;
  scrollPoints: number;
  sampleCount: number;
  audioFile: string;
  outputPath: string;
}

/** The chart surface exposed on `window.electronAPI.chart`. */
export interface ChartBridge {
  importOsu(sourcePath: string): Promise<ImportedChart>;
  listBundled(): Promise<BundledChart[]>;
}

/** The skin currently in use, and its visual theme. */
export interface ActiveSkin {
  id: string;
  name: string;
  author: string;
  /** Parsed from the skin's `osu.yaml`; `null` when it styles nothing. */
  theme: unknown | null;
}

export interface SkinBridge {
  active(): Promise<ActiveSkin | null>;
}

declare global {
  interface Window {
    electronAPI: {
      audio: AudioBridge;
      chart: ChartBridge;
      skin: SkinBridge;
    };
  }
}
