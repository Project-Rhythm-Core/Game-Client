//! Skins: the format the game reads, and the importers that produce it.
//!
//! Only what transfers is taken from a source skin. osu's positional values are pixels in
//! its own fixed-resolution stage, so importing them would drag its geometry into a
//! renderer that works differently — and it is that geometry, not anything in the skin
//! data, that produces effects like a long note appearing to end early.

pub mod model;
pub mod osu;
