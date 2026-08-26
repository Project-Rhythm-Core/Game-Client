//! Output device negotiation.
//!
//! Picks a stream configuration the device will actually accept and adapts the decoded
//! PCM to match it. Everything here runs once, at load time, off the real-time path.

use cpal::traits::DeviceTrait;
use cpal::{BufferSize, SampleFormat, SupportedBufferSize, SupportedStreamConfig};

use super::decoder::DecodedAudio;

/// Buffer size requested from the device, in frames.
///
/// 256 frames is ~5.3 ms at 48 kHz. The system default is typically 1024-8192 frames
/// (20-170 ms), which on its own would exceed a rhythm game's entire timing window.
/// The trade is CPU headroom: smaller buffers mean more callbacks and less slack before
/// an underrun.
const PREFERRED_BUFFER_FRAMES: u32 = 256;

/// A stream configuration plus the PCM already converted to match it.
pub struct DeviceStream {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
    /// Frames per callback, or `0` when the backend chose its own.
    pub buffer_frames: u32,
    pub config: cpal::StreamConfig,
}

impl DeviceStream {
    pub fn frame_count(&self) -> usize {
        self.samples.len() / self.channels.max(1) as usize
    }

    pub fn duration_ms(&self) -> f64 {
        self.frame_count() as f64 / self.sample_rate as f64 * 1000.0
    }

    /// Theoretical latency of one buffer at this rate, in milliseconds.
    pub fn buffer_ms(&self) -> f64 {
        if self.buffer_frames == 0 {
            return 0.0;
        }
        self.buffer_frames as f64 / self.sample_rate as f64 * 1000.0
    }
}

/// Adapts `audio` to something `device` will accept, and works out the stream config.
pub fn negotiate(
    device: &cpal::Device,
    audio: DecodedAudio,
    default_config: &SupportedStreamConfig,
) -> Result<DeviceStream, String> {
    let supported: Vec<_> = device
        .supported_output_configs()
        .map_err(|e| format!("could not list device configurations: {e}"))?
        .collect();

    // The stream is built as `f32`. cpal panics inside the callback if the host hands
    // back a different sample type, so refuse up front with a message that says why.
    // Supporting i16/u16 output means making the callback generic over the format.
    if !supported
        .iter()
        .any(|config| config.sample_format() == SampleFormat::F32)
    {
        return Err("the output device does not support 32-bit float samples".into());
    }

    let DecodedAudio {
        mut samples,
        mut sample_rate,
        mut channels,
    } = audio;

    // 1. Channels. If the device cannot take the file's layout, remap to its default.
    if !supported.iter().any(|c| c.channels() == channels) {
        let target = default_config.channels();
        samples = remap_channels(&samples, channels, target);
        channels = target;
    }

    // 2. Sample rate. If the rate falls outside every supported range, resample.
    let rate_supported = |rate: u32| {
        supported
            .iter()
            .any(|c| c.channels() == channels && c.min_sample_rate() <= rate && rate <= c.max_sample_rate())
    };
    if !rate_supported(sample_rate) {
        let target = default_config.sample_rate();
        samples = resample_linear(&samples, channels, sample_rate, target);
        sample_rate = target;
    }

    let buffer_size = pick_buffer_size(&supported, channels, sample_rate);
    let buffer_frames = match buffer_size {
        BufferSize::Fixed(frames) => frames,
        BufferSize::Default => 0,
    };

    let config = cpal::StreamConfig {
        channels,
        sample_rate,
        buffer_size,
    };

    Ok(DeviceStream {
        samples,
        sample_rate,
        channels,
        buffer_frames,
        config,
    })
}

/// Picks the smallest buffer the device allows, capped at [`PREFERRED_BUFFER_FRAMES`].
fn pick_buffer_size(
    supported: &[cpal::SupportedStreamConfigRange],
    channels: u16,
    sample_rate: u32,
) -> BufferSize {
    for config in supported {
        if config.channels() != channels
            || sample_rate < config.min_sample_rate()
            || sample_rate > config.max_sample_rate()
        {
            continue;
        }

        if let SupportedBufferSize::Range { min, max } = config.buffer_size() {
            return BufferSize::Fixed(PREFERRED_BUFFER_FRAMES.clamp(*min, *max));
        }
    }

    BufferSize::Default
}

