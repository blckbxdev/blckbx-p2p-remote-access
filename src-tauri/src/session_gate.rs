use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct GateInner {
    pub allow_remote_control: bool,
    move_window_start: Instant,
    move_events: u32,
    key_burst_start: Instant,
    key_burst: u32,
}

impl GateInner {
    pub fn reset_closed(&mut self) {
        self.allow_remote_control = false;
        self.move_events = 0;
        self.key_burst = 0;
    }

    pub fn configure_from_hub(&mut self, gated: bool, control_mode: &str) {
        if !gated {
            self.reset_closed();
            return;
        }

        let m = control_mode.trim().to_lowercase();
        self.allow_remote_control = m == "full" || m == "interactive" || m.contains("control");
        if !self.allow_remote_control {
            self.move_events = 0;
            self.key_burst = 0;
        }
    }

    pub fn assert_pointer_budget(&mut self) -> Result<(), String> {
        if !self.allow_remote_control {
            return Err("Remote injection is disabled — session is idle or restricted to viewing.".into());
        }

        let now = Instant::now();
        if now.duration_since(self.move_window_start) > Duration::from_millis(240) {
            self.move_window_start = now;
            self.move_events = 0;
        }
        self.move_events += 1;
        if self.move_events > 480 {
            return Err("Too many mouse move events — slowing down.".into());
        }
        Ok(())
    }

    pub fn assert_keyboard_budget(&mut self) -> Result<(), String> {
        if !self.allow_remote_control {
            return Err("Remote injection is disabled — session is idle or restricted to viewing.".into());
        }

        let now = Instant::now();
        if now.duration_since(self.key_burst_start) > Duration::from_millis(380) {
            self.key_burst_start = now;
            self.key_burst = 0;
        }
        self.key_burst += 1;
        if self.key_burst > 140 {
            return Err("Too many keystrokes burst — paused briefly.".into());
        }
        Ok(())
    }

    pub fn assert_paste_budget(&mut self, len: usize) -> Result<(), String> {
        if !self.allow_remote_control {
            return Err("Remote injection is disabled — session is idle or restricted to viewing.".into());
        }
        if len > 4000 {
            return Err("Text payload exceeds hardened limit.".into());
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct SessionInputGate(pub Arc<Mutex<GateInner>>);

impl SessionInputGate {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(GateInner {
            allow_remote_control: false,
            move_window_start: Instant::now(),
            move_events: 0,
            key_burst_start: Instant::now(),
            key_burst: 0,
        })))
    }

    pub fn seal(&self) {
        if let Ok(mut g) = self.0.lock() {
            g.reset_closed();
        }
    }

    pub fn sync_hub(&self, gated: bool, mode: &str) {
        if let Ok(mut g) = self.0.lock() {
            g.configure_from_hub(gated, mode);
        }
    }

    pub fn consume_move_budget(&self) -> Result<(), String> {
        self.0.lock().map_err(|_| "input gate poisoned".to_string())?.assert_pointer_budget()
    }

    pub fn consume_key_budget(&self) -> Result<(), String> {
        self.0.lock().map_err(|_| "input gate poisoned".to_string())?.assert_keyboard_budget()
    }

    pub fn consume_paste_budget(&self, len: usize) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "input gate poisoned".to_string())?
            .assert_paste_budget(len)
    }
}
