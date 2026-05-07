import { motion } from "framer-motion";

type Props = {
  finish: () => void;
};

export function SetupWizard({ finish }: Props) {
  const steps = [
    {
      title: "Choose your role",
      copy: "Host shares this computer’s screen after you start hosting. Viewer connects with the host’s address and session code.",
    },
    {
      title: "Approve every session",
      copy: "Unknown viewers knock first: you pick view-only or full control (mouse and keyboard). Nothing leaves your desk without consent.",
    },
    {
      title: "Encrypted stream",
      copy: "Remote video uses WebRTC peer encryption (DTLS-SRTP). Control commands are enforced on the host inside this app.",
    },
  ];

  return (
    <div className="relative isolate min-h-screen bg-[var(--bx-bg)]">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="relative z-10 mx-auto flex max-w-3xl flex-col gap-12 px-6 py-16">
        <header>
          <p className="text-[10px] font-semibold uppercase tracking-[0.35em] text-white/35">Welcome</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-[2.75rem]">
            Blckbx <span className="text-white/55">Remote Access</span>
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-white/45">
            Desktop-focused remote control with a clear host / viewer split. Set up once, then jump straight into the dashboard.
          </p>
        </header>

        <div className="grid gap-4 sm:grid-cols-3">
          {steps.map((step, idx) => (
            <motion.div
              key={step.title}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.07, type: "spring", stiffness: 320, damping: 28 }}
              className="rounded-2xl border border-white/[0.08] bg-[var(--bx-elevated)] p-5"
            >
              <p className="font-mono text-[11px] text-white/25">0{idx + 1}</p>
              <p className="mt-4 text-[15px] font-semibold text-white">{step.title}</p>
              <p className="mt-3 text-[12px] leading-relaxed text-white/45">{step.copy}</p>
            </motion.div>
          ))}
        </div>

        <div className="flex flex-col gap-4 border-t border-white/[0.06] pt-10 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] text-white/35">You can change behaviour anytime from the Host tab.</p>
          <motion.button
            whileTap={{ scale: 0.98 }}
            type="button"
            className="rounded-xl bg-white px-8 py-3.5 text-[13px] font-semibold text-black transition hover:bg-white/90"
            onClick={finish}
          >
            Open dashboard
          </motion.button>
        </div>
      </motion.div>
    </div>
  );
}
