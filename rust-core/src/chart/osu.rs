//! osu!mania importer.
//!
//! `.osu` is an INI-like text format: `[Section]` headers over either `Key: Value` lines
//! or comma-separated records. Files are CRLF, may carry a UTF-8 BOM, and any section
//! can be absent, so parsing stays tolerant and only the fields the game needs are
//! required.

use std::collections::BTreeMap;
use std::path::Path;

use super::model::*;
use super::validate;

/// `Mode: 3`. Anything else is not a vertically scrolling chart.
const MODE_MANIA: i64 = 3;

/// osu's playfield is a fixed 512 units wide; a mania note's column comes from its x.
const PLAYFIELD_WIDTH: f64 = 512.0;

/// Hit object type bits. The remaining bits carry combo information, which mania ignores.
const TYPE_TAP: i64 = 1;
const TYPE_HOLD: i64 = 128;

/// Timing point effect bits.
const EFFECT_KIAI: i64 = 1;

/// Hit sound bits. Bit 0 is implied: a value of zero still plays the normal sound.
const SOUND_WHISTLE: i64 = 2;
const SOUND_FINISH: i64 = 4;
const SOUND_CLAP: i64 = 8;

/// Sample set ids as they appear in both timing points and hit objects. Zero means
/// "inherit from the next level up".
fn sample_set_name(id: i64) -> &'static str {
    match id {
        1 => "normal",
        3 => "drum",
        _ => "soft",
    }
}

/// Extensions osu will accept for a sample, in the order it tries them.
const SAMPLE_EXTENSIONS: [&str; 3] = ["wav", "ogg", "mp3"];

/// Collects sample filenames and hands out stable indices.
///
/// Resolution against the chart folder happens once at the end, because charts routinely
/// name a sound with an extension it does not have on disk — this pack references 170
/// `.wav` files that are actually `.ogg`. osu tolerates that by trying alternatives, so
/// the importer does the same and records the name that will actually open.
#[derive(Default)]
struct SampleBank {
    files: Vec<String>,
    index: BTreeMap<String, u32>,
}

impl SampleBank {
    fn intern(&mut self, file: &str) -> u32 {
        if let Some(existing) = self.index.get(file) {
            return *existing;
        }
        let id = self.files.len() as u32;
        self.files.push(file.to_string());
        self.index.insert(file.to_string(), id);
        id
    }

    /// Rewrites each reference to a file that exists, where one can be found.
    ///
    /// Two things routinely differ between what a chart names and what it ships, and both
    /// are silent failures on Linux:
    ///
    /// - **Case.** osu runs on case-insensitive filesystems, so a chart asking for
    ///   `normal-hitnormal.wav` may well ship `Normal-Hitnormal.wav`. This is not rare;
    ///   it is the common case for hit sounds.
    /// - **Extension.** A chart may name a `.wav` and ship the `.ogg`.
    ///
    /// So the folder is indexed once by lowercase name and matched against that. A
    /// reference that still resolves to nothing is kept as written: the chart may be
    /// relying on the player's skin to supply it, which is the loader's problem.
    fn resolve(self, folder: Option<&Path>) -> Vec<Sample> {
        let Some(folder) = folder else {
            return self.files.into_iter().map(|file| Sample { file }).collect();
        };

        let mut by_lowercase: BTreeMap<String, String> = BTreeMap::new();
        if let Ok(entries) = std::fs::read_dir(folder) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    by_lowercase.insert(name.to_lowercase(), name.to_string());
                }
            }
        }

        self.files
            .into_iter()
            .map(|file| {
                let lowercase = file.to_lowercase();

                if let Some(actual) = by_lowercase.get(&lowercase) {
                    return Sample {
                        file: actual.clone(),
                    };
                }

                let stem = Path::new(&lowercase)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&lowercase)
                    .to_string();

                for extension in SAMPLE_EXTENSIONS {
                    if let Some(actual) = by_lowercase.get(&format!("{stem}.{extension}")) {
                        return Sample {
                            file: actual.clone(),
                        };
                    }
                }

                Sample { file }
            })
            .collect()
    }
}

/// Sample playback state in force at a given moment, inherited from timing points.
#[derive(Debug, Clone, Copy)]
struct SampleState {
    time_ms: f64,
    set: i64,
    index: i64,
    volume: f64,
}

/// Builds the filename osu would look for.
///
/// The naming rule is `{set}-hit{sound}{index}.wav`, with index 1 written as nothing at
/// all — which is why the reference chart's single sound is `soft-hitnormal.wav` and not
/// `soft-hitnormal1.wav`.
fn sample_file_name(set: i64, sound: &str, index: i64) -> String {
    let suffix = if index <= 1 {
        String::new()
    } else {
        index.to_string()
    };
    format!("{}-hit{sound}{suffix}.wav", sample_set_name(set))
}

