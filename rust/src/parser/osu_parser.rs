use rosu_map::Beatmap;
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
    fn parse_map(&self) -> GString {
        let path = "/home/manolo/github/project-rythm-core/Game-Client/rust/resources/roquira/roquira.osu";
        match rosu_map::from_path::<Beatmap>(path) {
            Ok(map) => format!("Beatmap title: {}, Artist: {}", map.title, map.artist).to_gstring(),
            Err(e) => format!("ERROR: {:?}", e).to_gstring(),
        }
    }
}