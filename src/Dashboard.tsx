import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicators } from "./dashboard/ActivityIndicators";
import { Btn, SurfaceCard, TopShareTabs, type DashboardTab } from "./dashboard/chrome";
import { ConsentDialog } from "./components/ConsentDialog";
import { deferred } from "./lib/deferred";
import { attachGuestBridge, finalizeHostOffer, previewDisplaySurface, sendRtc, setRtcIceServers, startHostShare } from "./lib/webrtc";
import { ensurePresenterOverlayVisible, hidePresenterOverlay, setBlackoutVisible } from "./lib/overlayWindows";
import type { ClientIdentity, ConsentCaps, ControlMode, IncomingKnockPayload, PreferencesShape, TransmitPulse } from "./types/session";
type ListeningSummary = { port: number };

const DEFAULT_PORT = 9755;
const Z: TransmitPulse = { mouse: false, keyboard: false };
const DONATION_WALLETS = {
  btc: "bc1qvjanpkddk8rjhzeep7qhddqzwkal6znauqdgva",
  eth: "0x86bE8d1ECfe7aBed9f1A3BE2139e0300aaD0CFBf",
  tether: "0x86bE8d1ECfe7aBed9f1A3BE2139e0300aaD0CFBf",
} as const;
const CODE_PREFIX = "BLKX1";
const NET_SETTINGS_KEY = "blckbx.network.v1";

const normalizeMode = (raw?: string): ControlMode => {
  const m = raw?.toLowerCase() ?? "full";
  return m.includes("view") ? "view" : "full";
};

const toSignalUrl = (txt: string) => {
  const t = txt.trim();
  if (/^wss?:\/\//i.test(t)) return t.endsWith("/signal") ? t : `${t.replace(/\/$/, "")}/signal`;
  const [hostPart, portGuess = `${DEFAULT_PORT}`] = t.split(":");
  if (!hostPart || hostPart.includes("/")) throw new Error("Invalid host");
  const pg = /^[0-9]+$/.test(portGuess) ? portGuess : `${DEFAULT_PORT}`;
  return `ws://${hostPart}:${pg}/signal`;
};

type InvitePayload = {
  u?: string;
  h?: string;
  p?: number;
  s: string;
};

const encodeInvite = (payload: InvitePayload) => {
  const raw = JSON.stringify(payload);
  const b64 = btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${CODE_PREFIX}-${b64}`;
};

const decodeInvite = (code: string): InvitePayload => {
  const normalized = code.trim();
  if (!normalized.startsWith(`${CODE_PREFIX}-`)) throw new Error("Invalid access code");
  const chunk = normalized.slice(CODE_PREFIX.length + 1).replace(/-/g, "+").replace(/_/g, "/");
  const padded = chunk + "=".repeat((4 - (chunk.length % 4 || 4)) % 4);
  const parsed = JSON.parse(atob(padded)) as InvitePayload;
  const hasEndpoint = typeof parsed?.u === "string" && parsed.u.length > 0;
  const hasLegacy = typeof parsed?.h === "string" && typeof parsed?.p === "number";
  if (!parsed?.s || (!hasEndpoint && !hasLegacy)) throw new Error("Invalid access code");
  return parsed;
};

const isPrivateIpv4 = (ip: string) =>
  ip.startsWith("10.") || ip.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);

type NetworkSettings = {
  signalingUrl: string;
  stunUrl: string;
  turnUrl: string;
  turnUser: string;
  turnPass: string;
};

const defaultNetworkSettings = (): NetworkSettings => ({
  signalingUrl: "",
  stunUrl: "stun:stun.l.google.com:19302",
  turnUrl: "",
  turnUser: "",
  turnPass: "",
});

const loadNetworkSettings = (): NetworkSettings => {
  try {
    const raw = localStorage.getItem(NET_SETTINGS_KEY);
    if (!raw) return defaultNetworkSettings();
    return { ...defaultNetworkSettings(), ...(JSON.parse(raw) as Partial<NetworkSettings>) };
  } catch {
    return defaultNetworkSettings();
  }
};

const saveNetworkSettings = (s: NetworkSettings) => {
  localStorage.setItem(NET_SETTINGS_KEY, JSON.stringify(s));
};

const normalizeSignalEndpoint = (txt: string) => {
  const t = txt.trim();
  if (!t) return "";
  if (/^wss?:\/\//i.test(t)) return t.endsWith("/signal") ? t : `${t.replace(/\/$/, "")}/signal`;
  if (t.includes("/") || !t.includes(":")) throw new Error("Use full ws:// or wss:// signaling URL");
  return `ws://${t.replace(/\/$/, "")}/signal`;
};

const isPrivateHost = (host: string) =>
  host === "localhost" ||
  host === "127.0.0.1" ||
  host.startsWith("10.") ||
  host.startsWith("192.168.") ||
  /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);