/// Reads `path` and converts it into a [`Chart`].
///
/// Sample references are resolved against the file's own folder, because charts
/// routinely name a sound with the wrong extension.
pub fn import(path: &str) -> Result<Chart, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("could not read '{path}': {e}"))?;
    let folder = Path::new(path).parent().map(Path::to_path_buf);
    parse_in_folder(&text, folder.as_deref())
}

/// Converts the contents of a `.osu` file without touching the filesystem.
///
/// Sample references are left exactly as the chart wrote them.
#[allow(dead_code)]
pub fn parse(text: &str) -> Result<Chart, String> {
    parse_in_folder(text, None)
}

/// Converts a `.osu` file, optionally resolving sample filenames against `folder`.
pub fn parse_in_folder(text: &str, folder: Option<&Path>) -> Result<Chart, String> {
    let sections = split_sections(text);

    let general = key_values(sections.get("General"));
    let metadata_fields = key_values(sections.get("Metadata"));
    let difficulty = key_values(sections.get("Difficulty"));

    let mode = number(&general, "Mode").unwrap_or(0.0) as i64;
    if mode != MODE_MANIA {
        return Err(format!(
            "this is not an osu!mania chart (Mode: {mode}); only mode {MODE_MANIA} is supported"
        ));
    }

    // In mania, CircleSize is the lane count rather than a note size.
    let column_count = number(&difficulty, "CircleSize")
        .ok_or("the chart does not declare CircleSize, so its key count is unknown")?
        .round() as i64;
    if !(1..=18).contains(&column_count) {
        return Err(format!("implausible key count: {column_count}"));
    }
    let column_count = column_count as usize;

    let (tempo, scroll, effects, sample_states) =
        parse_timing_points(sections.get("TimingPoints"))?;

    // `[General] SampleSet` is the last fallback when neither the hit object nor the
    // timing point names one.
    let default_set = match text_value(&general, "SampleSet").to_ascii_lowercase().as_str() {
        "normal" => 1,
        "drum" => 3,
        _ => 2,
    };

    let mut bank = SampleBank::default();

    let notes = parse_hit_objects(
        sections.get("HitObjects"),
        column_count,
        &sample_states,
        default_set,
        &mut bank,
    )?;

    let bgm_events = parse_sample_events(sections.get("Events"), &mut bank);

    let beatmap_id = number(&metadata_fields, "BeatmapID").unwrap_or(0.0) as i64;
    let beatmap_set_id = number(&metadata_fields, "BeatmapSetID").unwrap_or(0.0) as i64;

    let mut ids = BTreeMap::new();
    if beatmap_id != 0 {
        ids.insert("beatmapId".to_string(), beatmap_id);
    }
    if beatmap_set_id != 0 {
        ids.insert("beatmapSetId".to_string(), beatmap_set_id);
    }

    // Retained for completeness. Mania scroll speed comes from the player's setting
    // modulated by `timing.scroll`, so this does not feed rendering.
    let mut values = BTreeMap::new();
    for (source_key, name) in [
        ("SliderMultiplier", "sliderMultiplier"),
        ("OverallDifficulty", "overallDifficulty"),
        ("HPDrainRate", "hpDrainRate"),
    ] {
        if let Some(value) = number(&difficulty, source_key) {
            values.insert(name.to_string(), value);
        }
    }

    // `virtual` is osu's marker for a chart with no background track at all: every
    // sound comes from the notes and the scheduled samples.
    let audio_file = text_value(&general, "AudioFilename");
    let has_background_track =
        !audio_file.is_empty() && !audio_file.eq_ignore_ascii_case("virtual");

    let audio = has_background_track.then(|| AudioTrack {
        file: audio_file,
        // Has to be measured against real playback; see the format documentation.
        offset_ms: 0.0,
        preview_ms: number(&general, "PreviewTime").filter(|ms| *ms >= 0.0),
        lead_in_ms: number(&general, "AudioLeadIn").unwrap_or(0.0),
    });

    let difficulty_name = text_value(&metadata_fields, "Version");
    let id = if beatmap_id != 0 {
        format!("osu:{beatmap_id}")
    } else {
        // No stable identifier in the file. Good enough to import with, but charts
        // without a BeatmapID should be re-keyed on a content hash before being stored.
        format!("osu:{}", slug(&difficulty_name))
    };

    let mut chart = Chart {
        format_version: FORMAT_VERSION,
        id,
        metadata: Metadata {
            title: text_value(&metadata_fields, "Title"),
            title_unicode: text_value(&metadata_fields, "TitleUnicode"),
            artist: text_value(&metadata_fields, "Artist"),
            artist_unicode: text_value(&metadata_fields, "ArtistUnicode"),
            charter: text_value(&metadata_fields, "Creator"),
            difficulty_name,
            source: text_value(&metadata_fields, "Source"),
            tags: text_value(&metadata_fields, "Tags")
                .split_whitespace()
                .map(str::to_string)
                .collect(),
        },
        origin: Origin {
            format: "osu".into(),
            format_version: parse_format_version(text),
            ids,
            values,
        },
        columns: vec![Column::note(); column_count],
        audio,
        samples: bank.resolve(folder),
        bgm_events,
        timing: Timing {
            tempo,
            scroll,
            stops: Vec::new(),
        },
        notes,
        effects,
        breaks: parse_breaks(sections.get("Events")),
    };

    extend_timeline_to_first_note(&mut chart);
    validate::normalise(&mut chart)?;

    Ok(chart)
}

