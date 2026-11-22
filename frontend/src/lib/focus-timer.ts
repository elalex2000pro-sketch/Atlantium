export type TimerMode = "focus" | "break";

export const DURATIONS: Record<TimerMode, number> = { focus: 25 * 60, break: 5 * 60 };

export type FocusTimer = { mode: TimerMode; duration: number } & (
  | { status: "ready"; id: null }
  | { status: "running"; id: string; endsAt: number }
  | { status: "paused"; id: string; remainingMs: number }
  | { status: "sending" | "saved" | "unconfirmed"; id: string }
);

export function readyTimer(mode: TimerMode = "focus"): FocusTimer {
  return { mode, duration: DURATIONS[mode], status: "ready", id: null };
}

export function remainingMs(timer: FocusTimer, now: number): number {
  switch (timer.status) {
    case "running": return Math.min(timer.duration * 1000, Math.max(0, timer.endsAt - now));
    case "paused": return timer.remainingMs;
    case "ready": return timer.duration * 1000;
    default: return 0;
  }
}

export function toggleTimer(timer: FocusTimer, now: number, newId: () => string): FocusTimer {
  const { mode, duration } = timer;
  if (timer.status === "running") {
    const remaining = remainingMs(timer, now);
    return remaining > 0 ? { mode, duration, status: "paused", id: timer.id, remainingMs: remaining } : timer;
  }
  const paused = timer.status === "paused";
  return {
    mode,
    duration,
    status: "running",
    id: paused ? timer.id : newId(),
    endsAt: now + (paused ? timer.remainingMs : duration * 1000),
  };
}

export function claimExpired(timer: FocusTimer, now: number): FocusTimer {
  if (timer.status !== "running" || timer.endsAt > now) return timer;
  return { mode: timer.mode, duration: timer.duration, id: timer.id, status: "sending" };
}

export function timerKey(userId: string): string {
  return "autopilot:focus:timer:v1:" + userId;
}

export function readTimer(storage: Pick<Storage, "getItem">, userId: string): FocusTimer {
  const raw = storage.getItem(timerKey(userId));
  if (!raw) return readyTimer();
  try {
    const timer: FocusTimer = JSON.parse(raw);
    if (timer.duration !== DURATIONS[timer.mode] || !Number.isFinite(timer.duration)) return readyTimer();
    if (timer.status === "ready") return readyTimer(timer.mode);
    if (typeof timer.id !== "string" || !timer.id) return readyTimer();
    switch (timer.status) {
      case "running": if (Number.isFinite(timer.endsAt)) return timer; break;
      case "paused":
        if (timer.remainingMs > 0 && timer.remainingMs <= timer.duration * 1000) return timer;
        break;
      case "sending":
      case "saved":
      case "unconfirmed": return timer;
    }
  } catch {
    // A damaged snapshot cannot be resumed.
  }
  return readyTimer();
}
