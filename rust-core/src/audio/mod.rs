//! Audio engine.
//!
//! Layered so each piece can grow independently:
//!
//! - [`decoder`] turns a file into interleaved PCM.
//! - [`device`] negotiates a stream configuration and adapts the PCM to it.
//! - [`clock`] tracks which sample is audible right now.
//! - [`engine`] owns the output stream and ties the three together.
//!
//! Nothing here knows about Node or Electron; the bindings live in `crate::lib`.

pub mod clock;
pub mod decoder;
pub mod device;
pub mod engine;

pub use decoder::{DecodedAudio, decode_file};
pub use engine::AudioEngine;