/// Makes the timeline cover notes that precede the first timing point.
///
/// Charts routinely open with a note before their first timing point — the reference
/// chart starts at 964 ms with timing beginning at 1292 ms. osu treats that region as
/// governed by the first point, so a copy is prepended at the earliest note rather than
/// moving the original, which would shift the beat grid everywhere after it.
fn extend_timeline_to_first_note(chart: &mut Chart) {
    let Some(first_note_ms) = chart
        .notes
        .iter()
        .map(|note| note.time_ms)
        .min_by(|a, b| a.total_cmp(b))
    else {
        return;
    };

    if let Some(first) = chart.timing.tempo.first() {
        if first.time_ms > first_note_ms {
            let mut extended = first.clone();
            extended.time_ms = first_note_ms;
            chart.timing.tempo.insert(0, extended);
        }
    }

    if let Some(first) = chart.timing.scroll.first() {
        if first.time_ms > first_note_ms {
            let mut extended = first.clone();
            extended.time_ms = first_note_ms;
            chart.timing.scroll.insert(0, extended);
        }
    }
}

/// `osu file format v14` on the first line.
fn parse_format_version(text: &str) -> Option<u32> {
    text.lines()
        .next()?
        .trim()
        .strip_prefix("osu file format v")?
        .trim()
        .parse()
        .ok()
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/// Splits the file into `[Section]` blocks, dropping blank lines and `//` comments.
fn split_sections(text: &str) -> BTreeMap<String, Vec<String>> {
    let mut sections: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut current: Option<String> = None;

    // `trim_start_matches` handles the UTF-8 BOM; `trim` handles CRLF.
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }

        // A header may have content stuck to it on the same line. Real charts do this —
        // one in the reference pack opens its timing section as
        // `[TimingPoints]0,500,4,1,0,100,1,0` — and the recovery is unambiguous, since
        // the `]` closes the name and whatever follows is the first record.
        if let Some(rest) = line.strip_prefix('[') {
            if let Some((name, trailing)) = rest.split_once(']') {
                let name = name.to_string();
                let entry = sections.entry(name.clone()).or_default();

                let trailing = trailing.trim();
                if !trailing.is_empty() {
                    entry.push(trailing.to_string());
                }

                current = Some(name);
                continue;
            }
        }

        if let Some(name) = &current {
            sections.get_mut(name).unwrap().push(line.to_string());
        }
    }

    sections
}

