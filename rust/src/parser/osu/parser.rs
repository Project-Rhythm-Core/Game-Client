use rosu_map::{Beatmap};
use godot::prelude::*;

#[derive(GodotClass)]
#[class(base=Node)]
struct OsuParser {
    base: Base<Node>,
}

#[godot_api]
impl INode for OsuParser {
    fn init(base: Base<Node>) -> Self {
        Self { base }
    }
}

#[godot_api]
impl OsuParser {
    #[func]
    fn parse_map(&self) -> Dictionary<Variant,Variant> {

        let path = "/home/manolo/github/project-rythm-core/Game-Client/rust/resources/2177636 IOSYS TRAX with Chiyoko - DX Choyasei! Survival Zundoko Chan/IOSYS TRAX with Chiyoko - DX Choyasei! Survival Zundoko Chan (ERA arccat) [mint's DX Temple Run!].osu";
        let map = match rosu_map::from_path::<Beatmap>(path) {
            Ok( m) => m,
            Err(e) => {
                let mut result: Dictionary<Variant, Variant> = Dictionary::new();
                result.set("error", format!("{:?}", e));
                return result;
            }
        };

        let mut result: Dictionary<Variant, Variant> = Dictionary::new();
        
        // General

        result.set("audio_filename", map.audio_file);
        result.set("preview_time", map.preview_time);
        result.set("default_sample", map.default_sample_bank.to_string());

        // Metadata

        result.set("game_source", "Osu");
        result.set("title", map.title);
        result.set("title_unicode", map.title_unicode);
        result.set("artist", map.artist);
        result.set("artist_unicode", map.artist_unicode);
        result.set("creator", map.creator);
        result.set("version", map.version);
        result.set("source", map.source);

        let tags: Array<Variant> = map.tags.split_whitespace()
            .map(|s| s.to_variant())
            .collect();

        result.set("tags", &tags);

        result.set("beatmap_id", map.beatmap_id);
        result.set("beatmap_set_id", map.beatmap_set_id);

        // Difficulty

        result.set("hp_drain", map.hp_drain_rate);
        result.set("key_count", map.circle_size as i8);
        result.set("overall_difficulty", map.overall_difficulty);

        // Events

        result.set("background_filename", map.background_file);

        let mut breaks: Array<Variant> = Array::new();
        for b in &map.breaks {

            let mut break_dict: Dictionary<Variant, Variant> = Dictionary::new();
            break_dict.set("start_time", b.start_time);
            break_dict.set("end_time", b.end_time);
            breaks.push(&break_dict.to_variant());
        }
        result.set("breaks", &breaks);

        // Timing Points

        let mut bpm_changes: Array<Variant> = Array::new();

        for tp in &map.control_points.timing_points {
            let bpm = 60_600.0 / tp.beat_len;
            let bpm_rounded = (bpm * 100.0).round() / 100.0;

            let mut bpm_dict: Dictionary<Variant, Variant> = Dictionary::new();
            bpm_dict.set("time", tp.time);
            bpm_dict.set("bpm", bpm_rounded);
            bpm_changes.push(&bpm_dict.to_variant());
        }
        result.set("bpm_changes", &bpm_changes);

        let mut scroll_events: Array<Variant> = Array::new();

        for dp in &map.control_points.difficulty_points {
            let mut scroll_dict: Dictionary<Variant, Variant> = Dictionary::new();
            scroll_dict.set("time", dp.time);
            scroll_dict.set("multiplier", dp.slider_velocity);
            scroll_events.push(&scroll_dict.to_variant());
        }
        result.set("scroll_events", &scroll_events);

        // Notes

        use rosu_map::section::hit_objects::HitObjectKind;

        let mut notes: Array<Variant> = Array::new();

        for note in &map.hit_objects {
            let (x, end_time): (f32, f64) = match &note.kind {
                HitObjectKind::Circle(circle) => (circle.pos.x, -1.0),
                HitObjectKind::Hold(hold) => (hold.pos_x, note.start_time + hold.duration),
                HitObjectKind::Slider(_) | HitObjectKind::Spinner(_) => continue,
            };

            let column = ((x * map.circle_size) / 512.0).floor() as i64;

            let mut note_dict: Dictionary<Variant, Variant> = Dictionary::new();
            note_dict.set("column", column);
            note_dict.set("time", note.start_time);
            note_dict.set("end_time", end_time);
            notes.push(&note_dict.to_variant());
        }

        result.set("notes", &notes);

        result
    }
}