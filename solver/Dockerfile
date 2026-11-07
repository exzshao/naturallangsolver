# syntax=docker/dockerfile:1
# Build: rust (bookworm) -> release binary. Run: debian:bookworm-slim, non-root.

FROM rust:1-slim-bookworm AS build
# postflop-solver is a git dependency: cargo needs git and TLS roots to fetch it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates pkg-config \
 && rm -rf /var/lib/apt/lists/*
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true
WORKDIR /app

# Cache dependencies: build once against stub sources, then copy the real ones.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs \
 && cargo build --release --locked \
 && rm -rf src

COPY src ./src
RUN touch src/main.rs src/lib.rs && cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home solver
COPY --from=build /app/target/release/solver-service /usr/local/bin/solver-service
USER solver
ENV PORT=8080
EXPOSE 8080
CMD ["solver-service"]
