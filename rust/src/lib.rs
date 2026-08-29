use godot::prelude::*;

pub mod parser;
struct MyExtension;

#[gdextension]
unsafe impl ExtensionLibrary for MyExtension {}

#[derive(GodotClass)]
#[class(base=Node)]
struct RustPing {
    base: Base<Node>,
}

#[godot_api]
impl INode for RustPing {
    fn init(base: Base<Node>) -> Self {
        Self { base }
    }
}

#[godot_api]
impl RustPing {
    #[func]
    fn ping(&self) -> GString {
        "pong from Rust".into()
    }
}
