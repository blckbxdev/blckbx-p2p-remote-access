import { invoke } from "@tauri-apps/api/core";
import type { ControlMode, HostInputNotifyPayload, TransmitPulse } from "../types/session";

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
let runtimeIceServers: RTCIceServer[] = [...DEFAULT_ICE_SERVERS];

export function setRtcIceServers(servers: RTCIceServer[]) {
  runtimeIceServers = servers.length ? [...servers] : [...DEFAULT_ICE_SERVERS];
}

export function getRtcIceServers(): RTCIceServer[] {
  return runtimeIceServers.length ? [...runtimeIceServers] : [...DEFAULT_ICE_SERVERS];
}

export type RtcPayload = {
  candidate?: string | null;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
  type?: RTCSdpType;
  sdp?: string | null;
};

export function sendRtc(ws: WebSocket, body: RtcPayload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ kind: "webrtc", body }));
}

type InputPacket =
  | { t: "move"; nx: number; ny: number }
  | { t: "click"; nx: number; ny: number; b?: number }
  | { t: "button"; nx: number; ny: number; b?: number; kind: "mousedown" | "mouseup" }
  | { t: "wheel"; dx: number; dy: number }
  | { t: "key"; kind: string; code: string };

type TelemetryPacket =
  | InputPacket
  | { t: "activity"; mouse?: boolean; keyboard?: boolean }
  | { t: "blackout"; on?: boolean };

function attachHostInbound(
  dc: RTCDataChannel,
  mode: ControlMode,
  allowViewerBlackout: boolean,
  onInboundActivity?: (snap: TransmitPulse) => void,
  onInboundNotify?: (detail: HostInputNotifyPayload) => void,
  onViewerBlackout?: (on: boolean) => void,
) {
  let lastMoveNotifyAt = 0;

  dc.onmessage = async (evt) => {
    let parsed: TelemetryPacket | null = null;
    try {
      parsed = JSON.parse(String(evt.data)) as TelemetryPacket;
    } catch {
      return;
    }

    if (parsed?.t === "blackout") {
      if (mode !== "full" || !allowViewerBlackout) return;
      if (typeof (parsed as { on?: unknown }).on !== "boolean") return;
      onViewerBlackout?.((parsed as { on: boolean }).on);
      return;
    }

    if (parsed?.t === "activity") {
      onInboundActivity?.({
        mouse: Boolean(parsed.mouse),
        keyboard: Boolean(parsed.keyboard),
      });
      return;
    }

    if (mode !== "full") return;

    const ip = parsed as InputPacket;

    switch (ip?.t) {
      case "move": {
        await invoke("inject_pointer_move", { normX: ip.nx, normY: ip.ny }).catch(() => undefined);
        const now = Date.now();
        if (now - lastMoveNotifyAt > 320) {
          lastMoveNotifyAt = now;
          onInboundNotify?.({ kind: "mouse", label: "Mouse move" });
        }
        break;
      }
      case "click":
        onInboundNotify?.({ kind: "click", label: "Mouse click" });
        await invoke("inject_pointer_click", {
          payload: { normX: ip.nx, normY: ip.ny, button: ip.b ?? 0 },
        }).catch(() => undefined);
        break;
      case "button":
        onInboundNotify?.({ kind: "mouse", label: ip.kind === "mousedown" ? "Mouse down" : "Mouse up" });
        await invoke("inject_pointer_button", {
          payload: { normX: ip.nx, normY: ip.ny, button: ip.b ?? 0, type: ip.kind },
        }).catch(() => undefined);
        break;
      case "wheel":
        onInboundNotify?.({ kind: "mouse", label: "Mouse wheel" });
        await invoke("inject_pointer_scroll", {
          payload: { deltaX: ip.dx, deltaY: ip.dy },
        }).catch(() => undefined);
        break;
      case "key": {
        const down = ip.kind === "keydown";
        if (down) onInboundNotify?.({ kind: "key", label: ip.code });
        await invoke("inject_key_ev", {
          payload: { code: ip.code, type: down ? "keydown" : "keyup" },
        }).catch(() => undefined);
        break;
      }
      default:
        break;
    }
  };
}

