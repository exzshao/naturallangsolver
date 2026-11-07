//! Solver service: thin HTTP wrapper around b-inary's `postflop-solver`.
//! See ../SPEC.md §7-8 for the contract.

pub mod api;
pub mod config;
pub mod error;
pub mod routes;
pub mod solve;
pub mod summary;
pub mod tree_size;

pub use config::Settings;
pub use routes::{AppState, router};
