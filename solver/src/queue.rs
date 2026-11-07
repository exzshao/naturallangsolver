//! Bounded FIFO queue in front of the single solve slot.
//!
//! One solve runs at a time (rayon already uses every core). Up to
//! `max_waiting` more requests wait in arrival order, each for at most
//! `max_wait`. A full queue or an expired wait is `SOLVER_BUSY`.
//!
//! `tokio::sync::Semaphore` is also FIFO, but it can't report a waiter's
//! position, and a waiter only joins its queue when its future is first
//! polled. So the order lives in an explicit `VecDeque` here: positions are
//! exact and the hand-off is strictly first come, first served.
//!
//! Dropping a [`Ticket`] (client disconnect, timeout) removes it from the line;
//! dropping a [`Permit`] frees the slot. Both wake the remaining waiters.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueError {
    /// `max_waiting` requests are already waiting.
    Full,
    /// Waited `max_wait` without reaching the slot.
    TimedOut,
}

#[derive(Debug, Default)]
struct State {
    running: bool,
    /// Ticket ids, first in line at the front.
    waiting: VecDeque<u64>,
    next_id: u64,
}

#[derive(Debug)]
struct Inner {
    max_waiting: usize,
    max_wait: Duration,
    state: Mutex<State>,
    /// Bumped on every state change; waiters re-check when it moves.
    changed: watch::Sender<u64>,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn notify(&self) {
        self.changed.send_modify(|v| *v = v.wrapping_add(1));
    }
}

#[derive(Debug, Clone)]
pub struct SolveQueue {
    inner: Arc<Inner>,
}

/// Outcome of [`SolveQueue::join`].
#[derive(Debug)]
pub enum Admission {
    /// The slot was free and nobody was waiting: run now.
    Ready(Permit),
    /// In line; call [`Ticket::wait`].
    Queued(Ticket),
}

impl SolveQueue {
    pub fn new(max_waiting: usize, max_wait: Duration) -> Self {
        let (changed, _) = watch::channel(0);
        Self {
            inner: Arc::new(Inner { max_waiting, max_wait, state: Mutex::new(State::default()), changed }),
        }
    }

    /// Takes the slot if it's free and nobody is waiting, else joins the back of
    /// the line, else `Full`.
    pub fn join(&self) -> Result<Admission, QueueError> {
        let mut st = self.inner.lock();
        if !st.running && st.waiting.is_empty() {
            st.running = true;
            return Ok(Admission::Ready(Permit { inner: self.inner.clone() }));
        }
        if st.waiting.len() >= self.inner.max_waiting {
            return Err(QueueError::Full);
        }
        let id = st.next_id;
        st.next_id += 1;
        st.waiting.push_back(id);
        // Subscribe under the lock so no change after this point is missed.
        let rx = self.inner.changed.subscribe();
        drop(st);
        Ok(Admission::Queued(Ticket {
            inner: self.inner.clone(),
            id,
            rx,
            deadline: Instant::now() + self.inner.max_wait,
            in_line: true,
        }))
    }

    /// Takes the slot only if it's free and nobody is waiting (tests, tools).
    pub fn try_acquire(&self) -> Option<Permit> {
        match self.join() {
            Ok(Admission::Ready(p)) => Some(p),
            Ok(Admission::Queued(_)) | Err(_) => None,
        }
    }

    /// Number of requests waiting (not counting the running solve).
    pub fn waiting(&self) -> usize {
        self.inner.lock().waiting.len()
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().running
    }
}

/// Holds the solve slot until dropped.
#[derive(Debug)]
pub struct Permit {
    inner: Arc<Inner>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.inner.lock().running = false;
        self.inner.notify();
    }
}

/// A place in line. Dropping it leaves the line.
#[derive(Debug)]
pub struct Ticket {
    inner: Arc<Inner>,
    id: u64,
    rx: watch::Receiver<u64>,
    deadline: Instant,
    in_line: bool,
}

impl Ticket {
    /// 1-based place in line (1 = next to run), or 0 if no longer in line.
    pub fn position(&self) -> usize {
        let st = self.inner.lock();
        st.waiting.iter().position(|&i| i == self.id).map_or(0, |i| i + 1)
    }