function bindIceDispatcher(pc: RTCPeerConnection, dispatch: (body: RtcPayload) => void) {
  pc.onicecandidate = (evt) => {
    dispatch(evt.candidate ? { ...evt.candidate.toJSON() } : { candidate: null });
  };
}

async function hydrateRemote(pc: RTCPeerConnection, body: RtcPayload) {
  if ("candidate" in body) {
    if (body.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(body as RTCIceCandidateInit)).catch(() => undefined);
    }
    return;
  }
  if (body.type === "offer" || body.type === "answer") {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: body.type, sdp: body.sdp ?? undefined }));
  }
}

export type HostShareOptions = {
  ws: WebSocket;
  stream: MediaStream;
  mode: ControlMode;
  allowViewerPrivacyBlackout: boolean;
  onInboundTelemetry?: (snap: TransmitPulse) => void;
  onInboundNotify?: (detail: HostInputNotifyPayload) => void;
  onViewerBlackout?: (on: boolean) => void;
};

export function startHostShare(params: HostShareOptions): { pc: RTCPeerConnection; dispose: () => void } {
  const { ws, stream, mode, allowViewerPrivacyBlackout, onInboundTelemetry, onInboundNotify, onViewerBlackout } = params;
  const pc = new RTCPeerConnection({ iceServers: getRtcIceServers() });
  const abort = new AbortController();

  const dc = pc.createDataChannel("input", { ordered: false });
  attachHostInbound(dc, mode, allowViewerPrivacyBlackout, onInboundTelemetry, onInboundNotify, onViewerBlackout);
  dc.addEventListener("close", () => onViewerBlackout?.(false));

  bindIceDispatcher(pc, (body) => sendRtc(ws, body));
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));

  const handleSocket = (evt: MessageEvent<string>) => {
    const envelope = unwrapEnvelope(evt.data);
    if (!envelope || envelope.kind !== "webrtcEnvelope") return;
    void hydrateRemote(pc, envelope.payload).catch(() => undefined);
  };
  ws.addEventListener("message", handleSocket as EventListener, { signal: abort.signal });

  const dispose = () => {
    abort.abort();
    stream.getTracks().forEach((t) => t.stop());
    dc.close();
    pc.close();
  };

  return { pc, dispose };
}

export async function finalizeHostOffer(ws: WebSocket, pc: RTCPeerConnection) {
  const offer = await pc.createOffer({
    offerToReceiveAudio: false,
    offerToReceiveVideo: false,
  } as RTCOfferOptions);
  await pc.setLocalDescription(offer);
  sendRtc(ws, { type: offer.type, sdp: offer.sdp ?? undefined });
}

function transmitPulseEmitter(callback?: (pulse: TransmitPulse) => void) {
  let mouse = false;
  let keyboard = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    callback?.({ mouse, keyboard });
  };

  const bump = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 90);
  };

  const setMouse = (v: boolean) => {
    mouse = v;
    bump();
  };

  const setKeyboard = (v: boolean) => {
    keyboard = v;
    bump();
  };

  const teardown = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return { setMouse, setKeyboard, teardown };
}

