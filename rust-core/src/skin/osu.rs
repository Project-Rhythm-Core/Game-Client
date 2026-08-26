//! osu skin importer.
//!
//! Takes a skin folder as osu lays it out and produces the game's own package. Only the
//! parts that transfer are taken: sounds, and later textures. Positional values are
//! deliberately left behind — `ColumnStart: 136` and `HitPosition: 402` are pixels in
//! osu's fixed 640x480 stage, and importing them would drag its geometry into a renderer
//! that lays out responsively.
//!
//! Real skins are far messier than the format suggests, and every allowance below is
//! there because a skin in the reference set needs it.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::model::{
    ColumnStyle, FORMAT_VERSION, Layout, SkinManifest, SkinOrigin, SkinProvides, SoundBank, Stage,
    Theme,
};

/// Sample sets a chart can name.
const SAMPLE_SETS: [&str; 3] = ["normal", "soft", "drum"];

/// Sounds within a set.
const SOUND_NAMES: [&str; 4] = ["hitnormal", "hitwhistle", "hitfinish", "hitclap"];

/// Extensions osu accepts for a sound, in the order it tries them.
const SOUND_EXTENSIONS: [&str; 3] = ["wav", "ogg", "mp3"];

/// What an import produced.
pub struct ImportedSkin {
    pub id: String,
    pub name: String,
    pub author: String,
    pub sound_count: usize,
    pub layout_count: usize,
    pub texture_count: usize,
    pub output_dir: PathBuf,
}

/// Converts the osu skin at `source` into a package at `output`.
pub fn import(source: &str, output: &str) -> Result<ImportedSkin, String> {
    let source = Path::new(source);
    let output = Path::new(output);

    if !source.is_dir() {
        return Err(format!("'{}' is not a folder", source.display()));
    }

    let folder = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("skin")
        .to_string();

    let id = slug(&folder);
    let settings = read_general_section(source);

    // A skin need not declare anything about itself: one of the reference skins has no
    // [General] section at all, so the folder name stands in.
    let name = settings
        .get("name")
        .cloned()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| folder.clone());
    let author = settings.get("author").cloned().unwrap_or_default();
    let version = settings.get("version").cloned().unwrap_or_default();

    let sounds_dir = output.join("assets").join("sounds");
    fs::create_dir_all(&sounds_dir)
        .map_err(|e| format!("could not create '{}': {e}", sounds_dir.display()))?;

    let sounds = collect_sounds(source, &sounds_dir)?;

    let manifest = SkinManifest {
        format_version: FORMAT_VERSION,
        id: id.clone(),
        name: name.clone(),
        author: author.clone(),
        version,
        origin: SkinOrigin {
            format: "osu".into(),
            folder,
        },
        provides: SkinProvides {
            sounds: !sounds.is_empty(),
            themes: Vec::new(),
        },
    };

    let theme = build_theme(source, output)?;
    let has_theme = !theme.layouts.is_empty();
    let texture_count = count_textures(&theme);

    if has_theme {
        write_yaml(&output.join("osu.yaml"), &theme)?;
    }

    let manifest = SkinManifest {
        provides: SkinProvides {
            sounds: !sounds.is_empty(),
            themes: if has_theme { vec!["osu".into()] } else { Vec::new() },
        },
        ..manifest
    };

    write_yaml(&output.join("skin.yaml"), &manifest)?;
    write_yaml(&output.join("sounds.yaml"), &SoundBank::new(sounds.clone()))?;

    Ok(ImportedSkin {
        id,
        name,
        author,
        sound_count: sounds.len(),
        layout_count: theme.layouts.len(),
        texture_count,
        output_dir: output.to_path_buf(),
    })
}

fn count_textures(theme: &Theme) -> usize {
    let mut paths: std::collections::BTreeSet<&String> = theme.judgements.values().collect();

    for layout in &theme.layouts {
        for column in &layout.columns {
            for slot in [
                &column.note,
                &column.head,
                &column.body,
                &column.tail,
                &column.key,
                &column.key_pressed,
            ] {
                if let Some(path) = slot {
                    paths.insert(path);
                }
            }
        }
        for slot in [
            &layout.stage.left,
            &layout.stage.right,
            &layout.stage.hint,
            &layout.stage.light,
        ] {
            if let Some(path) = slot {
                paths.insert(path);
            }
        }
    }

    paths.len()
}