    /// Waits for the slot. Calls `on_position` with the current position right
    /// away and again whenever it changes. Cancel-safe: dropping the future
    /// drops the ticket, which leaves the line.
    pub async fn wait(mut self, mut on_position: impl FnMut(usize)) -> Result<Permit, QueueError> {
        let mut last = 0;
        loop {
            {
                let mut st = self.inner.lock();
                let idx = st.waiting.iter().position(|&i| i == self.id);
                match idx {
                    Some(0) if !st.running => {
                        st.waiting.pop_front();
                        st.running = true;
                        self.in_line = false;
                        drop(st);
                        // Others move up one place.
                        self.inner.notify();
                        return Ok(Permit { inner: self.inner.clone() });
                    }
                    Some(i) => {
                        if i + 1 != last {
                            last = i + 1;
                            drop(st);
                            on_position(last);
                        }
                    }
                    // Not reachable: only Drop removes a ticket that's still in line.
                    None => return Err(QueueError::TimedOut),
                }
            }
            match tokio::time::timeout_at(self.deadline, self.rx.changed()).await {
                Ok(Ok(())) => {}
                // Timed out, or the sender is gone (can't happen: `inner` owns it).
                Ok(Err(_)) | Err(_) => return Err(QueueError::TimedOut),
            }
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.in_line {
            return;
        }
        let mut st = self.inner.lock();
        st.waiting.retain(|&i| i != self.id);
        drop(st);
        self.inner.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc as StdArc;
    use tokio::sync::Mutex as AsyncMutex;

    fn queued(q: &SolveQueue) -> Ticket {
        match q.join().unwrap() {
            Admission::Queued(t) => t,
            Admission::Ready(_) => panic!("expected to queue"),
        }
    }

    #[tokio::test]
    async fn runs_immediately_when_idle() {
        let q = SolveQueue::new(2, Duration::from_secs(1));
        let p = q.try_acquire().expect("idle queue admits");
        assert!(q.is_running());
        assert!(q.try_acquire().is_none());
        drop(p);
        assert!(!q.is_running());
        assert!(q.try_acquire().is_some());
    }

    #[tokio::test]
    async fn full_when_max_waiting_reached() {
        let q = SolveQueue::new(2, Duration::from_secs(1));
        let _running = q.try_acquire().unwrap();
        let _a = queued(&q);
        let _b = queued(&q);
        assert_eq!(q.join().unwrap_err(), QueueError::Full);
        assert_eq!(q.waiting(), 2);
    }

    #[tokio::test]
    async fn zero_waiting_is_immediate_busy() {
        let q = SolveQueue::new(0, Duration::from_secs(1));
        let _running = q.try_acquire().unwrap();
        assert_eq!(q.join().unwrap_err(), QueueError::Full);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_times_out_and_leaves_the_line() {
        let q = SolveQueue::new(2, Duration::from_secs(120));
        let _running = q.try_acquire().unwrap();
        let t = queued(&q);
        let start = Instant::now();
        assert_eq!(t.wait(|_| {}).await.unwrap_err(), QueueError::TimedOut);
        assert_eq!(start.elapsed(), Duration::from_secs(120));
        assert_eq!(q.waiting(), 0);
    }

    #[tokio::test]
    async fn fifo_order_and_positions() {
        let q = SolveQueue::new(5, Duration::from_secs(10));
        let running = q.try_acquire().unwrap();
        let order = StdArc::new(AsyncMutex::new(Vec::new()));
        let positions = StdArc::new(std::sync::Mutex::new(vec![Vec::new(); 4]));
        let mut handles = Vec::new();
        for n in 0..4 {
            let t = queued(&q);
            assert_eq!(t.position(), n + 1);
            let (order, positions) = (order.clone(), positions.clone());
            handles.push(tokio::spawn(async move {
                let permit = t.wait(|p| positions.lock().unwrap()[n].push(p)).await.unwrap();
                order.lock().await.push(n);
                tokio::task::yield_now().await;
                drop(permit);
            }));
        }
        tokio::task::yield_now().await;
        drop(running);
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(*order.lock().await, vec![0, 1, 2, 3]);
        let positions = positions.lock().unwrap();
        // Each waiter saw its starting place first, then strictly smaller ones
        // down to 1 (wake-ups may coalesce, so steps can be skipped).
        for (n, seen) in positions.iter().enumerate() {
            assert_eq!(seen.first(), Some(&(n + 1)), "{seen:?}");
            assert_eq!(seen.last(), Some(&1), "{seen:?}");
            assert!(seen.windows(2).all(|w| w[0] > w[1]), "{seen:?}");
        }
    }

    #[tokio::test]
    async fn dropped_ticket_frees_its_place() {
        let q = SolveQueue::new(2, Duration::from_secs(10));
        let running = q.try_acquire().unwrap();
        let a = queued(&q);
        let b = queued(&q);
        assert_eq!(q.join().unwrap_err(), QueueError::Full);
        assert_eq!(b.position(), 2);
        drop(a);
        assert_eq!(b.position(), 1);
        let _c = queued(&q);
        drop(running);
        let permit = tokio::time::timeout(Duration::from_secs(1), b.wait(|_| {})).await.unwrap().unwrap();
        drop(permit);
    }

    #[tokio::test]
    async fn cancelled_wait_leaves_the_line() {
        let q = SolveQueue::new(2, Duration::from_secs(10));
        let _running = q.try_acquire().unwrap();
        let t = queued(&q);
        let h = tokio::spawn(t.wait(|_| {}));
        tokio::task::yield_now().await;
        assert_eq!(q.waiting(), 1);
        h.abort();
        let _ = h.await;
        assert_eq!(q.waiting(), 0);
    }
}
