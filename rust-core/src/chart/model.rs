//! The chart model the game plays.
//!
//! Every supported source format — osu!mania today, BMS and o2jam later — is converted
//! into this at import time. The runtime never sees a source format.
//!
//! Field names serialise to camelCase so the JSON reads naturally from TypeScript.

use serde::{Deserialize, Serialize};

/// Bumped on any breaking change to the shape below.
pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chart {
    pub format_version: u32,
    /// Stable identity, namespaced by source. For example `osu:5633412`.
    pub id: String,
    pub metadata: Metadata,
    pub origin: Origin,
    /// One entry per lane, in play order. Its length is the key count.
    pub columns: Vec<Column>,
    /// Background track, when the chart has one. Keysounded charts may not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioTrack>,
    /// Sample bank, shared by note sounds and BGM events.
    ///
    /// Covers two things that look different but resolve the same way: osu hitsounds,
    /// which layer on top of a background track, and BMS keysounds, which *are* the
    /// music. Empty only when a chart makes no sound of its own.
    pub samples: Vec<Sample>,
    /// Samples that fire on schedule with no note attached.
    pub bgm_events: Vec<BgmEvent>,
    pub timing: Timing,
    pub notes: Vec<Note>,
    /// Presentation only. Never affects judgement.
    pub effects: Vec<Effect>,
    pub breaks: Vec<Span>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub title: String,
    pub title_unicode: String,
    pub artist: String,
    pub artist_unicode: String,
    /// Who made the chart, as opposed to the music.
    pub charter: String,
    pub difficulty_name: String,
    pub source: String,
    pub tags: Vec<String>,
}

/// Where the chart came from. Kept because re-importing and debugging both need it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    /// Source format identifier, for example `osu`.
    pub format: String,
    /// Version of that format, when it declares one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format_version: Option<u32>,
    /// Identifiers the source format carried, kept verbatim.
    pub ids: std::collections::BTreeMap<String, i64>,
    /// Numeric fields worth preserving that have no home in the model proper.
    pub values: std::collections::BTreeMap<String, f64>,
}

/// What a lane is. A turntable is not a narrower note lane: it is judged and drawn
/// differently, so it gets its own role rather than being inferred from an index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnRole {
    Note,
    Scratch,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub role: ColumnRole,
}

impl Column {
    pub fn note() -> Self {
        Self {
            role: ColumnRole::Note,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    /// Path relative to the chart file.
    pub file: String,
    /// Correction between this chart's authored timing and how this engine decodes the
    /// audio. Encoder delay handling differs between decoders; see the format
    /// documentation. Starts at zero and has to be measured, not assumed.
    pub offset_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_ms: Option<f64>,
    pub lead_in_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// Filename, resolved relative to the chart. It may legitimately not exist: osu
    /// charts reference sample-set sounds that fall back to the player's skin when the
    /// chart does not ship them, so the loader has to tolerate a miss.
    pub file: String,
}



/// A sample that plays on its own, with no note to hit.
///
/// This is what carries the accompaniment in a fully keysounded chart: osu writes them
/// as storyboard sample events, BMS as BGM channels.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgmEvent {
    pub time_ms: f64,
    /// Index into [`Chart::samples`].
    pub sample: u32,
    /// Percentage, 0 to 100. Omitted when full.
    #[serde(default = "full_volume", skip_serializing_if = "is_full_volume")]
    pub volume: f64,
}

pub(crate) fn full_volume() -> f64 {
    100.0
}

pub(crate) fn is_full_volume(volume: &f64) -> bool {
    *volume >= 100.0
}

/// The musical grid and the visual velocity, deliberately kept apart.
///
/// Where a note is judged and where it is drawn follow different timelines. Source
/// formats blur this — osu packs both into one list behind a flag — and separating them
/// is what makes rendering and judgement independent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub tempo: Vec<TempoPoint>,
    pub scroll: Vec<ScrollPoint>,
    pub stops: Vec<StopPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoPoint {
    pub time_ms: f64,
    pub bpm: f64,
    /// Beats per measure.
    pub meter: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollPoint {
    pub time_ms: f64,
    /// Relative to the player's scroll speed setting. `1.0` is unmodified.
    pub multiplier: f64,
}

/// A scroll freeze. Musical time keeps running underneath it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopPoint {
    pub time_ms: f64,
    pub duration_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    /// A landmine: hitting it is the failure. BMS has these; osu!mania does not.
    Mine,
}

/// Deliberately small: a marathon chart is tens of thousands of these, and optional
/// fields are omitted rather than written as null.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// Absolute milliseconds from the start of the audio.
    pub time_ms: f64,
    /// Index into [`Chart::columns`].
    pub column: u16,
    /// Present means this is a hold note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<f64>,
    /// Omitted for ordinary notes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<NoteKind>,
    /// Indices into [`Chart::samples`], played together.
    ///
    /// A list rather than a single value because osu hitsounds layer: one note can fire
    /// a normal sound plus a whistle and a clap at the same instant.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub samples: Vec<u32>,
    /// Playback volume for this note's samples, 0 to 100. Omitted when full.
    ///
    /// Resolved at import from the hit object, falling back to the timing point in
    /// force. Keeping it on the note means the runtime needs no timeline lookup to
    /// play a sound, and it is the only representation that fits charts which vary
    /// volume note by note.
    #[serde(default = "full_volume", skip_serializing_if = "is_full_volume")]
    pub volume: f64,
}

impl Note {
    pub fn is_hold(&self) -> bool {
        self.end_ms.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EffectKind {
    /// A highlighted section. Presentation only.
    Kiai,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub start_ms: f64,
    pub end_ms: f64,
    pub kind: EffectKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start_ms: f64,
    pub end_ms: f64,
}
