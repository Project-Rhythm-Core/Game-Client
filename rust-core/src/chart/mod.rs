//! Charts: the format the game plays, and the importers that produce it.
//!
//! - [`model`] is the format itself.
//! - [`validate`] enforces the invariants the runtime relies on.
//! - [`osu`] converts osu!mania charts into it.
//!
//! Conversion happens at import time. The runtime never sees a source format, which is
//! what keeps gameplay free of per-format special cases as more importers are added.
//!
//! Which importer runs is decided here, from the file's own extension, so that callers
//! ask for "a chart" rather than for "an osu chart". Adding BMS is a new module plus a
//! row in [`IMPORTERS`]; nothing above this line changes.

pub mod model;
pub mod osu;
pub mod validate;

pub use model::Chart;

use std::path::Path;

/// A source format the game can import.
pub struct ChartImporter {
    /// What `origin.format` will read once imported.
    pub format: &'static str,
    /// Extensions that identify it, lowercase and without the dot.
    pub extensions: &'static [&'static str],
    /// Converts the file at `source` and writes the result to `output` as JSON.
    pub convert: fn(&str, &str) -> Result<Chart, String>,
}

/// Every importer, in the order extensions are matched.
///
/// BMS lands here as `&["bms", "bme", "bml", "pms"]` alongside its own module.
pub const IMPORTERS: &[ChartImporter] = &[ChartImporter {
    format: "osu",
    extensions: &["osu"],
    convert: osu::convert_to_json_file,
}];

/// Extensions any importer accepts, for a caller scanning a folder.
pub fn supported_extensions() -> Vec<String> {
    IMPORTERS
        .iter()
        .flat_map(|importer| importer.extensions.iter().map(|e| (*e).to_string()))
        .collect()
}

/// The importer that claims `path`, by extension.
pub fn importer_for(path: &str) -> Option<&'static ChartImporter> {
    let extension = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())?
        .to_lowercase();

    IMPORTERS
        .iter()
        .find(|importer| importer.extensions.contains(&extension.as_str()))
}

/// Converts a source chart of any supported format and writes it to `output_path`.
///
/// Refusing an unknown extension by name is deliberate: a caller that reached here with a
/// file nobody parses should hear which formats exist, not get a parse error from whatever
/// importer happened to be tried first.
pub fn convert_to_json_file(source_path: &str, output_path: &str) -> Result<Chart, String> {
    match importer_for(source_path) {
        Some(importer) => (importer.convert)(source_path, output_path),
        None => Err(format!(
            "no importer handles '{source_path}'; this build reads {}",
            supported_extensions().join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_extension_is_matched_whatever_case_it_is_written_in() {
        assert_eq!(importer_for("a/b/Song.OSU").map(|i| i.format), Some("osu"));
        assert_eq!(importer_for("a/b/song.osu").map(|i| i.format), Some("osu"));
    }

    #[test]
    fn an_unknown_format_is_refused_by_name_rather_than_guessed_at() {
        let error = convert_to_json_file("song.bms", "out.json").unwrap_err();

        assert!(error.contains("song.bms"), "{error}");
        assert!(error.contains("osu"), "it should say what it does read: {error}");
    }

    #[test]
    fn every_importer_claims_at_least_one_extension() {
        for importer in IMPORTERS {
            assert!(!importer.extensions.is_empty(), "{}", importer.format);
        }
    }
}
