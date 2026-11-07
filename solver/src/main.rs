use solver_service::{AppState, Settings, router};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let settings = Settings::from_env();
    let addr = format!("0.0.0.0:{}", settings.port);
    tracing::info!(?settings, "solver-service listening on {addr}");

    let app = router(AppState::new(settings));
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
