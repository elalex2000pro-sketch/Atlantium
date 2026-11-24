"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, Trophy } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  claimCookieLevelNotice,
  setCookieRewardEquipped,
  XP_EVENT,
  type CosmeticReward,
  type LevelInfo,
} from "@/lib/gamification";

interface XpToast {
  id: number;
  amount: number;
  reason: string;
  level: number;
  title: string;
  leveledUp: boolean;
  info: LevelInfo;
  unlocked?: CosmeticReward[];
  cookieRewards?: ReturnType<typeof claimCookieLevelNotice>;
}

/** Aviso flotante cuando se gana EXP o se sube de nivel. */
export function GamificationToast({ userId, reduceMotion, panelOpen, onCelebrate, outfit, panelSlot }: {
  userId: string;
  reduceMotion: boolean;
  panelOpen: boolean;
  onCelebrate: (happy: boolean) => void;
  outfit: readonly string[];
  panelSlot: HTMLDivElement | null;
}) {
  const [toast, setToast] = useState<XpToast | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const cookieRewards = toast?.cookieRewards ?? [];
  const hasCookieRewards = cookieRewards.length > 0;
  const inPanel = panelSlot !== null && hasCookieRewards;

  useEffect(() => {
    const onXp = (event: Event) => {
      const detail = (event as CustomEvent<Omit<XpToast, "id"> & { userId: string; previousLevel: number }>).detail;
      if (!detail || detail.userId !== userId) return;
      const cookieRewards = detail.leveledUp ? claimCookieLevelNotice(userId, detail.previousLevel, detail.level) : null;
      if (detail.leveledUp && !cookieRewards) return;
      setHovered(false);
      setFocused(false);
      setToast({ id: Date.now(), ...detail, cookieRewards });
    };
    window.addEventListener(XP_EVENT, onXp);
    return () => window.removeEventListener(XP_EVENT, onXp);
  }, [userId]);

  useEffect(() => {
    if (!toast?.cookieRewards || reduceMotion) return;
    onCelebrate(true);
    const timeout = window.setTimeout(() => onCelebrate(false), 3800);
    return () => {
      window.clearTimeout(timeout);
      onCelebrate(false);
    };
  }, [toast, reduceMotion, onCelebrate]);

  useEffect(() => {
    if (!toast || (hasCookieRewards && (hovered || focused))) return;
    const timeout = window.setTimeout(() => setToast(null), hasCookieRewards ? 12_000 : 3800);
    return () => window.clearTimeout(timeout);
  }, [toast, hasCookieRewards, hovered, focused]);

  useEffect(() => {
    setHovered(false);
    setFocused(false);
  }, [inPanel]);

  const notification = (
    <AnimatePresence>
      {toast ? (
        <motion.div
          key={toast.id}
          initial={reduceMotion ? false : { opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: 12, scale: 0.97 }}
          transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 28 }}
          className={inPanel
            ? "px-3 pt-3"
            : panelOpen && toast.leveledUp
              ? "pointer-events-none fixed left-4 top-[max(1rem,env(safe-area-inset-top))] z-[100] w-[min(92vw,360px)] md:bottom-6 md:left-6 md:top-auto"
              : "fixed bottom-[calc(var(--mobile-nav-offset,0px)+1rem)] left-1/2 z-[90] w-[min(92vw,360px)] -translate-x-1/2 md:bottom-6 md:left-6 md:translate-x-0"}
          onPointerEnter={() => { if (hasCookieRewards) setHovered(true); }}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
        >
          <div className="app-glass-strong rounded-2xl border border-white/40 px-3.5 py-3 shadow-[0_24px_60px_-28px_rgba(18,24,38,0.6)] dark:border-white/10">
            <div role="status" className="flex items-center gap-3">
              <span
                className={
                  toast.leveledUp
                    ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-sm"
                    : "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#0066FF]/10 text-[#0066FF] dark:bg-[#8ab9ff]/10 dark:text-[#8ab9ff]"
                }
              >
                {toast.leveledUp ? (
                  <Trophy className="h-5 w-5" />
                ) : (
                  <Sparkles className="h-5 w-5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold text-slate-800 dark:text-white/90">
                  {toast.leveledUp
                    ? `¡Subiste al nivel ${toast.level}!`
                    : `+${toast.amount} EXP`}
                </p>
                <p className="truncate text-[10.5px] text-slate-500 dark:text-white/40">
                  {toast.leveledUp
                    ? toast.unlocked?.length
                      ? `Desbloqueado: ${toast.unlocked.map((reward) => reward.name).join(", ")}`
                      : toast.title
                    : `${toast.reason} · ${toast.info.xp} EXP`}
                </p>
                {hasCookieRewards && (
                  <p className="text-[10.5px] text-muted-foreground">
                    Cookie desbloqueó: {cookieRewards.map((reward) => reward.name).join(", ")}
                  </p>
                )}
              </div>
              {!toast.leveledUp ? (
                <span className="shrink-0 text-[10px] font-semibold tabular-nums text-[#0066FF] dark:text-[#8ab9ff]">
                  Nv. {toast.level}
                </span>
              ) : null}
            </div>
            {hasCookieRewards && (
              <div className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                {cookieRewards.map(({ id, name }) => {
                  const equipped = outfit.includes(id);
                  return (
                    <Button key={id} type="button" variant="outline" size="sm" className="transition-none"
                      aria-label={equipped ? `Cookie lleva ${name.toLowerCase()}` : `Equipar ${name.toLowerCase()} en Cookie`} aria-disabled={equipped}
                      onClick={() => { if (!equipped) setCookieRewardEquipped(userId, id, true); }}>
                      {equipped ? "Equipado" : "Equipar"}{cookieRewards.length > 1 ? ` · ${name}` : ""}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
  return inPanel ? createPortal(notification, panelSlot) : notification;
}