/// Parses `Key: Value` lines. Values keep their internal spacing.
fn key_values(lines: Option<&Vec<String>>) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for line in lines.into_iter().flatten() {
        if let Some((key, value)) = line.split_once(':') {
            map.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    map
}

fn text_value(map: &BTreeMap<String, String>, key: &str) -> String {
    map.get(key).cloned().unwrap_or_default()
}

fn number(map: &BTreeMap<String, String>, key: &str) -> Option<f64> {
    map.get(key)?.parse().ok()
}

// ---------------------------------------------------------------------------
// Timing points
// ---------------------------------------------------------------------------

/// `time, beatLength, meter, sampleSet, sampleIndex, volume, uninherited, effects`
///
/// Two kinds share the list. Uninherited points set the tempo and carry a positive
/// `beatLength` in milliseconds per beat. Inherited points set the scroll velocity and
/// carry a negative value, where `-100` means 1.0x. Old files omit the trailing fields,
/// so the sign of `beatLength` is used as the fallback discriminator.
fn parse_timing_points(
    lines: Option<&Vec<String>>,
) -> Result<
    (
        Vec<TempoPoint>,
        Vec<ScrollPoint>,
        Vec<Effect>,
        Vec<SampleState>,
    ),
    String,
> {
    let mut tempo = Vec::new();
    let mut scroll = Vec::new();
    let mut sample_states: Vec<SampleState> = Vec::new();

    // Kiai is a state toggled by successive points, not a span in the file.
    let mut kiai_spans: Vec<Effect> = Vec::new();
    let mut kiai_started_at: Option<f64> = None;
    let mut last_time = 0.0;

    let mut raw: Vec<(f64, f64, u32, bool, bool, i64, i64, f64)> = Vec::new();

    for line in lines.into_iter().flatten() {
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() < 2 {
            continue;
        }

        let time_ms: f64 = fields[0]
            .trim()
            .parse()
            .map_err(|_| format!("bad timing point time: '{line}'"))?;
        let beat_length: f64 = fields[1]
            .trim()
            .parse()
            .map_err(|_| format!("bad timing point beat length: '{line}'"))?;

        let meter = fields
            .get(2)
            .and_then(|f| f.trim().parse::<u32>().ok())
            .unwrap_or(4);
        // The sign of `beat_length` outranks the flag. A negative value cannot be a
        // duration per beat, so a point claiming to be uninherited while carrying one is
        // contradicting itself — and SV charts do write these. Old files omit the flag
        // entirely, where the same rule is the only thing to go on.
        let flagged_uninherited = fields
            .get(6)
            .and_then(|f| f.trim().parse::<i64>().ok())
            .map(|v| v == 1)
            .unwrap_or(true);
        let uninherited = flagged_uninherited && beat_length > 0.0;
        let kiai = fields
            .get(7)
            .and_then(|f| f.trim().parse::<i64>().ok())
            .map(|v| v & EFFECT_KIAI != 0)
            .unwrap_or(false);

        // Sample set, index and volume also live on timing points and are inherited by
        // every hit object until the next point changes them.
        let field_i64 = |i: usize, fallback: i64| {
            fields
                .get(i)
                .and_then(|f| f.trim().parse::<i64>().ok())
                .unwrap_or(fallback)
        };
        let sample_set = field_i64(3, 0);
        let sample_index = field_i64(4, 1);
        let volume = field_i64(5, 100) as f64;

        raw.push((
            time_ms,
            beat_length,
            meter,
            uninherited,
            kiai,
            sample_set,
            sample_index,
            volume,
        ));
    }

    raw.sort_by(|a, b| a.0.total_cmp(&b.0));

    for (time_ms, beat_length, meter, uninherited, kiai, sample_set, sample_index, volume) in raw {
        sample_states.push(SampleState {
            time_ms,
            set: sample_set,
            index: sample_index,
            volume,
        });

        if uninherited {
            let bpm = 60_000.0 / beat_length;
            if !bpm.is_finite() {
                return Err(format!(
                    "tempo point at {time_ms:.0} ms yields an unusable BPM from beat length {beat_length}"
                ));
            }

            tempo.push(TempoPoint {
                time_ms,
                bpm,
                meter,
            });
            // An uninherited point also resets velocity to 1.0x.
            scroll.push(ScrollPoint {
                time_ms,
                multiplier: 1.0,
            });
        } else {
            // Velocity is presentation, so a nonsensical value is skipped rather than
            // failing the import: the previous multiplier simply stays in force.
            let multiplier = -100.0 / beat_length;
            if multiplier.is_finite() && multiplier >= 0.0 {
                scroll.push(ScrollPoint {
                    time_ms,
                    multiplier,
                });
            }
        }

        match (kiai, kiai_started_at) {
            (true, None) => kiai_started_at = Some(time_ms),
            (false, Some(start_ms)) => {
                kiai_spans.push(Effect {
                    start_ms,
                    end_ms: time_ms,
                    kind: EffectKind::Kiai,
                });
                kiai_started_at = None;
            }
            _ => {}
        }

        last_time = time_ms;
    }

    // A kiai section left open runs to the end of the timing data.
    if let Some(start_ms) = kiai_started_at {
        kiai_spans.push(Effect {
            start_ms,
            end_ms: last_time,
            kind: EffectKind::Kiai,
        });
    }

    if tempo.is_empty() {
        return Err("the chart declares no tempo, so nothing can be timed".into());
    }

    Ok((tempo, scroll, kiai_spans, sample_states))
}

// ---------------------------------------------------------------------------
// Hit objects
// ---------------------------------------------------------------------------

/// `x, y, time, type, hitSound, [endTime:]hitSample`
///
/// Only `x`, `time` and `type` matter for mania. The trailing group is
/// `normalSet:additionSet:index:volume:filename`, prefixed by the end time on holds.
fn parse_hit_objects(
    lines: Option<&Vec<String>>,
    column_count: usize,
    sample_states: &[SampleState],
    default_set: i64,
    bank: &mut SampleBank,
) -> Result<Vec<Note>, String> {
    let mut notes = Vec::new();

    for line in lines.into_iter().flatten() {
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() < 4 {
            return Err(format!("hit object has too few fields: '{line}'"));
        }

        let x: f64 = fields[0]
            .trim()
            .parse()
            .map_err(|_| format!("bad hit object x: '{line}'"))?;
        let time_ms: f64 = fields[2]
            .trim()
            .parse()
            .map_err(|_| format!("bad hit object time: '{line}'"))?;
        let object_type: i64 = fields[3]
            .trim()
            .parse()
            .map_err(|_| format!("bad hit object type: '{line}'"))?;

        // The y coordinate carries no meaning in mania; the column comes from x.
        let column = ((x * column_count as f64) / PLAYFIELD_WIDTH).floor();
        let column = (column.max(0.0) as usize).min(column_count - 1) as u16;

        let is_hold = object_type & TYPE_HOLD != 0;
        if !is_hold && object_type & TYPE_TAP == 0 {
            // Sliders and spinners cannot appear in a mania chart.
            return Err(format!(
                "unsupported hit object type {object_type} at {time_ms:.0} ms"
            ));
        }

        let hit_sound: i64 = fields
            .get(4)
            .and_then(|f| f.trim().parse().ok())
            .unwrap_or(0);

        let trailing = fields.get(5).copied().unwrap_or("");
        let (end_ms, sample_group) = if is_hold {
            let (end, rest) = trailing
                .split_once(':')
                .ok_or_else(|| format!("hold note has no end time: '{line}'"))?;
            let end_ms: f64 = end
                .trim()
                .parse()
                .map_err(|_| format!("bad hold end time: '{line}'"))?;
            (Some(end_ms), rest)
        } else {
            (None, trailing)
        };

        // `normalSet:additionSet:index:volume:filename`. Zeros mean "inherit".
        let group: Vec<&str> = sample_group.split(':').collect();
        let group_i64 = |i: usize| {
            group
                .get(i)
                .and_then(|f| f.trim().parse::<i64>().ok())
                .unwrap_or(0)
        };
        let custom_file = group.last().map(|f| f.trim()).unwrap_or("");

        let mut note_samples = Vec::new();

        // Volume is per hit object in keysounded charts and per timing point elsewhere;
        // resolving it here means the runtime never has to look it up.
        let state = sample_state_at(sample_states, time_ms);
        let volume = match group_i64(3) {
            0 => state.volume,
            volume => volume as f64,
        };

        if !custom_file.is_empty() {
            // An explicit filename replaces the set-derived sound entirely.
            note_samples.push(bank.intern(custom_file));
        } else {
            // Resolve through the inheritance chain: hit object, then the timing point
            // in force, then the file-wide default.
            let inherited_set = if state.set != 0 { state.set } else { default_set };

            let normal_set = match group_i64(0) {
                0 => inherited_set,
                set => set,
            };
            let addition_set = match group_i64(1) {
                0 => normal_set,
                set => set,
            };
            let index = match group_i64(2) {
                0 => state.index,
                index => index,
            };

            // The normal sound always plays; the rest layer on top of it.
            note_samples.push(bank.intern(&sample_file_name(normal_set, "normal", index)));
            for (bit, name) in [
                (SOUND_WHISTLE, "whistle"),
                (SOUND_FINISH, "finish"),
                (SOUND_CLAP, "clap"),
            ] {
                if hit_sound & bit != 0 {
                    note_samples.push(bank.intern(&sample_file_name(addition_set, name, index)));
                }
            }
        }

        notes.push(Note {
            time_ms,
            column,
            end_ms,
            kind: None,
            samples: note_samples,
            volume,
        });
    }

    if notes.is_empty() {
        return Err("the chart contains no hit objects".into());
    }

    Ok(notes)
}

/// Storyboard sample events: `Sample,time,layer,"file",volume`.
///
/// These are how a fully keysounded osu chart carries everything the player does not
/// hit — the accompaniment, in other words. Ignoring them leaves such a chart nearly
/// silent, so they map straight onto BGM events.
fn parse_sample_events(lines: Option<&Vec<String>>, bank: &mut SampleBank) -> Vec<BgmEvent> {
    let mut events = Vec::new();

    for line in lines.into_iter().flatten() {
        let fields: Vec<&str> = line.split(',').map(str::trim).collect();
        if fields.len() < 4 || !(fields[0] == "Sample" || fields[0] == "5") {
            continue;
        }

        let Ok(time_ms) = fields[1].parse::<f64>() else {
            continue;
        };

        let file = fields[3].trim_matches('"').trim();
        if file.is_empty() {
            continue;
        }

        // The volume field is optional; osu treats a missing or zero value as full.
        let volume = fields
            .get(4)
            .and_then(|f| f.parse::<f64>().ok())
            .filter(|v| *v > 0.0)
            .unwrap_or(100.0);

        events.push(BgmEvent {
            time_ms,
            sample: bank.intern(file),
            volume,
        });
    }

    events
}

/// The sample state in force at `time_ms`: the last timing point at or before it.
fn sample_state_at(states: &[SampleState], time_ms: f64) -> SampleState {
    let fallback = SampleState {
        time_ms: 0.0,
        set: 0,
        index: 1,
        volume: 100.0,
    };

    match states.partition_point(|state| state.time_ms <= time_ms) {
        0 => states.first().copied().unwrap_or(fallback),
        position => states[position - 1],
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Break periods are `2,start,end`, written either numerically or as `Break`.
fn parse_breaks(lines: Option<&Vec<String>>) -> Vec<Span> {
    let mut breaks = Vec::new();

    for line in lines.into_iter().flatten() {
        let fields: Vec<&str> = line.split(',').map(str::trim).collect();
        if fields.len() < 3 || !(fields[0] == "2" || fields[0].eq_ignore_ascii_case("Break")) {
            continue;
        }

        if let (Ok(start_ms), Ok(end_ms)) = (fields[1].parse::<f64>(), fields[2].parse::<f64>()) {
            if end_ms > start_ms {
                breaks.push(Span { start_ms, end_ms });
            }
        }
    }

    breaks
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Lowercase, alphanumerics and dashes only. Used only as a last-resort identifier.
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

    if out.is_empty() { "unknown".into() } else { out }
}

/// Convenience for callers that just want the file on disk.
pub fn convert_to_json_file(source_path: &str, output_path: &str) -> Result<Chart, String> {
    let chart = import(source_path)?;

    let json = serde_json::to_string_pretty(&chart)
        .map_err(|e| format!("could not serialise the chart: {e}"))?;

    if let Some(parent) = Path::new(output_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create '{}': {e}", parent.display()))?;
    }

    std::fs::write(output_path, json)
        .map_err(|e| format!("could not write '{output_path}': {e}"))?;

    Ok(chart)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A four-key chart exercising both note types, a tempo change and a velocity change.
    const FIXTURE: &str = "\
osu file format v14

[General]
AudioFilename: song.mp3
Mode: 3
PreviewTime: 5000

[Metadata]
Title:Test
Artist:Someone
Creator:Charter
Version:Normal
Tags:one two

[Difficulty]
CircleSize:4

[Events]
0,0,\"bg.png\",0,0
2,4000,5000

[TimingPoints]
1000,500,4,2,1,40,1,0
2000,-50,4,2,1,40,0,1
3000,-200,4,2,1,40,0,0
4000,250,4,2,1,40,1,0

[HitObjects]
64,192,1000,1,0,0:0:0:0:
192,192,1200,128,0,1500:0:0:0:0:
320,192,1400,1,0,0:0:0:0:hit.wav
448,192,1600,1,0,0:0:0:0:
";

    fn fixture() -> Chart {
        parse(FIXTURE).expect("fixture should import")
    }

    #[test]
    fn maps_x_positions_onto_columns() {
        let chart = fixture();
        let columns: Vec<u16> = chart.notes.iter().map(|n| n.column).collect();
        assert_eq!(columns, vec![0, 1, 2, 3]);
        assert_eq!(chart.columns.len(), 4);
    }

    #[test]
    fn reads_hold_end_times_from_the_sample_group() {
        let chart = fixture();
        let hold = chart.notes.iter().find(|n| n.is_hold()).expect("a hold");
        assert_eq!(hold.time_ms, 1200.0);
        assert_eq!(hold.end_ms, Some(1500.0));
        assert_eq!(chart.notes.iter().filter(|n| n.is_hold()).count(), 1);
    }

    #[test]
    fn splits_tempo_from_scroll_velocity() {
        let chart = fixture();

        // Two uninherited points become tempo; both also reset velocity to 1.0x.
        let tempo: Vec<(f64, f64)> = chart.timing.tempo.iter().map(|p| (p.time_ms, p.bpm)).collect();
        assert_eq!(tempo, vec![(1000.0, 120.0), (4000.0, 240.0)]);

        let scroll: Vec<(f64, f64)> =
            chart.timing.scroll.iter().map(|p| (p.time_ms, p.multiplier)).collect();
        assert_eq!(
            scroll,
            vec![(1000.0, 1.0), (2000.0, 2.0), (3000.0, 0.5), (4000.0, 1.0)]
        );
    }

    #[test]
    fn turns_kiai_flags_into_spans() {
        let chart = fixture();
        assert_eq!(chart.effects.len(), 1);
        assert_eq!(chart.effects[0].start_ms, 2000.0);
        assert_eq!(chart.effects[0].end_ms, 3000.0);
    }

    #[test]
    fn resolves_sample_sets_into_filenames() {
        let chart = fixture();

        // Timing points declare the Soft set at index 1, and index 1 is written as
        // nothing at all, so the notes that inherit resolve to `soft-hitnormal.wav`.
        let files: Vec<&str> = chart.samples.iter().map(|s| s.file.as_str()).collect();
        assert_eq!(files, vec!["soft-hitnormal.wav", "hit.wav"]);

        // Three notes inherit; one names its own file, which replaces the set sound.
        let inherited = chart.notes.iter().filter(|n| n.samples == vec![0]).count();
        let custom = chart.notes.iter().filter(|n| n.samples == vec![1]).count();
        assert_eq!((inherited, custom), (3, 1));
    }

    #[test]
    fn layers_addition_hitsounds_on_top_of_the_normal_one() {
        // hitSound 10 = whistle (2) + clap (8).
        let layered = FIXTURE.replace(
            "448,192,1600,1,0,0:0:0:0:",
            "448,192,1600,1,10,0:0:0:0:",
        );
        let chart = parse(&layered).expect("import");

        let note = chart.notes.last().expect("last note");
        let files: Vec<&str> = note
            .samples
            .iter()
            .map(|i| chart.samples[*i as usize].file.as_str())
            .collect();

        assert_eq!(
            files,
            vec![
                "soft-hitnormal.wav",
                "soft-hitwhistle.wav",
                "soft-hitclap.wav"
            ]
        );
    }

    #[test]
    fn writes_sample_indices_above_one_into_the_filename() {
        // Same timing point, sample index 3.
        let indexed = FIXTURE.replace("1000,500,4,2,1,40,1,0", "1000,500,4,2,3,40,1,0");
        let chart = parse(&indexed).expect("import");
        assert!(
            chart.samples.iter().any(|s| s.file == "soft-hitnormal3.wav"),
            "got {:?}",
            chart.samples
        );
    }

    #[test]
    fn inherits_volume_from_the_timing_point_onto_every_note() {
        let chart = fixture();
        // The fixture's timing points declare volume 40 and no hit object overrides it.
        assert!(chart.notes.iter().all(|n| n.volume == 40.0));
    }

    #[test]
    fn a_hit_object_can_override_the_inherited_volume() {
        // Same note, but with 90 in the volume slot of its sample group.
        let loud = FIXTURE.replace(
            "448,192,1600,1,0,0:0:0:0:",
            "448,192,1600,1,0,0:0:0:90:",
        );
        let chart = parse(&loud).expect("import");

        let last = chart.notes.last().expect("last note");
        assert_eq!(last.volume, 90.0);
        // The others still inherit.
        assert_eq!(chart.notes[0].volume, 40.0);
    }

    #[test]
    fn treats_virtual_audio_as_no_background_track() {
        let keysounded = FIXTURE.replace("AudioFilename: song.mp3", "AudioFilename: virtual");
        let chart = parse(&keysounded).expect("import");
        assert!(
            chart.audio.is_none(),
            "a virtual track is not a file to play"
        );
    }

    #[test]
    fn reads_storyboard_samples_as_bgm_events() {
        let with_bgm = FIXTURE.replace(
            "2,4000,5000",
            "2,4000,5000\nSample,2500,0,\"piano.ogg\",80\nSample,2600,0,\"piano.ogg\"",
        );
        let chart = parse(&with_bgm).expect("import");

        assert_eq!(chart.bgm_events.len(), 2);
        assert_eq!(chart.bgm_events[0].time_ms, 2500.0);
        assert_eq!(chart.bgm_events[0].volume, 80.0);
        // A missing volume field means full, not silent.
        assert_eq!(chart.bgm_events[1].volume, 100.0);

        // Both events name the same file, so they share one bank entry.
        assert_eq!(chart.bgm_events[0].sample, chart.bgm_events[1].sample);
        assert!(chart.samples.iter().any(|s| s.file == "piano.ogg"));
    }

    #[test]
    fn reads_breaks_and_audio() {
        let chart = fixture();
        assert_eq!(chart.breaks.len(), 1);
        assert_eq!(chart.breaks[0].start_ms, 4000.0);

        let audio = chart.audio.as_ref().expect("audio track");
        assert_eq!(audio.file, "song.mp3");
        assert_eq!(audio.preview_ms, Some(5000.0));
        // Calibration is never guessed at import.
        assert_eq!(audio.offset_ms, 0.0);
    }

    #[test]
    fn treats_a_negative_beat_length_as_velocity_whatever_the_flag_says() {
        // An SV chart writes this: the uninherited flag is set, but the value is the
        // negative encoding used for velocity. -100 / -1e14 is a near-total freeze.
        let contradictory = FIXTURE.replace(
            "4000,250,4,2,1,40,1,0",
            "4000,-100000000000000,4,2,1,40,1,0",
        );
        let chart = parse(&contradictory).expect("the sign settles it");

        // It did not become a tempo point.
        assert_eq!(chart.timing.tempo.len(), 1);
        assert_eq!(chart.timing.tempo[0].bpm, 120.0);

        let frozen = chart
            .timing
            .scroll
            .iter()
            .find(|p| p.time_ms == 4000.0)
            .expect("a velocity point at 4000 ms");
        assert!(frozen.multiplier < 0.001, "got {}", frozen.multiplier);
    }

    #[test]
    fn skips_an_unusable_velocity_rather_than_failing_the_import() {
        // Zero would divide to infinity.
        let broken = FIXTURE.replace("2000,-50,4,2,1,40,0,1", "2000,0,4,2,1,40,0,1");
        let chart = parse(&broken).expect("a bad velocity is not fatal");

        assert!(chart.timing.scroll.iter().all(|p| p.multiplier.is_finite()));
        assert!(!chart.notes.is_empty());
    }

    #[test]
    fn recovers_a_section_header_with_its_first_record_on_the_same_line() {
        let malformed = FIXTURE.replace(
            "[TimingPoints]\n1000,500,4,2,1,40,1,0",
            "[TimingPoints]1000,500,4,2,1,40,1,0",
        );
        let chart = parse(&malformed).expect("the header split is unambiguous");

        assert_eq!(chart.timing.tempo[0].bpm, 120.0);
        assert_eq!(chart.timing.tempo[0].time_ms, 1000.0);
    }

    #[test]
    fn sample_references_resolve_past_a_difference_in_case() {
        // osu runs case-insensitively, so a chart naming `normal-hitnormal.wav` while
        // shipping `Normal-Hitnormal.wav` is ordinary rather than broken.
        let folder = std::env::temp_dir().join(format!("rc-case-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("Normal-Hitnormal.WAV"), b"").unwrap();

        let mut bank = SampleBank::default();
        bank.intern("normal-hitnormal.wav");
        let resolved = bank.resolve(Some(&folder));

        std::fs::remove_dir_all(&folder).ok();
        assert_eq!(resolved[0].file, "Normal-Hitnormal.WAV");
    }

    #[test]
    fn sample_references_resolve_past_a_different_extension() {
        let folder = std::env::temp_dir().join(format!("rc-ext-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("A7S.ogg"), b"").unwrap();

        let mut bank = SampleBank::default();
        bank.intern("A7S.wav");
        let resolved = bank.resolve(Some(&folder));

        std::fs::remove_dir_all(&folder).ok();
        assert_eq!(resolved[0].file, "A7S.ogg");
    }

    #[test]
    fn a_reference_that_resolves_to_nothing_is_kept_as_written() {
        let folder = std::env::temp_dir().join(format!("rc-miss-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();

        let mut bank = SampleBank::default();
        bank.intern("soft-hitclap.wav");
        let resolved = bank.resolve(Some(&folder));

        std::fs::remove_dir_all(&folder).ok();
        assert_eq!(resolved[0].file, "soft-hitclap.wav", "a skin may still supply it");
    }

    #[test]
    fn rejects_charts_that_are_not_mania() {
        let standard = FIXTURE.replace("Mode: 3", "Mode: 0");
        let error = parse(&standard).expect_err("mode 0 should be refused");
        assert!(error.contains("osu!mania"), "unexpected message: {error}");
    }

    #[test]
    fn rejects_a_chart_whose_notes_do_not_fit_its_columns() {
        // Two lanes declared, but hit objects are still spread across four.
        let narrowed = FIXTURE.replace("CircleSize:4", "CircleSize:2");
        let chart = parse(&narrowed).expect("import clamps x into range");
        assert!(chart.notes.iter().all(|n| (n.column as usize) < 2));
    }

    #[test]
    fn extends_the_timeline_back_to_a_lead_in_note() {
        // A note at 500 ms, before the first timing point at 1000 ms.
        let early = FIXTURE.replace(
            "64,192,1000,1,0,0:0:0:0:",
            "64,192,500,1,0,0:0:0:0:",
        );
        let chart = parse(&early).expect("lead-in notes are supported");

        assert_eq!(chart.notes[0].time_ms, 500.0);
        assert_eq!(chart.timing.tempo[0].time_ms, 500.0);
        // The prepended point carries the original tempo, not a guess.
        assert_eq!(chart.timing.tempo[0].bpm, 120.0);
        assert_eq!(chart.timing.tempo[1].time_ms, 1000.0);
    }
}
