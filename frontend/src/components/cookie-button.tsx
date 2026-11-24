"use client";

import type { MouseEventHandler, ReactNode } from "react";
import { forwardRef, useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

type CookieButtonProps = {
  onClick: MouseEventHandler<HTMLButtonElement>;
  reduceMotion: boolean;
  className?: string;
  decoration?: ReactNode;
};

export type CookieExpression = "neutral" | "happy" | "thinking" | "surprised" | "sleeping";

function CookieFace({ expression, blink }: { expression: CookieExpression; blink: boolean }) {
  const closed = expression === "sleeping" || expression === "happy";
  const thinking = expression === "thinking";
  const surprised = expression === "surprised";
  return (
    <svg viewBox="0 0 40 40" className="absolute inset-0 h-full w-full" fill="none" aria-hidden="true">
      <g transform="translate(0 18)">
        <motion.g initial={false} animate={{ scaleY: blink ? 0.12 : 1 }} transition={{ duration: 0.09 }}>
          {[14, 26].map((x) => closed ? (
            <path key={x} d={expression === "happy" ? `M${x - 3} 1 q3 -5 6 0` : `M${x - 3} 0 q3 4 6 0`}
              stroke="#f0faff" strokeWidth="2.1" strokeLinecap="round" />
          ) : (
            <g key={x}>
              <ellipse cx={x} cy="0" rx={surprised ? 3.3 : 2.65} ry={surprised ? 3.75 : 3.35} fill="#f1faff" />
              <ellipse cx={x + (thinking ? 0.85 : 0.15)} cy={thinking ? -1.05 : 0.35} rx="1.45" ry="1.8" fill="#173985" />
              <circle cx={x + (thinking ? 1.25 : 0.55)} cy={thinking ? -1.7 : -0.42} r="0.55" fill="white" />
            </g>
          ))}
        </motion.g>
      </g>
      {surprised ? <ellipse cx="20" cy="26.5" rx="1.95" ry="2.4" fill="#eefaff" /> :
        expression === "happy" ? <path d="M16.5 25.5h7a.65.65 0 0 1 .55.95c-1.9 4.2-6.2 4.2-8.1 0a.65.65 0 0 1 .55-.95Z" fill="#eefaff" /> :
          <path d={thinking ? "M18.4 26.4q1.6-.8 3.25-.5" : "M16.9 25.3q3.1 3.1 6.2 0"}
            stroke="#e3f8ff" strokeWidth="1.65" strokeLinecap="round" />}
    </svg>
  );
}

export function CookieOrb({
  reduceMotion,
  decoration,
  expression = "neutral",
  idle = true,
  greet = false,
  size = "header",
}: Pick<CookieButtonProps, "reduceMotion" | "decoration"> & { expression?: CookieExpression; idle?: boolean; greet?: boolean; size?: "header" | "floating" }) {
  const systemReducedMotion = useReducedMotion();
  const still = reduceMotion || systemReducedMotion;
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (still || !idle || expression === "sleeping") return;
    let timer: ReturnType<typeof setTimeout>;
    const next = (delay = 3000 + Math.random() * 3000) => {
      timer = setTimeout(() => {
        setBlinking(true);
        timer = setTimeout(() => {
          setBlinking(false);
          next();
        }, 155);
      }, delay);
    };
    next(greet ? 650 : undefined);
    return () => {
      clearTimeout(timer);
      setBlinking(false);
    };
  }, [still, idle, expression, greet]);

  return (
    <motion.span
      aria-hidden="true"
      data-cookie-orb
      data-cookie-expression={expression}
      data-cookie-blinking={blinking && !still}
      initial={{ scale: 1, y: 0 }}
      animate={still || !idle ? { scale: 1, y: 0 } : { scale: [1, 1.055, 1], y: [0, -2.5, 0] }}
      transition={still || !idle ? { duration: 0 } : { duration: 3.8, ease: "easeInOut", repeat: Infinity }}
      className={cn("pointer-events-none relative block shrink-0 rounded-full border border-sky-200/65 shadow-[inset_0_-3px_6px_#92e6ff70,0_3px_12px_#2478ed70]", size === "floating" ? "h-[52px] w-[52px]" : "h-11 w-11")}
      style={{ background: "radial-gradient(ellipse at 29% 21%, #d7f0ff 0%, #91b4ff80 11%, transparent 32%), radial-gradient(ellipse at 51% 5%, #243ba5 8%, #3d52e5 49%, #3280ef 71%, #72daff 100%)" }}
    >
      <CookieFace expression={expression} blink={blinking && !still} />
      {decoration}
    </motion.span>
  );
}

export const CookieButton = forwardRef<HTMLButtonElement, CookieButtonProps & { active?: boolean; celebrating?: boolean }>(function CookieButton({
  onClick, reduceMotion, className, decoration, active = true, celebrating = false,
}, ref) {
  const [expression, setExpression] = useState<CookieExpression>("neutral");
  useEffect(() => {
    if (!active || expression !== "neutral") return;
    const timer = setTimeout(() => setExpression("sleeping"), 60_000);
    return () => clearTimeout(timer);
  }, [active, expression]);
  useEffect(() => {
    if (expression !== "surprised") return;
    const timer = setTimeout(() => setExpression("neutral"), 450);
    return () => clearTimeout(timer);
  }, [expression]);

  const wake = () => setExpression((current) => current === "sleeping" ? "surprised" : current);
  return (
    <button
      ref={ref}
      type="button"
      aria-label="Abrir Cookie, tu asistente de IA"
      aria-haspopup="dialog"
      title="Abrir Cookie, tu asistente de IA"
      onClick={onClick}
      onPointerEnter={wake}
      onFocus={wake}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    >
      <CookieOrb reduceMotion={reduceMotion} decoration={decoration} expression={celebrating && !reduceMotion ? "happy" : expression} idle={active} size="floating" />
    </button>
  );
});