/// Builds the visual theme, copying every texture it references into the package.
fn build_theme(source: &Path, output: &Path) -> Result<Theme, String> {
    let sections = read_mania_sections(source);
    if sections.is_empty() {
        return Ok(Theme::new(BTreeMap::new(), Vec::new()));
    }

    let assets_dir = output.join("assets").join("osu");
    fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("could not create '{}': {e}", assets_dir.display()))?;

    // One reference can be used by many columns and many key counts; copy it once.
    let mut copied: BTreeMap<String, String> = BTreeMap::new();
    let mut take = |reference: &str, is_body: bool| -> Option<String> {
        let key = format!("{}|{is_body}", reference.to_lowercase());
        if let Some(existing) = copied.get(&key) {
            return Some(existing.clone());
        }

        let path = resolve_image(source, reference)?;
        let name = slug(reference);
        let stored = copy_texture(&path, &assets_dir, &name, is_body).ok()?;
        copied.insert(key, stored.clone());
        Some(stored)
    };

    let general = read_general_section(source);
    let mut judgements = BTreeMap::new();
    for (osu_name, our_name) in JUDGEMENT_KEYS {
        // Judgement graphics are discovered by filename, not declared.
        let reference = general
            .get(&osu_name.to_lowercase())
            .cloned()
            .unwrap_or_else(|| format!("mania-{osu_name}"));
        if let Some(stored) = take(&reference, false) {
            judgements.insert(our_name.to_string(), stored);
        }
    }

    let mut layouts = Vec::new();
    for section in sections {
        let keys = section.keys as usize;
        if !(1..=18).contains(&keys) {
            continue;
        }

        let weights = width_weights(section.settings.get("columnwidth"), keys);
        let mut columns = Vec::with_capacity(keys);

        for index in 0..keys {
            let get = |suffix: &str| section.settings.get(&format!("noteimage{index}{suffix}"));

            columns.push(ColumnStyle {
                width_weight: weights[index],
                note: get("").and_then(|r| take(r, false)),
                head: get("h").and_then(|r| take(r, false)),
                body: get("l").and_then(|r| take(r, true)),
                tail: get("t").and_then(|r| take(r, false)),
                key: section
                    .settings
                    .get(&format!("keyimage{index}"))
                    .and_then(|r| take(r, false)),
                key_pressed: section
                    .settings
                    .get(&format!("keyimage{index}d"))
                    .and_then(|r| take(r, false)),
                colour: section
                    .settings
                    .get(&format!("colour{}", index + 1))
                    .and_then(|v| parse_colour(v)),
            });
        }

        let stage = Stage {
            left: section.settings.get("stageleft").and_then(|r| take(r, false)),
            right: section.settings.get("stageright").and_then(|r| take(r, false)),
            hint: section.settings.get("stagehint").and_then(|r| take(r, false)),
            light: section.settings.get("stagelight").and_then(|r| take(r, false)),
        };

        layouts.push(Layout {
            keys: section.keys,
            columns,
            stage,
        });
    }

    layouts.sort_by_key(|layout| layout.keys);
    layouts.dedup_by_key(|layout| layout.keys);

    Ok(Theme::new(judgements, layouts))
}

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

