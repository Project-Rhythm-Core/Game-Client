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
    ColumnStyle, FORMAT_VERSION, Fonts, Layout, SkinManifest, SkinOrigin, SkinProvides, SoundBank,
    Stage, TEXTURE_SPACE_HEIGHT, Theme, VIRTUAL_HEIGHT,
};

/// The name this importer's theme is stored under, and what a caller asks for it by.
pub const FORMAT: &str = "osu";

/// Sample sets a chart can name.
const SAMPLE_SETS: [&str; 3] = ["normal", "soft", "drum"];

/// Sounds within a set.
const SOUND_NAMES: [&str; 4] = ["hitnormal", "hitwhistle", "hitfinish", "hitclap"];

/// Extensions osu accepts for a sound, in the order it tries them.
const SOUND_EXTENSIONS: [&str; 3] = ["wav", "ogg", "mp3"];

/// What an import produced.
#[derive(Debug)]
pub struct ImportedSkin {
    pub id: String,
    pub name: String,
    pub author: String,
    pub sound_count: usize,
    pub layout_count: usize,
    pub texture_count: usize,
    /// Formats this skin ended up with a theme for. Empty when it provides only sounds.
    pub themes: Vec<String>,
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
            themes: if has_theme { vec![FORMAT.into()] } else { Vec::new() },
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
        themes: manifest.provides.themes.clone(),
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
        return Ok(Theme::new(BTreeMap::new(), Vec::new(), Fonts::default()));
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

    // Bitmap digits, for counters the skin would rather draw than have written in text.
    let fonts_section = read_named_section(source, "[Fonts]");
    let combo_prefix = fonts_section
        .get("comboprefix")
        .cloned()
        .unwrap_or_else(|| "combo".to_string());
    let combo: Vec<String> = (0..=9)
        .map(|digit| take(&format!("{combo_prefix}-{digit}"), false))
        .collect::<Option<Vec<_>>>()
        .unwrap_or_default();
    let fonts = Fonts {
        combo,
        // Stated in texture pixels like every other measurement in the file.
        combo_overlap: fonts_section
            .get("combooverlap")
            .and_then(|v| v.trim().parse::<f64>().ok())
            .unwrap_or(0.0)
            * VIRTUAL_HEIGHT
            / TEXTURE_SPACE_HEIGHT,
    };

    let mut layouts = Vec::new();
    for section in sections {
        let keys = section.keys as usize;
        if !(1..=18).contains(&keys) {
            continue;
        }

        let widths = numbers(section.settings.get("columnwidth"), keys, DEFAULT_COLUMN_WIDTH);
        // One more line than there are columns: the edges count.
        let line_widths = numbers(section.settings.get("columnlinewidth"), keys + 1, 0.0);
        let hit_position = section
            .settings
            .get("hitposition")
            .and_then(|v| v.trim().parse::<f64>().ok())
            .unwrap_or(DEFAULT_HIT_POSITION);

        let mut columns = Vec::with_capacity(keys);

        for index in 0..keys {
            // Declared images win; otherwise the conventional name for this column.
            let default_stem = default_note_image(index, keys);
            let get = |suffix: &str| -> String {
                section
                    .settings
                    .get(&format!("noteimage{index}{suffix}"))
                    .cloned()
                    .unwrap_or_else(|| format!("{default_stem}{}", suffix.to_uppercase()))
            };

            // osu falls back down a chain rather than leaving a piece undrawn: a missing
            // head becomes the plain note, and a missing tail becomes the head, then the
            // note. Skins lean on this — the reference o2jam skin ships no tail at all.
            let key_reference = section
                .settings
                .get(&format!("keyimage{index}"))
                .cloned()
                .unwrap_or_else(|| format!("mania-key{}", key_image_index(index, keys)));

            let note = take(&get(""), false);
            let head = take(&get("h"), false).or_else(|| note.clone());
            let declared_tail = take(&get("t"), false);
            let tail_flipped = declared_tail.is_none();
            let tail = declared_tail.or_else(|| head.clone());

            columns.push(ColumnStyle {
                width: widths[index],
                note,
                head,
                body: take(&get("l"), true),
                tail,
                tail_flipped,
                key: take(&key_reference, false),
                key_height: virtual_height(source, &key_reference),
                key_pressed: take(
                    section
                        .settings
                        .get(&format!("keyimage{index}d"))
                        .map(String::as_str)
                        .unwrap_or(&format!("mania-key{}D", key_image_index(index, keys))),
                    false,
                ),
                colour: section
                    .settings
                    .get(&format!("colour{}", index + 1))
                    .and_then(|v| parse_colour(v)),
            });
        }

        // Stage pieces are conventional too: skins ship `mania-stage-hint` and never
        // mention it. Leaving them out is what left the judgement line as a bare stroke.
        let stage_reference = |key: &str, default: &str| -> String {
            section.settings.get(key).cloned().unwrap_or_else(|| default.to_string())
        };
        let hint_reference = stage_reference("stagehint", "mania-stage-hint");

        let stage = Stage {
            left: take(&stage_reference("stageleft", "mania-stage-left"), false),
            right: take(&stage_reference("stageright", "mania-stage-right"), false),
            hint: take(&hint_reference, false),
            hint_height: virtual_height(source, &hint_reference).map(|h| h * HIT_TARGET_STRETCH),
            light: take(&stage_reference("stagelight", "mania-stage-light"), false),
        };

        layouts.push(Layout {
            keys: section.keys,
            hit_position,
            line_widths,
            columns,
            combo_position: section
                .settings
                .get("comboposition")
                .and_then(|v| v.trim().parse::<f64>().ok())
                .unwrap_or(DEFAULT_COMBO_POSITION),
            score_position: section
                .settings
                .get("scoreposition")
                .and_then(|v| v.trim().parse::<f64>().ok())
                .unwrap_or(DEFAULT_SCORE_POSITION),
            keys_under_notes: flag(section.settings.get("keysundernotes"), false),
            judgement_line: flag(section.settings.get("judgementline"), true),
            stage,
        });
    }

