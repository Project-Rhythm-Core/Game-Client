//! Playback clock.
//!
//! The clock answers one question: **which sample is audible right now?**
//!
//! The naive approach — counting frames as they are copied into the device buffer —
//! runs ahead of reality by the whole output latency, because those frames sit in the
//! device queue behind everything already submitted. Instead, the clock stores the
//! instant at which sample 0 becomes *audible*, and position is a subtraction from it.
//!
//! Every field is atomic so the real-time audio callback can publish updates without
//! ever taking a lock, and any other thread can read the position for free.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::time::Instant;

use once_cell::sync::Lazy;

/// Shared origin for every timestamp, so instants fit in a `u64` of nanoseconds and
/// can live in an atomic.
static EPOCH: Lazy<Instant> = Lazy::new(Instant::now);

/// Nanoseconds elapsed since the process-wide epoch.
pub fn now_nanos() -> u64 {
    EPOCH.elapsed().as_nanos() as u64
}

/// Ceiling of the anchor's smoothing window.
///
/// For the first `ANCHOR_SMOOTHING_WINDOW` updates this behaves as a cumulative mean,
/// converging in a few hundred milliseconds. After that it becomes an exponential
/// moving average with `alpha = 1 / ANCHOR_SMOOTHING_WINDOW`, which absorbs per-callback
/// scheduling jitter without the visible jumps a hard reset would cause.
const ANCHOR_SMOOTHING_WINDOW: u64 = 32;

/// Shared timing state between the audio callback and everyone else.
///
/// The audio thread is the only writer for every field except `pending_seek_frames` and
/// `has_anchor`, which callers may also clear to invalidate the clock synchronously.
pub struct PlaybackClock {
    /// Playback has been requested. Until it is set, the stream outputs silence.
    is_armed: AtomicBool,

    /// `origin_nanos` holds a real measurement. While false, position reads as 0.
    has_anchor: AtomicBool,

    /// The instant (nanoseconds since epoch) at which sample 0 reaches the speaker.
    origin_nanos: AtomicU64,

    /// Anchor updates since the last start or seek. Drives the smoothing window.
    anchor_updates: AtomicU64,

    /// The device is queueing audio ahead, so starting playback will be heard almost
    /// immediately. Before this, the backend is still bringing the stream up and a
    /// start can take a couple of hundred milliseconds to become audible.
    is_device_warm: AtomicBool,

    /// Requested seek position in frames; `-1` means no request pending. Claimed and
    /// cleared by the audio thread so it is honoured exactly once.
    pending_seek_frames: AtomicI64,

    /// Real hardware sample rate divided by the nominal one, as `f64` bits.
    ///
    /// Stays at exactly `1.0` until there is a long enough measurement window. See
    /// [`crate::audio::engine`] for how it is estimated and why it matters.
    rate_ratio_bits: AtomicU64,

    /// Manual calibration in nanoseconds. Positive means the audio is heard *later*
    /// than the clock reports, so the reported position must lag behind.
    calibration_offset_nanos: AtomicI64,

    /// Output latency observed on the first armed callback, in nanoseconds.
    /// A diagnostic snapshot, not a live measurement.
    output_latency_nanos: AtomicU64,
}

impl Default for PlaybackClock {
    fn default() -> Self {
        Self {
            is_armed: AtomicBool::new(false),
            has_anchor: AtomicBool::new(false),
            origin_nanos: AtomicU64::new(0),
            anchor_updates: AtomicU64::new(0),
            is_device_warm: AtomicBool::new(false),
            pending_seek_frames: AtomicI64::new(-1),
            rate_ratio_bits: AtomicU64::new(1.0f64.to_bits()),
            calibration_offset_nanos: AtomicI64::new(0),
            output_latency_nanos: AtomicU64::new(0),
        }
    }
}

// ---------------------------------------------------------------------------
// Reads — safe from any thread, cheap enough to poll.
// ---------------------------------------------------------------------------

impl PlaybackClock {
    /// Current audible position in milliseconds, clamped to `[0, duration_ms]`.
    ///
    /// Crystal drift is deliberately *not* applied here: it already lives inside
    /// `origin_nanos`. Once the lead estimate is converted with the real hardware rate,
    /// the anchor moves at `1 - rate_ratio` per second on its own, so `now - origin`
    /// advances at exactly the rate the song is being consumed. Scaling again here
    /// would square the correction.
    pub fn position_ms(&self, duration_ms: f64) -> f64 {
        if !self.has_anchor.load(Ordering::Acquire) {
            return 0.0;
        }

        let origin = self.origin_nanos.load(Ordering::Relaxed) as i128;
        let offset = self.calibration_offset_nanos.load(Ordering::Relaxed) as i128;
        let elapsed_ms = (now_nanos() as i128 - origin - offset) as f64 / 1_000_000.0;

        elapsed_ms.clamp(0.0, duration_ms)
    }