/// Finds every hit sound in the skin and copies it into the package.
///
/// Hit sounds are not declared anywhere: osu discovers them by filename, so this does the
/// same. The match is case-insensitive because skins routinely disagree with their own
/// files about case, and on a case-sensitive filesystem that means the sound simply is
/// not found.
fn collect_sounds(source: &Path, sounds_dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut on_disk: BTreeMap<String, PathBuf> = BTreeMap::new();
    if let Ok(entries) = fs::read_dir(source) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                on_disk.insert(name.to_lowercase(), entry.path());
            }
        }
    }

    let mut sounds = BTreeMap::new();

    for set in SAMPLE_SETS {
        for sound in SOUND_NAMES {
            // Index 1 is written as nothing at all, which is why the empty string leads.
            for index in ["", "2", "3", "4", "5", "6", "7", "8", "9"] {
                let canonical = format!("{set}-{sound}{index}");

                for extension in SOUND_EXTENSIONS {
                    let file = format!("{canonical}.{extension}");
                    let Some(path) = on_disk.get(&file) else {
                        continue;
                    };

                    // Copied under the canonical name, so the package is consistent even
                    // when the source was not.
                    let target = sounds_dir.join(&file);
                    fs::copy(path, &target)
                        .map_err(|e| format!("could not copy '{}': {e}", path.display()))?;

                    sounds.insert(canonical.clone(), format!("assets/sounds/{file}"));
                    break;
                }
            }
        }
    }

    Ok(sounds)
}

/// Reads `[General]` as lowercase keys, tolerating everything real skins do.
fn read_general_section(source: &Path) -> BTreeMap<String, String> {
    let mut settings = BTreeMap::new();

    let Ok(text) = fs::read_to_string(source.join("skin.ini")) else {
        return settings;
    };

    let mut in_general = false;
    for raw in text.trim_start_matches('\u{feff}').lines() {
        // Keys are routinely indented, which is enough to defeat a naive line match.
        let line = raw.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }

        if line.starts_with('[') {
            in_general = line.eq_ignore_ascii_case("[General]");
            continue;
        }

        if !in_general {
            continue;
        }

        if let Some((key, value)) = line.split_once(':') {
            settings.insert(key.trim().to_lowercase(), value.trim().to_string());
        }
    }

    settings
}

fn write_yaml<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("could not create '{}': {e}", parent.display()))?;
    }

    let text = serde_norway::to_string(value)
        .map_err(|e| format!("could not serialise '{}': {e}", path.display()))?;

    fs::write(path, text).map_err(|e| format!("could not write '{}': {e}", path.display()))
}

