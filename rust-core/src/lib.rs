//! Node bindings for the audio engine.
//!
//! This module is deliberately thin: it converts between JavaScript values and the
//! engine's own types, and guards the single global engine handle. All the real logic
//! lives in [`audio`].

mod audio;

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use once_cell::sync::Lazy;
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

/// Closes the stream and releases the device.
///
/// A later `play()` will fail: the track has to be loaded again. Always safe to call.
#[napi]
pub fn unload() {
    *ENGINE.lock().unwrap() = None;
}
