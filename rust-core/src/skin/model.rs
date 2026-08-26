//! The skin format the game reads.
//!
//! Written as YAML rather than JSON because a skin is meant to be edited by hand: the
//! whole point is that someone can open it, change a filename, and see the difference.
//!
//! A skin package looks like this:
//!
//! ```text
//! dpjam-percy/
//!   skin.yaml        identity, and what the package provides
//!   sounds.yaml      the hit sound bank
//!   osu.yaml         visual theme for charts imported from osu
//!   assets/
//!     sounds/
//!     osu/
//! ```
//!
//! Sounds sit at the root rather than under a per-game folder on purpose. A chart that
//! names a sound it does not ship needs that sound whatever format it came from, and the
//! naming space is the same, so one bank serves every importer.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const FORMAT_VERSION: u32 = 1;

/// `skin.yaml`: who made this and what is in the package.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinManifest {
    pub format_version: u32,
    /// Directory name, and how the game refers to this skin.
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: String,
    pub origin: SkinOrigin,
    pub provides: SkinProvides,
}

/// Where the skin came from. Kept so it can be re-imported and debugged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinOrigin {
    pub format: String,
    /// Source folder name, as it was on disk.
    pub folder: String,
}

/// What the package actually contains, so the loader need not probe for it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinProvides {
    pub sounds: bool,
    /// Source formats this skin has a visual theme for.
    pub themes: Vec<String>,
}

/// `sounds.yaml`: the fallback bank, keyed by the name a chart asks for.
///
/// Charts name their sounds with osu's canonical spelling — `soft-hitnormal`,
/// `drum-hitclap2` — so the bank is keyed by exactly that. Resolution becomes one lookup
/// with no translation step, and the file stays obvious to edit.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundBank {
    pub format_version: u32,
    /// Canonical sound name to path, relative to the skin's own folder.
    pub sounds: BTreeMap<String, String>,
}

/// `osu.yaml`: the visual theme for charts imported from osu.
///
/// Textures and colours only. osu's positional values — `ColumnStart`, `HitPosition` and
/// the rest — are pixels in its fixed 640x480 stage, so they describe a playfield this
/// renderer does not have. Column *proportions* survive, because uneven widths are design
/// intent; their absolute coordinates do not.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub format_version: u32,
    /// Judgement graphics, keyed by the game's own judgement names.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub judgements: BTreeMap<String, String>,
    /// One entry per key count the skin styles.
    pub layouts: Vec<Layout>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub keys: u32,
    pub columns: Vec<ColumnStyle>,
    #[serde(default, skip_serializing_if = "Stage::is_empty")]
    pub stage: Stage,
}

/// How one lane is drawn. Every texture is optional: skins style what they care about.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnStyle {
    /// Width relative to the mean lane of this layout. `1.0` is even.
    pub width_weight: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// Hold body. Tiled down the note rather than stretched, so it is stored as a short
    /// strip regardless of how long the source image was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_pressed: Option<String>,
    /// Lane tint, `#rrggbbaa`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colour: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub light: Option<String>,
}

impl Stage {
    pub fn is_empty(&self) -> bool {
        self.left.is_none() && self.right.is_none() && self.hint.is_none() && self.light.is_none()
    }
}

impl Theme {
    pub fn new(judgements: BTreeMap<String, String>, layouts: Vec<Layout>) -> Self {
        Self {
            format_version: FORMAT_VERSION,
            judgements,
            layouts,
        }
    }
}

impl SoundBank {
    pub fn new(sounds: BTreeMap<String, String>) -> Self {
        Self {
            format_version: FORMAT_VERSION,
            sounds,
        }
    }
}