/// Lowercase, alphanumerics and dashes. Used as the package's directory name and id.
fn slug(text: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;

    for ch in text.chars() {
        if ch.is_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.extend(ch.to_lowercase());
        } else {
            pending_dash = true;
        }
    }

    if out.is_empty() { "skin".into() } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rc-skin-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn identity_falls_back_to_the_folder_when_general_is_absent() {
        // One reference skin has no [General] section at all.
        let source = temp("noheader").join("# boj - pl0x Circles");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("skin.ini"), "[Mania]\n    Keys: 4\n").unwrap();
        let out = temp("noheader-out");

        let skin = import(source.to_str().unwrap(), out.to_str().unwrap()).unwrap();

        assert_eq!(skin.name, "# boj - pl0x Circles");
        assert_eq!(skin.id, "boj-pl0x-circles");
        assert_eq!(skin.author, "");
    }

    #[test]
    fn indented_keys_are_read() {
        let source = temp("indent").join("s");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("skin.ini"),
            "[General]\n    Name: Spaced\n    Author: Someone\n",
        )
        .unwrap();
        let out = temp("indent-out");

        let skin = import(source.to_str().unwrap(), out.to_str().unwrap()).unwrap();

        assert_eq!(skin.name, "Spaced");
        assert_eq!(skin.author, "Someone");
    }

    #[test]
    fn sounds_are_found_whatever_case_they_are_stored_in() {
        let source = temp("case").join("s");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("skin.ini"), "[General]\nName: Case\n").unwrap();
        // osu runs case-insensitively; skins are written accordingly.
        fs::write(source.join("Normal-HitNormal.WAV"), b"riff").unwrap();
        fs::write(source.join("soft-hitclap2.ogg"), b"oggs").unwrap();
        let out = temp("case-out");

        let skin = import(source.to_str().unwrap(), out.to_str().unwrap()).unwrap();
        assert_eq!(skin.sound_count, 2);

        let bank = read_sound_bank(out.to_str().unwrap()).unwrap();
        assert!(bank.contains_key("normal-hitnormal"), "got {:?}", bank.keys());
        assert!(bank.contains_key("soft-hitclap2"));

        // Copied under the canonical name, so the package is consistent regardless.
        assert!(out.join("assets/sounds/normal-hitnormal.wav").is_file());
    }

    /// A real body image: an empty percy margin, then a fade, then the steady pattern.
    fn percy_body(height: u32, clear: u32, fade: u32) -> image::DynamicImage {
        use image::{Rgba, RgbaImage};

        let mut source = RgbaImage::new(4, height);
        for y in 0..height {
            let alpha = if y < clear {
                0
            } else if y < clear + fade {
                ((y - clear) * 255 / fade) as u8
            } else {
                255
            };
            for x in 0..4 {
                source.put_pixel(x, y, Rgba([10, 20, 30, alpha]));
            }
        }

        image::DynamicImage::ImageRgba8(source)
    }

    #[test]
    fn a_hold_body_keeps_none_of_its_lead_in() {
        let strip = body_strip(&percy_body(2000, 120, 95)).expect("cropped");

        assert!(strip.height() <= MAX_BODY_HEIGHT, "must fit on a GPU");

        // Neither the empty margin nor the fade survives: every row is the steady
        // pattern, so tiling it cannot band the note.
        let rgba = strip.to_rgba8();
        for y in 0..strip.height() {
            assert_eq!(rgba.get_pixel(0, y).0[3], 255, "row {y} should be fully opaque");
        }
    }

    #[test]
    fn the_strip_comes_from_the_bottom_where_the_pattern_is_steady() {
        use image::{Rgba, RgbaImage};

        // Distinct rows, so where the strip was taken from is visible in the result.
        let mut source = RgbaImage::new(1, 1000);
        for y in 0..1000 {
            source.put_pixel(0, y, Rgba([(y % 251) as u8, 0, 0, 255]));
        }

        let strip = body_strip(&image::DynamicImage::ImageRgba8(source)).expect("cropped");
        let rgba = strip.to_rgba8();

        assert_eq!(strip.height(), MAX_BODY_HEIGHT);
        assert_eq!(rgba.get_pixel(0, strip.height() - 1).0[0], (999 % 251) as u8);
    }

    #[test]
    fn a_body_that_is_already_reasonable_is_left_alone() {
        use image::{Rgba, RgbaImage};

        let mut source = RgbaImage::new(4, 64);
        for y in 0..64 {
            for x in 0..4 {
                source.put_pixel(x, y, Rgba([1, 2, 3, 255]));
            }
        }

        assert!(
            body_strip(&image::DynamicImage::ImageRgba8(source)).is_none(),
            "no margin and small enough: copy it untouched",
        );
    }

    #[test]
    fn a_fully_transparent_body_is_not_cropped_into_nothing() {
        use image::RgbaImage;

        let source = RgbaImage::new(4, 500);
        assert!(body_strip(&image::DynamicImage::ImageRgba8(source)).is_none());
    }

    #[test]
    fn a_skin_with_no_sounds_still_imports() {
        let source = temp("nosound").join("s");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("skin.ini"), "[General]\nName: Silent\n").unwrap();
        let out = temp("nosound-out");

        let skin = import(source.to_str().unwrap(), out.to_str().unwrap()).unwrap();

        assert_eq!(skin.sound_count, 0);
        assert!(out.join("skin.yaml").is_file());
        assert_eq!(read_sound_bank(out.to_str().unwrap()).unwrap().len(), 0);
    }

    #[test]
    fn the_written_package_round_trips() {
        let source = temp("round").join("s");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("skin.ini"), "[General]\nName: Round\nAuthor: A\n").unwrap();
        fs::write(source.join("drum-hitfinish.wav"), b"x").unwrap();
        let out = temp("round-out");

        import(source.to_str().unwrap(), out.to_str().unwrap()).unwrap();

        let yaml = fs::read_to_string(out.join("sounds.yaml")).unwrap();
        assert!(yaml.contains("drum-hitfinish"), "got:\n{yaml}");

        let bank = read_sound_bank(out.to_str().unwrap()).unwrap();
        assert!(bank["drum-hitfinish"].ends_with("assets/sounds/drum-hitfinish.wav"));
    }
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

