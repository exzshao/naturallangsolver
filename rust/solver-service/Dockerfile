FROM rust:1.81 as builder
WORKDIR /app
# Expect build context = project root (docker build -f rust/solver-service/Dockerfile .)
COPY . .
WORKDIR /app/rust/solver-service
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/rust/solver-service/target/release/solver-service /usr/local/bin/solver-service
ENV PORT=8080
EXPOSE 8080
CMD ["/usr/local/bin/solver-service"]


