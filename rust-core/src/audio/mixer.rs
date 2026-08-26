//! Polyphonic sample mixing.
//!
//! Two kinds of sound arrive here and they need very different handling.
//!
//! **Scheduled sounds** — a keysounded chart's accompaniment — are known in advance, so
//! the audio thread fires them itself at an exact frame. Nothing outside the audio thread
//! is involved, which is what makes them sample-accurate.
//!
//! **Triggered sounds** come from the player hitting a key, so they arrive whenever they
//! arrive. They cross into the audio thread through a lock-free queue, because the
//! callback must never block, allocate, or wait on another thread.
//!
//! Everything is mixed into the same stream as the music. That is not a convenience: a
//! hit sound routed through a separate output would have its own latency, and the game
//! would feel wrong however accurate the judgement was.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

/// Simultaneous voices. Piano charts sustain heavily, so this is generous on purpose;
/// running out steals the oldest voice rather than dropping the new one.
const MAX_VOICES: usize = 64;

/// Capacity of the queue carrying triggers into the audio thread.
///
/// A power of two so the index wrap is a mask. Sized far beyond any plausible burst of
/// keypresses, because overflowing it means dropping a sound the player asked for.
const TRIGGER_QUEUE_SIZE: usize = 256;

/// An empty queue slot. A real trigger always carries a volume, so this cannot collide.
const EMPTY_SLOT: u64 = u64::MAX;

/// A sound waiting to be played, packed into one atomic so a slot can never be read
/// half-written.
fn pack_trigger(sample_index: u32, volume: f32) -> u64 {
    ((sample_index as u64) << 32) | volume.to_bits() as u64
}

fn unpack_trigger(packed: u64) -> (usize, f32) {
    ((packed >> 32) as usize, f32::from_bits(packed as u32))
}

/// Single-producer, single-consumer queue of sounds to start.
///
/// The producer is whichever thread handles input; the consumer is the audio callback.
/// Neither ever blocks: a full queue drops the trigger, which is the right failure — a
/// missing sound is far better than a stalled audio thread.
pub struct TriggerQueue {
    slots: Box<[AtomicU64]>,
    write: AtomicUsize,
    read: AtomicUsize,
    /// Triggers dropped because the queue was full, as a diagnostic.
    dropped: AtomicUsize,
}

impl TriggerQueue {
    pub fn new() -> Self {
        Self {
            slots: (0..TRIGGER_QUEUE_SIZE)
                .map(|_| AtomicU64::new(EMPTY_SLOT))
                .collect(),
            write: AtomicUsize::new(0),
            read: AtomicUsize::new(0),
            dropped: AtomicUsize::new(0),
        }
    }

    /// Queues a sound. Safe to call from any thread that is not the audio thread.
    pub fn push(&self, sample_index: u32, volume: f32) {
        let write = self.write.load(Ordering::Relaxed);
        let read = self.read.load(Ordering::Acquire);

        if write.wrapping_sub(read) >= TRIGGER_QUEUE_SIZE {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }

        self.slots[write & (TRIGGER_QUEUE_SIZE - 1)]
            .store(pack_trigger(sample_index, volume), Ordering::Relaxed);
        self.write.store(write.wrapping_add(1), Ordering::Release);
    }

    /// Takes the next queued sound, if any. Only the audio thread may call this.
    fn pop(&self) -> Option<(usize, f32)> {
        let read = self.read.load(Ordering::Relaxed);
        if read == self.write.load(Ordering::Acquire) {
            return None;
        }

        let packed = self.slots[read & (TRIGGER_QUEUE_SIZE - 1)].load(Ordering::Relaxed);
        self.read.store(read.wrapping_add(1), Ordering::Release);

        Some(unpack_trigger(packed))
    }

    pub fn dropped_count(&self) -> usize {
        self.dropped.load(Ordering::Relaxed)
    }
}

impl Default for TriggerQueue {
    fn default() -> Self {
        Self::new()
    }
}