function bindGuestInput(
  video: HTMLVideoElement,
  gesture: HTMLElement,
  channel: RTCDataChannel,
  mode: ControlMode,
  onLocalPulse?: (snap: TransmitPulse) => void,
) {
  if (mode !== "full") return () => undefined;

  const emitLocal = transmitPulseEmitter(onLocalPulse);
  const remoteEmit = transmitPulseEmitter((snap) => {
    try {
      if (channel.readyState !== "open") return;
      channel.send(JSON.stringify({ t: "activity", mouse: snap.mouse, keyboard: snap.keyboard }));
    } catch {
      /* noop */
    }
  });

  const sendCommand = (pkt: InputPacket) => {
    try {
      if (channel.readyState === "open") channel.send(JSON.stringify(pkt));
      if (pkt.t === "move") {
        emitLocal.setMouse(true);
        remoteEmit.setMouse(true);
        window.setTimeout(() => {
          emitLocal.setMouse(false);
          remoteEmit.setMouse(false);
        }, 140);
      }
      if (pkt.t === "click") {
        emitLocal.setMouse(true);
        remoteEmit.setMouse(true);
        window.setTimeout(() => {
          emitLocal.setMouse(false);
          remoteEmit.setMouse(false);
        }, 200);
      }
      if (pkt.t === "key") {
        const down = pkt.kind === "keydown";
        emitLocal.setKeyboard(down);
        remoteEmit.setKeyboard(down);
        window.setTimeout(() => {
          if (!down) {
            emitLocal.setKeyboard(false);
            remoteEmit.setKeyboard(false);
          }
        }, 240);
      }
      if (pkt.t === "wheel") {
        emitLocal.setMouse(true);
        remoteEmit.setMouse(true);
        window.setTimeout(() => {
          emitLocal.setMouse(false);
          remoteEmit.setMouse(false);
        }, 180);
      }
    } catch {
      /* noop */
    }
  };
  const pressedButtons = new Set<number>();
  let lastPoint = { nx: 0.5, ny: 0.5 };

  const norm = (evt: MouseEvent) => {
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const nx = (evt.clientX - rect.left) / rect.width;
    const ny = (evt.clientY - rect.top) / rect.height;
    return {
      nx: Math.min(1, Math.max(0, nx)),
      ny: Math.min(1, Math.max(0, ny)),
    };
  };

  const move = (evt: PointerEvent) => {
    const p = norm(evt);
    if (!p) return;
    lastPoint = p;
    sendCommand({ t: "move", nx: p.nx, ny: p.ny });
  };

  const buttonFromMouse = (button: number) => {
    if (button === 2) return 1;
    if (button === 1) return 2;
    return 0;
  };

  const down = (evt: PointerEvent) => {
    const p = norm(evt);
    if (!p) return;
    lastPoint = p;
    const button = buttonFromMouse(evt.button);
    evt.preventDefault();
    pressedButtons.add(button);
    sendCommand({ t: "button", nx: p.nx, ny: p.ny, b: button, kind: "mousedown" });
  };

  const up = (evt: PointerEvent) => {
    const p = norm(evt);
    if (!p) return;
    lastPoint = p;
    const button = buttonFromMouse(evt.button);
    evt.preventDefault();
    pressedButtons.delete(button);
    sendCommand({ t: "button", nx: p.nx, ny: p.ny, b: button, kind: "mouseup" });
  };

  const releaseAll = () => {
    for (const button of pressedButtons) {
      sendCommand({ t: "button", nx: lastPoint.nx, ny: lastPoint.ny, b: button, kind: "mouseup" });
    }
    pressedButtons.clear();
  };

  const wheel = (evt: WheelEvent) => {
    evt.preventDefault();
    const stepX = evt.deltaX === 0 ? 0 : Math.max(-6, Math.min(6, Math.round(evt.deltaX / 50)));
    const stepY = evt.deltaY === 0 ? 0 : Math.max(-6, Math.min(6, Math.round(evt.deltaY / 50)));
    if (stepX === 0 && stepY === 0) return;
    sendCommand({ t: "wheel", dx: stepX, dy: stepY });
  };

  const suppressContextMenu = (evt: MouseEvent) => evt.preventDefault();

  const kd = (evt: KeyboardEvent) => {
    if (evt.repeat) return;
    sendCommand({ t: "key", kind: "keydown", code: evt.code });
  };
  const ku = (evt: KeyboardEvent) => sendCommand({ t: "key", kind: "keyup", code: evt.code });

  gesture.addEventListener("pointermove", move);
  gesture.addEventListener("pointerdown", down);
  gesture.addEventListener("pointerup", up);
  gesture.addEventListener("pointercancel", releaseAll);
  gesture.addEventListener("wheel", wheel, { passive: false });
  gesture.addEventListener("contextmenu", suppressContextMenu);
  window.addEventListener("blur", releaseAll);
  window.addEventListener("keydown", kd);
  window.addEventListener("keyup", ku);

  return () => {
    emitLocal.teardown();
    remoteEmit.teardown();
    gesture.removeEventListener("pointermove", move);
    gesture.removeEventListener("pointerdown", down);
    gesture.removeEventListener("pointerup", up);
    gesture.removeEventListener("pointercancel", releaseAll);
    gesture.removeEventListener("wheel", wheel);
    gesture.removeEventListener("contextmenu", suppressContextMenu);
    window.removeEventListener("blur", releaseAll);
    releaseAll();
    window.removeEventListener("keydown", kd);
    window.removeEventListener("keyup", ku);
  };
}

