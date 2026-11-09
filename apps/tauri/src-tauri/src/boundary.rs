use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BeginClose {
    Started,
    AlreadyPending,
    IdCollision,
    ShuttingDown,
}

#[derive(Default)]
pub(crate) struct CloseLedger {
    pending: HashMap<String, String>,
    shutting_down: bool,
}

impl CloseLedger {
    pub(crate) fn begin(&mut self, window_label: &str, request_id: &str) -> BeginClose {
        if self.shutting_down {
            return BeginClose::ShuttingDown;
        }
        if self.pending.values().any(|label| label == window_label) {
            return BeginClose::AlreadyPending;
        }
        if self.pending.contains_key(request_id) {
            return BeginClose::IdCollision;
        }
        self.pending
            .insert(request_id.to_owned(), window_label.to_owned());
        BeginClose::Started
    }

    pub(crate) fn settle(&mut self, request_id: &str) -> Option<String> {
        if self.shutting_down {
            return None;
        }
        let window_label = self.pending.remove(request_id)?;
        self.shutting_down = true;
        self.pending.clear();
        Some(window_label)
    }
}

pub(crate) fn is_success_status(status: u16) -> bool {
    (200..=299).contains(&status)
}

#[cfg(test)]
mod tests {
    use super::{is_success_status, BeginClose, CloseLedger};

    #[test]
    fn close_ledger_settles_once_and_blocks_new_requests_during_shutdown() {
        let mut ledger = CloseLedger::default();
        let request_id = "close-1".to_owned();
        assert_eq!(ledger.begin("main", &request_id), BeginClose::Started);
        assert_eq!(ledger.begin("main", "close-2"), BeginClose::AlreadyPending);
        assert_eq!(ledger.settle(&request_id).as_deref(), Some("main"));
        assert_eq!(ledger.settle(&request_id), None);
        assert_eq!(ledger.begin("main", "close-3"), BeginClose::ShuttingDown);
    }

    #[test]
    fn close_ledger_rejects_request_id_collisions() {
        let mut ledger = CloseLedger::default();
        assert_eq!(ledger.begin("main", "same-id"), BeginClose::Started);
        assert_eq!(ledger.begin("other", "same-id"), BeginClose::IdCollision);
    }

    #[test]
    fn update_status_accepts_only_the_complete_2xx_range() {
        assert!(!is_success_status(199));
        assert!(is_success_status(200));
        assert!(is_success_status(299));
        assert!(!is_success_status(300));
        assert!(!is_success_status(302));
        assert!(!is_success_status(400));
    }
}
