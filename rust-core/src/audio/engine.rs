//! Audio engine.
//!
//! Owns the output stream and the clock that describes it. The stream is opened and
//! started at load time, emitting silence, so the expensive part of playback — bringing
//! the device up, which costs a couple of hundred milliseconds on Linux — is paid while
//! a chart is being selected rather than when it starts.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::clock::{PlaybackClock, now_nanos};
use super::decoder::DecodedAudio;
use super::device::{self, DeviceStream};
use super::mixer::{Mixer, ScheduledSound, TriggerQueue};

/// Shortest measurement window before the hardware rate estimate is believed.
///
/// The estimate's noise is dominated by callback scheduling jitter divided by the
/// window, so a short window produces numbers far larger than the drift being measured.
const MIN_RATE_WINDOW_NANOS: u64 = 10_000_000_000;

/// How long the device must have been warm before the rate reference is taken.
///
/// "Warm" only means the device has started queueing ahead; it keeps filling for a
/// while after that. Anchoring the measurement mid-fill counts that growth as frames
/// delivered, which biases the estimate high by `fill / window` — hundreds of ppm, far
/// more than the drift being measured, and it decays only as the window grows.
const RATE_SETTLE_NANOS: u64 = 2_000_000_000;

/// Largest crystal deviation accepted. Anything beyond this is an underrun or a
/// misbehaving backend, not drift, and is discarded rather than allowed to skew timing.
const MAX_RATE_DEVIATION: f64 = 0.01;

const NANOS_PER_SECOND: u64 = 1_000_000_000;

/// Everything about the stream that callers may want to display or reason about.
#[derive(Clone)]
pub struct StreamInfo {
    pub duration_ms: f64,
    /// The rate and layout the device was opened with. These can differ from the source
    /// file when the PCM had to be remapped or resampled.
    pub sample_rate: u32,
    pub channels: u16,
    pub device_name: String,
    /// Frames per callback, or `0` when the backend chose its own.
    pub buffer_frames: u32,
    pub buffer_ms: f64,
}

pub struct AudioEngine {
    /// Held so the stream stays alive; dropping it closes the device.
    _stream: cpal::Stream,
    clock: Arc<PlaybackClock>,
    info: StreamInfo,
    /// How sounds reach the audio thread from wherever input is handled.
    triggers: Arc<TriggerQueue>,
    /// Voices sounding as of the last callback. Published so the state of the mix is
    /// observable from outside the audio thread.
    active_voices: Arc<AtomicUsize>,
}

// cpal::Stream is not Send on every backend. The stream is created and dropped only
// from the thread that owns the engine, which is the sole holder of the global handle.
//
// This assumption breaks if the addon is ever loaded into a Node worker thread. Giving
// the engine its own dedicated thread with a command channel would remove the unsafe
// impl entirely, and would also keep the device open off the caller's thread.
unsafe impl Send for AudioEngine {}

impl AudioEngine {
    /// Opens the device for a chart with a background track and nothing else.
    pub fn prepare(audio: DecodedAudio) -> Result<Self, String> {
        Self::prepare_with_samples(Some(audio), Vec::new(), Vec::new(), 0.0)
    }

    /// Opens the default output device and starts the stream, initially silent.
    ///
    /// `music` is optional: a fully keysounded chart has no background track, and its
    /// entire soundtrack is the sample bank. `duration_ms` gives such a chart a length,
    /// since there is no track to measure.
    pub fn prepare_with_samples(
        music: Option<DecodedAudio>,
        samples: Vec<DecodedAudio>,
        scheduled: Vec<(f64, u32, f32)>,
        duration_ms: f64,
    ) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or("no output device available")?;

        let default_config = device
            .default_output_config()
            .map_err(|e| format!("could not read the default output configuration: {e}"))?;

        // A keysounded chart has no music to negotiate against, so a single silent frame
        // stands in: the device's own defaults then decide the format.
        let negotiation_source = music.unwrap_or_else(|| DecodedAudio {
            samples: vec![0.0; default_config.channels() as usize],
            sample_rate: default_config.sample_rate(),
            channels: default_config.channels(),
        });

        let stream_config = device::negotiate(&device, negotiation_source, &default_config)?;

        // Every sound has to reach the device's own format before it can be mixed.
        let bank: Vec<Arc<[f32]>> = samples
            .into_iter()
            .map(|sample| {
                Arc::from(device::adapt_to(
                    sample,
                    stream_config.sample_rate,
                    stream_config.channels,
                ))
            })
            .collect();

