"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Loader2, LogOut } from "lucide-react";
import { CookieButton, CookieOrb } from "@/components/cookie-button";
import { CookieWelcome } from "@/components/cookie-welcome";

import { useAuth } from "@/components/auth-provider";
import { ContextPanel } from "@/components/context-panel";
import { ErrorBoundary } from "@/components/error-boundary";
import { GamificationThemeSync } from "@/components/gamification-theme-sync";
import { GamificationToast } from "@/components/gamification-toast";
import { Logo } from "@/components/logo";
import { MobileNavigationBar } from "@/components/mobile-navigation-bar";
import { NotificationBell, NotificationCenter } from "@/components/notification-center";
import { OfflineStatus } from "@/components/offline-status";
import { PageTransition } from "@/components/page-transition";
import { usePreferences } from "@/components/preferences-provider";
import { SystemNotifications } from "@/components/system-notifications";
import { OverdueTaskPrompt } from "@/components/overdue-task-prompt";
import { ThemeCycleButton } from "@/components/theme-toggle";
import { Sidebar } from "@/components/navigation/sidebar";
import { Button } from "@/components/ui/button";
import { AI_DRAWER_EVENT, QUICK_AI_DRAWER_EVENT, type CookieCard } from "@/lib/ai-drawer";
import { lockBodyScroll } from "@/lib/scroll-lock";
import {
  SECONDARY_NAV_ITEMS,
  isActive,
} from "@/lib/navigation";
import { useSidebarPreferences } from "@/lib/layout-preferences";
import { hasCompletedOnboarding, markOnboardingCompleted } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

// El instalador no participa en el primer pintado: se carga como chunk aparte
// y aparece cuando está listo.
const InstallAppButton = lazy(() =>
  import("@/components/install-app-button").then((module) => ({
    default: module.InstallAppButton,
  })),
);
// El tour de bienvenida solo se descarga si la marca local dice que aún no se
// ha completado. Los usuarios que ya lo vieron no pagan su JavaScript.
const OnboardingModal = lazy(() =>
  import("@/components/onboarding-modal").then((module) => ({
    default: module.OnboardingModal,
  })),
);
// El drawer de IA se descarga solo cuando se abre por primera vez.
const IAStudio = lazy(() =>
  import("@/components/ia-studio").then((module) => ({ default: module.IAStudio })),
);
const QuickAiPanel = lazy(() =>
  import("@/components/studio/quick-ai-panel").then((module) => ({ default: module.QuickAiPanel })),
);

const HEADER_CONTROL =
  "flex items-center justify-center rounded-full border border-white/20 bg-white/50 p-2 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-white/[0.07]";

// En Academic-Office los controles flotan sobre el lienzo, sin la píldora
// blanca que rompía la continuidad del fondo.
const HEADER_CONTROL_FLAT = "flex items-center justify-center p-2";

const WIDE_CONTENT_ROUTES = new Set(["/classes", "/academics", "/library", "/documents", "/review"]);