export function attachGuestBridge(params: {
  send: (payload: RtcPayload) => void;
  video: HTMLVideoElement;
  gestureLayer: HTMLElement;
  modeAwaiter: Promise<ControlMode>;
  onLocalTransmit?: (pulse: TransmitPulse) => void;
}): { ingest: (rawText: string) => void; dispose: () => void; sendViewerBlackout: (on: boolean) => void } {
  const { send, video, gestureLayer, modeAwaiter, onLocalTransmit } = params;

  const pc = new RTCPeerConnection({ iceServers: getRtcIceServers() });
  bindIceDispatcher(pc, send);

  let inputChannel: RTCDataChannel | null = null;

  const sendViewerBlackout = (on: boolean) => {
    try {
      if (inputChannel?.readyState === "open") {
        inputChannel.send(JSON.stringify({ t: "blackout", on }));
      }
    } catch {
      /* noop */
    }
  };

  pc.ontrack = (evt) => {
    const streamSource = evt.streams[0];
    video.srcObject = streamSource ?? new MediaStream([evt.track]);
    void video.play().catch(() => undefined);
  };

  let detachGestures: (() => void) | undefined;
  pc.ondatachannel = ({ channel }) => {
    inputChannel = channel;
    void modeAwaiter.then((mode) => {
      detachGestures?.();
      detachGestures = bindGuestInput(video, gestureLayer, channel, mode, onLocalTransmit);
    });
    channel.addEventListener(
      "close",
      () => {
        detachGestures?.();
        detachGestures = undefined;
        inputChannel = null;
      },
      { once: true },
    );
  };

  const ingest = (rawText: string) => {
    const envelope = unwrapEnvelope(rawText);
    if (!envelope || envelope.kind !== "webrtcEnvelope") return;
    const chunk = envelope.payload;

    void (async () => {
      if (chunk.type === "offer") {
        await hydrateRemote(pc, chunk);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: answer.type, sdp: answer.sdp ?? undefined });
        return;
      }

      await hydrateRemote(pc, chunk);
    })().catch(() => undefined);
  };

  const dispose = () => {
    detachGestures?.();
    detachGestures = undefined;
    inputChannel = null;
    video.srcObject = null;
    pc.close();
  };

  return { ingest, dispose, sendViewerBlackout };
}

export async function previewDisplaySurface(target: HTMLVideoElement): Promise<{ dispose: () => void }> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  target.srcObject = stream;
  await target.play().catch(() => undefined);
  const dispose = () => {
    stream.getTracks().forEach((track) => track.stop());
    target.srcObject = null;
  };
  return { dispose };
}

function unwrapEnvelope(raw: string): { kind: string; payload: RtcPayload } | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.kind === "webrtcEnvelope" ? parsed : null;
  } catch {
    return null;
  }
}
