use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard as _, Mouse as _, Settings};
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

use crate::signaling::SignalState;

fn clamp_norm(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

fn mouse_button_from_u8(btn: u8) -> Button {
    match btn {
        2 => Button::Middle,
        1 => Button::Right,
        _ => Button::Left,
    }
}

#[tauri::command]
pub fn inject_pointer_move(norm_x: f64, norm_y: f64, signal: State<'_, Arc<SignalState>>) -> Result<(), String> {
    signal.input_gate.consume_move_budget()?;
    let mut eng = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let (w, h) = eng.main_display().map_err(|e| e.to_string())?;
    let x = (clamp_norm(norm_x) * w as f64).round() as i32;
    let y = (clamp_norm(norm_y) * h as f64).round() as i32;
    eng
        .move_mouse(x.max(0), y.max(0), Coordinate::Abs)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickPayload {
    pub norm_x: f64,
    pub norm_y: f64,
    pub button: u8,
}

#[tauri::command]
pub fn inject_pointer_click(payload: ClickPayload, signal: State<'_, Arc<SignalState>>) -> Result<(), String> {
    signal.input_gate.consume_move_budget()?;
    let mut eng = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let (w, h) = eng.main_display().map_err(|e| e.to_string())?;
    let x = (clamp_norm(payload.norm_x) * w as f64).round() as i32;
    let y = (clamp_norm(payload.norm_y) * h as f64).round() as i32;
    eng
        .move_mouse(x.max(0), y.max(0), Coordinate::Abs)
        .map_err(|e| e.to_string())?;
    eng
        .button(mouse_button_from_u8(payload.button), Direction::Click)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonPayload {
    pub norm_x: f64,
    pub norm_y: f64,
    pub button: u8,
    #[serde(rename = "type")]
    pub state: String,
}

#[tauri::command]
pub fn inject_pointer_button(payload: ButtonPayload, signal: State<'_, Arc<SignalState>>) -> Result<(), String> {
    signal.input_gate.consume_move_budget()?;
    let mut eng = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let (w, h) = eng.main_display().map_err(|e| e.to_string())?;
    let x = (clamp_norm(payload.norm_x) * w as f64).round() as i32;
    let y = (clamp_norm(payload.norm_y) * h as f64).round() as i32;
    eng
        .move_mouse(x.max(0), y.max(0), Coordinate::Abs)
        .map_err(|e| e.to_string())?;

    let direction = match payload.state.as_str() {
        "mousedown" => Direction::Press,
        "mouseup" => Direction::Release,
        _ => return Ok(()),
    };

    eng
        .button(mouse_button_from_u8(payload.button), direction)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollPayload {
    pub delta_x: i32,
    pub delta_y: i32,
}

#[tauri::command]
pub fn inject_pointer_scroll(payload: ScrollPayload, signal: State<'_, Arc<SignalState>>) -> Result<(), String> {
    signal.input_gate.consume_move_budget()?;
    let mut eng = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    if payload.delta_y != 0 {
        eng.scroll(payload.delta_y, Axis::Vertical)
            .map_err(|e| e.to_string())?;
    }
    if payload.delta_x != 0 {
        eng.scroll(payload.delta_x, Axis::Horizontal)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn inject_text(paste: String, signal: State<'_, Arc<SignalState>>) -> Result<(), String> {
    signal.input_gate.consume_paste_budget(paste.len())?;
    if paste.is_empty() {
        return Ok(());
    }
    let mut eng = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    eng.text(&paste).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEvPayload {
    pub code: String,
    #[serde(rename = "type")]
    pub state: String,
}

fn map_dom_code(code: &str) -> Option<Key> {
    if let Some(rest) = code.strip_prefix("Key") {
        let mut ch_it = rest.chars();
        let ch = ch_it.next()?.to_ascii_lowercase();
        return Some(Key::Unicode(ch));
    }
    if let Some(d) = code.strip_prefix("Digit") {
        let ch = d.chars().next()?;
        return Some(Key::Unicode(ch));
    }

    Some(match code {
        "Backspace" => Key::Backspace,
        "Tab" => Key::Tab,
        "Enter" => Key::Return,
        "ShiftLeft" | "ShiftRight" => Key::Shift,
        "ControlLeft" | "ControlRight" => Key::Control,
        "AltLeft" | "AltRight" => Key::Alt,
        "Escape" => Key::Escape,
        "Space" => Key::Space,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowUp" => Key::UpArrow,
        "ArrowRight" => Key::RightArrow,
        "ArrowDown" => Key::DownArrow,
        "Delete" => Key::Delete,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        _ => return None,
    })
}

#[tauri::command]
pub fn inject_key_ev(payload: KeyEvPayload, signal: State<'_, Arc<SignalState>>) -> Result<(), String> {
    signal.input_gate.consume_key_budget()?;

    let key = match map_dom_code(&payload.code) {
        Some(k) => k,
        None => return Ok(()),
    };

    let direction = match payload.state.as_str() {
        "keydown" => Direction::Press,
        "keyup" => Direction::Release,
        _ => return Ok(()),
    };

    let mut eng = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    eng.key(key, direction).map_err(|e| e.to_string())
}
