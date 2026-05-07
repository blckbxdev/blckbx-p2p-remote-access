import type { TransmitPulse } from "../types/session";

function Led({ label, hot }: { label: string; hot: boolean }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider transition-all duration-150 ${
        hot ? "border-white/35 bg-white/[0.08] text-white" : "border-white/[0.08] bg-transparent text-white/30"
      }`}
    >
      {label}
    </div>
  );
}

export function ActivityIndicators({ subtitle, remoteRx }: { subtitle: string; remoteRx: TransmitPulse }) {
  return (
    <div className="space-y-3 rounded-xl border border-white/[0.06] bg-black/50 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Input activity</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Led label="Mouse" hot={remoteRx.mouse} />
        <Led label="Keyboard" hot={remoteRx.keyboard} />
      </div>
      <p className="text-[11px] leading-snug text-white/40">{subtitle}</p>
    </div>
  );
}
