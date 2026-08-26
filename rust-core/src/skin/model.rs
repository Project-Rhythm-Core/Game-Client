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
    /// Bitmap number fonts, for counters the skin draws itself rather than in text.
    #[serde(default, skip_serializing_if = "Fonts::is_empty")]
    pub fonts: Fonts,
}

/// Bitmap digits, `0` through `9` in order.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fonts {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub combo: Vec<String>,
    /// How far each digit is drawn over the one before it, in virtual units.
    ///
    /// Bitmap digits are authored with their own side bearing and look wrongly spaced
    /// side by side, so skins state how much to pull them together.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub combo_overlap: f64,
}

impl Fonts {
    pub fn is_empty(&self) -> bool {
        self.combo.is_empty()
    }
}

fn yes() -> bool {
    true
}

fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

/// Height of the space skin textures are authored in.
///
/// osu measures its stage in 480 units but draws legacy textures at 1.6x that, so a
/// texture pixel is `480 / 768` of a virtual unit. Anything sized from a texture's own
/// pixels — a receptor, a judgement line — has to come back through this, and both
/// reference skins confirm it: their receptors then reach exactly from the hit position
/// to the foot of the stage.
pub const TEXTURE_SPACE_HEIGHT: f64 = 768.0;

/// Height of the playfield every measurement in a layout is expressed against.
///
/// osu positions its stage inside a fixed 480-unit-high space and scales that to the
/// window. Keeping the numbers in those units rather than converting them to pixels is
/// what makes a layout resolution-independent: the renderer multiplies by
/// `screenHeight / 480` and everything follows, at any window size.
pub const VIRTUAL_HEIGHT: f64 = 480.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub keys: u32,
    /// Where the judgement line sits, in virtual units from the top.
    pub hit_position: f64,
    /// Separator widths in virtual units, one per lane edge — so one more than there
    /// are columns. Skins overwhelmingly leave these at zero; the one non-zero value in
    /// the reference set marks the split between hands of a 10-key double-play layout.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub line_widths: Vec<f64>,
    pub columns: Vec<ColumnStyle>,
    /// Where the combo counter sits, in virtual units from the top.
    pub combo_position: f64,
    /// Where the judgement graphic sits, in virtual units from the top.
    pub score_position: f64,
    /// Whether the receptors are drawn behind the notes instead of over them.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub keys_under_notes: bool,
    /// Whether to draw a plain line across the hit position.
    ///
    /// Skins that draw their own hit target turn this off, and drawing it anyway puts a
    /// line across the stage the author deliberately removed.
    #[serde(default = "yes")]
    pub judgement_line: bool,
    #[serde(default, skip_serializing_if = "Stage::is_empty")]
    pub stage: Stage,
}

/// How one lane is drawn. Every texture is optional: skins style what they care about.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnStyle {
    /// Lane width in virtual units. Uneven widths are design intent and are kept.
    pub width: f64,
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
    /// Height of the receptor in virtual units.
    ///
    /// A receptor is stretched across the lane but keeps its authored height, unlike a
    /// note which scales with the lane, so the height cannot be recovered from the
    /// texture alone once the renderer has it: whether the file was a `@2x` variant is
    /// known here and nowhere else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_height: Option<f64>,
    /// Whether the tail image must be drawn upside down.
    ///
    /// Most skins ship no tail at all and reuse the head, which osu draws flipped so the
    /// note reads as pointing the other way. Recording it here keeps that decision with
    /// the skin rather than making the renderer guess from filenames.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tail_flipped: bool,
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
    /// Height of the judgement line in virtual units, for the same reason as `key_height`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint_height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub light: Option<String>,
}

impl Stage {
    pub fn is_empty(&self) -> bool {
        self.left.is_none() && self.right.is_none() && self.hint.is_none() && self.light.is_none()
    }
}

impl Theme {
    pub fn new(judgements: BTreeMap<String, String>, layouts: Vec<Layout>, fonts: Fonts) -> Self {
        Self {
            format_version: FORMAT_VERSION,
            judgements,
            layouts,
            fonts,
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
