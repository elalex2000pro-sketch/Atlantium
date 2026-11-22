"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { api, tokenStore } from "@/lib/api";
import { awardFocusXp } from "@/lib/gamification";
import { showSystemNotification } from "@/lib/system-notifications";
import { withFocusLock } from "@/lib/focus-timer-lock";
import { claimExpired, readTimer, readyTimer, remainingMs, timerKey, toggleTimer, type FocusTimer, type TimerMode } from "@/lib/focus-timer";

const UNCONFIRMED = "Guardado sin confirmar";
const STORAGE_ERROR = "No se pudo acceder al temporizador guardado.";

const FocusTimerContext = createContext({
  mode: "focus" as TimerMode,
  secondsLeft: readyTimer().duration,
  running: false,
  ready: false,
  finishing: false,
  sessionsDone: 0,
  notice: null as string | null,
  toggle: () => {},
  reset: () => {},
  changeMode: (_mode: TimerMode) => {},
});

export function useFocusTimer() {
  return useContext(FocusTimerContext);
}

export function FocusTimerProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  return userId
    ? <AccountFocusTimer key={userId} userId={userId}>{children}</AccountFocusTimer>
    : children;
}

// Check the active token even in a tab whose AuthProvider hasn't noticed a
// logout or account switch in another tab. The server still validates the JWT.
function hasAccount(userId: string) {
  try {
    const payload = tokenStore.get()?.split(".")[1];
    return !!payload && JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).sub === userId;
  } catch {
    return false;
  }
}

function AccountFocusTimer({ userId, children }: { userId: string; children: ReactNode }) {
  const key = timerKey(userId);
  const pathname = usePathname();
  const [timer, setTimer] = useState<FocusTimer>(readyTimer);
  const [now, setNow] = useState(Date.now);
  const [ready, setReady] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [sessionsDone, setSessionsDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const seen = useRef(new Set<string>());
  const hydrated = useRef(false);

  const publish = useCallback((snapshot: FocusTimer) => {
    if (!mounted.current) return;
    if (snapshot.status === "saved" && snapshot.mode === "focus" && !seen.current.has(snapshot.id)) {
      seen.current.add(snapshot.id);
      if (hydrated.current) setSessionsDone((count) => count + 1);
    }
    hydrated.current = true;
    setTimer(snapshot);
    setNow(Date.now());
    setReady(true);
  }, []);

  const update = useCallback(async (edit: (current: FocusTimer) => FocusTimer, settle = false) => {
    const snapshot = await withFocusLock(key, () => {
      const current = readTimer(localStorage, userId);
      const next = settle || (mounted.current && hasAccount(userId)) ? edit(current) : current;
      if (next !== current) localStorage.setItem(key, JSON.stringify(next));
      return next;
    });
    // Read again in case another tab already changed the snapshot.
    if (mounted.current && hasAccount(userId)) publish(readTimer(localStorage, userId));
    return snapshot;
  }, [key, publish, userId]);

  const finish = useCallback(async () => {
    if (inFlight.current || !hasAccount(userId)) return;
    inFlight.current = true;
    let claimed = false;
    try {
      const snapshot = await update((current) => {
        const next = claimExpired(current, Date.now());
        claimed = next !== current;
        return next;
      });
      if (!claimed || !mounted.current || !hasAccount(userId)) return;

      setFinishing(true);
      const result = api.logFocusSession(Math.round(snapshot.duration / 60), snapshot.mode);
      void showSystemNotification({
        title: snapshot.mode === "focus" ? "Sesión completada" : "Descanso terminado",
        body: snapshot.mode === "focus"
          ? "Buen trabajo. Tómate 5 minutos antes de seguir."
          : "Vuelve al enfoque cuando estés listo.",
        tag: "focus-timer",
        url: "/focus",
      });
      // The server could have committed before the connection dropped.
      const saved = await result.then(() => true, () => false);
      if (saved && snapshot.mode === "focus") awardFocusXp(userId);
      await update((current) => current.id === snapshot.id && current.status === "sending"
        ? { ...current, status: saved ? "saved" : "unconfirmed" }
        : current, true);
    } catch {
      if (mounted.current) setError(claimed ? UNCONFIRMED : STORAGE_ERROR);
    } finally {
      inFlight.current = false;
      if (mounted.current) setFinishing(false);
    }
  }, [update, userId]);

  const refresh = useCallback(() => {
    if (!hasAccount(userId)) {
      setReady(false);
      return;
    }
    try {
      const snapshot = readTimer(localStorage, userId);
      publish(snapshot);
      if (snapshot.status === "running" && snapshot.endsAt <= Date.now()) void finish();
    } catch {
      setError(STORAGE_ERROR);
    }
  }, [finish, publish, userId]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    function onStorage(event: StorageEvent) {
      if (event.key === key || event.key === "autopilot_token" || event.key === null) refresh();
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted.current = false;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [key, refresh]);

  const deadline = ready && timer.status === "running" ? timer.endsAt : null;
  useEffect(() => {
    if (deadline === null || pathname !== "/focus") return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [deadline, pathname]);

  useEffect(() => {
    if (deadline === null) return;
    let timeout: number;
    function schedule(target: number) {
      timeout = window.setTimeout(() => {
        if (target > Date.now()) schedule(target);
        else refresh();
      }, Math.max(0, target - Date.now()));
    }
    schedule(deadline);
    return () => window.clearTimeout(timeout);
  }, [deadline, refresh]);

  function edit(change: (current: FocusTimer, time: number) => FocusTimer) {
    if (!ready || finishing || inFlight.current || !hasAccount(userId)) return;
    setError(null);
    void update((current) => {
      const time = Date.now();
      if (current.status === "running" && current.endsAt <= time) return current;
      return change(current, time);
    }).then((snapshot) => {
      if (snapshot.status === "running" && snapshot.endsAt <= Date.now()) void finish();
    }).catch(() => setError(STORAGE_ERROR));
  }

  const visibleTimer = ready ? timer : readyTimer();
  const notice = error ?? (ready && (timer.status === "unconfirmed" || (timer.status === "sending" && !finishing))
    ? UNCONFIRMED
    : null);

  return (
    <FocusTimerContext.Provider value={{
      mode: visibleTimer.mode,
      secondsLeft: Math.ceil(remainingMs(visibleTimer, now) / 1000),
      running: visibleTimer.status === "running",
      ready,
      finishing,
      sessionsDone: ready ? sessionsDone : 0,
      notice,
      toggle: () => edit((current, time) => toggleTimer(current, time, () => crypto.randomUUID())),
      reset: () => edit((current) => readyTimer(current.mode)),
      changeMode: (mode) => edit(() => readyTimer(mode)),
    }}>
      {children}
    </FocusTimerContext.Provider>
  );
}