const assertSignalSecurity = (endpoint: string) => {
  const url = new URL(endpoint);
  if (url.protocol !== "wss:" && !isPrivateHost(url.hostname)) {
    throw new Error("Public signaling must use wss:// for security");
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (normalizedPath !== "/signal") {
    throw new Error("Signaling endpoint must use the /signal route");
  }

  if (url.search && url.search !== "/") {
    throw new Error("Signaling endpoint must not include query parameters");
  }

  if (url.username || url.password) {
    throw new Error("Signaling endpoint must not include credentials");
  }
};

const heartbeat = (ws: WebSocket) => {
  const timer = window.setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: "ping" }));
  }, 12000);
  return () => window.clearInterval(timer);
};

async function openGuestSession(args: {
  password: string;
  endpoint: string;
  videoEl: HTMLVideoElement;
  gestureEl: HTMLDivElement;
  onPulse: (pulse: TransmitPulse) => void;
  onConsent: (mode: ControlMode, caps: ConsentCaps) => void;
  onDeniedNote?: (msg: string) => void;
  onEnded?: (msg: string) => void;
}): Promise<{ teardown: () => void; sendViewerBlackout: (on: boolean) => void }> {
  const slot = deferred<ControlMode>();
  const socket = new WebSocket(args.endpoint);
  const connectTimer = window.setTimeout(() => {
    try {
      socket.close();
    } catch {
      /* noop */
    }
  }, 9000);
  await new Promise<void>((ok, err) => {
    socket.onopen = () => {
      window.clearTimeout(connectTimer);
      ok();
    };
    socket.onerror = () => {
      window.clearTimeout(connectTimer);
      err(new Error("Unable to reach host signaling server"));
    };
    socket.onclose = () => {
      window.clearTimeout(connectTimer);
    };
  });
  const stopHeartbeat = heartbeat(socket);

  const bridge = attachGuestBridge({
    send: (body) => sendRtc(socket, body),
    video: args.videoEl,
    gestureLayer: args.gestureEl,
    modeAwaiter: slot.promise,
    onLocalTransmit: (p) => args.onPulse({ ...p }),
  });

  void slot.promise.catch(() => undefined);

  let finished = false;
  const teardown = () => {
    if (finished) return;
    finished = true;
    bridge.sendViewerBlackout(false);
    bridge.dispose();
    stopHeartbeat();
    socket.close();
    args.videoEl.srcObject = null;
  };

  const handleMessage = (event: MessageEvent<string>) => {
    let decoded: Record<string, unknown>;
    try {
      decoded = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (decoded.kind) {
      case "consentResolved": {
        if (decoded.accepted !== true) {
          slot.reject(new Error("denied"));
          args.onDeniedNote?.("Host declined.");
          teardown();
          return;
        }
        const mode = normalizeMode(decoded.mode as string | undefined);
        const caps: ConsentCaps = {
          allowViewerPrivacyBlackout: decoded.allowViewerPrivacyBlackout !== false,
        };
        slot.resolve(mode);
        args.onConsent(mode, caps);
        break;
      }
      case "webrtcEnvelope":
        bridge.ingest(event.data);
        break;
      case "hostDisconnected":
        args.onEnded?.("Host ended the session.");
        teardown();
        break;
      case "error": {
        const msg = typeof decoded.message === "string" ? decoded.message : "Connection rejected";
        args.onEnded?.(msg);
        teardown();
        break;
      }
      default:
        break;
    }
  };

  socket.addEventListener("message", handleMessage);
  socket.addEventListener("close", () => {
    if (!finished) {
      args.onEnded?.("Connection closed.");
      teardown();
    }
  });
  socket.send(JSON.stringify({ kind: "register", role: "remote", password: args.password }));

  return { teardown, sendViewerBlackout: bridge.sendViewerBlackout };
}

export default function Dashboard() {
  const [prefs, setPrefs] = useState<PreferencesShape>({});
  const prefsHold = useRef(prefs);

  useEffect(() => {
    prefsHold.current = prefs;
  }, [prefs]);

  const persistLabs = async (patch: PreferencesShape) => {
    await invoke("prefs_save_lab_settings", patch).catch(console.error);
    const merged: PreferencesShape = { ...prefsHold.current, ...patch };
    if (merged.trustLoopbackLab !== true) merged.loopbackAutoFullControl = false;
    prefsHold.current = merged;
    setPrefs(merged);
  };

  const [identity, setIdentity] = useState<ClientIdentity | null>(null);
  const [routes, setRoutes] = useState<string[]>([]);
  const [listenPort, setListenPort] = useState(DEFAULT_PORT);
  const [tab, setTab] = useState<DashboardTab>("share");
  const [connectCode, setConnectCode] = useState("");
  const [publicIp, setPublicIp] = useState<string>("");
  const [netCfg] = useState<NetworkSettings>(() => loadNetworkSettings());
  const [activeSignalEndpoint, setActiveSignalEndpoint] = useState("");

  const [relayListening, setRelayListening] = useState(false);
  const [relayHot, setRelayHot] = useState(false);

  const [toast, setToast] = useState<string | null>(null);

  const [incomingOpen, setIncomingOpen] = useState(false);
  const [incomingCopy, setIncomingCopy] = useState("");
  const [loopKnockFlag, setLoopKnockFlag] = useState(false);

  const [cockpitReady, setCockpitReady] = useState(false);
  const [cockpitFull, setCockpitFull] = useState(false);
  const [labReady, setLabReady] = useState(false);
  const [labFull, setLabFull] = useState(false);

  const [pulseFromRemote, setPulseFromRemote] = useState(Z);
  const [pulseOutboundCockpit, setPulseOutboundCockpit] = useState(Z);
  const [pulseOutboundLab, setPulseOutboundLab] = useState(Z);

  const hostSocket = useRef<WebSocket | null>(null);
  const hostHeartbeatStop = useRef<(() => void) | null>(null);
  const hostRtcTeardown = useRef<(() => void) | null>(null);
  const knockUnregister = useRef<UnlistenFn | null>(null);
  const eventBus = useRef<UnlistenFn[]>([]);

  const teardownCockpit = useRef<(() => void) | null>(null);
  const teardownLab = useRef<(() => void) | null>(null);
  const cockpitBlackoutSend = useRef<(on: boolean) => void>(() => {});

  const stageVideoRef = useRef<HTMLVideoElement | null>(null);
  const stageGestureRef = useRef<HTMLDivElement | null>(null);
  const remoteStageRef = useRef<HTMLDivElement | null>(null);

  const [privacyBlackout, setPrivacyBlackout] = useState(false);
  const [hostAllowsViewerBlackout, setHostAllowsViewerBlackout] = useState(true);
  const [remoteFs, setRemoteFs] = useState(false);
  const [localTestFs, setLocalTestFs] = useState(false);

  const labVideoRef = useRef<HTMLVideoElement | null>(null);
  const labGestureRef = useRef<HTMLDivElement | null>(null);
  const localTestStageRef = useRef<HTMLDivElement | null>(null);

  const previewMount = useRef<HTMLVideoElement | null>(null);
  const previewTeardown = useRef<(() => void) | null>(null);

  const consentRunner = useRef<(mode: ControlMode | null) => Promise<void>>(async () => {});

  useEffect(() => {
    const t = toast == null ? null : window.setTimeout(() => setToast(null), 5200);
    return () => {
      if (t != null) window.clearTimeout(t);
    };
  }, [toast]);

  useEffect(() => {
    invoke<PreferencesShape>("prefs_load").then((p) => {
      prefsHold.current = { ...p };
      setPrefs({ ...p });
    });
    invoke<ClientIdentity>("identity_current").then(setIdentity).catch(console.error);
    invoke<string[]>("signaling_local_addrs").then(setRoutes).catch(() => []);

    listen<ClientIdentity>("identity/updated", (evt) => setIdentity(evt.payload)).then((tap) => eventBus.current.push(tap));

    return () => {
      eventBus.current.forEach((u) => u());
      eventBus.current = [];
    };
  }, []);

  useEffect(() => {
    fetch("https://api.ipify.org?format=json")
      .then((r) => r.json())
      .then((j: { ip?: string }) => {
        if (typeof j.ip === "string") setPublicIp(j.ip);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const ice: RTCIceServer[] = [];
    if (netCfg.stunUrl.trim()) ice.push({ urls: netCfg.stunUrl.trim() });
    if (netCfg.turnUrl.trim()) {
      ice.push({
        urls: netCfg.turnUrl.trim(),
        username: netCfg.turnUser.trim() || undefined,
        credential: netCfg.turnPass || undefined,
      });
    }
    setRtcIceServers(ice);
    saveNetworkSettings(netCfg);
  }, [netCfg]);

  useEffect(() => {
    if (!relayListening) {
      void hidePresenterOverlay();
      return;
    }
    void ensurePresenterOverlayVisible().catch(console.error);
  }, [relayListening]);

  useEffect(() => {
    if (!relayListening) return;
    void emit("bx/presenter-status", { sharing: relayHot, connecting: incomingOpen && !relayHot });
  }, [relayListening, relayHot, incomingOpen]);

  useEffect(() => {
    if (!cockpitFull && privacyBlackout) {
      setPrivacyBlackout(false);
      cockpitBlackoutSend.current(false);
    }
  }, [cockpitFull, privacyBlackout]);

  useEffect(() => {
    const syncFs = () => setRemoteFs(document.fullscreenElement === remoteStageRef.current);
    document.addEventListener("fullscreenchange", syncFs);
    return () => document.removeEventListener("fullscreenchange", syncFs);
  }, []);

  useEffect(() => {
    const syncFs = () => setLocalTestFs(document.fullscreenElement === localTestStageRef.current);
    document.addEventListener("fullscreenchange", syncFs);
    return () => document.removeEventListener("fullscreenchange", syncFs);
  }, []);

  const resetLabLane = () => {
    teardownLab.current?.();
    teardownLab.current = null;
    if (labVideoRef.current) labVideoRef.current.srcObject = null;
    setLabReady(false);
    setLabFull(false);
    setPulseOutboundLab(Z);
  };

  const resetCockpitLane = () => {
    cockpitBlackoutSend.current(false);
    cockpitBlackoutSend.current = () => {};
    teardownCockpit.current?.();
    teardownCockpit.current = null;
    if (stageVideoRef.current) stageVideoRef.current.srcObject = null;
    setCockpitReady(false);
    setCockpitFull(false);
    setPulseOutboundCockpit(Z);
    setPrivacyBlackout(false);
    setHostAllowsViewerBlackout(true);
    void document.exitFullscreen().catch(() => undefined);
  };

  const resetHostRail = () => {
    knockUnregister.current?.();
    knockUnregister.current = null;

    hostRtcTeardown.current?.();
    hostRtcTeardown.current = null;

    hostSocket.current?.close();
    hostSocket.current = null;
    hostHeartbeatStop.current?.();
    hostHeartbeatStop.current = null;

    resetLabLane();

    setRelayListening(false);
    setRelayHot(false);
    setLoopKnockFlag(false);
    setIncomingOpen(false);

    setPulseFromRemote(Z);

    void hidePresenterOverlay();
    void setBlackoutVisible(false);
  };

  const purgePreviewLane = () => {
    previewTeardown.current?.();
    previewTeardown.current = null;
    if (previewMount.current) previewMount.current.srcObject = null;
  };

  const applyHostEmergencyStop = useCallback(() => {
    purgePreviewLane();
    knockUnregister.current?.();
    knockUnregister.current = null;
    hostRtcTeardown.current?.();
    hostRtcTeardown.current = null;
    hostSocket.current?.close();
    hostSocket.current = null;
    hostHeartbeatStop.current?.();
    hostHeartbeatStop.current = null;
    resetLabLane();
    setRelayListening(false);
    setRelayHot(false);
    setLoopKnockFlag(false);
    setIncomingOpen(false);
    setPulseFromRemote(Z);
    void invoke("signaling_stop").catch(() => undefined);
    void hidePresenterOverlay();
    void setBlackoutVisible(false);
    setToast("Force disconnect ended hosting.");
  }, []);

  useEffect(() => {
    let u: (() => void) | undefined;
    void listen("host/force-disconnect", () => {
      applyHostEmergencyStop();
    }).then((fn) => {
      u = fn;
    });
    return () => {
      u?.();
    };
  }, [applyHostEmergencyStop]);

  useEffect(() => {
    resetHostRail();
    resetCockpitLane();
    purgePreviewLane();
    invoke("signaling_stop").catch(() => undefined);
  }, [tab]);

  const finalizeConsent = useCallback(async (resolution: ControlMode | null) => {
    const ws = hostSocket.current;
    setIncomingOpen(false);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setToast("Start hosting first: relay is not connected.");
      return;
    }

    if (!resolution) {
      ws.send(JSON.stringify({ kind: "hostConsent", accept: false }));
      setToast("Connection rejected.");
      return;
    }

    void setBlackoutVisible(false).catch(() => undefined);

    const allowViewerPrivacyBlackout = prefsHold.current.allowViewerPrivacyBlackout !== false;

    ws.send(
      JSON.stringify({
        kind: "hostConsent",
        accept: true,
        mode: resolution,
        allowViewerPrivacyBlackout,
      }),
    );
    await new Promise((done) => setTimeout(done, 80));

    const surface =
      (previewMount.current?.srcObject as MediaStream | null) ?? (await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }));
    if (previewMount.current?.srcObject) {
      previewTeardown.current = null;
      previewMount.current.srcObject = null;
    }
    const { dispose, pc } = startHostShare({
      ws,
      stream: surface,
      mode: resolution,
      allowViewerPrivacyBlackout,
      onInboundTelemetry: (snap) => setPulseFromRemote({ ...snap }),
      onViewerBlackout: (on) => {
        void setBlackoutVisible(on).catch(console.error);
      },
    });
    hostRtcTeardown.current = dispose;
    await finalizeHostOffer(ws, pc).catch(console.error);

    setRelayHot(true);
    setToast("Session active: screen is being shared.");
  }, []);

  consentRunner.current = finalizeConsent;

  const wireKnocks = () => {
    knockUnregister.current?.();

    listen<IncomingKnockPayload>("signaling/incoming", (evt) => {
      const loopHit = evt.payload.peerIsLoopback ?? false;

      setIncomingCopy(evt.payload.peerEndpoint ?? "?");
      setLoopKnockFlag(loopHit);

      const cfg = prefsHold.current;

      if (loopHit && cfg.trustLoopbackLab === true) {
        const autoMode = cfg.loopbackAutoFullControl ? "full" : "view";
        void consentRunner.current(autoMode);
        setToast(`Local test auto-approved (${autoMode === "full" ? "full control" : "view only"}).`);
        return;
      }

      setIncomingOpen(true);
    }).then((u) => {
      knockUnregister.current = u;
    });
  };

  const pressListenHost = async () => {
    if (!identity?.sessionPassword) return;
    resetHostRail();
    void setBlackoutVisible(false).catch(() => undefined);
    await pressPreviewTiles(true);
    const info = await invoke<ListeningSummary>("signaling_start", { port: listenPort }).catch((er: Error) => {
      setToast(er.message);
      throw er;
    });
    const endpoint = `ws://127.0.0.1:${info.port}/signal`;

    const ws = new WebSocket(endpoint);
    hostSocket.current = ws;

    await new Promise<void>((fine, rotten) => {
      ws.onopen = () => fine();
      ws.onerror = () => rotten(new Error("ws"));
    });
    hostHeartbeatStop.current = heartbeat(ws);
    setActiveSignalEndpoint("");

    ws.send(JSON.stringify({ kind: "register", role: "host", password: identity.sessionPassword }));

    wireKnocks();
    setRelayListening(true);

    setToast(`Listening on LAN port ${listenPort}. Share access code with viewer on the same network.`);
  };

  const pressStopRelay = async () => {
    resetHostRail();
    purgePreviewLane();

    await invoke("signaling_stop").catch(() => {});

    setToast("Hosting stopped.");
  };

  const pressPreviewTiles = async (silent = false) => {
    if (!previewMount.current) return;

    purgePreviewLane();

    const kit = await previewDisplaySurface(previewMount.current).catch(() => ({
      dispose: () => undefined,
    }));

    previewTeardown.current = kit.dispose;
    if (!silent) setToast("Preview started: only visible on this PC.");
  };

  const labSpawn = async () => {
    if (!relayListening || !identity?.sessionPassword) {
      setToast("Start hosting first.");
      return;
    }
    const v = labVideoRef.current;
    const g = labGestureRef.current;
    if (!v || !g) return;

    resetLabLane();

    try {
      const session = await openGuestSession({
        password: identity.sessionPassword,
        endpoint: activeSignalEndpoint || `ws://127.0.0.1:${listenPort}/signal`,
        videoEl: v,
        gestureEl: g,
        onPulse: (pl) => setPulseOutboundLab({ ...pl }),
        onConsent: (mode, _caps) => {
          setLabReady(true);
          setLabFull(mode === "full");
        },
        onDeniedNote: () => setToast("Host declined the local viewer."),
        onEnded: (msg) => setToast(msg),
      });
      teardownLab.current = session.teardown;
      setToast("Local viewer connected: approve sharing when prompted.");
    } catch (boom) {
      setToast(boom instanceof Error ? boom.message : String(boom));
      resetLabLane();
    }
  };

  const cockpitSpawn = async () => {
    if (!connectCode.trim()) {
      setToast("Enter the access code.");
      return;
    }
    const vid = stageVideoRef.current;
    const gest = stageGestureRef.current;
    if (!vid || !gest) return;

    resetCockpitLane();

    let invite: InvitePayload;
    try {
      invite = decodeInvite(connectCode);
    } catch {
      setToast("Access code is invalid.");
      return;
    }

    const endpoint = invite.u ? normalizeSignalEndpoint(invite.u) : toSignalUrl(`${invite.h}:${invite.p}`);
    try {
      assertSignalSecurity(endpoint);
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err));
      return;
    }

    try {
      const session = await openGuestSession({
        password: invite.s,
        endpoint,
        videoEl: vid,
        gestureEl: gest,
        onPulse: (pl) => setPulseOutboundCockpit({ ...pl }),
        onConsent: (mode, caps) => {
          setCockpitReady(true);
          setCockpitFull(mode === "full");
          setHostAllowsViewerBlackout(caps.allowViewerPrivacyBlackout);
        },
        onDeniedNote: () => setToast("Host declined access."),
        onEnded: (msg) => setToast(msg),
      });
      teardownCockpit.current = session.teardown;
      cockpitBlackoutSend.current = session.sendViewerBlackout;
      setToast("Connected. Mouse and keyboard work only if the host chose full control.");
    } catch (explode) {
      setToast(explode instanceof Error ? explode.message : String(explode));
      resetCockpitLane();
    }
  };

  const clipboard = async (line: string) => {
    try {
      await navigator.clipboard?.writeText(line);
      setToast("Copied.");
    } catch {
      setToast(line);
    }
  };

  if (!identity) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-white/40">
        <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1.4 }} className="h-1 w-12 rounded-full bg-white/30" />
        <p className="text-sm">Loading…</p>
      </div>
    );
  }

  const lanRoute = routes.find((r) => isPrivateIpv4(r));
  const nonLoopbackRoute = routes.find((r) => !r.startsWith("127.") && !r.startsWith("::1"));
  const inviteHost = lanRoute || nonLoopbackRoute || publicIp || routes[0] || "127.0.0.1";
  const hostAccessCode = encodeInvite({
    u: activeSignalEndpoint || `ws://${inviteHost}:${listenPort}/signal`,
    s: identity.sessionPassword,
  });

  return (
    <div className="mx-auto max-w-[1120px] px-5 pb-20 pt-10">
      <ConsentDialog
        open={incomingOpen}
        peerHint={`${incomingCopy}${loopKnockFlag ? " (this device)" : ""}`}
        onApprove={(grant) => void finalizeConsent(grant)}
        onDismiss={() => void finalizeConsent(null)}
      />
      <video ref={previewMount} muted playsInline className="hidden" />

      <motion.header initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mb-6 border-b border-white/[0.08] pb-6">
        <div className="flex flex-wrap items-start gap-5">
          <img src="/blckbx-logo.png" alt="" width={56} height={56} className="h-14 w-14 shrink-0 opacity-95" />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.35em] text-white/35">Blckbx</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-[2rem]">Remote Access</h1>
            <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-white/45">
              Host shares their screen. Viewer connects with a secure access code. Keyboard and mouse work only after the host grants{" "}
              <span className="text-white/70">full control</span>.
            </p>
          </div>
        </div>
      </motion.header>

      <TopShareTabs tab={tab} onShare={() => setTab("share")} onConnect={() => setTab("connect")} onHelp={() => setTab("help")} onSupport={() => setTab("support")} />

      <AnimatePresence mode="wait">
        {tab === "share" ? (
          <motion.div key="share" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }} className="mt-8 grid gap-6 lg:grid-cols-[300px_1fr]">
            <div className="flex flex-col gap-6">
              <SurfaceCard title="Your session" description="Give the session code to someone who will view or control this PC.">
                <p className="font-mono text-lg font-medium tracking-wider text-white">{identity.clientId}</p>
                <Btn variant="ghost" onClick={() => void clipboard(identity.clientId)} className="mt-2 !px-0">
                  Copy ID
                </Btn>
                <p className="mt-5 text-[10px] font-semibold uppercase tracking-wider text-white/35">Session code</p>
                <p className="mt-2 font-mono text-xl tracking-[0.35em] text-white">{identity.sessionPassword}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Btn variant="outline" onClick={() => void clipboard(identity.sessionPassword)}>
                    Copy code
                  </Btn>
                  <Btn variant="outline" onClick={() => invoke<ClientIdentity>("identity_refresh_manual").then(setIdentity)}>
                    New code
                  </Btn>
                </div>
                <p className="mt-4 text-[11px] text-white/35">Expires {new Date(identity.passwordExpiresAt).toLocaleString()}</p>
                <p className="mt-5 text-[10px] font-semibold uppercase tracking-wider text-white/35">Access code</p>
                <textarea
                  readOnly
                  rows={3}
                  value={hostAccessCode}
                  className="mt-2 w-full resize-none rounded-xl border border-white/[0.08] bg-black/50 px-3 py-2 font-mono text-[11px] text-white/70"
                />
                <div className="mt-3 flex gap-2">
                  <Btn variant="outline" onClick={() => void clipboard(hostAccessCode)}>
                    Copy access code
                  </Btn>
                </div>
              </SurfaceCard>

              <SurfaceCard title="Your network addresses" description="Viewer can use IP:port if not on this machine.">
                <textarea readOnly rows={4} value={routes.join("\n")} className="w-full resize-none rounded-xl border border-white/[0.08] bg-black/50 px-3 py-2 font-mono text-[11px] text-white/55" />
              </SurfaceCard>
            </div>

            <div className="flex flex-col gap-6">
              <SurfaceCard title="Hosting" description="Starts the relay on this PC. Approve each viewer when they connect.">
                <label className="text-[11px] font-medium text-white/40">Port</label>
                <input
                  type="number"
                  min={1024}
                  max={59999}
                  value={listenPort}
                  onChange={(event) => setListenPort(+event.target.value)}
                  className="mt-2 w-full rounded-xl border border-white/[0.1] bg-black/50 px-4 py-3 font-mono text-white"
                />
                <div className="mt-5 flex flex-wrap gap-3">
                  <Btn variant="primary" disabled={relayListening} onClick={() => pressListenHost().catch(console.error)}>
                    Start hosting
                  </Btn>
                  <Btn variant="danger" disabled={!relayListening} onClick={() => pressStopRelay().catch(console.error)}>
                    Stop hosting
                  </Btn>
                </div>
                <p className="mt-4 text-[12px] text-white/40">{relayListening ? "Relay running: waiting for viewers." : "Not listening yet."}</p>
                <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-white/[0.07] bg-black/35 px-4 py-3 text-[13px] text-white/65">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-white/25 accent-white"
                    checked={prefs.allowViewerPrivacyBlackout !== false}
                    onChange={(evt) =>
                      void persistLabs({
                        allowViewerPrivacyBlackout: evt.target.checked,
                      })
                    }
                  />
                  Allow connected viewers with full control to hide my displays (privacy blackout). Turn off if you never want viewers to darken your monitors.
                </label>

              </SurfaceCard>

              {relayListening ? (
                <SurfaceCard
                  title="Test on this PC"
                  description="Opens a second connection from this same app to localhost (no second PC). Use when learning the flow or debugging."
                >
                  <div className="space-y-4 rounded-xl border border-white/[0.06] bg-black/40 px-4 py-4">
                    <label className="flex cursor-pointer items-start gap-3 text-[13px] text-white/70">
                      <input type="checkbox" className="mt-1 h-4 w-4 rounded border-white/20 accent-white" checked={prefs.trustLoopbackLab ?? false} onChange={(evt) => void persistLabs({ trustLoopbackLab: evt.target.checked })} />
                      Trust localhost: auto-approve local test connections
                    </label>
                    <label className={`flex cursor-pointer items-start gap-3 text-[13px] ${prefs.trustLoopbackLab !== true ? "text-white/25" : "text-white/70"}`}>
                      <input
                        disabled={prefs.trustLoopbackLab !== true}
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-white/20 accent-white"
                        checked={prefs.loopbackAutoFullControl ?? false}
                        onChange={(evt) => void persistLabs({ loopbackAutoFullControl: evt.target.checked })}
                      />
                      Local test uses full control (mouse & keyboard on this PC)
                    </label>
                  </div>
                  <Btn variant="primary" className="mt-4" onClick={() => labSpawn().catch(console.error)}>
                    Start local viewer test
                  </Btn>

                  <div ref={localTestStageRef} className="relative mt-6 overflow-hidden rounded-xl border border-white/[0.08] bg-black">
                    <video ref={labVideoRef} muted playsInline className={`w-full object-contain ${labReady ? "aspect-video" : "h-[180px]"}`} />
                    <div ref={labGestureRef} className={`absolute inset-0 rounded-xl ${labReady && labFull ? "cursor-crosshair touch-none" : "pointer-events-none"}`} />
                  </div>

                  <div className="mt-4 flex flex-wrap gap-3">
                    <Btn
                      variant="outline"
                      disabled={!labReady}
                      onClick={() => {
                        const el = localTestStageRef.current;
                        if (!el) return;
                        if (document.fullscreenElement === el) void document.exitFullscreen();
                        else void el.requestFullscreen().catch(() => setToast("Fullscreen blocked by the browser."));
                      }}
                    >
                      {localTestFs ? "Exit simulate fullscreen" : "Simulate fullscreen"}
                    </Btn>
                  </div>

                  <div className="mt-4">
                    <ActivityIndicators subtitle="Lights up when this local viewer sends mouse or keyboard input." remoteRx={pulseOutboundLab} />
                  </div>
                </SurfaceCard>
              ) : null}

              {relayListening ? (
                <div className="space-y-2">
                  <p className="text-[11px] leading-relaxed text-white/35">
                    While hosting, a small always-on-top window in the corner shows the spinning cube indicator only and your desktop stays visible.
                    Remote input pulses appear in this app below, not on your desktop.
                  </p>
                  {relayHot ? (
                    <ActivityIndicators subtitle="Same activity, mirrored inside the app." remoteRx={pulseFromRemote} />
                  ) : null}
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : tab === "connect" ? (
          <motion.div key="connect" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }} className="mt-8 grid gap-6 lg:grid-cols-[320px_1fr]">
            <div className="flex flex-col gap-6">
              <SurfaceCard title="Connect to host" description="You are the viewer. Paste the access code from the host.">
                <label className="text-[11px] font-medium text-white/40">Access code</label>
                <input
                  value={connectCode}
                  onChange={(e) => setConnectCode(e.target.value)}
                  className="mt-2 w-full rounded-xl border border-white/[0.1] bg-black/50 px-4 py-3 text-[13px] text-white placeholder:text-white/25"
                  placeholder={`${CODE_PREFIX}-...`}
                />
                <Btn variant="primary" className="mt-6 w-full" onClick={() => cockpitSpawn().catch(console.error)}>
                  Connect
                </Btn>
                <p className="mt-4 text-[11px] leading-relaxed text-white/35">
                  After connect: click inside the video when the host allows control, then mouse and keyboard go to their PC.
                </p>
              </SurfaceCard>
            </div>

            <SurfaceCard
              title="Remote desktop"
              description={
                cockpitReady
                  ? cockpitFull
                    ? "Control active: use mouse and keyboard here. Fullscreen recommended."
                    : "View only: host did not enable control."
                  : "Connect using the form on the left."
              }
            >
              <div ref={remoteStageRef} className="relative overflow-hidden rounded-xl border border-white/[0.06] bg-black">
                <video ref={stageVideoRef} muted playsInline className="aspect-video w-full object-contain" />
                <div ref={stageGestureRef} className={`absolute inset-0 rounded-xl ${cockpitReady && cockpitFull ? "touch-none cursor-crosshair" : "pointer-events-none"}`} />
                {!cockpitReady ? (
                  <p className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-[13px] text-white/30">No stream yet</p>
                ) : null}
              </div>

              <div className="mt-4 flex flex-wrap gap-3">
                <Btn
                  variant="outline"
                  disabled={!cockpitReady}
                  onClick={() => {
                    const el = remoteStageRef.current;
                    if (!el) return;
                    if (document.fullscreenElement === el) void document.exitFullscreen();
                    else void el.requestFullscreen().catch(() => setToast("Fullscreen blocked by the browser."));
                  }}
                >
                  {remoteFs ? "Exit fullscreen" : "Fullscreen session"}
                </Btn>
              </div>
              {cockpitReady && cockpitFull && hostAllowsViewerBlackout ? (
                <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-white/[0.08] bg-black/40 px-4 py-3 text-[13px] text-white/70">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-white/20 accent-white"
                    checked={privacyBlackout}
                    onChange={(evt) => {
                      const on = evt.target.checked;
                      setPrivacyBlackout(on);
                      cockpitBlackoutSend.current(on);
                      setToast(on ? "Host sees a privacy blackout with a Force disconnect safeguard." : "Host screen restored.");
                    }}
                  />
                  Black out host display (their monitors only go dark when you enable this)
                </label>
              ) : null}
              {cockpitReady && cockpitFull && !hostAllowsViewerBlackout ? (
                <p className="mt-4 text-[11px] text-white/38">Host disabled viewer privacy blackout for this session.</p>
              ) : null}

              <div className="mt-4">
                <ActivityIndicators subtitle="Shows when you are sending mouse or keyboard to the host." remoteRx={pulseOutboundCockpit} />
              </div>
            </SurfaceCard>
          </motion.div>
        ) : tab === "help" ? (
          <motion.div key="help" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }} className="mt-8 flex flex-col gap-6 lg:max-w-3xl">
            <SurfaceCard title="Host a session successfully" description="You are sharing this Windows PC.">
              <ol className="list-inside list-decimal space-y-4 text-[13px] leading-relaxed text-white/52">
                <li>Open Share, pick a port (default ok), tap Start hosting.</li>
                <li>Copy your access code and send it to your partner.</li>
                <li>When they connect, approve View only or Mouse and keyboard.</li>
                <li>Select the monitor or desktop to capture if Windows asks.</li>
                <li>Keep Blckbx running until you Stop hosting.</li>
                <li>You can disable viewer privacy blackout in Hosting if you refuse black screens.</li>
                <li>If your screen is hidden unexpectedly, use Force disconnect on the blackout screen to cut all viewers instantly.</li>
                <li>When hosting starts, capture prep runs automatically so you can approve and share faster.</li>
              </ol>
            </SurfaceCard>
            <SurfaceCard title="Connect as viewer" description={`You're controlling someone else's PC.`}>
              <ol className="list-inside list-decimal space-y-4 text-[13px] leading-relaxed text-white/52">
                <li>Open Connect.</li>
                <li>Paste the host access code from the Share tab.</li>
                <li>Tap Connect and wait until the stream appears.</li>
                <li>Click inside the video if the host gave full control, then keyboard and mouse go to them.</li>
                <li>Use Fullscreen session for a full-desktop feel.</li>
                <li>Privacy blackout is only honored if the host allows it.</li>
                <li>If a connection fails, ask the host to restart hosting and share a fresh access code.</li>
              </ol>
            </SurfaceCard>
          </motion.div>
        ) : (
          <motion.div key="support" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }} className="mt-8 flex flex-col gap-6 lg:max-w-3xl">
            <SurfaceCard title="Support Blckbx" description="Choose a network below. Clicking a button copies the wallet address.">
              <div className="grid justify-center gap-4 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => void clipboard(DONATION_WALLETS.btc)}
                  className="w-[220px] rounded-xl border border-white/12 bg-black/40 px-4 py-5 text-center transition hover:border-white/25 hover:bg-white/[0.03]"
                >
                  <div className="mb-3 flex justify-center">
                    <img src="/SupportIcons/Bitcoin.png" alt="Bitcoin" className="h-10 w-10 object-contain" />
                  </div>
                  <p className="text-sm font-semibold text-white">Donate BTC</p>
                  <p className="mt-2 text-[11px] text-white/45">Copy wallet</p>
                </button>
                <button
                  type="button"
                  onClick={() => void clipboard(DONATION_WALLETS.eth)}
                  className="w-[220px] rounded-xl border border-white/12 bg-black/40 px-4 py-5 text-center transition hover:border-white/25 hover:bg-white/[0.03]"
                >
                  <div className="mb-3 flex justify-center">
                    <img src="/SupportIcons/ETH.png" alt="Ethereum" className="h-10 w-10 object-contain" />
                  </div>
                  <p className="text-sm font-semibold text-white">Donate ETH</p>
                  <p className="mt-2 text-[11px] text-white/45">Copy wallet</p>
                </button>
                <button
                  type="button"
                  onClick={() => void clipboard(DONATION_WALLETS.tether)}
                  className="w-[220px] rounded-xl border border-white/12 bg-black/40 px-4 py-5 text-center transition hover:border-white/25 hover:bg-white/[0.03]"
                >
                  <div className="mb-3 flex justify-center">
                    <img src="/SupportIcons/Thether.png" alt="Tether" className="h-10 w-10 object-contain" />
                  </div>
                  <p className="text-sm font-semibold text-white">Donate Tether</p>
                  <p className="mt-2 text-[11px] text-white/45">Copy wallet</p>
                </button>
              </div>
            </SurfaceCard>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast ? (
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="fixed bottom-8 left-1/2 z-40 max-w-lg -translate-x-1/2 rounded-xl border border-white/[0.12] bg-[var(--bx-surface)] px-5 py-3 text-center text-[13px] text-white/85 shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
          >
            {toast}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
