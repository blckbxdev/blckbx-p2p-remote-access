import type { PropsWithChildren } from "react";
import { motion } from "framer-motion";

type PanelProps = {
  title: string;
  description?: string;
  children: React.ReactNode;
};

export function SurfaceCard({ title, description, children }: PanelProps) {
  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      className="rounded-2xl border border-white/[0.08] bg-[var(--bx-elevated)] shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
    >
      <div className="border-b border-white/[0.06] px-5 py-4">
        <h2 className="text-[13px] font-semibold tracking-wide text-white">{title}</h2>
        {description ? <p className="mt-1 text-[12px] leading-relaxed text-white/45">{description}</p> : null}
      </div>
      <div className="px-5 py-5">{children}</div>
    </motion.section>
  );
}

export type DashboardTab = "share" | "connect" | "help" | "support";

export function TopShareTabs(props: {
  tab: DashboardTab;
  onShare: () => void;
  onConnect: () => void;
  onHelp: () => void;
  onSupport: () => void;
}) {
  const cls = (active: boolean) =>
    `relative flex-1 border-b-2 py-4 text-center text-[13px] font-semibold transition-colors ${
      active ? "border-white text-white" : "border-transparent text-white/35 hover:text-white/55"
    }`;

  return (
    <nav className="flex border-b border-white/[0.08]">
      <motion.button layout type="button" onClick={props.onShare} className={cls(props.tab === "share")}>
        Share
      </motion.button>
      <motion.button layout type="button" onClick={props.onConnect} className={cls(props.tab === "connect")}>
        Connect
      </motion.button>
      <motion.button layout type="button" onClick={props.onHelp} className={cls(props.tab === "help")}>
        Help
      </motion.button>
      <motion.button layout type="button" onClick={props.onSupport} className={cls(props.tab === "support")}>
        Support
      </motion.button>
    </nav>
  );
}

type BtnProps = PropsWithChildren<{
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "outline" | "danger" | "ghost";
  className?: string;
}>;

export function Btn({ onClick, disabled, variant = "outline", className = "", children }: BtnProps) {
  const styles: Record<string, string> = {
    primary: "border-transparent bg-white text-black hover:bg-white/90 shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]",
    outline: "border-white/15 bg-transparent text-white hover:border-white/25 hover:bg-white/[0.04]",
    danger: "border-red-500/35 bg-red-950/40 text-red-100 hover:bg-red-950/55",
    ghost: "border-transparent bg-transparent text-white/55 hover:bg-white/[0.05] hover:text-white",
  };
  return (
    <motion.button
      whileTap={{ scale: disabled ? 1 : 0.98 }}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-xl border px-4 py-3 text-[12px] font-semibold tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${styles[variant]} ${className}`}
    >
      {children}
    </motion.button>
  );
}