    layouts.sort_by_key(|layout| layout.keys);
    layouts.dedup_by_key(|layout| layout.keys);

    Ok(Theme::new(judgements, layouts, fonts))
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
    read_named_section(source, "[General]")
}

/// Reads one named top-level section of `skin.ini`.
fn read_named_section(source: &Path, wanted: &str) -> BTreeMap<String, String> {
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
            in_general = line.eq_ignore_ascii_case(wanted);
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
pub fn slug(text: &str) -> String {
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
    fn a_subfolder_resolves_however_the_skin_capitalises_it() {
        // The reference Nabos skin writes `4K\\1` for its notes and `4k\\keyL` for its
        // hold bodies in the same file. Windows cannot tell the two apart; Linux can.
        let source = temp("dircase").join("s");
        fs::create_dir_all(source.join("4K")).unwrap();
        image::RgbaImage::new(4, 4).save(source.join("4K").join("note.png")).unwrap();

        for reference in ["4K/note", "4k/note", "4K\\note", "4k\\NOTE"] {
            assert!(
                resolve_image(&source, reference).is_some(),
                "'{reference}' should resolve"
            );
        }

        assert!(resolve_image(&source, "5K/note").is_none());
        assert!(resolve_image(&source, "4K/missing").is_none());
    }

    #[test]
    fn a_texture_the_browser_cannot_decode_is_not_packaged_as_is() {
        // A file whose extension lies: shipping it would fail at play time, where it
        // reads as a renderer bug rather than as this skin being malformed.
        let source = temp("liar").join("s");
        fs::create_dir_all(&source).unwrap();
        let path = source.join("body.png");
        image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 255]))
            .save_with_format(&path, image::ImageFormat::Tiff)
            .unwrap();

        let assets = temp("liar-out");
        let stored = copy_texture(&path, &assets, "body", false).unwrap();

        // Re-encoded under a `.png` name, and genuinely a PNG this time.
        assert_eq!(stored, "assets/osu/body.png");
        assert_eq!(
            guessed_format(&assets.join("body.png")),
            Some(image::ImageFormat::Png)
        );
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

        let bank = crate::skin::package::read_sound_bank(out.to_str().unwrap()).unwrap();
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
        assert_eq!(crate::skin::package::read_sound_bank(out.to_str().unwrap()).unwrap().len(), 0);
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

        let bank = crate::skin::package::read_sound_bank(out.to_str().unwrap()).unwrap();
        assert!(bank["drum-hitfinish"].ends_with("assets/sounds/drum-hitfinish.wav"));
    }

    #[test]
    fn columns_take_the_conventional_names_when_the_skin_declares_none() {
        // The middle of an odd stage is special; the rest alternate outward from the edges.
        assert_eq!(
            (0..4).map(|c| default_note_image(c, 4)).collect::<Vec<_>>(),
            ["mania-note1", "mania-note2", "mania-note2", "mania-note1"]
        );
        assert_eq!(
            (0..7).map(|c| default_note_image(c, 7)).collect::<Vec<_>>(),
            [
                "mania-note1",
                "mania-note2",
                "mania-note1",
                "mania-noteS",
                "mania-note1",
                "mania-note2",
                "mania-note1"
            ]
        );
        // An even stage has no special column however wide its outer lane is drawn.
        assert!(!(0..8).any(|c| default_note_image(c, 8) == "mania-noteS"));
    }

    #[test]
    fn an_animated_image_resolves_to_its_first_frame() {
        let folder = temp("animated");
        fs::write(folder.join("mania-note1L-0.png"), []).unwrap();

        assert_eq!(
            resolve_image(&folder, "mania-note1L").unwrap().file_name().unwrap(),
            "mania-note1L-0.png"
        );
    }

    #[test]
    fn a_still_image_is_preferred_over_an_animation_of_the_same_name() {
        let folder = temp("still-over-animated");
        fs::write(folder.join("mania-note1L.png"), []).unwrap();
        fs::write(folder.join("mania-note1L-0.png"), []).unwrap();

        assert_eq!(
            resolve_image(&folder, "mania-note1L").unwrap().file_name().unwrap(),
            "mania-note1L.png"
        );
    }

    #[test]
    fn a_texture_is_measured_in_the_space_it_was_authored_for() {
        let folder = temp("virtual-height");
        // 154 pixels of a 768-unit stage is 96.25 of a 480-unit one, which is what makes
        // the reference skin's receptor reach exactly from its hit position to the foot.
        image::RgbaImage::new(75, 154).save(folder.join("mania-key1.png")).unwrap();
        assert_eq!(virtual_height(&folder, "mania-key1"), Some(96.25));

        // A @2x variant is the same artwork at twice the resolution, not twice the size.
        image::RgbaImage::new(150, 308).save(folder.join("mania-key2@2x.png")).unwrap();
        assert_eq!(virtual_height(&folder, "mania-key2"), Some(96.25));
    }

    #[test]
    fn stage_pieces_are_found_without_being_declared() {
        let source = temp("stage-defaults");
        fs::write(source.join("skin.ini"), "[Mania]\nKeys: 4\n").unwrap();
        image::RgbaImage::new(210, 25).save(source.join("mania-stage-hint.png")).unwrap();

        let output = temp("stage-defaults-out");
        import(source.to_str().unwrap(), output.to_str().unwrap()).unwrap();

        let theme: Theme =
            serde_norway::from_str(&fs::read_to_string(output.join("osu.yaml")).unwrap()).unwrap();
        let stage = &theme.layouts[0].stage;

        assert!(stage.hint.is_some(), "a skin that ships a judgement line but never names it");
        assert!(stage.hint_height.unwrap() > 0.0);
    }

    #[test]
    fn a_combo_font_needs_all_ten_digits() {
        let source = temp("combo-partial");
        fs::write(source.join("skin.ini"), "[Mania]\nKeys: 4\n").unwrap();
        for digit in 0..9 {
            image::RgbaImage::new(30, 40)
                .save(source.join(format!("combo-{digit}.png")))
                .unwrap();
        }

        let output = temp("combo-partial-out");
        import(source.to_str().unwrap(), output.to_str().unwrap()).unwrap();
        let theme: Theme =
            serde_norway::from_str(&fs::read_to_string(output.join("osu.yaml")).unwrap()).unwrap();

        assert!(theme.fonts.combo.is_empty(), "nine digits cannot draw every number");

        image::RgbaImage::new(30, 40).save(source.join("combo-9.png")).unwrap();
        let output = temp("combo-full-out");
        import(source.to_str().unwrap(), output.to_str().unwrap()).unwrap();
        let theme: Theme =
            serde_norway::from_str(&fs::read_to_string(output.join("osu.yaml")).unwrap()).unwrap();

        assert_eq!(theme.fonts.combo.len(), 10);
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

/// The default image a column uses when the skin declares none.
///
/// Skins are not obliged to name their note images: osu falls back to conventional
/// filenames, and a skin that only wants the defaults simply ships them and says nothing.
/// One of the reference skins does exactly that, so without this it imports with no note
/// textures at all.
///
/// Which of the three a column gets follows osu's own rule. The middle column of an odd
/// stage is special; the rest alternate outward from the edges. That the reference skin's
/// own lane widths reproduce this pattern exactly — `121S121` for seven keys — is a
/// useful confirmation it is right.
fn default_note_image(column: usize, keys: usize) -> &'static str {
    if keys % 2 == 1 && column == keys / 2 {
        return "mania-noteS";
    }

    let distance_from_edge = column.min(keys.saturating_sub(1) - column);
    if distance_from_edge % 2 == 0 {
        "mania-note1"
    } else {
        "mania-note2"
    }
}

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
        Some((dir, stem)) => (resolve_dir(source, dir)?, stem.to_string()),
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

    // An animated image has no file under its own name at all, only numbered frames.
    // The reference o2jam skin ships six frames per hold body and nothing else, so
    // without this its long notes resolve to nothing. Only the first frame is taken:
    // the format has no way to describe an animation yet, and a still body is very much
    // better than an invisible one.
    for extension in IMAGE_EXTENSIONS {
        for candidate in [format!("{stem}-0@2x.{extension}"), format!("{stem}-0.{extension}")] {
            if let Some(path) = index.get(&candidate) {
                return Some(path.clone());
            }
        }
    }

    index.get(&stem).cloned()
}

