//! Charts: the format the game plays, and the importers that produce it.
//!
//! - [`model`] is the format itself.
//! - [`validate`] enforces the invariants the runtime relies on.
//! - [`osu`] converts osu!mania charts into it.
//!
//! Conversion happens at import time. The runtime never sees a source format, which is
//! what keeps gameplay free of per-format special cases as more importers are added.

pub mod model;
pub mod osu;
pub mod validate;

pub use model::Chart;
