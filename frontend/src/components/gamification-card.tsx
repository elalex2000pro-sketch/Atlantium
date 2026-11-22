"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

import { useAuth } from "@/components/auth-provider";
import { RewardShelf } from "@/components/reward-shelf";
import { AnimatedCounter } from "@/components/ui/animated-counter";
import { DASHBOARD_ITEM } from "@/lib/dashboard";
import {
  XP_EVENT,
  getGamification,
  getLevelInfo,
  type LevelInfo,
} from "@/lib/gamification";

function readLevel(userId: string | undefined): LevelInfo | null {
  if (!userId || typeof window === "undefined") return null;
  return getLevelInfo(getGamification(userId).xp);
}

/** Tarjeta de progreso: nivel, título y EXP, integrada en el cristal del Dashboard. */
export function GamificationCard() {
  const { user } = useAuth();
  const [info, setInfo] = useState<LevelInfo | null>(() => readLevel(user?.id));

  useEffect(() => {
    if (!user) {
      setInfo(null);
      return;
    }
    const sync = () => setInfo(getLevelInfo(getGamification(user.id).xp));
    sync();
    window.addEventListener(XP_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(XP_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [user]);

  if (!user) return null;

  if (!info) {
    return (
      <motion.section
        variants={DASHBOARD_ITEM}
        aria-busy="true"
        className="app-glass-strong relative overflow-hidden rounded-[26px] border border-white/45 px-4 py-3 shadow-[0_22px_60px_-42px_rgba(15,23,42,0.55)] dark:border-white/10"
      >
        <div className="flex animate-pulse items-center gap-4">
          <div className="h-10 w-10 shrink-0 rounded-2xl bg-black/[0.06] dark:bg-white/[0.08]" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-2.5 w-36 rounded-full bg-black/[0.06] dark:bg-white/[0.08]" />
            <div className="h-4 w-52 max-w-full rounded-full bg-black/[0.08] dark:bg-white/[0.1]" />
            <div className="h-1.5 w-full rounded-full bg-black/[0.06] dark:bg-white/[0.08]" />
          </div>
        </div>
      </motion.section>
    );
  }

  return (
    <motion.section
      variants={DASHBOARD_ITEM}
      aria-label={`Nivel ${info.level}, ${info.title}, ${info.xp} EXP`}
      className="app-glass-strong relative overflow-hidden rounded-[26px] border border-white/45 px-4 py-3 shadow-[0_22px_60px_-42px_rgba(15,23,42,0.55)] dark:border-white/10"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-[#0066FF]/15 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-20 left-1/3 h-36 w-36 rounded-full bg-[#c084fc]/15 blur-3xl"
      />

      <div className="relative flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-2xl bg-gradient-to-br from-[#0066FF] via-[#6a7bff] to-[#c084fc] text-white shadow-[0_10px_24px_-12px_rgba(0,102,255,0.8)]">
          <span className="text-[7.5px] font-semibold uppercase tracking-[0.14em] opacity-75">
            Nivel
          </span>
          <span className="text-[17px] font-bold leading-none">
            <AnimatedCounter value={info.level} />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-white/40">
              <Sparkles className="h-3 w-3 text-[#0066FF] dark:text-[#8ab9ff]" />
              Nivel y experiencia
            </p>
            <p className="text-[10.5px] font-semibold tabular-nums text-slate-500 dark:text-white/40">
              <AnimatedCounter value={info.xp} /> EXP
            </p>
          </div>

          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
            <p className="text-[14px] font-semibold tracking-[-0.025em] text-slate-800 dark:text-white/90">
              {info.title}
            </p>
            <span className="text-[10px] font-medium text-slate-400 dark:text-white/30">
              Nivel <AnimatedCounter value={info.level} />
            </span>
          </div>

          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(info.progress * 100)}
            aria-label={`Progreso al nivel ${info.level + 1}`}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/10"
          >
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(4, Math.round(info.progress * 100))}%` }}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="h-full rounded-full bg-gradient-to-r from-[#0066FF] to-[#c084fc]"
            />
          </div>
        </div>

      </div>

      <RewardShelf level={info.level} />
    </motion.section>
  );
}