/// Walks a subdirectory path, matching each segment without regard to case.
///
/// The filename lookup below is already case-insensitive, but the directory leading to it
/// was joined verbatim, so a skin that disagrees with itself about a folder's case lost
/// every reference through it. That is not hypothetical: the reference Nabos skin writes
/// `4K\\1` for its notes and `4k\\keyL` for its hold bodies, in the same file. osu never
/// notices because Windows does not, and on Linux the bodies simply vanished.
fn resolve_dir(source: &Path, dir: &str) -> Option<PathBuf> {
    let mut current = source.to_path_buf();

    for segment in dir.split('/').filter(|s| !s.is_empty() && *s != ".") {
        let candidate = current.join(segment);
        if candidate.is_dir() {
            current = candidate;
            continue;
        }

        // Only pay for the listing when the literal name missed.
        let wanted = segment.to_lowercase();
        let matched = fs::read_dir(&current).ok()?.flatten().find(|entry| {
            entry.file_name().to_str().is_some_and(|n| n.to_lowercase() == wanted)
        })?;

        if !matched.path().is_dir() {
            return None;
        }
        current = matched.path();
    }

    Some(current)
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

    // A skin may ship a file whose extension lies about its contents: the reference Nabos
    // skin's hold body is a 22 MB TIFF called `keyL.png`. The renderer hands textures
    // straight to the browser, which decodes by content rather than by name and refuses
    // what it does not recognise, so one of those has to be re-encoded rather than copied.
    let unusable = !guessed_format(source_path).is_some_and(is_web_decodable);

    if is_body || unusable {
        if let Ok(image) = decode_image(source_path) {
            let strip = if is_body { body_strip(&image) } else { None };

            if strip.is_some() || unusable {
                // Always PNG once re-encoded: the source may be a JPEG, and a body needs
                // its alpha channel.
                let png_name = format!("{name}.png");
                strip
                    .as_ref()
                    .unwrap_or(&image)
                    .save(assets_dir.join(&png_name))
                    .map_err(|e| format!("could not write '{png_name}': {e}"))?;
                return Ok(format!("assets/osu/{png_name}"));
            }
        } else if unusable {
            // Copying it anyway would put a texture in the package that fails to load at
            // play time, which reads as a bug in the renderer. Dropping it instead lets
            // the column fall back to flat colour, which is a result the player can see
            // and the importer can report.
            return Err(format!(
                "'{}' is not an image the renderer can decode",
                source_path.display()
            ));
        }
    }

    fs::copy(source_path, &target)
        .map_err(|e| format!("could not copy '{}': {e}", source_path.display()))?;

    Ok(format!("assets/osu/{file_name}"))
}