        let frames_per_ms = stream_config.sample_rate as f64 / 1000.0;
        let scheduled: Vec<ScheduledSound> = scheduled
            .into_iter()
            .map(|(time_ms, sample_index, volume)| ScheduledSound {
                frame: (time_ms.max(0.0) * frames_per_ms) as u64,
                sample_index,
                volume,
            })
            .collect();

        let info = StreamInfo {
            duration_ms: stream_config.duration_ms().max(duration_ms),
            sample_rate: stream_config.sample_rate,
            channels: stream_config.channels,
            device_name: device
                .description()
                .map(|description| description.name().to_owned())
                .unwrap_or_else(|_| "unknown".into()),
            buffer_frames: stream_config.buffer_frames,
            buffer_ms: stream_config.buffer_ms(),
        };

        let clock = Arc::new(PlaybackClock::default());
        let triggers = Arc::new(TriggerQueue::new());
        let active_voices = Arc::new(AtomicUsize::new(0));
        let mixer = Mixer::new(bank, scheduled, stream_config.channels);

        let total_frames = (info.duration_ms * frames_per_ms) as usize;
        let stream = build_stream(
            &device,
            stream_config,
            clock.clone(),
            mixer,
            triggers.clone(),
            active_voices.clone(),
            total_frames,
        )?;

        stream
            .play()
            .map_err(|e| format!("could not start the stream: {e}"))?;

        Ok(Self {
            _stream: stream,
            clock,
            info,
            triggers,
            active_voices,
        })
    }

    /// Queues a sound to play as soon as the audio thread next runs.
    ///
    /// This is the path a keypress takes. It cannot be scheduled any more precisely than
    /// the next buffer, because the press has already happened by the time it gets here.
    pub fn play_sample(&self, sample_index: u32, volume: f32) {
        self.triggers.push(sample_index, volume);
    }

    /// Sounds dropped because the queue backed up. Should stay at zero.
    pub fn dropped_triggers(&self) -> usize {
        self.triggers.dropped_count()
    }

    /// Voices sounding as of the last callback.
    pub fn active_voices(&self) -> usize {
        self.active_voices.load(Ordering::Relaxed)
    }

    pub fn info(&self) -> &StreamInfo {
        &self.info
    }

    pub fn clock(&self) -> &PlaybackClock {
        &self.clock
    }

    /// Starts playback from wherever the cursor currently sits.
    pub fn play(&self) {
        self.clock.arm();
    }

    /// Returns to the beginning without reopening the device, so it is instantaneous.
    pub fn restart(&self) {
        self.clock.request_seek(0);
    }

    /// Current audible position in milliseconds.
    pub fn position_ms(&self) -> f64 {
        self.clock.position_ms(self.info.duration_ms)
    }
}