/// Longest a hold-body strip is kept, in pixels.
///
/// Source bodies are absurdly tall — 20 000 px is typical, 40 000 happens — and that is
/// not an accident of authoring. It is how a "percy" body works: the top of the image is
/// left transparent, and stretched down the length of a note that sliver becomes a
/// visible gap, so the note looks shorter than it is while still ending where it ends.
///
/// Two reasons that cannot come across as-is. 20 000 exceeds the maximum texture
/// dimension of every common GPU, so it would not upload at all; and this format should
/// describe a hold body, not bake one skin's visual trick into every note drawn with it.
/// If percy is wanted later it belongs in the renderer, where it can be turned off.
const MAX_BODY_HEIGHT: u32 = 256;

/// Alpha above which a row counts as visible, out of 255.
const VISIBLE_ALPHA: u8 = 8;

/// Extensions to try for an image reference, which skins routinely write without one.
const IMAGE_EXTENSIONS: [&str; 3] = ["png", "jpg", "jpeg"];

/// Judgement image keys, paired with the game's own judgement names.
const JUDGEMENT_KEYS: [(&str, &str); 6] = [
    ("hit300g", "perfect"),
    ("hit300", "great"),
    ("hit200", "good"),
    ("hit100", "ok"),
    ("hit50", "meh"),
    ("hit0", "miss"),
];

/// One `[Mania]` block, as key-value pairs with its key count.
struct ManiaSection {
    keys: u32,
    settings: BTreeMap<String, String>,
}

/// Splits `skin.ini` into its `[Mania]` sections.
///
/// Tolerant by necessity: keys are routinely indented, and a prefix match would confuse
/// `KeysUnderNotes` for `Keys`. Sections appear in whatever order the author left them.
fn read_mania_sections(source: &Path) -> Vec<ManiaSection> {
    let Ok(text) = fs::read_to_string(source.join("skin.ini")) else {
        return Vec::new();
    };

    let mut sections = Vec::new();
    let mut current: Option<BTreeMap<String, String>> = None;

    let finish = |current: Option<BTreeMap<String, String>>, out: &mut Vec<ManiaSection>| {
        let Some(settings) = current else { return };
        let Some(keys) = settings.get("keys").and_then(|k| k.parse::<u32>().ok()) else {
            return;
        };
        out.push(ManiaSection { keys, settings });
    };

    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }

        if line.starts_with('[') {
            finish(current.take(), &mut sections);
            if line.eq_ignore_ascii_case("[Mania]") {
                current = Some(BTreeMap::new());
            }
            continue;
        }

        if let (Some(settings), Some((key, value))) = (current.as_mut(), line.split_once(':')) {
            settings.insert(key.trim().to_lowercase(), value.trim().to_string());
        }
    }

    finish(current, &mut sections);
    sections
}

/// Resolves an image reference against the skin folder.
///
/// Skins write references with Windows separators, through subdirectories, without an
/// extension, and in whatever case they please. All four happen in the reference set, and
/// on a case-sensitive filesystem each one silently resolves to nothing.
fn resolve_image(source: &Path, reference: &str) -> Option<PathBuf> {
    let normalised = reference.replace('\\', "/");
    let normalised = normalised.trim().trim_start_matches("./");

    let (dir, stem) = match normalised.rsplit_once('/') {
        Some((dir, stem)) => (source.join(dir), stem.to_string()),
        None => (source.to_path_buf(), normalised.to_string()),
    };

    let mut index: BTreeMap<String, PathBuf> = BTreeMap::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                index.insert(name.to_lowercase(), entry.path());
            }
        }
    }

    let stem = stem.to_lowercase();

    // A skin shipping an @2x variant is shipping its better artwork; take that.
    for extension in IMAGE_EXTENSIONS {
        for candidate in [format!("{stem}@2x.{extension}"), format!("{stem}.{extension}")] {
            if let Some(path) = index.get(&candidate) {
                return Some(path.clone());
            }
        }
    }

    index.get(&stem).cloned()
}

