use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const CANCELLED: &str = "图片复制已取消。";
type Pixels = Arc<Vec<u8>>;

struct Cached {
    id: Uuid,
    key: [u8; 32],
    pixels: Pixels,
    expires: Instant,
    scope: CancellationToken,
    timer: CancellationToken,
}

impl Drop for Cached {
    fn drop(&mut self) {
        self.timer.cancel();
    }
}

#[derive(Default)]
struct State {
    pending: Option<(Uuid, CancellationToken)>,
    cached: Option<Cached>,
}

pub struct ImageCopies {
    state: Arc<Mutex<State>>,
    worker: Arc<Semaphore>,
    max_bytes: usize,
    ttl: Duration,
}

impl Default for ImageCopies {
    fn default() -> Self {
        Self::new(64 * 1024 * 1024, Duration::from_secs(20))
    }
}

impl ImageCopies {
    fn new(max_bytes: usize, ttl: Duration) -> Self {
        Self {
            state: Arc::default(),
            worker: Arc::new(Semaphore::new(1)),
            max_bytes,
            ttl,
        }
    }

    pub fn begin(&self, scope: &CancellationToken) -> Result<CopyJob, &'static str> {
        let mut state = self.state.lock().map_err(|_| CANCELLED)?;
        if let Some((_, previous)) = state.pending.take() {
            previous.cancel();
        }
        if state
            .cached
            .as_ref()
            .is_some_and(|cache| cache.expires <= Instant::now() || cache.scope.is_cancelled())
        {
            state.cached = None;
        }
        let id = Uuid::new_v4();
        let cancel = scope.child_token();
        state.pending = Some((id, cancel.clone()));
        Ok(CopyJob {
            id,
            cancel,
            scope: scope.clone(),
            state: self.state.clone(),
            worker: self.worker.clone(),
            max_bytes: self.max_bytes,
            ttl: self.ttl,
        })
    }
}

pub struct CopyJob {
    id: Uuid,
    cancel: CancellationToken,
    scope: CancellationToken,
    state: Arc<Mutex<State>>,
    worker: Arc<Semaphore>,
    max_bytes: usize,
    ttl: Duration,
}

impl CopyJob {
    pub fn cancel(&self) -> &CancellationToken {
        &self.cancel
    }

    pub async fn slot(&self) -> Result<OwnedSemaphorePermit, &'static str> {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(CANCELLED),
            permit = self.worker.clone().acquire_owned() => permit.map_err(|_| CANCELLED),
        }
    }

    fn current(&self, state: &State) -> bool {
        !self.cancel.is_cancelled() && state.pending.as_ref().is_some_and(|(id, _)| *id == self.id)
    }

    // The caller must re-read the authorized message before looking up pixels.
    // Only immutable media from the same session, route and message can match.
    pub fn cached(&self, key: [u8; 32]) -> Result<Option<Pixels>, &'static str> {
        let mut state = self.state.lock().map_err(|_| CANCELLED)?;
        if !self.current(&state) {
            return Err(CANCELLED);
        }
        if state.cached.as_ref().is_some_and(|cache| {
            cache.key != key || cache.expires <= Instant::now() || cache.scope.is_cancelled()
        }) {
            state.cached = None;
        }
        Ok(state.cached.as_ref().map(|cache| cache.pixels.clone()))
    }

    pub fn commit(
        self,
        key: [u8; 32],
        pixels: Pixels,
        write: impl FnOnce(&[u8]) -> Result<(), &'static str>,
    ) -> Result<(), &'static str> {
        let mut state = self.state.lock().map_err(|_| CANCELLED)?;
        if !self.current(&state) {
            return Err(CANCELLED);
        }
        write(&pixels)?;
        state.cached = None;
        if pixels.len() <= self.max_bytes && !self.ttl.is_zero() {
            let timer = CancellationToken::new();
            state.cached = Some(Cached {
                id: self.id,
                key,
                pixels,
                expires: Instant::now() + self.ttl,
                scope: self.scope.clone(),
                timer: timer.clone(),
            });
            let weak = Arc::downgrade(&self.state);
            let id = self.id;
            let ttl = self.ttl;
            tokio::spawn(async move {
                tokio::select! {
                    biased;
                    _ = timer.cancelled() => return,
                    _ = tokio::time::sleep(ttl) => {}
                }
                if let Some(state) = weak.upgrade() {
                    if let Ok(mut state) = state.lock() {
                        if state.cached.as_ref().is_some_and(|cache| cache.id == id) {
                            state.cached = None;
                        }
                    }
                }
            });
        }
        state.pending = None;
        Ok(())
    }
}

