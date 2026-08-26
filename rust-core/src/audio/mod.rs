//! Audio engine.
//!
//! Layered so each piece can grow independently:
//!
//! - [`decoder`] turns a file into interleaved PCM.
//! - [`device`] negotiates a stream configuration and adapts the PCM to it.
//! - [`clock`] tracks which sample is audible right now.
//! - [`mixer`] plays the sample bank: keysounds and scheduled accompaniment.
//! - [`engine`] owns the output stream and ties them together.
//!
//! Nothing here knows about Node or Electron; the bindings live in `crate::lib`.

pub mod clock;
pub mod decoder;
pub mod device;
pub mod engine;
pub mod mixer;

pub use decoder::{DecodedAudio, decode_file};
pub use engine::AudioEngine;
