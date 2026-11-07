//! "Can't solve" reasons (SPEC §6) and mapping of `postflop-solver` errors to them.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};

use crate::api::ErrorBody;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Body is not valid JSON or is missing fields. Not in SPEC §6; added so
    /// malformed requests still get the §6 body shape.
    InvalidRequest,
    InvalidBoard,
    InvalidRange,
    InvalidBetSizes,
    InvalidStacks,
    TreeTooLarge,
    Timeout,
    SolverBusy,
    Internal,
}

impl Reason {
    pub fn code(self) -> &'static str {
        match self {
            Reason::InvalidRequest => "INVALID_REQUEST",
            Reason::InvalidBoard => "INVALID_BOARD",
            Reason::InvalidRange => "INVALID_RANGE",
            Reason::InvalidBetSizes => "INVALID_BET_SIZES",
            Reason::InvalidStacks => "INVALID_STACKS",
            Reason::TreeTooLarge => "TREE_TOO_LARGE",
            Reason::Timeout => "TIMEOUT",
            Reason::SolverBusy => "SOLVER_BUSY",
            Reason::Internal => "INTERNAL",
        }
    }

    pub fn status(self) -> StatusCode {
        match self {
            Reason::SolverBusy => StatusCode::SERVICE_UNAVAILABLE,
            Reason::Timeout => StatusCode::GATEWAY_TIMEOUT,
            Reason::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Reason::InvalidRequest => "Can't solve this: the solver request was malformed.",
            Reason::InvalidBoard => {
                "Can't solve this: the board must be 3-5 distinct valid cards, and the hero hand can't overlap it."
            }
            Reason::InvalidRange => {
                "Can't solve this: a range couldn't be parsed or is empty after board blockers."
            }
            Reason::InvalidBetSizes => "Can't solve this: the bet sizes aren't valid.",
            Reason::InvalidStacks => "Can't solve this: pot and stack sizes must be positive.",
            Reason::TreeTooLarge => {
                "Can't solve this: the game tree is too large to solve within the memory limit."
            }
            Reason::Timeout => "Can't solve this: the solve didn't converge within the time limit.",
            Reason::SolverBusy => "Can't solve this right now: the solver is busy. Try again shortly.",
            Reason::Internal => "Can't solve this: the solver hit an unexpected error.",
        }
    }
}

/// An error carrying a §6 reason plus a detail string for logs (not sent to clients).
#[derive(Debug, Clone)]
pub struct SolveError {
    pub reason: Reason,
    pub detail: String,
}

impl SolveError {
    pub fn new(reason: Reason, detail: impl Into<String>) -> Self {
        Self { reason, detail: detail.into() }
    }

    /// Wraps an `Err(String)` from `ActionTree::new` / `PostFlopGame::with_config`.
    pub fn from_crate(msg: impl Into<String>) -> Self {
        let msg = msg.into();
        Self { reason: map_crate_error(&msg), detail: msg }
    }

    pub fn body(&self) -> ErrorBody {
        ErrorBody {
            status: "cant_solve".into(),
            reason: self.reason.code().into(),
            message: self.reason.message().into(),
        }
    }
}

impl std::fmt::Display for SolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.reason.code(), self.detail)
    }
}

impl IntoResponse for SolveError {
    fn into_response(self) -> Response {
        tracing::warn!(reason = self.reason.code(), detail = %self.detail, "solve rejected");
        (self.reason.status(), Json(self.body())).into_response()
    }
}

/// Maps a `postflop-solver` error string to a §6 reason by substring.
/// Falls back to `Internal` for anything unrecognised.
pub fn map_crate_error(msg: &str) -> Reason {
    const BOARD: &[&str] = &[
        "Flop cards",
        "Turn card",
        "River card",
        "Cards must be unique",
        "Invalid initial state",
        "Expected exactly",
        "Expected rank character",
        "Expected suit character",
    ];
    const RANGE: &[&str] = &[
        "range is empty",
        "range is invalid",
        "Valid card assignment does not exist",
        "Valid combination not found",
        "Failed to parse range",
        "Invalid weight",
        "Invalid suitedness",
        "suitedness is not allowed",
        "The first rank must be",
        "Duplicate cards are not allowed",
        "descending order",
        "Suitedness does not match",
        "Invalid range",
    ];
    const STACKS: &[&str] = &["Starting pot must be positive", "Effective stack must be positive"];
    const TOO_LARGE: &[&str] = &["Too many nodes", "Memory usage exceeds"];
    const BET: &[&str] = &[
        "bet size",
        "Multiplier must be",
        "Additional size",
        "Raise cap",
        "Number of streets",
        "threshold",
        "Relative size to the previous bet",
    ];

    let hit = |needles: &[&str]| needles.iter().any(|n| msg.contains(n));
    if hit(TOO_LARGE) {
        Reason::TreeTooLarge
    } else if hit(STACKS) {
        Reason::InvalidStacks
    } else if hit(RANGE) {
        Reason::InvalidRange
    } else if hit(BOARD) {
        Reason::InvalidBoard
    } else if hit(BET) {
        Reason::InvalidBetSizes
    } else {
        Reason::Internal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_board_errors() {
        for m in [
            "Flop cards must be unique: flop = [1, 1, 2]",
            "Turn card must be different from flop cards: turn = 3",
            "River card must be different from turn card: river = 4",
            "Cards must be unique",
            "Invalid initial state of `tree_config`: expected = Flop, actual = Turn",
        ] {
            assert_eq!(map_crate_error(m), Reason::InvalidBoard, "{m}");
        }
    }

    #[test]
    fn maps_range_errors() {
        for m in [
            "OOP range is empty",
            "IP range is empty",
            "Valid card assignment does not exist",
            "Failed to parse range: XYZ",
            "Invalid weight: 2",
        ] {
            assert_eq!(map_crate_error(m), Reason::InvalidRange, "{m}");
        }
    }

    #[test]
    fn maps_bet_size_errors() {
        for m in [
            "Invalid bet size: 33",
            "Relative size to the previous bet is not allowed: 3x",
            "Multiplier must be greater than 1.0: 0.5x",
            "Add all-in threshold must be non-negative: -1",
        ] {
            assert_eq!(map_crate_error(m), Reason::InvalidBetSizes, "{m}");
        }
    }

    #[test]
    fn maps_stack_size_and_fallback() {
        assert_eq!(map_crate_error("Starting pot must be positive: 0"), Reason::InvalidStacks);
        assert_eq!(map_crate_error("Effective stack must be positive: -5"), Reason::InvalidStacks);
        assert_eq!(map_crate_error("Too many nodes"), Reason::TreeTooLarge);
        assert_eq!(map_crate_error("Invalid terminal is found in action tree"), Reason::Internal);
        assert_eq!(map_crate_error("something new"), Reason::Internal);
    }

    #[test]
    fn status_codes() {
        assert_eq!(Reason::InvalidBoard.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(Reason::TreeTooLarge.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(Reason::SolverBusy.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(Reason::Timeout.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(Reason::Internal.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn body_shape() {
        let b = SolveError::new(Reason::InvalidBoard, "dup").body();
        assert_eq!(b.status, "cant_solve");
        assert_eq!(b.reason, "INVALID_BOARD");
        assert!(b.message.starts_with("Can't solve this"));
    }
}