/// The real format of a file, read from its contents rather than its name.
fn guessed_format(path: &Path) -> Option<image::ImageFormat> {
    reader(path)?.format()
}

/// Decodes an image by what it *is* rather than by what it is called.
///
/// `image::open` picks its decoder from the file extension, so a mislabelled file fails
/// with an error about the format it was never in. Skins mislabel files routinely, which
/// makes reading the magic bytes the only reliable way in.
fn decode_image(path: &Path) -> Result<image::DynamicImage, String> {
    reader(path)
        .ok_or_else(|| format!("could not read '{}'", path.display()))?
        .decode()
        .map_err(|e| format!("could not decode '{}': {e}", path.display()))
}

/// Dimensions of an image, again by content rather than by name.
fn image_dimensions(path: &Path) -> Option<(u32, u32)> {
    reader(path)?.into_dimensions().ok()
}

fn reader(path: &Path) -> Option<image::ImageReader<std::io::BufReader<fs::File>>> {
    image::ImageReader::open(path).ok()?.with_guessed_format().ok()
}

/// Whether a browser can decode this format, which is what the renderer ultimately needs.
fn is_web_decodable(format: image::ImageFormat) -> bool {
    matches!(
        format,
        image::ImageFormat::Png
            | image::ImageFormat::Jpeg
            | image::ImageFormat::Gif
            | image::ImageFormat::WebP
            | image::ImageFormat::Bmp
    )
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

/// Receptor images follow the same three-way split as notes, numbered from one.
fn key_image_index(column: usize, keys: usize) -> &'static str {
    match default_note_image(column, keys) {
        "mania-noteS" => "S",
        "mania-note2" => "2",
        _ => "1",
    }
}

