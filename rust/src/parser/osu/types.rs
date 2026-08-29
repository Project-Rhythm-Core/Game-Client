use rosu_map::section::{events::BreakPeriod, hit_objects::hit_samples::{SampleBank}};

pub enum GameSource {
    Osu,
    Bms,
    O2jam,
}

pub struct Beatmap {
    pub general: General,
    pub metadata: Metadata,
    pub difficulty: Difficulty,
    pub events: Events,
    pub timing_points: TimingPoints,
    pub notes: Vec<Note>
}

pub struct General {
    pub audio_filename: String,
    pub preview_time: i32,
    pub default_sample: SampleBank,
}

pub struct Metadata {
    pub game_source: GameSource,
    pub title: String,
    pub title_unicode: String,
    pub artist: String,
    pub artist_unicode: String,
    pub creator: String,
    pub version: String,
    pub source: String,
    pub tags: Vec<String>,
    pub beatmap_id: i32,
    pub beatmap_set_id: i32,
}

pub struct Difficulty {
    pub hp_drain: f32,
    pub key_count: f32,
    pub overall_difficulty: f32,
}

pub struct Events {
    pub background_filename: String,
    pub breaks: Vec<BreakPeriod>,

}

pub struct TimingPoints {
    pub bpm_changes: Vec<BpmChange>,
    pub scroll_events: Vec<ScrollEvent>,
}

pub struct BpmChange {
    pub time: f64,
    pub bpm: f32,
}

pub struct ScrollEvent {
    pub time: f64,
    pub multiplier: f32,
}

pub struct Note {
    pub column: i8,
    pub time: f64,
    pub end_time: f64,
    
    // HitSamples pending
}