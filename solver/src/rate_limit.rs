//! In-memory sliding-window limits for `/admit`. The service runs as a single
//! machine, so these counters are exact (they reset when the process restarts).

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const IP_WINDOW: Duration = Duration::from_secs(60 * 60);
pub const GLOBAL_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Admit,
    /// This IP used its `per_ip` admits in the last hour.
    IpLimited,
    /// All IPs together used `global` admits in the last 24 hours.
    GlobalLimited,
}

#[derive(Debug)]
pub struct RateLimiter {
    per_ip: u32,
    global: u32,
    inner: Mutex<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    /// Admit times per IP, oldest first, within `IP_WINDOW`.
    ips: HashMap<String, VecDeque<Instant>>,
    /// All admit times, oldest first, within `GLOBAL_WINDOW`.
    all: VecDeque<Instant>,
}

fn expire(q: &mut VecDeque<Instant>, now: Instant, window: Duration) {
    while q.front().is_some_and(|&t| now.saturating_duration_since(t) >= window) {
        q.pop_front();
    }
}

impl RateLimiter {
    pub fn new(per_ip: u32, global: u32) -> Self {
        Self { per_ip, global, inner: Mutex::new(Inner::default()) }
    }

    pub fn admit(&self, ip: &str) -> Decision {
        self.admit_at(ip, Instant::now())
    }

    /// Records an admit at `now` if both limits allow it. Refused requests are
    /// not recorded, so they don't use up the window.
    pub fn admit_at(&self, ip: &str, now: Instant) -> Decision {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Inner { ips, all } = &mut *inner;

        // Drop expired entries everywhere. Only admits create entries, and admits
        // are capped by `global`, so the map stays small.
        expire(all, now, GLOBAL_WINDOW);
        ips.retain(|_, q| {
            expire(q, now, IP_WINDOW);
            !q.is_empty()
        });

        let ip_count = ips.get(ip).map_or(0, VecDeque::len);
        if ip_count >= self.per_ip as usize {
            return Decision::IpLimited;
        }
        if all.len() >= self.global as usize {
            return Decision::GlobalLimited;
        }
        ips.entry(ip.to_string()).or_default().push_back(now);
        all.push_back(now);
        Decision::Admit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: Duration = Duration::from_secs(60);

    #[test]
    fn per_ip_limit_then_window_slides() {
        let rl = RateLimiter::new(3, 100);
        let t0 = Instant::now();
        for i in 0..3 {
            assert_eq!(rl.admit_at("1.1.1.1", t0 + MIN * i), Decision::Admit);
        }
        assert_eq!(rl.admit_at("1.1.1.1", t0 + MIN * 10), Decision::IpLimited);
        // Another IP is unaffected.
        assert_eq!(rl.admit_at("2.2.2.2", t0 + MIN * 10), Decision::Admit);
        // The first admit (t0) expires one hour later, freeing one slot.
        assert_eq!(rl.admit_at("1.1.1.1", t0 + IP_WINDOW), Decision::Admit);
        assert_eq!(rl.admit_at("1.1.1.1", t0 + IP_WINDOW), Decision::IpLimited);
    }

    #[test]
    fn refused_requests_are_not_counted() {
        let rl = RateLimiter::new(1, 100);
        let t0 = Instant::now();
        assert_eq!(rl.admit_at("ip", t0), Decision::Admit);
        for i in 1..50 {
            assert_eq!(rl.admit_at("ip", t0 + MIN * i), Decision::IpLimited);
        }
        assert_eq!(rl.admit_at("ip", t0 + IP_WINDOW), Decision::Admit);
    }

    #[test]
    fn global_limit_across_ips_for_a_day() {
        let rl = RateLimiter::new(10, 5);
        let t0 = Instant::now();
        for i in 0..5 {
            assert_eq!(rl.admit_at(&format!("ip{i}"), t0), Decision::Admit);
        }
        assert_eq!(rl.admit_at("fresh", t0 + MIN), Decision::GlobalLimited);
        assert_eq!(rl.admit_at("fresh", t0 + GLOBAL_WINDOW - MIN), Decision::GlobalLimited);
        assert_eq!(rl.admit_at("fresh", t0 + GLOBAL_WINDOW), Decision::Admit);
    }

    #[test]
    fn expired_ips_are_pruned() {
        let rl = RateLimiter::new(10, 1000);
        let t0 = Instant::now();
        for i in 0..100 {
            rl.admit_at(&format!("ip{i}"), t0);
        }
        rl.admit_at("late", t0 + IP_WINDOW);
        let inner = rl.inner.lock().unwrap();
        assert_eq!(inner.ips.len(), 1);
        assert_eq!(inner.all.len(), 101);
    }

    #[test]
    fn zero_limits_refuse_everything() {
        assert_eq!(RateLimiter::new(0, 10).admit("ip"), Decision::IpLimited);
        assert_eq!(RateLimiter::new(10, 0).admit("ip"), Decision::GlobalLimited);
    }
}
