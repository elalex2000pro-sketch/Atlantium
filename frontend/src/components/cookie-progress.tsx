"use client";

import { useCallback, useSyncExternalStore } from "react";
import { getCookieRewards, getGamification, getLevelInfo, MAX_LEVEL, XP_EVENT } from "@/lib/gamification";

function subscribe(onChange: () => void) {
  window.addEventListener(XP_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(XP_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function CookieProgress({ userId }: { userId: string }) {
  const readXp = useCallback(() => getGamification(userId).xp, [userId]);
  const xp = useSyncExternalStore(subscribe, readXp, () => 0);
  const { level, currentLevelXp, nextLevelXp, toNext } = getLevelInfo(xp);
  const atMax = level === MAX_LEVEL;
  return (
    <div className="shrink-0 border-b border-border/50 px-4 py-2 text-xs">
      <details>
        <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          <span className="font-semibold">Nivel {level} de Cookie</span>
          <span className="ml-2 text-muted-foreground">Recompensas</span>
        </summary>
        <div className="mt-2 max-h-[min(8rem,20dvh)] space-y-2 overflow-y-auto">
          <ul aria-label="Recompensas de Cookie" className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {getCookieRewards(level).map(({ id, name, level: required, icon, unlocked }) => (
              <li key={id} className="flex min-w-0 items-center gap-2 rounded-lg border border-border/50 bg-background/40 p-1.5">
                <span aria-hidden="true" className={unlocked ? "text-base" : "text-base brightness-0 opacity-40 dark:invert"}>{icon}</span>
                <span className="min-w-0">
                  <span className="block font-medium">{name}</span>
                  <span className="text-muted-foreground">{unlocked ? "Desbloqueado" : `Nivel ${required}`}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </details>
      <div className="mt-1.5 flex items-center gap-2">
        <progress value={atMax ? 1 : xp - currentLevelXp} max={atMax ? 1 : nextLevelXp - currentLevelXp}
          aria-label="Progreso de XP de Cookie"
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full accent-blue-500" />
        <span className="text-muted-foreground">{atMax ? "Nivel máximo" : `${toNext} XP para el nivel ${level + 1}`}</span>
      </div>
    </div>
  );
}
