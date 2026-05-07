import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const PRESENTER = "bx-presenter";
const BLACKOUT = "bx-blackout";
const PRESENTER_W = 240;
const PRESENTER_H = 240;
const CORNER_GAP = 4;

function inTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function hashUrl(route: string): string {
  const base = window.location.href.split("#")[0];
  const path = route.startsWith("/") ? route : `/${route}`;
  return `${base}#${path}`;
}

async function pause(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function resolvePresenterPosition(): Promise<{ x: number; y: number }> {
  try {
    const mon = await currentMonitor();
    if (!mon) return { x: CORNER_GAP, y: CORNER_GAP };
    return {
      x: Math.round(mon.position.x + CORNER_GAP),
      y: Math.round(mon.position.y + CORNER_GAP),
    };
  } catch {
    return { x: CORNER_GAP, y: CORNER_GAP };
  }
}

async function shapePresenterWindow(w: WebviewWindow): Promise<void> {
  const { x, y } = await resolvePresenterPosition();
  await w.setFullscreen(false);
  await w.setSize(new LogicalSize(PRESENTER_W, PRESENTER_H));
  await w.setPosition(new LogicalPosition(x, y));
}

export async function ensurePresenterOverlayVisible(): Promise<void> {
  if (!inTauriShell()) return;
  try {
    let w = await WebviewWindow.getByLabel(PRESENTER);
    const { x, y } = await resolvePresenterPosition();

    if (!w) {
      w = new WebviewWindow(PRESENTER, {
        url: hashUrl("/presenter"),
        width: PRESENTER_W,
        height: PRESENTER_H,
        x,
        y,
        parent: "main",
        fullscreen: false,
        transparent: true,
        shadow: false,
        decorations: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        visible: false,
        title: "Blckbx",
      });
      await pause(600);
    } else {
      await shapePresenterWindow(w);
    }
    await w.show();
    await w.setAlwaysOnTop(true);
    await w.setIgnoreCursorEvents(true);
  } catch (e) {
    console.warn("[Blckbx] presenter overlay:", e);
  }
}

export async function hidePresenterOverlay(): Promise<void> {
  if (!inTauriShell()) return;
  try {
    const w = await WebviewWindow.getByLabel(PRESENTER);
    if (w) await w.hide();
  } catch {}
}

export async function setBlackoutVisible(show: boolean): Promise<void> {
  if (!inTauriShell()) return;
  try {
    let w = await WebviewWindow.getByLabel(BLACKOUT);
    if (show) {
      if (!w) {
        w = new WebviewWindow(BLACKOUT, {
          url: hashUrl("/blackout"),
          parent: "main",
          fullscreen: true,
          transparent: false,
          shadow: false,
          decorations: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          resizable: false,
          visible: false,
        });
        await pause(900);
      }
      await w.setIgnoreCursorEvents(false);
      await w.show();
      await w.setFocus();
    } else if (w) {
      await w.hide();
    }
  } catch (e) {
    console.warn("[Blckbx] blackout overlay:", e);
  }
}
