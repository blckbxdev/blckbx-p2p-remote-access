import { AnimatePresence, motion } from "framer-motion";

type Props = {
  open: boolean;
  peerHint?: string;
  onApprove: (mode: "full" | "view") => void;
  onDismiss: () => void;
};

export function ConsentDialog({ open, peerHint, onApprove, onDismiss }: Props) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-black/80 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="mx-4 w-full max-w-md rounded-2xl border border-white/[0.12] bg-[var(--bx-surface)] p-6 shadow-[0_32px_120px_rgba(0,0,0,0.65)]"
            initial={{ scale: 0.96, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-white/40">Incoming connection</p>
            <h2 className="mt-2 text-xl font-semibold text-white">Allow remote session?</h2>
            <p className="mt-3 text-[13px] leading-relaxed text-white/50">
              From <span className="font-medium text-white/80">{peerHint ?? "unknown"}</span>. Pick what they may do on your PC. You can reject safely.
            </p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <motion.button
                whileTap={{ scale: 0.98 }}
                type="button"
                className="rounded-xl border border-white/15 bg-white/[0.06] px-4 py-4 text-left transition hover:border-white/25 hover:bg-white/[0.09]"
                onClick={() => onApprove("full")}
              >
                <p className="text-[10px] font-semibold uppercase tracking-wider text-white/45">Full control</p>
                <p className="mt-1 text-[15px] font-semibold text-white">Mouse & keyboard</p>
                <p className="mt-2 text-[11px] leading-snug text-white/40">Viewer can move the cursor and type when you approve.</p>
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.98 }}
                type="button"
                className="rounded-xl border border-white/[0.08] bg-black/40 px-4 py-4 text-left transition hover:border-white/15"
                onClick={() => onApprove("view")}
              >
                <p className="text-[10px] font-semibold uppercase tracking-wider text-white/45">View only</p>
                <p className="mt-1 text-[15px] font-semibold text-white">Screen share</p>
                <p className="mt-2 text-[11px] leading-snug text-white/40">They see your screen; control stays blocked.</p>
              </motion.button>
            </div>

            <motion.button
              whileTap={{ scale: 0.99 }}
              type="button"
              className="mt-4 w-full rounded-xl border border-white/[0.08] py-3 text-[12px] font-medium text-white/45 transition hover:bg-white/[0.04]"
              onClick={onDismiss}
            >
              Reject
            </motion.button>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
