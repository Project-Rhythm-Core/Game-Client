//! Node bindings for the audio engine.
//!
//! This module is deliberately thin: it converts between JavaScript values and the
//! engine's own types, and guards the single global engine handle. All the real logic
//! lives in [`audio`].

mod audio;
mod chart;
mod skin;

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;

use audio::{AudioEngine, DecodedAudio};

/// The engine currently loaded, if any.
///
/// One track at a time: loading again replaces what was there. Supporting previews,
/// crossfades or hit sounds means growing this into a mixer with one handle per voice,
/// at which point this global becomes a registry.
static ENGINE: Lazy<Mutex<Option<AudioEngine>>> = Lazy::new(|| Mutex::new(None));

fn engine_error(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

fn not_loaded() -> Error {
    engine_error("no audio loaded: call loadAudio() first")
}

/// Describes the stream as it was actually opened.
#[napi(object)]
pub struct AudioInfo {
    pub duration_ms: f64,
    /// Rate and layout the device was opened with. May differ from the source file if
    /// the PCM had to be remapped or resampled.
    pub sample_rate: u32,
    pub channels: u32,
    pub device_name: String,
    /// Frames per callback. `0` means the backend chose its own.
    pub buffer_frames: u32,
    /// Theoretical latency of one buffer at this rate, in milliseconds.
    pub buffer_ms: f64,
    /// Samples that could not be decoded and were loaded as silence.
    pub silent_samples: u32,
}

/// A snapshot of playback state.
#[napi(object)]
pub struct PlaybackStats {
    pub position_ms: f64,
    pub duration_ms: f64,
    /// Output latency measured on the first armed callback. A snapshot, not live.
    pub output_latency_ms: f64,
    /// Manual calibration currently applied, in milliseconds.
    pub offset_ms: f64,
    /// Real hardware sample rate over nominal. `1.0` until measured; diagnostic only.
    pub rate_ratio: f64,
    pub playing: bool,
    /// The device is up to speed, so starting playback will be heard immediately.
    pub ready: bool,
    /// Sample voices sounding right now. Non-zero means the bank is actually playing.
    pub active_voices: u32,
    /// Sounds dropped because the trigger queue backed up. Should stay at zero.
    pub dropped_samples: u32,
}

/// A sound the chart plays on its own, with no note to hit.
#[napi(object)]
pub struct ScheduledSoundInput {
    pub time_ms: f64,
    /// Index into the sample paths given to `loadChartAudio`.
    pub sample: u32,
    /// 0 to 100.
    pub volume: f64,
}

/// Everything a chart needs to be heard.
#[napi(object)]
pub struct ChartAudioRequest {
    /// Background track, if the chart has one. A fully keysounded chart has none.
    pub music_path: Option<String>,
    /// Sound bank, in the order the chart's sample indices refer to.
    pub sample_paths: Vec<String>,
    /// Sounds that play on schedule with no note attached.
    pub scheduled: Vec<ScheduledSoundInput>,
    /// Chart length, used when there is no music to measure.
    pub duration_ms: f64,
}

/// Decodes on a worker thread, then opens the device on the caller's thread.
pub struct LoadAudioTask {
    path: String,
}

impl Task for LoadAudioTask {
    type Output = DecodedAudio;
    type JsValue = AudioInfo;

    /// Runs on a libuv worker: decoding a whole file blocks for tens of milliseconds,
    /// which the main thread cannot afford.
    fn compute(&mut self) -> Result<Self::Output> {
        audio::decode_file(&self.path).map_err(engine_error)
    }

    /// Back on the main thread, which is where the stream must be created and dropped.
    fn resolve(&mut self, _env: Env, decoded: Self::Output) -> Result<Self::JsValue> {
        let engine = AudioEngine::prepare(decoded).map_err(engine_error)?;
        let info = engine.info();

        let audio_info = AudioInfo {
            duration_ms: info.duration_ms,
            sample_rate: info.sample_rate,
            channels: info.channels as u32,
            device_name: info.device_name.clone(),
            buffer_frames: info.buffer_frames,
            buffer_ms: info.buffer_ms,
            silent_samples: 0,
        };

        *ENGINE.lock().unwrap() = Some(engine);

        Ok(audio_info)
    }
}

/// Decodes `path` and leaves the device open, emitting silence.
///
/// All of the start-up cost is paid here rather than on the first `play()`.
#[napi(ts_return_type = "Promise<AudioInfo>")]
pub fn load_audio(path: String) -> AsyncTask<LoadAudioTask> {
    AsyncTask::new(LoadAudioTask { path })
}

/// Decodes a chart's music and its whole sample bank, then opens the device.
pub struct LoadChartAudioTask {
    request: ChartAudioRequest,
}

impl Task for LoadChartAudioTask {
    type Output = (Option<DecodedAudio>, Vec<DecodedAudio>, u32);
    type JsValue = AudioInfo;

    /// Runs on a libuv worker. A keysounded chart can carry hundreds of sounds, so this
    /// is well beyond what the main thread could absorb.
    fn compute(&mut self) -> Result<Self::Output> {
        let music = match &self.request.music_path {
            Some(path) => Some(audio::decode_file(path).map_err(engine_error)?),
            None => None,
        };

        let mut bank = Vec::with_capacity(self.request.sample_paths.len());
        for path in &self.request.sample_paths {
            // A chart may name sounds it does not ship, expecting a skin to supply them.
            // One missing file must not cost the player the whole chart, so it becomes
            // silence and everything else still plays.
            match audio::decode_file(path) {
                Ok(decoded) => bank.push(decoded),
                Err(_) => bank.push(DecodedAudio {
                    samples: Vec::new(),
                    sample_rate: 44_100,
                    channels: 2,
                }),
            }

        }

        let silent = bank.iter().filter(|sample| sample.samples.is_empty()).count() as u32;

        Ok((music, bank, silent))
    }

    fn resolve(&mut self, _env: Env, (music, bank, silent): Self::Output) -> Result<Self::JsValue> {
        let scheduled = self
            .request
            .scheduled
            .iter()
            .map(|sound| (sound.time_ms, sound.sample, (sound.volume / 100.0) as f32))
            .collect();

        let engine =
            AudioEngine::prepare_with_samples(music, bank, scheduled, self.request.duration_ms)
                .map_err(engine_error)?;

        let info = engine.info();
        let audio_info = AudioInfo {
            duration_ms: info.duration_ms,
            sample_rate: info.sample_rate,
            channels: info.channels as u32,
            device_name: info.device_name.clone(),
            buffer_frames: info.buffer_frames,
            buffer_ms: info.buffer_ms,
            silent_samples: silent,
        };

        *ENGINE.lock().unwrap() = Some(engine);

        Ok(audio_info)
    }
}

/// Loads a chart's music and sample bank together, and opens the device.
///
/// Everything is mixed into one stream, so a keysound and the music share a latency.
/// Splitting them across outputs would make the game feel wrong however accurate its
/// judgement was.
#[napi(ts_return_type = "Promise<AudioInfo>")]
pub fn load_chart_audio(request: ChartAudioRequest) -> AsyncTask<LoadChartAudioTask> {
    AsyncTask::new(LoadChartAudioTask { request })
}

/// Plays one sound from the bank straight away, at `volume` from 0 to 100.
///
/// This is the path a keypress takes. It reaches the audio thread through a lock-free
/// queue, so it never blocks whoever called it and never stalls playback.
#[napi]
pub fn play_sample(sample_index: u32, volume: f64) {
    if let Some(engine) = ENGINE.lock().unwrap().as_ref() {
        engine.play_sample(sample_index, (volume / 100.0) as f32);
    }
}

/// Sounds dropped because the trigger queue backed up. Should stay at zero.
#[napi]
pub fn dropped_sample_count() -> u32 {
    ENGINE
        .lock()
        .unwrap()
        .as_ref()
        .map(|engine| engine.dropped_triggers() as u32)
        .unwrap_or(0)
}

/// Starts playback of the loaded track. Audible within one buffer period.
#[napi]
pub fn play() -> Result<()> {
    ENGINE
        .lock()
        .unwrap()
        .as_ref()
        .ok_or_else(not_loaded)?
        .play();
    Ok(())
}

/// Returns to the beginning without reopening the device.
///
/// `getPositionMs()` reports `0` from the moment this returns, rather than from when
/// the audio thread notices, so callers syncing to this clock cannot latch onto the
/// previous anchor.
#[napi]
pub fn restart() -> Result<()> {
    ENGINE
        .lock()
        .unwrap()
        .as_ref()
        .ok_or_else(not_loaded)?
        .restart();
    Ok(())
}

/// Current audible position in milliseconds.
///
/// Cheap by design — an atomic load and a subtraction — so it is safe to poll.
#[napi]
pub fn get_position_ms() -> f64 {
    ENGINE
        .lock()
        .unwrap()
        .as_ref()
        .map(|engine| engine.position_ms())
        .unwrap_or(0.0)
}

/// Full playback snapshot. Returns zeroed values when nothing is loaded.
#[napi]
pub fn get_stats() -> PlaybackStats {
    let guard = ENGINE.lock().unwrap();

    let Some(engine) = guard.as_ref() else {
        return PlaybackStats {
            position_ms: 0.0,
            duration_ms: 0.0,
            output_latency_ms: 0.0,
            offset_ms: 0.0,
            rate_ratio: 1.0,
            playing: false,
            ready: false,
            active_voices: 0,
            dropped_samples: 0,
        };
    };

    let clock = engine.clock();

    PlaybackStats {
        position_ms: engine.position_ms(),
        duration_ms: engine.info().duration_ms,
        output_latency_ms: clock.output_latency_ms(),
        offset_ms: clock.calibration_offset_ms(),
        rate_ratio: clock.rate_ratio(),
        playing: clock.is_playing(),
        ready: clock.is_device_warm(),
        active_voices: engine.active_voices() as u32,
        dropped_samples: engine.dropped_triggers() as u32,
    }
}

/// True once the device is up to speed and `play()` will be heard immediately.
///
/// Before that, a `play()` can take a couple of hundred milliseconds to become audible
/// because the backend is still bringing the stream up.
#[napi]
pub fn is_ready() -> bool {
    ENGINE
        .lock()
        .unwrap()
        .as_ref()
        .map(|engine| engine.clock().is_device_warm())
        .unwrap_or(false)
}

/// Manual calibration, in milliseconds.
///
/// Positive means the audio is heard *later* than the clock reports, so the reported
/// position is pulled back to match. No API can know the real latency of the physical
/// output chain — Bluetooth headphones, an amplifier's DSP — so this has to be set by
/// the player. It is a no-op when nothing is loaded.
#[napi]
pub fn set_offset_ms(offset_ms: f64) {
    if let Some(engine) = ENGINE.lock().unwrap().as_ref() {
        engine.clock().set_calibration_offset_ms(offset_ms);
    }
}

/// What a conversion produced. The chart itself goes to disk rather than across the
/// boundary: marshalling tens of thousands of notes into JavaScript objects would cost
/// far more than writing the file.
#[napi(object)]
pub struct ChartSummary {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub difficulty_name: String,
    /// Key count.
    pub columns: u32,
    pub note_count: u32,
    pub hold_count: u32,
    /// Time of the last note, in milliseconds.
    pub last_note_ms: f64,
    pub tempo_points: u32,
    pub scroll_points: u32,
    pub sample_count: u32,
    /// Audio file the chart refers to, relative to the chart file.
    pub audio_file: String,
    pub output_path: String,
}

pub struct ConvertChartTask {
    source_path: String,
    output_path: String,
}

impl Task for ConvertChartTask {
    type Output = (chart::Chart, String);
    type JsValue = ChartSummary;

    /// Runs on a libuv worker: parsing a marathon chart is tens of thousands of lines.
    fn compute(&mut self) -> Result<Self::Output> {
        let converted = chart::osu::convert_to_json_file(&self.source_path, &self.output_path)
            .map_err(engine_error)?;
        Ok((converted, self.output_path.clone()))
    }

    fn resolve(&mut self, _env: Env, (converted, output_path): Self::Output) -> Result<Self::JsValue> {
        Ok(ChartSummary {
            id: converted.id.clone(),
            title: converted.metadata.title.clone(),
            artist: converted.metadata.artist.clone(),
            difficulty_name: converted.metadata.difficulty_name.clone(),
            columns: converted.columns.len() as u32,
            note_count: converted.notes.len() as u32,
            hold_count: converted.notes.iter().filter(|n| n.is_hold()).count() as u32,
            last_note_ms: converted.notes.last().map(|n| n.end_ms.unwrap_or(n.time_ms)).unwrap_or(0.0),
            tempo_points: converted.timing.tempo.len() as u32,
            scroll_points: converted.timing.scroll.len() as u32,
            sample_count: converted.samples.len() as u32,
            audio_file: converted.audio.as_ref().map(|a| a.file.clone()).unwrap_or_default(),
            output_path,
        })
    }
}

/// Converts an osu!mania `.osu` file into the game's chart format and writes it to
/// `outputPath` as JSON.
///
/// Rejects charts that are not mode 3, and any chart that violates the format's
/// invariants — better to fail at import than to ship something the runtime misreads.
#[napi(ts_return_type = "Promise<ChartSummary>")]
pub fn convert_osu_chart(source_path: String, output_path: String) -> AsyncTask<ConvertChartTask> {
    AsyncTask::new(ConvertChartTask {
        source_path,
        output_path,
    })
}

/// What importing a skin produced.
#[napi(object)]
pub struct SkinSummary {
    pub id: String,
    pub name: String,
    pub author: String,
    /// Hit sounds found and copied into the package.
    pub sound_count: u32,
    /// Key counts the skin styles.
    pub layout_count: u32,
    /// Distinct textures copied.
    pub texture_count: u32,
    pub output_path: String,
}

/// Converts an osu skin folder into the game's own package.
///
/// Only what transfers is taken. osu's positional values are pixels in its fixed stage
/// and are deliberately left behind.
#[napi]
pub fn import_osu_skin(source_dir: String, output_dir: String) -> Result<SkinSummary> {
    let imported = skin::osu::import(&source_dir, &output_dir).map_err(engine_error)?;

    Ok(SkinSummary {
        id: imported.id,
        name: imported.name,
        author: imported.author,
        sound_count: imported.sound_count as u32,
        layout_count: imported.layout_count as u32,
        texture_count: imported.texture_count as u32,
        output_path: imported.output_dir.to_string_lossy().into_owned(),
    })
}

/// Reads a skin package's manifest.
#[napi]
pub fn read_skin_manifest(skin_dir: String) -> Result<SkinSummary> {
    let manifest = skin::osu::read_manifest(&skin_dir).map_err(engine_error)?;

    Ok(SkinSummary {
        id: manifest.id,
        name: manifest.name,
        author: manifest.author,
        sound_count: 0,
        layout_count: 0,
        texture_count: 0,
        output_path: skin_dir,
    })
}

/// Reads a skin package's visual theme for one source format, as JSON.
///
/// Returns `null` when the skin has no theme for that format, which is ordinary: a skin
/// may provide only sounds.
#[napi]
pub fn read_skin_theme(skin_dir: String, format: String) -> Option<String> {
    skin::osu::read_theme_json(&skin_dir, &format).ok()
}

/// Reads a skin's sound bank, as absolute paths keyed by the name a chart asks for.
///
/// This is the fallback for a chart that names a sound it does not ship — which is not an
/// edge case: every difficulty of one reference chart asks for `normal-hitnormal.wav`
/// without providing it, so without this the whole chart plays with no hit sounds at all.
#[napi]
pub fn load_skin_sounds(skin_dir: String) -> Result<HashMap<String, String>> {
    let bank = skin::osu::read_sound_bank(&skin_dir).map_err(engine_error)?;
    Ok(bank.into_iter().collect())
}

/// Closes the stream and releases the device.
///
/// A later `play()` will fail: the track has to be loaded again. Always safe to call.
#[napi]
pub fn unload() {
    *ENGINE.lock().unwrap() = None;
}
