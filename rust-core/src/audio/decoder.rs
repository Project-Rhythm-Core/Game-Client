//! File decoding.
//!
//! Decodes a whole audio file into interleaved `f32` PCM, ready to hand to the device
//! with no conversion pending.
//!
//! Keeping the track resident costs memory — roughly 92 MB for four minutes of 48 kHz
//! stereo — but it buys two things a rhythm game needs: no disk I/O or decoder jitter
//! inside the real-time callback, and seeks that are exact by construction, since a
//! position is just an index rather than a re-decode from the nearest frame boundary.

use std::fs::File;
use std::path::Path;

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

/// Fallback capacity when the container does not declare a frame count: one minute of
/// audio. Only avoids the first few reallocations; the vector still grows if needed.
const FALLBACK_CAPACITY_SECONDS: usize = 60;

/// Interleaved PCM plus the format it was decoded at.
pub struct DecodedAudio {
    /// Interleaved samples, `channels` values per frame.
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
}

impl DecodedAudio {
    pub fn frame_count(&self) -> usize {
        self.samples.len() / self.channels.max(1) as usize
    }

    pub fn duration_ms(&self) -> f64 {
        self.frame_count() as f64 / self.sample_rate as f64 * 1000.0
    }
}

/// Decodes `path` in full.
///
/// Blocking and CPU bound: callers must keep it off any thread that has to stay
/// responsive.
pub fn decode_file(path: &str) -> Result<DecodedAudio, String> {
    let file = File::open(path).map_err(|e| format!("could not open '{path}': {e}"))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    // The file extension lets the probe identify the container on the first attempt.
    let mut hint = Hint::new();
    if let Some(extension) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(extension);
    }

    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| format!("unrecognised audio format: {e}"))?;

    let track = format
        .first_track(TrackType::Audio)
        .ok_or("the file contains no audio track")?;
    let track_id = track.id;

    let codec_params = track
        .codec_params
        .as_ref()
        .and_then(|params| params.audio())
        .ok_or("the audio track declares no codec parameters")?;

    let sample_rate = codec_params.sample_rate.ok_or("unknown sample rate")?;
    let channels = codec_params
        .channels
        .as_ref()
        .ok_or("unknown channel layout")?
        .count() as u16;

    // Reserving up front avoids dozens of reallocations part-way through the decode.
    let estimated_samples = track
        .num_frames
        .map(|frames| frames as usize * channels as usize)
        .unwrap_or(sample_rate as usize * channels as usize * FALLBACK_CAPACITY_SECONDS);

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(codec_params, &AudioDecoderOptions::default())
        .map_err(|e| format!("could not create a decoder: {e}"))?;

    let mut samples: Vec<f32> = Vec::with_capacity(estimated_samples);
    let mut interleaved: Vec<f32> = Vec::new();

    while let Some(packet) = format
        .next_packet()
        .map_err(|e| format!("error reading the file: {e}"))?
    {
        if packet.track_id != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            // A few corrupt packets should not fail the whole load.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(format!("error decoding: {e}")),
        };

        // One scratch buffer, resized only when a packet needs more room than the last.
        let needed = decoded.samples_interleaved();
        if interleaved.len() < needed {
            interleaved.resize(needed, 0.0);
        }

        decoded.copy_to_slice_interleaved(&mut interleaved[..needed]);
        samples.extend_from_slice(&interleaved[..needed]);
    }

    if samples.is_empty() {
        return Err("the file contains no decodable samples".into());
    }

    Ok(DecodedAudio {
        samples,
        sample_rate,
        channels,
    })
}
