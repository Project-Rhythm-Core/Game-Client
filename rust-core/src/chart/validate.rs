//! Chart invariants.
//!
//! The runtime is allowed to rely on these without re-checking, so an importer that
//! cannot satisfy them must fail loudly rather than emit a chart that will be misread.

use super::model::Chart;

/// Times are rounded to microseconds. Well past anything audible, and far past anything
/// judgeable, but enough that a conversion from measure-based formats does not land on
/// a value that only differs in the last bits of an f64.
const TIME_DECIMALS: i32 = 3;

/// Rates keep six decimals. A BPM error of 1e-6 accumulates to a few microseconds over a
/// ten-minute chart, so this costs nothing real and removes the noise.
const RATE_DECIMALS: i32 = 6;

/// Rounds everything to a sane precision, sorts it, then checks what sorting cannot fix.
pub fn normalise(chart: &mut Chart) -> Result<(), String> {
    round(chart);
    sort(chart);
    check(chart)
}

/// Rounds a value to `decimals` places, leaving non-finite input alone.
fn round_to(value: f64, decimals: i32) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let scale = 10f64.powi(decimals);
    (value * scale).round() / scale
}

/// Strips floating-point noise from derived values.
///
/// Rates in particular are divisions — osu stores milliseconds per beat, so a BPM of 187
/// arrives as `187.00000000000003`. That is harmless arithmetically and ugly in a file
/// meant to be read and diffed, so it is cleaned up once, here, rather than in every
/// importer.
fn round(chart: &mut Chart) {
    for note in &mut chart.notes {
        note.time_ms = round_to(note.time_ms, TIME_DECIMALS);
        note.end_ms = note.end_ms.map(|end| round_to(end, TIME_DECIMALS));
        note.volume = round_to(note.volume, RATE_DECIMALS);
    }

    for point in &mut chart.timing.tempo {
        point.time_ms = round_to(point.time_ms, TIME_DECIMALS);
        point.bpm = round_to(point.bpm, RATE_DECIMALS);
    }

    for point in &mut chart.timing.scroll {
        point.time_ms = round_to(point.time_ms, TIME_DECIMALS);
        point.multiplier = round_to(point.multiplier, RATE_DECIMALS);
    }

    for point in &mut chart.timing.stops {
        point.time_ms = round_to(point.time_ms, TIME_DECIMALS);
        point.duration_ms = round_to(point.duration_ms, TIME_DECIMALS);
    }

    for event in &mut chart.bgm_events {
        event.time_ms = round_to(event.time_ms, TIME_DECIMALS);
        event.volume = round_to(event.volume, RATE_DECIMALS);
    }

    for effect in &mut chart.effects {
        effect.start_ms = round_to(effect.start_ms, TIME_DECIMALS);
        effect.end_ms = round_to(effect.end_ms, TIME_DECIMALS);
    }

    for span in &mut chart.breaks {
        span.start_ms = round_to(span.start_ms, TIME_DECIMALS);
        span.end_ms = round_to(span.end_ms, TIME_DECIMALS);
    }

    if let Some(audio) = &mut chart.audio {
        audio.offset_ms = round_to(audio.offset_ms, TIME_DECIMALS);
        audio.lead_in_ms = round_to(audio.lead_in_ms, TIME_DECIMALS);
        audio.preview_ms = audio.preview_ms.map(|ms| round_to(ms, TIME_DECIMALS));
    }
}

/// Invariant 1: notes and every timing array are ascending by time.
fn sort(chart: &mut Chart) {
    // Total order: times are finite by the time they get here, so this cannot panic.
    chart
        .notes
        .sort_by(|a, b| (a.time_ms, a.column).partial_cmp(&(b.time_ms, b.column)).unwrap());
    chart.timing.tempo.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    chart.timing.scroll.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    chart.timing.stops.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    chart.bgm_events.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    chart.effects.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    chart.breaks.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
}

fn check(chart: &Chart) -> Result<(), String> {
    if chart.columns.is_empty() {
        return Err("chart has no columns".into());
    }
    if chart.notes.is_empty() {
        return Err("chart has no notes".into());
    }

    let column_count = chart.columns.len();
    let sample_count = chart.samples.len();

    for (index, note) in chart.notes.iter().enumerate() {
        if !note.time_ms.is_finite() {
            return Err(format!("note {index} has a non-finite time"));
        }

        // Invariant 2: every column is addressable.
        if note.column as usize >= column_count {
            return Err(format!(
                "note {index} at {:.0} ms is in column {}, but the chart has {column_count}",
                note.time_ms, note.column
            ));
        }

        // Invariant 3: a hold ends after it starts. Zero-length holds are rejected too:
        // they are almost always a conversion bug, and they are unjudgeable.
        if let Some(end_ms) = note.end_ms {
            if !(end_ms > note.time_ms) {
                return Err(format!(
                    "hold {index} starts at {:.0} ms and ends at {end_ms:.0} ms",
                    note.time_ms
                ));
            }
        }

        // Invariant 5: sample references resolve.
        for sample in &note.samples {
            if *sample as usize >= sample_count {
                return Err(format!(
                    "note {index} references sample {sample}, but only {sample_count} exist"
                ));
            }
        }
    }

    // Invariant 4: no two notes occupy the same instant in the same column. Notes are
    // sorted by (time, column) at this point, so duplicates are adjacent.
    for pair in chart.notes.windows(2) {
        if pair[0].time_ms == pair[1].time_ms && pair[0].column == pair[1].column {
            return Err(format!(
                "two notes share column {} at {:.0} ms",
                pair[0].column, pair[0].time_ms
            ));
        }
    }

    for event in &chart.bgm_events {
        if event.sample as usize >= sample_count {
            return Err(format!(
                "a BGM event references sample {}, but only {sample_count} exist",
                event.sample
            ));
        }
    }

    // Invariant 6: timing lookups never fall off the front of the chart.
    let first_note_ms = chart.notes[0].time_ms;
    if chart.timing.tempo.is_empty() {
        return Err("chart has no tempo points".into());
    }
    if chart.timing.tempo[0].time_ms > first_note_ms {
        return Err(format!(
            "the first tempo point is at {:.0} ms, after the first note at {first_note_ms:.0} ms",
            chart.timing.tempo[0].time_ms
        ));
    }
    if let Some(first) = chart.timing.scroll.first() {
        if first.time_ms > first_note_ms {
            return Err(format!(
                "the first scroll point is at {:.0} ms, after the first note at {first_note_ms:.0} ms",
                first.time_ms
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_away_division_noise_without_touching_real_precision() {
        // What 60000 / 320.855614973262 actually produces.
        assert_eq!(round_to(187.000000000000_03, RATE_DECIMALS), 187.0);
        assert_eq!(round_to(0.900000000000000_1, RATE_DECIMALS), 0.9);
        // Genuinely fractional values survive.
        assert_eq!(round_to(174.5, RATE_DECIMALS), 174.5);
        assert_eq!(round_to(128.003_25, RATE_DECIMALS), 128.00325);
    }

    #[test]
    fn leaves_non_finite_values_alone_rather_than_producing_garbage() {
        assert!(round_to(f64::NAN, TIME_DECIMALS).is_nan());
        assert_eq!(round_to(f64::INFINITY, TIME_DECIMALS), f64::INFINITY);
    }
}
