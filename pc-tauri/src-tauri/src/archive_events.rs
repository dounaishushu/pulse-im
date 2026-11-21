use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Position {
    cursor: i64,
    pending: i64,
    running: bool,
}

pub(crate) struct Watch {
    position: Mutex<Position>,
    pub cancel: CancellationToken,
}

impl Watch {
    pub fn new(cursor: i64, parent: &CancellationToken) -> Self {
        Self {
            position: Mutex::new(Position {
                cursor,
                pending: cursor,
                running: false,
            }),
            cancel: parent.child_token(),
        }
    }

    /// Coalesces hints arriving while a previously queued range is being checked.
    pub fn hint(&self, through: i64) -> bool {
        let Ok(mut state) = self.position.lock() else {
            return false;
        };
        if self.cancel.is_cancelled() || through <= state.cursor {
            return false;
        }
        state.pending = state.pending.max(through);
        if state.running {
            return false;
        }
        state.running = true;
        true
    }

    pub fn next(&self) -> Option<(i64, i64)> {
        let mut state = self.position.lock().ok()?;
        if self.cancel.is_cancelled() || state.pending <= state.cursor {
            state.running = false;
            return None;
        }
        Some((state.cursor, state.pending))
    }

    pub fn finish(&self, through: i64) {
        if let Ok(mut state) = self.position.lock() {
            state.cursor = through;
        }
    }
}
