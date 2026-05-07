import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import { useState } from "react";
import { usePointerReactiveGrid } from "../hooks/usePointerReactiveGrid";

export function BlackoutView() {
  usePointerReactiveGrid(true);
  const [busy, setBusy] = useState(false);

  const forceDisconnect = () => {
    if (busy) return;
    setBusy(true);
    void invoke("host_force_disconnect")
      .catch(console.error)
      .finally(() => setBusy(false));
  };

  return (
    <div className="bx-grid-reactive fixed inset-0 overflow-hidden bg-[#030303]">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="pointer-events-none absolute inset-0 bg-black/88" />

      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center gap-10 px-6 text-center">
        <p className="max-w-md text-xl font-semibold leading-snug text-white/92">Your screen has been hidden for viewer privacy.</p>
        <p className="max-w-lg text-[14px] leading-relaxed text-white/52">
          If this was not intended, stop the session immediately. Force disconnect closes all viewers, ends hosting, and restores your display.
        </p>

        <motion.button
          type="button"
          disabled={busy}
          whileTap={{ scale: busy ? 1 : 0.98 }}
          onClick={forceDisconnect}
          className="pointer-events-auto rounded-xl border border-white/20 bg-white px-8 py-4 text-[14px] font-semibold text-black shadow-[0_12px_40px_rgba(0,0,0,0.45)] transition hover:bg-white/90 disabled:cursor-wait disabled:opacity-50"
        >
          {busy ? "Disconnecting…" : "Force disconnect"}
        </motion.button>
      </div>
    </div>
  );
}
