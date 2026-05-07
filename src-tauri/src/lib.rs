mod identity;
mod input;
mod session_gate;
mod signaling;

use identity::{ClientIdentityDto, IdentityState, Preferences};
use serde::Serialize;
use serde_json::{json, Value};
use signaling::{signal_state_new, signaling_router, SignalState};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tokio::sync::oneshot::Sender;

type ShutdownSlot = Arc<Mutex<Option<Sender<()>>>>;

fn stop_signaling(slot: &ShutdownSlot) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(stop) = guard.take() {
            let _ = stop.send(());
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningInfo {
    pub port: u16,
}

#[tauri::command]
fn prefs_load(signal: State<'_, Arc<SignalState>>) -> Preferences {
    signal.identity.load_prefs()
}

#[tauri::command]
fn prefs_save_setup_complete(signal: State<'_, Arc<SignalState>>, complete: bool) -> Result<(), String> {
    let mut prefs = signal.identity.load_prefs();
    prefs.setup_complete = complete;
    signal.identity.save_prefs(&prefs)
}

#[derive(serde::Deserialize)]
pub struct LabPrefsPayload {
    #[serde(default, rename = "trustLoopbackLab")]
    pub trust_loopback_lab: Option<bool>,
    #[serde(default, rename = "loopbackAutoFullControl")]
    pub loopback_auto_full_control: Option<bool>,
    #[serde(default, rename = "allowViewerPrivacyBlackout")]
    pub allow_viewer_privacy_blackout: Option<bool>,
}

#[tauri::command]
fn prefs_save_lab_settings(signal: State<'_, Arc<SignalState>>, patch: LabPrefsPayload) -> Result<(), String> {
    let mut prefs = signal.identity.load_prefs();
    if let Some(v) = patch.trust_loopback_lab {
        prefs.trust_loopback_lab = v;
    }
    if let Some(v) = patch.loopback_auto_full_control {
        prefs.loopback_auto_full_control = v;
    }
    if let Some(v) = patch.allow_viewer_privacy_blackout {
        prefs.allow_viewer_privacy_blackout = v;
    }
    signal.identity.save_prefs(&prefs)
}

#[tauri::command]
fn identity_current(signal: State<'_, Arc<SignalState>>) -> ClientIdentityDto {
    signal.identity.dto()
}

#[tauri::command]
fn identity_refresh_manual(app: AppHandle, signal: State<'_, Arc<SignalState>>) -> ClientIdentityDto {
    let dto = signal.identity.refresh_session_password();
    let payload = serde_json::to_value(&dto).unwrap_or(Value::Null);
    let _ = app.emit("identity/updated", payload);
    dto
}

#[tauri::command]
fn signaling_local_addrs() -> Vec<String> {
    let mut ips = Vec::new();
    if let Ok(primary) = local_ip_address::local_ip() {
        ips.push(primary.to_string());
    }
    if let Ok(entries) = local_ip_address::list_afinet_netifas() {
        ips.extend(entries.into_iter().map(|(_, addr)| addr.to_string()));
    }

    ips.sort();
    ips.dedup();
    ips
}

#[tauri::command]
async fn signaling_start(
    port: u16,
    signal_arc: State<'_, Arc<SignalState>>,
    shutdown_holder: State<'_, ShutdownSlot>,
) -> Result<ListeningInfo, String> {
    if port == 0 {
        return Err("Port cannot be zero".into());
    }

    let restarted_previous = {
        let mut slot = shutdown_holder
            .lock()
            .map_err(|_| "signaling mutex poisoned".to_string())?;
        if let Some(stop) = slot.take() {
            let _ = stop.send(());
            true
        } else {
            false
        }
    };
    if restarted_previous {
        tokio::time::sleep(std::time::Duration::from_millis(280)).await;
    }

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
        .await
        .map_err(|err| format!("listen {port}: {err}"))?;

    let bind_addr = listener
        .local_addr()
        .map_err(|e| format!("sockaddr failed: {e}"))?;

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    shutdown_holder
        .lock()
        .map_err(|_| "signaling mutex poisoned".to_string())?
        .replace(shutdown_tx);

    let signal_for_router = Arc::clone(&signal_arc);
    let app_handle = signal_for_router.app.clone();

    tauri::async_runtime::spawn(async move {
        let service = signaling_router(signal_for_router.clone())
            .into_make_service_with_connect_info::<SocketAddr>();

        if axum::serve(listener, service)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .is_err()
        {
            let _ = app_handle.emit(
                "signaling/server",
                json!({"state":"stopped","detail":"server ended"}),
            );
        }
    });

    Ok(ListeningInfo {
        port: bind_addr.port(),
    })
}

#[tauri::command]
async fn signaling_stop(holder: State<'_, ShutdownSlot>) -> Result<(), String> {
    if holder.lock().is_err() {
        return Err("signaling mutex poisoned".to_string());
    }
    stop_signaling(holder.inner());
    Ok(())
}

#[tauri::command]
async fn host_force_disconnect(holder: State<'_, ShutdownSlot>, app: AppHandle) -> Result<(), String> {
    if holder.lock().is_err() {
        return Err("signaling mutex poisoned".to_string());
    }
    stop_signaling(holder.inner());
    let _ = app.emit("host/force-disconnect", Value::Null);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                if let Some(slot) = window.app_handle().try_state::<ShutdownSlot>() {
                    stop_signaling(slot.inner());
                }
                let _ = window.app_handle().emit("host/force-disconnect", Value::Null);
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            install_app_state(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            prefs_load,
            prefs_save_setup_complete,
            prefs_save_lab_settings,
            identity_current,
            identity_refresh_manual,
            signaling_start,
            signaling_stop,
            host_force_disconnect,
            signaling_local_addrs,
            input::inject_pointer_move,
            input::inject_pointer_click,
            input::inject_pointer_button,
            input::inject_pointer_scroll,
            input::inject_text,
            input::inject_key_ev,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Blckbx Remote Access");
}

fn install_app_state(app: &mut tauri::App) -> anyhow::Result<()> {
    let identity = IdentityState::load().map_err(|err| anyhow::anyhow!("{err}"))?;
    identity::spawn_password_rotation(identity.clone(), app.handle().clone());

    let signal_state = signal_state_new(identity, app.handle().clone());
    app.manage(Arc::new(signal_state));
    let shutdown: ShutdownSlot = Arc::new(Mutex::new(None));
    app.manage(shutdown);
    Ok(())
}