    pub fn is_playing(&self) -> bool {
        self.is_armed.load(Ordering::Acquire)
    }

    /// True once the device is queueing ahead and starting playback is heard at once.
    pub fn is_device_warm(&self) -> bool {
        self.is_device_warm.load(Ordering::Acquire)
    }

    /// Real hardware rate over nominal. `1.0` until it has been measured.
    pub fn rate_ratio(&self) -> f64 {
        f64::from_bits(self.rate_ratio_bits.load(Ordering::Relaxed))
    }

    pub fn calibration_offset_ms(&self) -> f64 {
        self.calibration_offset_nanos.load(Ordering::Relaxed) as f64 / 1_000_000.0
    }

    pub fn output_latency_ms(&self) -> f64 {
        self.output_latency_nanos.load(Ordering::Relaxed) as f64 / 1_000_000.0
    }
}

// ---------------------------------------------------------------------------
// Control — called from the thread driving playback, never from the callback.
// ---------------------------------------------------------------------------

impl PlaybackClock {
    /// Requests playback. Audio starts on the next callback — one buffer period, a few
    /// milliseconds — because the stream is already running and emitting silence.
    pub fn arm(&self) {
        self.is_armed.store(true, Ordering::Release);
    }

    /// Requests a seek and arms playback.
    ///
    /// Invalidating the anchor first is load-bearing. The audio thread only picks the
    /// request up on its next callback, up to a buffer period later, and an IPC round
    /// trip is much shorter than that. Without clearing it here, `position_ms` would
    /// keep answering from the *old* anchor and any consumer syncing to this clock
    /// would latch onto a stale origin.
    pub fn request_seek(&self, frame: u64) {
        self.has_anchor.store(false, Ordering::Release);
        self.pending_seek_frames
            .store(frame.min(i64::MAX as u64) as i64, Ordering::Release);
        self.is_armed.store(true, Ordering::Release);
    }

    /// Manual calibration. Positive means the audio is heard later than reported, so
    /// the reported position is pulled back to match.
    pub fn set_calibration_offset_ms(&self, offset_ms: f64) {
        self.calibration_offset_nanos
            .store((offset_ms * 1_000_000.0) as i64, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Audio-thread updates — real-time safe: no locks, no allocation, no syscalls.
// ---------------------------------------------------------------------------

impl PlaybackClock {
    pub(super) fn is_armed(&self) -> bool {
        self.is_armed.load(Ordering::Acquire)
    }

    pub(super) fn mark_device_warm(&self) {
        self.is_device_warm.store(true, Ordering::Release);
    }

    pub(super) fn publish_rate_ratio(&self, ratio: f64) {
        self.rate_ratio_bits.store(ratio.to_bits(), Ordering::Relaxed);
    }

    /// Claims a pending seek, if any. Returns the target frame exactly once.
    pub(super) fn take_pending_seek(&self) -> Option<u64> {
        match self.pending_seek_frames.swap(-1, Ordering::AcqRel) {
            frame if frame >= 0 => Some(frame as u64),
            _ => None,
        }
    }

    /// Drops the anchor so it is rebuilt from scratch on the next update.
    pub(super) fn reset_anchor(&self) {
        self.anchor_updates.store(0, Ordering::Relaxed);
        self.has_anchor.store(false, Ordering::Release);
    }

    /// Folds a freshly measured origin into the anchor.
    ///
    /// The first update after a start or seek is taken verbatim, which is also when the
    /// output latency snapshot is recorded. Later ones are smoothed, so a single jittery
    /// callback cannot move the clock far enough to be seen.
    pub(super) fn update_anchor(&self, candidate_origin_nanos: u64, lead_nanos: u64) {
        let update_index = self.anchor_updates.fetch_add(1, Ordering::Relaxed);

        if update_index == 0 {
            self.origin_nanos
                .store(candidate_origin_nanos, Ordering::Relaxed);
            self.output_latency_nanos.store(lead_nanos, Ordering::Relaxed);
            self.has_anchor.store(true, Ordering::Release);
            return;
        }

        let divisor = (update_index + 1).min(ANCHOR_SMOOTHING_WINDOW) as i128;
        let previous = self.origin_nanos.load(Ordering::Relaxed) as i128;
        let smoothed = previous + (candidate_origin_nanos as i128 - previous) / divisor;

        self.origin_nanos.store(smoothed as u64, Ordering::Relaxed);
    }
}
