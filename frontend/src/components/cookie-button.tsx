"use client";

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

type CookieButtonProps = {
  onClick: () => void;
  expanded: boolean;
  reduceMotion: boolean;
  showLabel?: boolean;
  closeControl?: boolean;
  className?: string;
  decoration?: ReactNode;
};

export function CookieButton({
  onClick,
  expanded,
  reduceMotion,
  showLabel,
  closeControl,
  className,
  decoration,
}: CookieButtonProps) {
  const systemReducedMotion = useReducedMotion();
  const still = reduceMotion || systemReducedMotion || expanded;
  const label = closeControl ? "Cerrar Cookie, tu asistente de IA" : "Abrir Cookie, tu asistente de IA";

  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup={closeControl ? undefined : "dialog"}
      aria-expanded={closeControl ? undefined : expanded}
      title={label}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    >
      <motion.span
        aria-hidden="true"
        data-cookie-orb
        initial={false}
        animate={{ scale: still ? 1 : [1, 1.075, 1] }}
        transition={still ? { duration: 0 } : { duration: 3.6, ease: "easeInOut", repeat: Infinity }}
        className="pointer-events-none relative h-6 w-6 shrink-0 rounded-full border border-white/50 bg-blue-600/80 shadow-[inset_0_-3px_6px_#123e9d,0_2px_7px_#2678ed55] backdrop-blur-sm"
        style={{ backgroundImage: "radial-gradient(circle at 33% 24%, #e5f8ff 0%, #72cbff 22%, #3489ff 48%, #1252c2 86%)" }}
      >
        {decoration}
      </motion.span>
      {showLabel && <span>Cookie</span>}
    </button>
  );
}