/// A sound that plays on its own at a known point in the chart.
#[derive(Clone, Copy, Debug)]
pub struct ScheduledSound {
    /// Frame within the chart at which it starts.
    pub frame: u64,
    pub sample_index: u32,
    pub volume: f32,
}

/// One sound currently being played.
#[derive(Clone, Copy)]
struct Voice {
    sample_index: usize,
    /// Frames of this sample already mixed.
    cursor: usize,
    volume: f32,
    /// Frames to wait before this voice starts, within the buffer it was started in.
    /// This is what places a scheduled sound on its exact frame instead of at the head
    /// of whatever buffer happened to contain it.
    delay: usize,
    /// When it started, so the oldest can be stolen when every voice is busy.
    age: u64,
    active: bool,
}

impl Voice {
    const SILENT: Self = Self {
        sample_index: 0,
        cursor: 0,
        volume: 0.0,
        delay: 0,
        age: 0,
        active: false,
    };
}

/// The sample bank and the voices playing out of it.
///
/// Lives on the audio thread. Nothing here allocates once it has been built.
pub struct Mixer {
    /// Decoded sounds, already in the device's rate and channel layout.
    samples: Vec<Arc<[f32]>>,
    voices: [Voice; MAX_VOICES],
    channels: usize,

    /// Sounds to fire at known frames, ordered, with a cursor into them.
    scheduled: Vec<ScheduledSound>,
    next_scheduled: usize,

    /// Increments per voice started, so age comparison needs no clock.
    started: u64,
}

impl Mixer {
    pub fn new(samples: Vec<Arc<[f32]>>, mut scheduled: Vec<ScheduledSound>, channels: u16) -> Self {
        scheduled.sort_by_key(|sound| sound.frame);

        Self {
            samples,
            voices: [Voice::SILENT; MAX_VOICES],
            channels: channels.max(1) as usize,
            scheduled,
            next_scheduled: 0,
            started: 0,
        }
    }