/// Builds the output stream and the real-time callback that drives the clock.
fn build_stream(
    device: &cpal::Device,
    stream: DeviceStream,
    clock: Arc<PlaybackClock>,
    mut mixer: Mixer,
    triggers: Arc<TriggerQueue>,
    active_voices: Arc<AtomicUsize>,
    chart_frames: usize,
) -> Result<cpal::Stream, String> {
    let DeviceStream {
        samples,
        sample_rate,
        channels,
        config,
        ..
    } = stream;

    let channels = channels as usize;
    let sample_rate = sample_rate as u64;

    // A keysounded chart has no music, so its length comes from the chart rather than
    // from a buffer of music samples.
    let total_frames = (samples.len() / channels).max(chart_frames);

    // State private to the audio thread. None of it is shared, so none of it is atomic.
    //
    // `first_callback_nanos`  when the hardware began consuming.
    // `frames_submitted`      frames handed to the device, silence included.
    // `playback_cursor`       frames of the song delivered so far.
    // `rate_window_*`         reference point the hardware rate is measured against.
    // `rate_ratio`            real rate over nominal; a local copy of what is published.
    let mut first_callback_nanos: u64 = 0;
    let mut frames_submitted: u64 = 0;
    let mut playback_cursor: usize = 0;
    let mut warm_since_nanos: u64 = 0;
    let mut rate_window_start_nanos: u64 = 0;
    let mut rate_window_start_frames: u64 = 0;
    let mut rate_ratio: f64 = 1.0;

    device
        .build_output_stream(
            config,
            move |output: &mut [f32], info: &cpal::OutputCallbackInfo| {
                let now = now_nanos();
                let frames_this_callback = (output.len() / channels) as u64;

                if frames_submitted == 0 {
                    first_callback_nanos = now;
                }

                // --- Hardware rate ------------------------------------------------
                //
                // The sound card's crystal does not run at exactly the nominal rate,
                // and the difference is linear in time: at 100 ppm it is ~24 ms over a
                // four-minute song, easily enough to change a judgement between the
                // first chorus and the last.
                //
                // Nothing in the buffer arithmetic below can recover that number,
                // because the real rate never enters it. It has to be measured against
                // an independent clock: frames actually delivered per second of
                // monotonic time. Taking the difference between two instants cancels
                // the buffer lead, which would otherwise bias the result.
                if rate_window_start_nanos == 0 {
                    // Let the buffer settle first, otherwise the reference is taken
                    // mid-fill and every later estimate inherits that surplus.
                    if clock.is_device_warm() {
                        if warm_since_nanos == 0 {
                            warm_since_nanos = now;
                        } else if now.saturating_sub(warm_since_nanos) > RATE_SETTLE_NANOS {
                            rate_window_start_nanos = now;
                            rate_window_start_frames = frames_submitted;
                        }
                    }
                } else {
                    let window = now.saturating_sub(rate_window_start_nanos);
                    if window > MIN_RATE_WINDOW_NANOS {
                        let delivered =
                            frames_submitted.saturating_sub(rate_window_start_frames) as f64;
                        let estimate = delivered * NANOS_PER_SECOND as f64
                            / (window as f64 * sample_rate as f64);

                        if (estimate - 1.0).abs() < MAX_RATE_DEVIATION {
                            rate_ratio = estimate;
                            clock.publish_rate_ratio(rate_ratio);
                        }
                    }
                }

                // --- When will this buffer be heard? ------------------------------
                //
                // Two independent estimates, and the larger wins.
                //
                // `reported` is what the backend claims. ALSA behind PipeWire or
                // PulseAudio frequently reports zero, so it cannot be trusted alone.
                //
                // `estimated` comes from first principles: the frames already handed
                // over take `frames / (rate * ratio)` to drain. Converting with the
                // *nominal* rate instead would make this diverge from reality at
                // exactly the drift rate, growing without bound until it beat
                // `reported` forever — even on backends whose timestamps are good.
                let timestamps = info.timestamp();
                let reported_lead_nanos = timestamps
                    .playback
                    .duration_since(timestamps.callback)
                    .as_nanos() as u64;

                let nominal_drain_nanos = frames_submitted * NANOS_PER_SECOND / sample_rate;
                let estimated_lead_nanos = (first_callback_nanos
                    + (nominal_drain_nanos as f64 / rate_ratio) as u64)
                    .saturating_sub(now);

                let lead_nanos = reported_lead_nanos.max(estimated_lead_nanos);
                let audible_at_nanos = now + lead_nanos;

                // Queueing ahead of the callback means the device is up to speed.
                if estimated_lead_nanos > 0 {
                    clock.mark_device_warm();
                }

                // --- Seeks --------------------------------------------------------
                if let Some(target_frame) = clock.take_pending_seek() {
                    playback_cursor = (target_frame as usize).min(total_frames);
                    clock.reset_anchor();
                    mixer.rewind_to(playback_cursor as u64);
                }

                // --- Fill the buffer ----------------------------------------------
                if clock.is_armed() {
                    // Where sample 0 was, or would have been, audible.
                    let cursor_nanos = playback_cursor as u64 * NANOS_PER_SECOND / sample_rate;
                    let candidate_origin_nanos = audible_at_nanos.saturating_sub(cursor_nanos);
                    clock.update_anchor(candidate_origin_nanos, lead_nanos);

                    // Past the end of the song the tail is zero-filled, so playback
                    // simply goes quiet. There is no end-of-track signal; callers
                    // compare position against duration themselves.
                    // Clamping the start is load-bearing, not defensive: slicing from
                    // beyond the end panics even when the range is empty. A keysounded
                    // chart's music is a one-frame placeholder while its cursor runs the
                    // whole length of the chart, so the cursor is past the end almost
                    // immediately — and a panic here kills the audio thread outright.
                    let start = (playback_cursor * channels).min(samples.len());
                    let available = (samples.len() - start).min(output.len());
                    output[..available].copy_from_slice(&samples[start..start + available]);
                    output[available..].fill(0.0);

                    // Keysounds and the scheduled accompaniment go into the *same* buffer
                    // as the music. Routing them anywhere else would give them their own
                    // latency, and the game would feel wrong however accurate the
                    // judgement was.
                    mixer.mix(output, playback_cursor as u64, &triggers);
                    active_voices.store(mixer.active_voices(), Ordering::Relaxed);

                    playback_cursor =
                        (playback_cursor + frames_this_callback as usize).min(total_frames);
                } else {
                    output.fill(0.0);
                }

                frames_submitted += frames_this_callback;
            },
            move |error| eprintln!("[audio] stream error: {error}"),
            None,
        )
        .map_err(|e| format!("could not build the output stream: {e}"))
}