impl Drop for CopyJob {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Ok(mut state) = self.state.lock() {
            if state.pending.as_ref().is_some_and(|(id, _)| *id == self.id) {
                state.pending = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn repeated_selected_image_reuses_only_successful_pixels() {
        let copies = ImageCopies::default();
        let scope = CancellationToken::new();
        let pixels = Arc::new(vec![1, 2, 3]);
        let first = copies.begin(&scope).unwrap();
        assert!(first.cached([1; 32]).unwrap().is_none());
        first.commit([1; 32], pixels.clone(), |_| Ok(())).unwrap();
        let second = copies.begin(&scope).unwrap();
        assert!(Arc::ptr_eq(
            &second.cached([1; 32]).unwrap().unwrap(),
            &pixels
        ));
    }

    #[tokio::test]
    async fn later_selection_cancels_old_download_and_cannot_be_overwritten() {
        let copies = ImageCopies::default();
        let scope = CancellationToken::new();
        let older = copies.begin(&scope).unwrap();
        let newer = copies.begin(&scope).unwrap();
        assert!(older.cancel().is_cancelled());
        assert!(older
            .commit([1; 32], Arc::new(vec![1]), |_| panic!(
                "stale clipboard write"
            ))
            .is_err());
        newer
            .commit([2; 32], Arc::new(vec![2]), |bytes| {
                assert_eq!(bytes, &[2]);
                Ok(())
            })
            .unwrap();
    }

    #[tokio::test]
    async fn account_or_message_changes_do_not_reuse_pixels() {
        let copies = ImageCopies::default();
        let scope = CancellationToken::new();
        copies
            .begin(&scope)
            .unwrap()
            .commit([1; 32], Arc::new(vec![1]), |_| Ok(()))
            .unwrap();
        assert!(copies
            .begin(&scope)
            .unwrap()
            .cached([2; 32])
            .unwrap()
            .is_none());
        copies
            .begin(&scope)
            .unwrap()
            .commit([1; 32], Arc::new(vec![1]), |_| Ok(()))
            .unwrap();
        scope.cancel();
        assert!(copies
            .begin(&CancellationToken::new())
            .unwrap()
            .cached([1; 32])
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn cancelled_scope_and_failed_write_preserve_clipboard() {
        let copies = ImageCopies::default();
        let scope = CancellationToken::new();
        let job = copies.begin(&scope).unwrap();
        scope.cancel();
        assert!(job
            .commit([1; 32], Arc::new(vec![1]), |_| panic!(
                "cancelled clipboard write"
            ))
            .is_err());
        let scope = CancellationToken::new();
        assert!(copies
            .begin(&scope)
            .unwrap()
            .commit([1; 32], Arc::new(vec![1]), |_| Err("busy"))
            .is_err());
        assert!(copies
            .begin(&scope)
            .unwrap()
            .cached([1; 32])
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn cache_has_a_hard_size_limit_and_releases_expired_pixels() {
        let copies = ImageCopies::new(2, Duration::from_millis(5));
        let scope = CancellationToken::new();
        copies
            .begin(&scope)
            .unwrap()
            .commit([1; 32], Arc::new(vec![1, 2, 3]), |_| Ok(()))
            .unwrap();
        assert!(copies
            .begin(&scope)
            .unwrap()
            .cached([1; 32])
            .unwrap()
            .is_none());
        let pixels = Arc::new(vec![1]);
        copies
            .begin(&scope)
            .unwrap()
            .commit([1; 32], pixels.clone(), |_| Ok(()))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert_eq!(Arc::strong_count(&pixels), 1);
    }

    #[tokio::test]
    async fn cancellation_does_not_leave_an_old_copy_waiting_for_the_worker() {
        let copies = ImageCopies::default();
        let scope = CancellationToken::new();
        let first = copies.begin(&scope).unwrap();
        let occupied = first.slot().await.unwrap();
        let second = copies.begin(&scope).unwrap();
        let third = copies.begin(&scope).unwrap();
        assert!(second.slot().await.is_err());
        drop(occupied);
        assert!(third.slot().await.is_ok());
    }
}
