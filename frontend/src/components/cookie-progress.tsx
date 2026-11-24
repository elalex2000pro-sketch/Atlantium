"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { getCookieRewards, getGamification, getLevelInfo, MAX_LEVEL, setCookieRewardEquipped, XP_EVENT } from "@/lib/gamification";

function subscribe(onChange: () => void) {
  window.addEventListener(XP_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(XP_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function CookieProgress({ userId, outfit }: { userId: string; outfit: readonly string[] }) {
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
        <div className="mt-2 max-h-[min(8rem,20dvh)] overflow-y-auto sm:max-h-[min(11rem,24dvh)]">
          <ul aria-label="Recompensas de Cookie" className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {getCookieRewards(level).map(({ id, name, level: required, icon, unlocked }) => {
              const equipped = outfit.includes(id);
              const action = equipped ? "Quitar" : "Equipar";
              return (
                <li key={id} className="flex min-w-0 flex-col justify-between gap-1 rounded-lg border border-border/50 bg-background/40 p-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span aria-hidden="true" className={unlocked ? "text-base" : "text-base brightness-0 opacity-40 dark:invert"}>{icon}</span>
                    <span className="min-w-0">
                      <span className="block font-medium">{name}</span>
                      <span className="text-muted-foreground">{equipped ? "Equipado" : unlocked ? "Desbloqueado" : `Nivel ${required}`}</span>
                    </span>
                  </div>
                  {unlocked && (
                    <Button type="button" variant="outline" size="sm" className="transition-none" aria-label={`${action} ${name.toLowerCase()}`}
                      onClick={() => setCookieRewardEquipped(userId, id, !equipped)}>
                      {action}
                    </Button>
                  )}
                </li>
              );
            })}
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