/// Maps interleaved audio from one channel count to another.
///
/// This is a positional fallback, not a proper downmix matrix: it never invents content
/// for channels the source does not have, and never drops a source channel entirely.
/// Replacing it with a real matrix (ITU-R BS.775 for 5.1 to stereo, an explicit LFE
/// policy) is the natural next step once surround output is worth supporting properly.
fn remap_channels(samples: &[f32], from: u16, to: u16) -> Vec<f32> {
    if from == to || from == 0 || to == 0 {
        return samples.to_vec();
    }

    let (from, to) = (from as usize, to as usize);
    let frame_count = samples.len() / from;
    let mut output = Vec::with_capacity(frame_count * to);

    for frame in 0..frame_count {
        let source = &samples[frame * from..frame * from + from];

        if from < to {
            // Upmix. Mono feeds both front channels; anything else keeps its own
            // positions. Channels with no source (centre, LFE, surrounds) stay silent
            // rather than being fed a copy of an unrelated channel.
            for channel in 0..to {
                output.push(match (from, channel) {
                    (1, 0) | (1, 1) => source[0],
                    (_, c) if c < from => source[c],
                    _ => 0.0,
                });
            }
        } else {
            // Downmix. Fold the extra channels onto the ones that remain, so front-left
            // content stays left, and average so the result cannot clip.
            for channel in 0..to {
                let mut sum = 0.0;
                let mut count = 0.0;
                let mut source_channel = channel;
                while source_channel < from {
                    sum += source[source_channel];
                    count += 1.0;
                    source_channel += to;
                }
                output.push(sum / count);
            }
        }
    }

    output
}

/// Resamples interleaved audio by linear interpolation.
///
/// Cheap and adequate while assets ship at the device's rate. It is not a quality
/// resampler — expect audible aliasing on large ratio changes — so accepting arbitrary
/// user-supplied audio means swapping in a windowed-sinc or polyphase implementation.
fn resample_linear(samples: &[f32], channels: u16, from: u32, to: u32) -> Vec<f32> {
    if from == to || from == 0 || to == 0 {
        return samples.to_vec();
    }

    let channels = channels.max(1) as usize;
    let input_frames = samples.len() / channels;
    if input_frames == 0 {
        return Vec::new();
    }

    let step = from as f64 / to as f64;
    let output_frames = (input_frames as f64 / step).floor() as usize;
    let mut output = Vec::with_capacity(output_frames * channels);

    for frame in 0..output_frames {
        let position = frame as f64 * step;
        let index = position.floor() as usize;
        let fraction = (position - index as f64) as f32;
        let next_index = (index + 1).min(input_frames - 1);

        for channel in 0..channels {
            let current = samples[index * channels + channel];
            let next = samples[next_index * channels + channel];
            output.push(current + (next - current) * fraction);
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_upmix_feeds_both_front_channels_and_silences_the_rest() {
        // One frame, mono, to a 5.1 layout.
        let output = remap_channels(&[0.5], 1, 6);
        assert_eq!(output, vec![0.5, 0.5, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn stereo_upmix_keeps_positions_without_inventing_content() {
        let output = remap_channels(&[-1.0, 1.0], 2, 6);
        assert_eq!(output, vec![-1.0, 1.0, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn stereo_downmix_to_mono_averages_both_channels() {
        let output = remap_channels(&[1.0, 0.0], 2, 1);
        assert_eq!(output, vec![0.5]);
    }

    #[test]
    fn identity_mapping_is_a_passthrough() {
        let input = vec![0.1, 0.2, 0.3, 0.4];
        assert_eq!(remap_channels(&input, 2, 2), input);
    }

    #[test]
    fn halving_the_rate_keeps_every_other_frame() {
        // Two channels, four frames, resampled 2:1.
        let input = vec![0.0, 10.0, 1.0, 11.0, 2.0, 12.0, 3.0, 13.0];
        let output = resample_linear(&input, 2, 48_000, 24_000);
        assert_eq!(output, vec![0.0, 10.0, 2.0, 12.0]);
    }

    #[test]
    fn resampling_to_the_same_rate_is_a_passthrough() {
        let input = vec![0.1, 0.2, 0.3, 0.4];
        assert_eq!(resample_linear(&input, 2, 48_000, 48_000), input);
    }
}
