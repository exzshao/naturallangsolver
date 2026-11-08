//! Native baseline: same spots, same code, rayon on all cores.
//! `native [name-substring] [spots.json]` (defaults: all, the built-in spots.json)
use wasm_spike::{run_spot, spots_json, Spot};

fn main() {
    let filter = std::env::args().nth(1).unwrap_or_default();
    let json = match std::env::args().nth(2) {
        Some(path) => std::fs::read_to_string(path).unwrap(),
        None => spots_json().to_string(),
    };
    let spots: Vec<Spot> = serde_json::from_str(&json).unwrap();
    for spot in spots.iter().filter(|s| s.name.contains(&filter)) {
        let r = run_spot(spot, |_, _, _| {}).unwrap();
        println!("{}", serde_json::to_string(&r).unwrap());
    }
}