/// Copies one texture into the package, cropping a hold body down to a tileable strip.
///
/// Returns the path to record in the theme, relative to the skin folder.
fn copy_texture(
    source_path: &Path,
    assets_dir: &Path,
    name: &str,
    is_body: bool,
) -> Result<String, String> {
    let extension = source_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();

    let file_name = format!("{name}.{extension}");
    let target = assets_dir.join(&file_name);

    if is_body {
        if let Ok(image) = image::open(source_path) {
            if let Some(strip) = body_strip(&image) {
                // Always PNG once re-encoded: the source may be a JPEG, and a body needs
                // its alpha channel.
                let png_name = format!("{name}.png");
                strip
                    .save(assets_dir.join(&png_name))
                    .map_err(|e| format!("could not write '{png_name}': {e}"))?;
                return Ok(format!("assets/osu/{png_name}"));
            }
        }
    }

    fs::copy(source_path, &target)
        .map_err(|e| format!("could not copy '{}': {e}", source_path.display()))?;

    Ok(format!("assets/osu/{file_name}"))
}

/// Reduces a hold body to a short strip that tiles cleanly.
///
/// The strip is taken from the **bottom** of the image, and that is the whole trick.
/// Everything a body image does at its top is a lead-in: the transparent margin of a
/// percy body, and the fade that usually follows it. The bottom is the steady pattern the
/// body is actually made of, which is what a well-behaved skin ships on its own — dpjam's
/// `WhiteL.jpg` is 44x3 pixels of flat colour and nothing else.
///
/// Taking the top instead ruins the result twice over. It keeps the percy gap, and worse,
/// it captures the fade — which then repeats on every tile and bands the whole note.
///
/// Returns `None` when the image is already short enough to use untouched.
fn body_strip(image: &image::DynamicImage) -> Option<image::DynamicImage> {
    use image::GenericImageView;

    let (width, height) = image.dimensions();
    let rgba = image.to_rgba8();

    let row_is_visible =
        |y: u32| (0..width).any(|x| rgba.get_pixel(x, y).0[3] > VISIBLE_ALPHA);

    // A transparent bottom margin would tile as a gap, so it goes too.
    let last = (0..height).rev().find(|y| row_is_visible(*y))?;
    let first = (0..=last).find(|y| row_is_visible(*y))?;

    let visible = last - first + 1;
    if visible <= MAX_BODY_HEIGHT && first == 0 && last == height - 1 {
        return None;
    }

    let kept = visible.min(MAX_BODY_HEIGHT);
    Some(image.crop_imm(0, last + 1 - kept, width, kept))
}

/// Turns `r,g,b[,a]` into `#rrggbbaa`.
fn parse_colour(value: &str) -> Option<String> {
    let parts: Vec<u8> = value
        .split(',')
        .filter_map(|p| p.trim().parse::<u8>().ok())
        .collect();

    match parts.len() {
        3 => Some(format!("#{:02x}{:02x}{:02x}ff", parts[0], parts[1], parts[2])),
        4 => Some(format!(
            "#{:02x}{:02x}{:02x}{:02x}",
            parts[0], parts[1], parts[2], parts[3]
        )),
        _ => None,
    }
}

/// Comma-separated widths, normalised so the mean lane is `1.0`.
fn width_weights(value: Option<&String>, keys: usize) -> Vec<f64> {
    let widths: Vec<f64> = value
        .map(|v| v.split(',').filter_map(|p| p.trim().parse::<f64>().ok()).collect())
        .unwrap_or_default();

    if widths.is_empty() {
        return vec![1.0; keys];
    }

    let mean = widths.iter().sum::<f64>() / widths.len() as f64;
    if mean <= 0.0 {
        return vec![1.0; keys];
    }

    (0..keys)
        .map(|i| ((widths.get(i).copied().unwrap_or(mean) / mean) * 1000.0).round() / 1000.0)
        .collect()
}
