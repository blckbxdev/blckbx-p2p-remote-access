use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, RwLock},
};

#[derive(Clone, Serialize)]
pub struct ClientIdentityDto {
    pub client_id: String,
    #[serde(rename = "sessionPassword")]
    pub session_password: String,
    #[serde(rename = "passwordExpiresAt")]
    pub password_expires_at_iso: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredIdentity {
    client_id: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Preferences {
    #[serde(default, rename = "setupComplete", alias = "setup_complete")]
    pub setup_complete: bool,
    #[serde(default, rename = "trustLoopbackLab", alias = "trust_loopback_lab")]
    pub trust_loopback_lab: bool,
    #[serde(
        default,
        rename = "loopbackAutoFullControl",
        alias = "loopback_auto_full_control"
    )]
    pub loopback_auto_full_control: bool,
    #[serde(
        default = "default_true",
        rename = "allowViewerPrivacyBlackout",
        alias = "allow_viewer_privacy_blackout"
    )]
    pub allow_viewer_privacy_blackout: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            setup_complete: false,
            trust_loopback_lab: false,
            loopback_auto_full_control: false,
            allow_viewer_privacy_blackout: true,
        }
    }
}

fn app_dir() -> Result<PathBuf, String> {
    let dir = dirs::data_dir()
        .ok_or_else(|| "No data directory".to_string())?
        .join("SimpleAnyDesk");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn gen_digits(len: usize) -> String {
    let mut rng = rand::thread_rng();
    let first: u32 = rng.gen_range(1..10);
    let rest: String = (1..len)
        .map(|_| rng.gen_range(0..10).to_string())
        .collect();
    format!("{first}{rest}")
}

fn gen_session_pw() -> String {
    let mut rng = rand::thread_rng();
    const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
    (0..12)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

#[derive(Clone)]
pub struct IdentityState {
    dir: Arc<PathBuf>,
    client_id: Arc<RwLock<String>>,
    pub session_password: Arc<RwLock<(String, DateTime<Utc>)>>,
}

impl IdentityState {
    pub fn load() -> Result<Self, String> {
        let dir = Arc::new(app_dir()?);
        let identity_path = dir.join("identity.json");
        let client_id = if identity_path.exists() {
            let raw = fs::read_to_string(&identity_path).map_err(|e| e.to_string())?;
            let parsed: StoredIdentity = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            parsed.client_id
        } else {
            let cid = gen_digits(9);
            let payload = StoredIdentity {
                client_id: cid.clone(),
            };
            fs::write(
                &identity_path,
                serde_json::to_vec_pretty(&payload).unwrap(),
            )
            .map_err(|e| e.to_string())?;
            cid
        };

        let pw = gen_session_pw();
        let exp = Utc::now() + Duration::minutes(15);

        Ok(Self {
            dir,
            client_id: Arc::new(RwLock::new(client_id)),
            session_password: Arc::new(RwLock::new((pw, exp))),
        })
    }

    pub fn dto(&self) -> ClientIdentityDto {
        let client_id = self.client_id.read().unwrap().clone();
        let (pw, exp) = {
            let g = self.session_password.read().unwrap();
            g.clone()
        };
        ClientIdentityDto {
            client_id,
            session_password: pw,
            password_expires_at_iso: exp.to_rfc3339(),
        }
    }

    pub fn prefs_path(&self) -> PathBuf {
        self.dir.join("preferences.json")
    }

    pub fn load_prefs(&self) -> Preferences {
        let p = self.prefs_path();
        if !p.exists() {
            return Preferences::default();
        }
        fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save_prefs(&self, prefs: &Preferences) -> Result<(), String> {
        fs::write(
            self.prefs_path(),
            serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    }

    pub fn refresh_session_password(&self) -> ClientIdentityDto {
        let nw = gen_session_pw();
        let exp = Utc::now() + Duration::minutes(15);
        {
            let mut w = self.session_password.write().unwrap();
            *w = (nw, exp);
        }
        self.dto()
    }

    pub fn verify_session_password(&self, candidate: &str) -> bool {
        let (pw, exp) = self.session_password.read().unwrap().clone();
        if Utc::now() > exp {
            return false;
        }
        constant_time_compare(&pw, candidate)
    }
}

pub fn spawn_password_rotation(identity: IdentityState, app: tauri::AppHandle) {
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(12));
        loop {
            ticker.tick().await;
            let exp = identity.session_password.read().unwrap().1;
            if Utc::now() > exp {
                identity.refresh_session_password();
                let dto = identity.dto();
                let _ = app.emit("identity/updated", &dto);
            }
        }
    });
}

pub fn constant_time_compare(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();

    let a_len = a_bytes.len();
    let b_len = b_bytes.len();

    let mut diff = 0u8;
    for i in 0..a_len {
        let x = a_bytes[i];
        let y = if i < b_len { b_bytes[i] } else { 0 };
        diff |= x ^ y;
    }

    // Mix length into the accumulator so different lengths don't accidentally
    // produce the same byte-diff pattern.
    diff |= ((a_len ^ b_len) & 0xFF) as u8;
    diff == 0 && a_len == b_len
}
