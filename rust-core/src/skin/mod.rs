//! Skins: the format the game reads, and the importers that produce it.
//!
//! Only what transfers is taken from a source skin. osu's positional values are pixels in
//! its own fixed-resolution stage, so importing them would drag its geometry into a
//! renderer that works differently — and it is that geometry, not anything in the skin
//! data, that produces effects like a long note appearing to end early.
//!
//! - [`model`] is the package format.
//! - [`package`] reads one back, whatever produced it.
//! - [`osu`] converts an osu skin folder into one.
//!
//! Which importer runs is decided here rather than by the caller. A source skin does not
//! announce its format, so each importer says how to recognise its own: osu skins carry a
//! `skin.ini`, LR2 skins carry `.lr2skin` files. Adding one is a module plus a row in
//! [`IMPORTERS`].

pub mod model;
pub mod osu;
pub mod package;

use std::path::Path;

use osu::ImportedSkin;

/// A source skin format the game can import.
pub struct SkinImporter {
    /// The name its theme is stored under, and what a caller asks [`package::read_theme_json`] for.
    pub format: &'static str,
    /// Whether this importer recognises the folder as its own.
    pub claims: fn(&Path) -> bool,
    /// Converts the skin at `source` into a package at `output`.
    pub import: fn(&str, &str) -> Result<ImportedSkin, String>,
}

/// Every importer, in the order a folder is offered to them.
pub const IMPORTERS: &[SkinImporter] = &[SkinImporter {
    format: osu::FORMAT,
    claims: claims_osu,
    import: osu::import,
}];

/// An osu skin is the one with a `skin.ini`.
///
/// Not every osu skin has one — some ship only sounds and textures under conventional
/// names — so this is deliberately the *last* thing that would rule the folder out rather
/// than a strict test. With one importer it never matters; with two it decides.
fn claims_osu(dir: &Path) -> bool {
    dir.join("skin.ini").is_file()
}

/// The importer that recognises `dir`, if any.
pub fn importer_for(dir: &str) -> Option<&'static SkinImporter> {
    let path = Path::new(dir);
    IMPORTERS.iter().find(|importer| (importer.claims)(path))
}

/// Imports a source skin of any recognised format into a package at `output_dir`.
pub fn import(source_dir: &str, output_dir: &str) -> Result<ImportedSkin, String> {
    let path = Path::new(source_dir);

    if !path.is_dir() {
        return Err(format!("'{source_dir}' is not a folder"));
    }

    match importer_for(source_dir) {
        Some(importer) => (importer.import)(source_dir, output_dir),
        None => Err(format!(
            "nothing in '{source_dir}' identifies it as a skin this build reads ({})",
            IMPORTERS
                .iter()
                .map(|i| i.format)
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_with_no_skin_of_any_kind_is_refused_by_name() {
        let dir = std::env::temp_dir().join(format!("rc-skin-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let error = import(dir.to_str().unwrap(), "/tmp/out").unwrap_err();

        assert!(error.contains("osu"), "it should say what it does read: {error}");
    }

    #[test]
    fn a_folder_that_does_not_exist_is_refused_before_any_importer_is_tried() {
        let error = import("/definitely/not/here", "/tmp/out").unwrap_err();
        assert!(error.contains("not a folder"), "{error}");
    }
}
