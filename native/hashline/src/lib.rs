use napi::bindgen_prelude::*;
use napi_derive::napi;
use xxhash_rust::xxh32::xxh32;

/// Seed used for xxh32 hashing — consistent across all invocations.
const XXH_SEED: u32 = 0;

/// Compute per-line xxh32 hashes for the given source buffer.
///
/// Splits the source by newline characters (`\n`) and hashes each line
/// (without the trailing newline). Returns a Uint32Array of hashes with
/// one entry per line.
///
/// Performance target: ≤2ms for a 10k-line file.
#[napi]
pub fn compute_line_hashes(source: Buffer) -> Uint32Array {
    let bytes = source.as_ref();
    let mut hashes: Vec<u32> = Vec::new();
    let mut start = 0;

    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' {
            let line = &bytes[start..i];
            hashes.push(xxh32(line, XXH_SEED));
            start = i + 1;
        }
    }

    // Handle the last line (if file doesn't end with newline or is empty)
    if start <= bytes.len() {
        let line = &bytes[start..];
        // Only add if there's content or if we haven't added anything yet
        // (handles empty files and files ending with newline)
        if !line.is_empty() || hashes.is_empty() {
            hashes.push(xxh32(line, XXH_SEED));
        }
    }

    Uint32Array::new(hashes)
}

/// Result of an anchor lookup operation.
#[napi(object)]
pub struct AnchorResult {
    /// The offset (index) in the file hashes where the best match starts.
    /// -1 if no match with sufficient confidence was found.
    pub offset: i32,
    /// Confidence score: ratio of matching hashes to total target hashes.
    /// Range: 0.0 to 1.0
    pub confidence: f64,
}

