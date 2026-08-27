//! Reading a skin package back.
//!
//! These read the game's *own* format, not anyone else's. They live apart from the
//! importers for that reason: an importer is per source format and there will be several,
//! while a package is read exactly one way however it was produced.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use super::model::{SkinManifest, SoundBank, Theme};

/// Reads a package's manifest back.
pub fn read_manifest(skin_dir: &str) -> Result<SkinManifest, String> {
    let path = Path::new(skin_dir).join("skin.yaml");

    let text = fs::read_to_string(&path)
        .map_err(|e| format!("could not read '{}': {e}", path.display()))?;

    serde_norway::from_str(&text).map_err(|e| format!("could not parse '{}': {e}", path.display()))
}

/// Reads a package's visual theme as JSON.
///
/// JSON rather than a typed binding because the theme is deeply nested and entirely
/// optional at every level; the renderer wants the whole tree, not a flattened view of
/// it. YAML is still parsed in one place — here — so the format has a single reader.
pub fn read_theme_json(skin_dir: &str, format: &str) -> Result<String, String> {
    let path = Path::new(skin_dir).join(format!("{format}.yaml"));

    let text = fs::read_to_string(&path)
        .map_err(|e| format!("could not read '{}': {e}", path.display()))?;

    let theme: Theme = serde_norway::from_str(&text)
        .map_err(|e| format!("could not parse '{}': {e}", path.display()))?;

    serde_json::to_string(&theme).map_err(|e| format!("could not encode the theme: {e}"))
}

/// Reads a skin's sound bank back.
pub fn read_sound_bank(skin_dir: &str) -> Result<BTreeMap<String, String>, String> {
    let path = Path::new(skin_dir).join("sounds.yaml");

    let text = fs::read_to_string(&path)
        .map_err(|e| format!("could not read '{}': {e}", path.display()))?;

    let bank: SoundBank = serde_norway::from_str(&text)
        .map_err(|e| format!("could not parse '{}': {e}", path.display()))?;

    // Paths are stored relative to the skin so a package can be moved; the caller wants
    // something it can open.
    Ok(bank
        .sounds
        .into_iter()
        .map(|(name, relative)| {
            (
                name,
                Path::new(skin_dir).join(relative).to_string_lossy().into_owned(),
            )
        })
        .collect())
}