const HEADER_BUTTON =
  "h-9 w-9 rounded-full text-literal-3f3852 hover:bg-white/60 hover:text-text-on-selection dark:text-white/65 dark:hover:bg-white/10 dark:hover:text-white";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const { animationLevel } = usePreferences();
  const { sidebar: sidebarLayout } = useSidebarPreferences();
  const systemReducedMotion = useReducedMotion();
  const reduceMotion = animationLevel === "reduced" || Boolean(systemReducedMotion);
  const isPublic = pathname === "/login";
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [aiMode, setAiMode] = useState<"cookie" | "quick" | "studio" | null>(null);
  const [cookieCard, setCookieCard] = useState<CookieCard | null>(null);
  const [cookieCelebrating, setCookieCelebrating] = useState(false);
  const [cookieOrigin, setCookieOrigin] = useState<{ right: number; bottom: number } | null>(null);
  const aiDialog = useRef<HTMLElement>(null);
  const cookieAnchor = useRef<HTMLButtonElement>(null);
  const cookieTrigger = useRef<HTMLButtonElement | null>(null);
  const quickAiExpanded = aiMode === "cookie" || aiMode === "quick";
  const closeAi = () => setAiMode(null);

  // Guard de rutas: sin sesión -> /login.
  useEffect(() => {
    if (!loading && !user && !isPublic) router.replace("/login");
  }, [loading, user, isPublic, router]);

  // El tour solo aparece la primera vez que se abre la app en este
  // dispositivo. Se comprueba tras montar para no romper la hidratación y se
  // espera a tener sesión para no tapar la pantalla de carga.
  useEffect(() => {
    if (loading || !user || isPublic) return;
    if (!hasCompletedOnboarding()) setShowOnboarding(true);
  }, [loading, user, isPublic]);

  // El drawer de IA se abre desde cualquier pantalla mediante un evento.
  useEffect(() => {
    const open = () => {
      setCookieOrigin(null);
      setAiMode("studio");
    };
    const openQuick = (event: Event) => {
      const detail = (event as CustomEvent<{ card: CookieCard; trigger: HTMLButtonElement }>).detail;
      setCookieCard(detail?.card ?? null);
      setCookieOrigin(null);
      if (detail) cookieTrigger.current = detail.trigger;
      setAiMode(detail ? "cookie" : "quick");
    };
    window.addEventListener(AI_DRAWER_EVENT, open);
    window.addEventListener(QUICK_AI_DRAWER_EVENT, openQuick);
    return () => {
      window.removeEventListener(AI_DRAWER_EVENT, open);
      window.removeEventListener(QUICK_AI_DRAWER_EVENT, openQuick);
    };
  }, []);

  useEffect(() => {
    if (!aiMode) return;
    const previousFocus = aiMode === "cookie" ? cookieTrigger.current : document.activeElement;
    if (!aiDialog.current?.contains(document.activeElement)) {
      aiDialog.current?.focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAiMode(null);
    };
    const releaseScrollLock = lockBodyScroll();
    window.addEventListener("keydown", onKey);
    return () => {
      releaseScrollLock();
      window.removeEventListener("keydown", onKey);
      if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
    };
  }, [aiMode]);

  const finishOnboarding = useCallback(() => {
    markOnboardingCompleted();
    setShowOnboarding(false);
  }, []);

  if (isPublic) {
    return (
      <ErrorBoundary resetKey={pathname}>
        <PageTransition>{children}</PageTransition>
      </ErrorBoundary>
    );
  }

  if (loading || !user) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-transparent text-slate-500 dark:text-white/45">
        <Loader2 className="h-5 w-5 animate-spin text-text-on-selection dark:text-white" />
        <span className="text-[12.5px]">Cargando tu espacio…</span>
      </div>
    );
  }

  const name = user.full_name?.trim() || user.email.split("@")[0];
  const firstName = user.full_name?.trim().split(/\s+/)[0];
  const initials = name.slice(0, 2).toUpperCase();

  // Studio y el lector de libros ocupan toda la altura disponible y ya
  // gestionan su propia cabecera; el inset del shell les haría desbordar.
  const isBookReader = pathname.startsWith("/library/");
  const isOffice = pathname === "/office";
  const isDashboard = pathname === "/";
  const isPlanner = pathname === "/planner";
  const isChat = pathname === "/chat";
  const hasWideContent = WIDE_CONTENT_ROUTES.has(pathname) || pathname.startsWith("/classes/");
  const isImmersive = pathname === "/studio" || isBookReader || isChat;

  return (
    <NotificationCenter>
      <SystemNotifications />
      <OverdueTaskPrompt key={user.id} />
      <div
        className={cn(
          "app-shell flex min-h-dvh flex-col bg-transparent md:flex-row",
          sidebarLayout.side === "right"
            ? cn("md:flex-row-reverse", sidebarLayout.collapsed ? "md:[--shell-right-rail:5.25rem]" : "md:[--shell-right-rail:14.75rem]")
            : sidebarLayout.collapsed ? "md:[--shell-left-rail:5.25rem]" : "md:[--shell-left-rail:14.75rem]",
        )}
      >
        <Sidebar reduceMotion={reduceMotion} logout={logout} name={name} email={user.email} />

        <div className="flex min-w-0 flex-1 flex-col bg-transparent">
          {/* Cabecera móvil: el rail de escritorio empieza en `md`. */}
          {!isBookReader ? (
            <header
              className={cn(
                "sticky top-0 z-40 border-b pt-[env(safe-area-inset-top,0px)] md:hidden",
                isOffice
                  ? "border-transparent bg-transparent"
                  : "border-black/[0.04] bg-literal-f4f4f7/82 backdrop-blur-2xl dark:border-white/[0.06] dark:bg-literal-0c0c0f/82",
              )}
            >
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <Link
                  href="/"
                  className="flex min-w-0 items-center gap-2.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-text-on-selection/25 dark:focus-visible:ring-white/35"
                  aria-label="Atlantium · Inicio"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-inverse text-white">
                    <Logo className="h-6 w-6" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-semibold leading-tight tracking-[-0.02em] text-text-on-selection dark:text-white/90">
                      Atlantium
                    </span>
                    <span className="block truncate text-[9.5px] leading-tight text-black/45 dark:text-white/35">
                      Planificador de estudio
                    </span>
                  </span>
                </Link>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Suspense fallback={<span className="block h-9 w-9" />}>
                    <InstallAppButton compact />
                  </Suspense>
                  <NotificationBell className="h-10 w-10 rounded-full text-slate-500 hover:bg-black/[0.05] hover:text-slate-800 dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white" />
                  <ThemeCycleButton className="h-10 w-10 rounded-full text-slate-500 hover:bg-black/[0.05] hover:text-slate-800 dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white" />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={logout}
                    aria-label="Cerrar sesión"
                    className="h-10 w-10 rounded-full text-slate-500 hover:bg-black/[0.05] hover:text-slate-800 dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white"
                  >
                    <LogOut className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <nav className="hide-scrollbar flex gap-1.5 overflow-x-auto px-3 pb-2">
                {SECONDARY_NAV_ITEMS.map(({ href, label, icon: Icon }) => {
                  const active = isActive(pathname, href);
                  return (
                    <Link
                      key={href}
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-11 shrink-0 touch-manipulation items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-colors",
                        active
                          ? "bg-surface-inverse text-white shadow-[shadow:var(--elevation-app-shell-2)]"
                          : "bg-white/55 text-black/55 hover:bg-white/80 hover:text-black/80 dark:bg-white/[0.06] dark:text-white/55 dark:hover:bg-white/10 dark:hover:text-white/85",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
                      {label}
                    </Link>
                  );
                })}
              </nav>
            </header>
          ) : null}

          {/* Barra superior de escritorio: controles globales fuera del rail. */}
          {!isImmersive ? (
            <header className={cn(
              "mx-auto hidden w-full max-w-7xl shrink-0 items-center justify-end gap-4 px-6 pb-2 pt-8 md:flex",
              hasWideContent && "2xl:max-w-content",
            )}>
              <motion.div
                whileHover={reduceMotion ? undefined : { scale: 1.05, y: -2 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className={isOffice ? HEADER_CONTROL_FLAT : HEADER_CONTROL}
              >
                <NotificationBell className={HEADER_BUTTON} />
              </motion.div>
              {!isDashboard && (
                <motion.div
                  whileHover={reduceMotion ? undefined : { scale: 1.05, y: -2 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  className={isOffice ? HEADER_CONTROL_FLAT : HEADER_CONTROL}
                >
                  <ThemeCycleButton className={HEADER_BUTTON} />
                </motion.div>
              )}
              <motion.div
                whileHover={reduceMotion ? undefined : { scale: 1.05, y: -2 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className={isOffice ? HEADER_CONTROL_FLAT : HEADER_CONTROL}
              >
                <Link
                  href="/settings"
                  aria-label={`Perfil de ${name}`}
                  title={name}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-inverse text-[10.5px] font-semibold text-white shadow-[shadow:var(--elevation-app-shell-3)] outline-none transition-colors hover:bg-literal-2a2a31 focus-visible:ring-2 focus-visible:ring-text-on-selection/25 dark:bg-selection-soft dark:text-text-on-selection dark:hover:bg-white dark:focus-visible:ring-white/40"
                >
                  {initials}
                </Link>
              </motion.div>
            </header>
          ) : null}

          <OfflineStatus />

          <main
            className={cn(
              "min-w-0 flex-1 bg-transparent",
              // `clip` no convierte el eje Y en un scroller: con `hidden` el
              // navegador calcula `overflow-y: auto` y la rueda se queda atrapada
              // dentro de `main` en vez de mover la página.
              "overflow-x-clip",
              !isImmersive &&
                "pb-[calc(var(--mobile-nav-offset)+4.5rem)] pt-4 md:pb-20 md:pt-5",
            )}
          >
            <div
              className={cn(
                "mx-auto w-full",
                isChat && "px-4 py-4 md:pl-4 md:pr-5",
                (isChat || isPlanner) && "max-w-content",
                isDashboard && "max-w-[1720px]",
                !isImmersive && !isPlanner && !isDashboard && "max-w-7xl",
                hasWideContent && "2xl:max-w-content",
              )}
            >
              <ErrorBoundary resetKey={pathname}>
                <PageTransition>{children}</PageTransition>
              </ErrorBoundary>
            </div>
          </main>
        </div>

        {!isDashboard && !isImmersive && !isPlanner ? <ContextPanel /> : null}

        {!isBookReader ? <MobileNavigationBar /> : null}
        {!showOnboarding && (
          <CookieButton
            ref={cookieAnchor}
            reduceMotion={reduceMotion}
            celebrating={cookieCelebrating}
            active={!aiMode}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setCookieOrigin({ right: window.innerWidth - rect.right + rect.width / 2, bottom: window.innerHeight - rect.bottom + rect.height / 2 });
              cookieTrigger.current = event.currentTarget;
              setCookieCard(null);
              setAiMode("cookie");
            }}
            className={cn(
              "cookie-launcher fixed right-[calc(var(--shell-right-rail,0px)+1rem+env(safe-area-inset-right,0px))] z-[35] h-14 w-14",
              isBookReader ? "bottom-[calc(1rem+env(safe-area-inset-bottom,0px))]" : "bottom-[calc(var(--mobile-nav-offset)+0.5rem)]",
              "md:bottom-[calc(1rem+env(safe-area-inset-bottom,0px))]",
              aiMode && "invisible",
            )}
          />
        )}
        {!showOnboarding && (
          <CookieWelcome key={user.id} userId={user.id} name={firstName} anchor={cookieAnchor}
            reduced={reduceMotion} panelOpen={Boolean(aiMode)} />
        )}
      </div>

      <GamificationToast key={user.id} userId={user.id} reduceMotion={reduceMotion} panelOpen={Boolean(aiMode)} onCelebrate={setCookieCelebrating} />
      <GamificationThemeSync />

      <AnimatePresence>
        {aiMode ? (
          <motion.div
            key="ai-drawer"
            className={cn(
              "fixed inset-0 z-[95] flex justify-end bg-slate-950/35 backdrop-blur-sm",
              quickAiExpanded && "items-end pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]",
            )}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeAi}
          >
            <motion.aside
              ref={aiDialog}
              data-cookie-ai-dialog
              role="dialog"
              aria-modal="true"
              aria-label={quickAiExpanded ? "Panel de IA" : "IA Studio"}
              tabIndex={-1}
              className={cn(
                "flex w-full min-w-0 max-w-[480px] flex-col overflow-hidden border-white/15 shadow-[shadow:var(--elevation-app-shell-4)] outline-none backdrop-blur-3xl dark:border-white/10",
                quickAiExpanded
                  ? "h-full max-h-[48rem] origin-bottom-right rounded-[24px] border bg-background/95"
                  : "h-dvh border-l bg-literal-f4f4f7/92 dark:bg-literal-0b0f18/94",
              )}
              style={quickAiExpanded && cookieOrigin ? {
                transformOrigin: `calc(100% + max(0.75rem, env(safe-area-inset-right)) - ${cookieOrigin.right}px) calc(100% + max(0.75rem, env(safe-area-inset-bottom)) - ${cookieOrigin.bottom}px)`,
              } : undefined}
              initial={reduceMotion ? { opacity: 0 } : quickAiExpanded ? { scale: 0.18, opacity: 0 } : { x: 64, opacity: 0 }}
              animate={reduceMotion ? { opacity: 1 } : quickAiExpanded ? { scale: [0.18, 1.025, 1], opacity: [0, 1, 1] } : { x: 0, opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : quickAiExpanded
                ? { scale: 0.18, opacity: 0, transition: { duration: 0.24, ease: "easeIn" } }
                : { x: 64, opacity: 0 }}
              transition={reduceMotion ? { duration: 0.12 } : quickAiExpanded
                ? { duration: 0.5, delay: cookieOrigin ? 0.1 : 0, times: [0, 0.82, 1], ease: "easeOut" }
                : { type: "spring", stiffness: 320, damping: 34 }}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key !== "Tab") return;
                const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
                )).filter((item) => item.getClientRects().length > 0);
                const first = items[0];
                const last = items.at(-1);
                if (!first || !last || (event.shiftKey
                  ? document.activeElement === first || document.activeElement === aiDialog.current
                  : document.activeElement === last)) {
                  event.preventDefault();
                  (event.shiftKey ? last : first)?.focus();
                }
              }}
            >
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center gap-2 text-[12px] text-slate-500 dark:text-white/45">
                    <Loader2 className="h-4 w-4 animate-spin" /> Abriendo IA…
                  </div>
                }
              >
                {quickAiExpanded ? (
                  <QuickAiPanel onClose={closeAi} fromCookie={aiMode === "cookie"} card={aiMode === "cookie" ? cookieCard : null}
                    userName={firstName} userId={user.id} reduceMotion={reduceMotion} celebrating={cookieCelebrating} />
                ) : <IAStudio embedded onClose={closeAi} />}
              </Suspense>
            </motion.aside>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {aiMode === "cookie" && cookieOrigin && !reduceMotion && (
          <motion.div key="cookie-panel-flight" data-cookie-panel-flight aria-hidden="true"
            className="pointer-events-none fixed z-[96] flex h-14 w-14 translate-x-1/2 translate-y-1/2 items-center justify-center"
            style={{ right: cookieOrigin.right, bottom: cookieOrigin.bottom }}>
            <motion.div
              initial={{ x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1 }}
              animate={{ x: [0, 0, -26, -62], y: [0, 4, -104, -138],
                scaleX: [1, 1.16, 0.96, 1], scaleY: [1, 0.82, 1.18, 1], opacity: [1, 1, 1, 0] }}
              transition={{ duration: 0.53, times: [0, 0.16, 0.63, 1], ease: "easeOut" }}
              exit={{ x: [-52, -22, 0, 0], y: [-105, -75, 0, 0], opacity: [0, 1, 1, 1],
                scaleX: [1, 0.94, 1.12, 1], scaleY: [1, 1.13, 0.86, 1],
                transition: { duration: 0.31, times: [0, 0.35, 0.81, 1], ease: "easeInOut" } }}>
              <CookieOrb expression="happy" reduceMotion={false} idle={false} size="floating" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {showOnboarding ? (
        <Suspense fallback={null}>
          <OnboardingModal onClose={finishOnboarding} />
        </Suspense>
      ) : null}
    </NotificationCenter>
  );
}
