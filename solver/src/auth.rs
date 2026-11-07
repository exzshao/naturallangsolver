//! Shared-secret auth: `x-solver-key` must match `SOLVER_API_KEY`.

use axum::{
    extract::{Request, State},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::error::{Reason, SolveError};
use crate::routes::AppState;

pub const HEADER: &str = "x-solver-key";

/// Compares in time that depends only on the lengths, never on where the
/// first mismatching byte is. (The key length is not secret.)
pub fn keys_match(given: &[u8], expected: &[u8]) -> bool {
    if given.len() != expected.len() {
        return false;
    }
    let diff = given.iter().zip(expected).fold(0u8, |acc, (a, b)| acc | (a ^ b));
    std::hint::black_box(diff) == 0
}

/// Middleware: passes through when no key is configured, otherwise requires a
/// matching header and answers 401 UNAUTHORIZED in the §6 body shape.
pub async fn require_key(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if let Some(expected) = &state.settings.api_key {
        let given = req.headers().get(HEADER).map(|v| v.as_bytes()).unwrap_or_default();
        if !keys_match(given, expected.0.as_bytes()) {
            return SolveError::new(Reason::Unauthorized, "missing or wrong x-solver-key").into_response();
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_bytes_exactly() {
        assert!(keys_match(b"abc123", b"abc123"));
        assert!(!keys_match(b"abc124", b"abc123"));
        assert!(!keys_match(b"abc12", b"abc123"));
        assert!(!keys_match(b"", b"abc123"));
        assert!(keys_match(b"", b""));
    }
}
