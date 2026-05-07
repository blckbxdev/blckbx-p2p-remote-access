import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import Dashboard from "./Dashboard";
import { SetupWizard } from "./components/SetupWizard";
import { usePointerReactiveGrid } from "./hooks/usePointerReactiveGrid";

type PreferencesPayload = {
  setupComplete?: boolean;
};

export default function App() {
  const [bootReady, setBootReady] = useState(false);
  const [wizardComplete, setWizardComplete] = useState<boolean | null>(null);
  usePointerReactiveGrid(true);

  useEffect(() => {
    invoke<PreferencesPayload>("prefs_load")
      .then((prefs) => setWizardComplete(Boolean(prefs?.setupComplete ?? false)))
      .catch(() => setWizardComplete(true))
      .finally(() => setBootReady(true));
  }, []);

  if (!bootReady || wizardComplete === null) {
    return (
      <div className="bx-grid-bg bx-grid-reactive relative grid min-h-screen place-items-center bg-[var(--bx-bg)]">
        <div className="flex flex-col items-center gap-4">
          <motion.div animate={{ opacity: [0.35, 1, 0.35] }} transition={{ repeat: Infinity, duration: 1.2 }} className="text-[11px] font-semibold uppercase tracking-[0.45em] text-white/40">
            Blckbx
          </motion.div>
          <div className="h-px w-16 bg-white/15" />
        </div>
      </div>
    );
  }

  const finishWizard = async () => {
    await invoke("prefs_save_setup_complete", { complete: true }).catch(console.error);
    setWizardComplete(true);
  };

  return (
    <div className="relative min-h-screen bg-[var(--bx-bg)] text-[var(--bx-fg)]">
      <div className="bx-grid-bg bx-grid-reactive pointer-events-none fixed inset-0 opacity-95" />
      <motion.main className="relative z-10 min-h-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }}>
        {!wizardComplete ? <SetupWizard finish={() => void finishWizard()} /> : <Dashboard />}
      </motion.main>
    </div>
  );
}