/// Find the best position of a target hash sequence within the file hashes.
///
/// Uses a sliding window approach:
/// 1. Slides the target window over all positions in the file hashes
/// 2. At each position, counts how many hashes match
/// 3. Returns the position with the highest match count and confidence score
/// 4. If no position achieves confidence > 0.5, returns offset -1 (not found)
///
/// The target array represents the expected line hashes of the region being searched for.
/// The hashes array represents all line hashes of the current file content.
#[napi]
pub fn anchor_lookup(hashes: Uint32Array, target: Uint32Array) -> AnchorResult {
    let file_hashes = hashes.as_ref();
    let target_hashes = target.as_ref();

    let target_len = target_hashes.len();
    let file_len = file_hashes.len();

    // Edge cases
    if target_len == 0 {
        return AnchorResult {
            offset: -1,
            confidence: 0.0,
        };
    }

    if file_len == 0 {
        return AnchorResult {
            offset: -1,
            confidence: 0.0,
        };
    }

    let mut best_offset: i32 = -1;
    let mut best_matches: usize = 0;

    // Slide the target window over all valid positions in the file
    // Allow positions where at least part of the target overlaps with the file
    let max_start = if file_len >= target_len {
        file_len - target_len
    } else {
        0
    };

    // Only consider positions where the full target fits within the file
    if file_len >= target_len {
        for pos in 0..=max_start {
            let mut matches = 0usize;
            for i in 0..target_len {
                if file_hashes[pos + i] == target_hashes[i] {
                    matches += 1;
                }
            }
            if matches > best_matches {
                best_matches = matches;
                best_offset = pos as i32;
            }
        }
    } else {
        // File is shorter than target — check the single position (0)
        // counting matches for overlapping portion
        let overlap = file_len;
        let mut matches = 0usize;
        for i in 0..overlap {
            if file_hashes[i] == target_hashes[i] {
                matches += 1;
            }
        }
        if matches > best_matches {
            best_matches = matches;
            best_offset = 0;
        }
    }

    let confidence = if target_len > 0 {
        best_matches as f64 / target_len as f64
    } else {
        0.0
    };

    // Only return a match if confidence exceeds 0.5
    if confidence > 0.5 {
        AnchorResult {
            offset: best_offset,
            confidence,
        }
    } else {
        AnchorResult {
            offset: -1,
            confidence,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_line_hashes_basic() {
        let source = b"hello\nworld\n";
        let hashes = compute_line_hashes(Buffer::from(source.to_vec()));
        assert_eq!(hashes.len(), 2);
        // Verify determinism
        let hashes2 = compute_line_hashes(Buffer::from(source.to_vec()));
        assert_eq!(hashes.as_ref(), hashes2.as_ref());
    }

    #[test]
    fn test_compute_line_hashes_no_trailing_newline() {
        let source = b"line1\nline2";
        let hashes = compute_line_hashes(Buffer::from(source.to_vec()));
        assert_eq!(hashes.len(), 2);
    }

    #[test]
    fn test_compute_line_hashes_empty() {
        let source = b"";
        let hashes = compute_line_hashes(Buffer::from(source.to_vec()));
        assert_eq!(hashes.len(), 1); // One empty line
    }

    #[test]
    fn test_compute_line_hashes_single_line() {
        let source = b"single line without newline";
        let hashes = compute_line_hashes(Buffer::from(source.to_vec()));
        assert_eq!(hashes.len(), 1);
    }

    #[test]
    fn test_anchor_lookup_exact_match() {
        let file = b"aaa\nbbb\nccc\nddd\neee\n";
        let hashes = compute_line_hashes(Buffer::from(file.to_vec()));

        // Target is lines "ccc" and "ddd"
        let target_src = b"ccc\nddd\n";
        let target = compute_line_hashes(Buffer::from(target_src.to_vec()));

        let result = anchor_lookup(hashes, target);
        assert_eq!(result.offset, 2);
        assert!((result.confidence - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_anchor_lookup_shifted() {
        // Original file: a, b, c, d, e
        // Modified file: x, y, a, b, c, d, e (inserted 2 lines at top)
        let file = b"xxx\nyyy\naaa\nbbb\nccc\nddd\neee\n";
        let hashes = compute_line_hashes(Buffer::from(file.to_vec()));

        // Target is still "ccc" and "ddd" from original positions
        let target_src = b"ccc\nddd\n";
        let target = compute_line_hashes(Buffer::from(target_src.to_vec()));

        let result = anchor_lookup(hashes, target);
        assert_eq!(result.offset, 4); // shifted by 2
        assert!((result.confidence - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_anchor_lookup_not_found() {
        let file = b"aaa\nbbb\nccc\n";
        let hashes = compute_line_hashes(Buffer::from(file.to_vec()));

        let target_src = b"zzz\nyyy\n";
        let target = compute_line_hashes(Buffer::from(target_src.to_vec()));

        let result = anchor_lookup(hashes, target);
        assert_eq!(result.offset, -1);
        assert!(result.confidence <= 0.5);
    }

    #[test]
    fn test_anchor_lookup_partial_match() {
        // File has "aaa", "bbb", "ccc"
        // Target has "aaa", "zzz", "ccc" — 2/3 match at position 0
        let file = b"aaa\nbbb\nccc\n";
        let hashes = compute_line_hashes(Buffer::from(file.to_vec()));

        let target_src = b"aaa\nzzz\nccc\n";
        let target = compute_line_hashes(Buffer::from(target_src.to_vec()));

        let result = anchor_lookup(hashes, target);
        // 2/3 = 0.667 > 0.5, so should find
        assert_eq!(result.offset, 0);
        assert!(result.confidence > 0.5);
        assert!(result.confidence < 1.0);
    }

    #[test]
    fn test_anchor_lookup_empty_target() {
        let file = b"aaa\nbbb\n";
        let hashes = compute_line_hashes(Buffer::from(file.to_vec()));
        let target = Uint32Array::new(vec![]);

        let result = anchor_lookup(hashes, target);
        assert_eq!(result.offset, -1);
    }
}