    #[allow(dead_code)]
    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }

    #[allow(dead_code)]
    pub fn scheduled_count(&self) -> usize {
        self.scheduled.len()
    }

    /// How many voices are sounding right now.
    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|voice| voice.active).count()
    }

    /// Rewinds the schedule to `frame`.
    ///
    /// Voices are cut: a seek should not leave the previous position still sounding.
    pub fn rewind_to(&mut self, frame: u64) {
        self.voices = [Voice::SILENT; MAX_VOICES];
        self.next_scheduled = self.scheduled.partition_point(|sound| sound.frame < frame);
    }

    /// Starts a sound, stealing the oldest voice if all of them are busy.
    pub fn trigger(&mut self, sample_index: usize, volume: f32, delay: usize) {
        if sample_index >= self.samples.len() || volume <= 0.0 {
            return;
        }

        let slot = match self.voices.iter().position(|voice| !voice.active) {
            Some(free) => free,
            None => {
                // Every voice is busy. Cutting the oldest is far less noticeable than
                // refusing the newest, which would silence what the player just did.
                let mut oldest = 0;
                for (index, voice) in self.voices.iter().enumerate() {
                    if voice.age < self.voices[oldest].age {
                        oldest = index;
                    }
                }
                oldest
            }
        };

        self.started += 1;
        self.voices[slot] = Voice {
            sample_index,
            cursor: 0,
            volume,
            delay,
            age: self.started,
            active: true,
        };
    }

    /// Mixes every sounding voice into `output`, which already holds the music.
    ///
    /// `start_frame` is the chart frame the buffer begins at, which is what lets a
    /// scheduled sound land on the frame it was authored for.
    pub fn mix(&mut self, output: &mut [f32], start_frame: u64, queue: &TriggerQueue) {
        let channels = self.channels;
        let frames = output.len() / channels;

        // Sounds the player just asked for start at the head of the buffer. They cannot
        // be placed any better than that: the press already happened.
        while let Some((sample_index, volume)) = queue.pop() {
            self.trigger(sample_index, volume, 0);
        }

        // Scheduled sounds are placed to the frame.
        let end_frame = start_frame + frames as u64;
        while self.next_scheduled < self.scheduled.len() {
            let sound = self.scheduled[self.next_scheduled];
            if sound.frame >= end_frame {
                break;
            }
            self.next_scheduled += 1;

            // Anything already behind the buffer plays from its head rather than being
            // skipped, so a stall does not silently swallow the accompaniment.
            let delay = sound.frame.saturating_sub(start_frame) as usize;
            self.trigger(sound.sample_index as usize, sound.volume, delay.min(frames));
        }

        // Disjoint field borrows: the bank is read while the voices are written.
        let samples = &self.samples;
        for voice in self.voices.iter_mut() {
            if !voice.active {
                continue;
            }

            let sample = &samples[voice.sample_index];
            let available = sample.len() / channels;
            let mut cursor = voice.cursor;

            for frame in voice.delay..frames {
                if cursor >= available {
                    voice.active = false;
                    break;
                }

                let source = cursor * channels;
                let target = frame * channels;
                for channel in 0..channels {
                    output[target + channel] += sample[source + channel] * voice.volume;
                }

                cursor += 1;
            }

            voice.cursor = cursor;
            // The delay only applies to the buffer the voice was started in.
            voice.delay = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bank(samples: &[&[f32]]) -> Vec<Arc<[f32]>> {
        samples.iter().map(|s| Arc::from(s.to_vec())).collect()
    }

    #[test]
    fn a_triggered_sound_is_mixed_from_the_head_of_the_buffer() {
        let mut mixer = Mixer::new(bank(&[&[1.0, 1.0, 1.0]]), vec![], 1);
        let queue = TriggerQueue::new();
        queue.push(0, 1.0);

        let mut output = vec![0.0; 4];
        mixer.mix(&mut output, 0, &queue);

        assert_eq!(output, vec![1.0, 1.0, 1.0, 0.0]);
    }

    #[test]
    fn volume_scales_what_is_mixed() {
        let mut mixer = Mixer::new(bank(&[&[1.0, 1.0]]), vec![], 1);
        let queue = TriggerQueue::new();
        queue.push(0, 0.5);

        let mut output = vec![0.0; 2];
        mixer.mix(&mut output, 0, &queue);

        assert_eq!(output, vec![0.5, 0.5]);
    }

    #[test]
    fn sounds_add_together_rather_than_replacing_each_other() {
        let mut mixer = Mixer::new(bank(&[&[1.0, 1.0], &[0.25, 0.25]]), vec![], 1);
        let queue = TriggerQueue::new();
        queue.push(0, 1.0);
        queue.push(1, 1.0);

        // The music is already in the buffer; voices layer on top of it.
        let mut output = vec![0.5, 0.5];
        mixer.mix(&mut output, 0, &queue);

        assert_eq!(output, vec![1.75, 1.75]);
    }

    #[test]
    fn a_scheduled_sound_lands_on_its_own_frame_not_the_buffer_head() {
        let scheduled = vec![ScheduledSound { frame: 2, sample_index: 0, volume: 1.0 }];
        let mut mixer = Mixer::new(bank(&[&[1.0, 1.0]]), scheduled, 1);

        let mut output = vec![0.0; 5];
        mixer.mix(&mut output, 0, &TriggerQueue::new());

        assert_eq!(output, vec![0.0, 0.0, 1.0, 1.0, 0.0]);
    }

    #[test]
    fn a_voice_carries_on_into_the_next_buffer() {
        let mut mixer = Mixer::new(bank(&[&[1.0, 2.0, 3.0, 4.0]]), vec![], 1);
        let queue = TriggerQueue::new();
        queue.push(0, 1.0);

        let mut first = vec![0.0; 2];
        mixer.mix(&mut first, 0, &queue);
        assert_eq!(first, vec![1.0, 2.0]);

        let mut second = vec![0.0; 2];
        mixer.mix(&mut second, 2, &queue);
        assert_eq!(second, vec![3.0, 4.0], "the delay applies only to the first buffer");
    }

    #[test]
    fn a_voice_stops_when_its_sample_runs_out() {
        let mut mixer = Mixer::new(bank(&[&[1.0]]), vec![], 1);
        let queue = TriggerQueue::new();
        queue.push(0, 1.0);

        let mut output = vec![0.0; 4];
        mixer.mix(&mut output, 0, &queue);

        assert_eq!(output, vec![1.0, 0.0, 0.0, 0.0]);
        assert_eq!(mixer.active_voices(), 0);
    }

    #[test]
    fn channels_are_interleaved_correctly() {
        // One stereo frame per sample value pair.
        let mut mixer = Mixer::new(bank(&[&[1.0, -1.0, 0.5, -0.5]]), vec![], 2);
        let queue = TriggerQueue::new();
        queue.push(0, 1.0);

        let mut output = vec![0.0; 4];
        mixer.mix(&mut output, 0, &queue);

        assert_eq!(output, vec![1.0, -1.0, 0.5, -0.5]);
    }

    #[test]
    fn rewinding_cuts_the_voices_and_repositions_the_schedule() {
        let scheduled = vec![
            ScheduledSound { frame: 0, sample_index: 0, volume: 1.0 },
            ScheduledSound { frame: 100, sample_index: 0, volume: 1.0 },
        ];
        let mut mixer = Mixer::new(bank(&[&[1.0; 8]]), scheduled, 1);

        let mut output = vec![0.0; 4];
        mixer.mix(&mut output, 0, &TriggerQueue::new());
        assert_eq!(mixer.active_voices(), 1);

        mixer.rewind_to(0);
        assert_eq!(mixer.active_voices(), 0, "a seek must not leave the old position sounding");

        // The schedule is back at the start, so the first sound fires again.
        let mut again = vec![0.0; 4];
        mixer.mix(&mut again, 0, &TriggerQueue::new());
        assert_eq!(again[0], 1.0);
    }

    #[test]
    fn an_unknown_sample_is_ignored_rather_than_panicking() {
        let mut mixer = Mixer::new(bank(&[&[1.0]]), vec![], 1);
        let queue = TriggerQueue::new();
        queue.push(99, 1.0);

        let mut output = vec![0.0; 2];
        mixer.mix(&mut output, 0, &queue);

        assert_eq!(output, vec![0.0, 0.0]);
    }

    #[test]
    fn running_out_of_voices_steals_the_oldest_rather_than_dropping_the_newest() {
        let mut mixer = Mixer::new(bank(&[&[1.0; 1024]]), vec![], 1);

        for _ in 0..MAX_VOICES {
            mixer.trigger(0, 1.0, 0);
        }
        assert_eq!(mixer.active_voices(), MAX_VOICES);

        // One more still sounds; it takes over the slot of the longest-running voice.
        mixer.trigger(0, 1.0, 0);
        assert_eq!(mixer.active_voices(), MAX_VOICES);
    }

    #[test]
    fn a_full_queue_drops_triggers_instead_of_blocking() {
        let queue = TriggerQueue::new();
        for _ in 0..TRIGGER_QUEUE_SIZE + 10 {
            queue.push(0, 1.0);
        }

        assert_eq!(queue.dropped_count(), 10);
    }

    #[test]
    fn the_queue_hands_sounds_back_in_order() {
        let queue = TriggerQueue::new();
        queue.push(3, 0.25);
        queue.push(7, 0.5);

        assert_eq!(queue.pop(), Some((3, 0.25)));
        assert_eq!(queue.pop(), Some((7, 0.5)));
        assert_eq!(queue.pop(), None);
    }
}
