/** Evento global para abrir el drawer de IA desde cualquier pantalla. */
export const AI_DRAWER_EVENT = "autopilot:open-ai";
export const QUICK_AI_DRAWER_EVENT = "autopilot:open-quick-ai";

export type CookieCard = { kind: "tasks" | "document"; id: string };
export const COOKIE_DOCUMENT_EXTENSION = /\.(pdf|txt|md|csv|docx|xlsx|xlsm)$/i;

export function askCookie(card: CookieCard, trigger: HTMLButtonElement): void {
  window.dispatchEvent(new CustomEvent(QUICK_AI_DRAWER_EVENT, { detail: { card, trigger } }));
}

export function openQuickAiDrawer(): void {
  window.dispatchEvent(new Event(QUICK_AI_DRAWER_EVENT));
}

export function openAiDrawer(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AI_DRAWER_EVENT));
}
