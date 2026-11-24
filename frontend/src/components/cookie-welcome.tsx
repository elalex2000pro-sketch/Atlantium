"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CookieOrb } from "@/components/cookie-button";

const seenInMemory = new Set<string>();
const startupOverlay = '[data-boot-splash], [data-cookie-startup-overlay], [aria-modal="true"], dialog[open]';

export function CookieWelcome({ anchor, userId, name, reduced, panelOpen }: {
  anchor: RefObject<HTMLButtonElement>;
  userId: string;
  name?: string;
  reduced: boolean;
  panelOpen: boolean;
}) {
  const key = `atlantium:cookie-welcome:${userId}`;
  const [phase, setPhase] = useState<"waiting" | "greeting" | "flight" | "done">("waiting");
  const [place, setPlace] = useState<{ x: number; y: number } | null>(null);

  const finish = useCallback(() => {
    seenInMemory.add(key);
    try { sessionStorage.setItem(key, "1"); } catch { /* La sesión actual conserva el aviso en memoria. */ }
    setPhase("done");
  }, [key]);

  useEffect(() => {
    let seen = seenInMemory.has(key);
    try { seen ||= sessionStorage.getItem(key) === "1"; } catch { /* Almacenamiento no disponible. */ }
    if (seen) setPhase("done");
  }, [key]);

  useEffect(() => {
    if (phase === "done") return;
    if (panelOpen) {
      finish();
      return;
    }
    const check = () => {
      if (document.querySelector(startupOverlay)) {
        setPhase((current) => current === "done" ? current : "waiting");
      } else if (document.documentElement.dataset.cookieStartupReady && anchor.current) {
        setPhase((current) => current === "waiting" ? "greeting" : current);
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-cookie-startup-ready"] });
    check();
    return () => observer.disconnect();
  }, [anchor, finish, panelOpen, phase]);

  useEffect(() => {
    if (phase !== "greeting" && phase !== "flight") return;
    const measure = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setPlace({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [phase, anchor]);

  useEffect(() => {
    if (phase !== "greeting") return;
    const timer = window.setTimeout(() => reduced ? finish() : setPhase("flight"), 2500);
    return () => window.clearTimeout(timer);
  }, [phase, reduced, finish]);

  useEffect(() => {
    if (phase !== "greeting" && phase !== "flight") return;
    const skip = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector(startupOverlay)) return;
      event.preventDefault();
      finish();
    };
    window.addEventListener("keydown", skip);
    return () => window.removeEventListener("keydown", skip);
  }, [phase, finish]);

  useEffect(() => {
    if (reduced && phase === "flight") finish();
  }, [reduced, phase, finish]);

  if (phase === "waiting" || phase === "done" || !place) return null;
  const greeting = phase === "greeting";
  const x = place.x - window.innerWidth / 2;
  const y = place.y - window.innerHeight / 2;
  return (
    <div data-cookie-welcome={reduced ? "corner" : "center"} className="pointer-events-none fixed inset-0 z-[36]">
      <div className="absolute h-14 w-14 -translate-x-1/2 -translate-y-1/2"
        style={reduced ? { left: place.x, top: place.y } : { left: "50%", top: "50%" }}>
        <AnimatePresence>
          {greeting && (
            <motion.div role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
              className={`absolute bottom-full mb-6 w-max max-w-[calc(100vw-2rem)] ${reduced ? "right-0" : "left-1/2 -translate-x-1/2"}`}>
              <div className="app-glass rounded-2xl px-4 py-2 text-center text-sm font-medium shadow-lg [overflow-wrap:anywhere]">
                Hola{name ? `, ${name}` : ""}, ¿qué tal?
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {!reduced && (
          <motion.button type="button" aria-label="Saltar saludo de Cookie"
            className="pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            initial={{ scale: 0 }}
            animate={greeting
              ? { scale: [0, 2.35, 2.05, 2.15] }
              : { x: [0, 0, x * 0.45, x, x, x], y: [0, 5, y * 0.45 - 95, y, y - 7, y],
                  scaleX: [2.15, 2.37, 1.48, 1.16, 0.97, 1], scaleY: [2.15, 1.86, 1.7, 0.86, 1.05, 1] }}
            transition={greeting ? { duration: 0.5, ease: "easeOut" } : { duration: 0.66, times: [0, 0.12, 0.46, 0.79, 0.91, 1], ease: "easeInOut" }}
            onAnimationComplete={() => { if (!greeting) finish(); }}
            onClick={() => {
              finish();
              requestAnimationFrame(() => anchor.current?.focus({ preventScroll: true }));
            }}>
            <CookieOrb reduceMotion={false} expression={greeting ? "neutral" : "happy"} idle={greeting} greet={greeting} size="floating" />
          </motion.button>
        )}
      </div>
    </div>
  );
}