/// How much taller than its own texture osu draws the judgement line graphic.
///
/// A constant with no explanation in osu either — `0.9f * 1.6025f` in `LegacyHitTarget`.
/// The graphic is centred on the hit position rather than resting above or below it.
const HIT_TARGET_STRETCH: f64 = 0.9 * 1.6025;

/// Where the combo counter sits when the skin does not say, in virtual units from the top.
const DEFAULT_COMBO_POSITION: f64 = 111.0;

/// Where the judgement graphic sits when the skin does not say.
///
/// osu reaches the same height by two different routes depending on whether the value is
/// above or below half the hit position, but both land at this many units from the top.
const DEFAULT_SCORE_POSITION: f64 = 300.0;

/// The height a texture is drawn at, in virtual units, before any lane scaling.
///
/// Legacy textures are authored against a 768-unit stage, and a `@2x` variant doubles
/// that again, so the file's own pixel height is never the answer on its own.
fn virtual_height(source: &Path, reference: &str) -> Option<f64> {
    let path = resolve_image(source, reference)?;
    let (_, pixels) = image_dimensions(&path)?;

    let doubled = path
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|stem| stem.to_lowercase().ends_with("@2x"));

    let authored = f64::from(pixels) / if doubled { 2.0 } else { 1.0 };
    Some(authored * VIRTUAL_HEIGHT / TEXTURE_SPACE_HEIGHT)
}

/// Reads an on/off setting, which skins write as `1`/`0` and occasionally as a word.
fn flag(value: Option<&String>, default: bool) -> bool {
    match value.map(|v| v.trim().to_lowercase()) {
        Some(text) => text == "1" || text == "true",
        None => default,
    }
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

/// osu's own defaults, for the settings a skin leaves out.
const DEFAULT_COLUMN_WIDTH: f64 = 30.0;
const DEFAULT_HIT_POSITION: f64 = 402.0;

/// Reads a comma-separated list of numbers, padded to `count`.
///
/// Short lists are normal: a skin may give one width for a layout with several columns,
/// and repeating the last value is what osu does rather than refusing the section.
fn numbers(value: Option<&String>, count: usize, fallback: f64) -> Vec<f64> {
    let parsed: Vec<f64> = value
        .map(|v| v.split(',').filter_map(|p| p.trim().parse::<f64>().ok()).collect())
        .unwrap_or_default();

    let last = parsed.last().copied().unwrap_or(fallback);
    (0..count)
        .map(|i| parsed.get(i).copied().unwrap_or(last))
        .collect()
}
