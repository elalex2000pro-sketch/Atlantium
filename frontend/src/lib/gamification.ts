/**
 * Gamificación local por usuario: EXP, niveles, recompensas y cosméticos.
 *
 * Se guarda en localStorage porque es progreso personal del dispositivo. Las
 * tareas premiadas se recuerdan por id para que desmarcar y volver a marcar no
 * genere EXP infinito.
 */

export const XP_EVENT = "autopilot:xp";
export const LEVEL_UP_EVENT = "autopilot:level-up";
export const COSMETICS_EVENT = "autopilot:cosmetics";
export const COOKIE_OUTFIT_EVENT = "autopilot:cookie-outfit";
export const TASK_XP = 15;
export const FOCUS_XP = 25;
export const MAX_LEVEL = 99;

export const COOKIE_REWARDS = [
  { id: "glasses", name: "Gafas", level: 2, icon: "🕶️", slot: "eyes" },
  { id: "headphones", name: "Auriculares", level: 4, icon: "🎧", slot: "ears" },
  { id: "graduation-cap", name: "Gorro de graduación", level: 6, icon: "🎓", slot: "head" },
  { id: "scarf", name: "Bufanda", level: 8, icon: "🧣", slot: "neck" },
  { id: "crown", name: "Corona", level: 10, icon: "👑", slot: "head" },
] as const;

export type CookieRewardId = (typeof COOKIE_REWARDS)[number]["id"];

export function getCookieRewards(level: number) {
  return COOKIE_REWARDS.map((reward) => ({ ...reward, unlocked: level >= reward.level }));
}

function cookieOutfitKey(userId: string) {
  return `autopilot:cookie-outfit:${userId}`;
}

export function getEquippedCookieRewards(userId: string): CookieRewardId[] {
  if (typeof window === "undefined" || !userId) return [];
  const level = getLevelInfo(getGamification(userId).xp).level;
  try {
    const stored = JSON.parse(window.localStorage.getItem(cookieOutfitKey(userId)) ?? "{}");
    return COOKIE_REWARDS
      .filter((reward) => reward.level <= level && stored?.[reward.slot] === reward.id)
      .map((reward) => reward.id);
  } catch {
    return [];
  }
}

export function setCookieRewardEquipped(userId: string, id: CookieRewardId, equipped: boolean): boolean {
  if (typeof window === "undefined" || !userId) return false;
  const level = getLevelInfo(getGamification(userId).xp).level;
  const reward = COOKIE_REWARDS.find((item) => item.id === id);
  if (!reward || reward.level > level) return false;

  const current = getEquippedCookieRewards(userId);
  const outfit = Object.fromEntries(COOKIE_REWARDS
    .filter((item) => current.includes(item.id) && item.id !== id && (!equipped || item.slot !== reward.slot))
    .map((item) => [item.slot, item.id]));
  if (equipped) outfit[reward.slot] = id;
  try {
    window.localStorage.setItem(cookieOutfitKey(userId), JSON.stringify(outfit));
  } catch {
    return false;
  }
  window.dispatchEvent(new CustomEvent(COOKIE_OUTFIT_EVENT));
  return true;
}

const cookieNotifiedLevels = new Map<string, number>();

/** Solo un aumento de XP puede anunciar un nivel, incluso después de recargar. */
export function claimCookieLevelNotice(userId: string, previousLevel: number, level: number) {
  if (!userId || level <= previousLevel || typeof window === "undefined") return null;
  const key = `autopilot:cookie-notified-level:${userId}`;
  let seen = cookieNotifiedLevels.get(userId) ?? 0;
  try {
    seen = Math.max(seen, Number(window.localStorage.getItem(key)) || 0);
  } catch { /* La memoria de esta pestaña sigue disponible. */ }
  if (level <= seen) return null;
  cookieNotifiedLevels.set(userId, level);
  try {
    window.localStorage.setItem(key, String(level));
  } catch { /* La memoria de esta pestaña sigue disponible. */ }
  return COOKIE_REWARDS.filter((reward) => reward.level > Math.max(previousLevel, seen) && reward.level <= level);
}

const TITLES = [
  "Aprendiz",
  "Explorador",
  "Analista",
  "Arquitecto",
  "Ingeniero",
  "Maestro",
  "Leyenda",
];

export interface GamificationState {
  xp: number;
  awardedTasks: string[];
  equippedBadge: string | null;
  equippedTheme: string | null;
}

export interface LevelInfo {
  xp: number;
  level: number;
  title: string;
  currentLevelXp: number;
  nextLevelXp: number;
  progress: number;
  toNext: number;
}

export interface ChatSticker {
  id: string;
  name: string;
  emoji: string;
  level: number;
  pack: string;
}

export type CosmeticKind = "badge" | "sticker" | "theme";

export interface CosmeticReward {
  id: string;
  kind: CosmeticKind;
  name: string;
  description: string;
  level: number;
  emoji: string;
  accent: string;
}

export const CHAT_STICKERS: ChatSticker[] = [
  { id: "sparkles", name: "Chispa", emoji: "✨", level: 1, pack: "Base" },
  { id: "star", name: "Estrella", emoji: "🌟", level: 1, pack: "Base" },
  { id: "focus", name: "Enfoque", emoji: "🎯", level: 3, pack: "Enfoque" },
  { id: "flame", name: "Racha", emoji: "🔥", level: 3, pack: "Enfoque" },
  { id: "rocket", name: "Despegue", emoji: "🚀", level: 5, pack: "Impulso" },
  { id: "brain", name: "Cerebro", emoji: "🧠", level: 6, pack: "Estudio" },
  { id: "books", name: "Estudio", emoji: "📚", level: 6, pack: "Estudio" },
  { id: "crown", name: "Corona", emoji: "👑", level: 8, pack: "Leyenda" },
  { id: "galaxy", name: "Galaxia", emoji: "🌌", level: 9, pack: "Leyenda" },
];

export const COSMETIC_REWARDS: CosmeticReward[] = [
  {
    id: "badge-explorer",
    kind: "badge",
    name: "Explorador",
    description: "Insignia para tu perfil.",
    level: 2,
    emoji: "🧭",
    accent: "#0066FF",
  },
  {
    id: "pack-focus",
    kind: "sticker",
    name: "Pack Enfoque",
    description: "Dos stickers nuevos para el chat.",
    level: 3,
    emoji: "🎯",
    accent: "#FF9500",
  },
  {
    id: "badge-architect",
    kind: "badge",
    name: "Arquitecto",
    description: "Insignia para tu perfil.",
    level: 4,
    emoji: "🏛️",
    accent: "#AF52DE",
  },
  {
    id: "theme-aurora",
    kind: "theme",
    name: "Tema Aurora",
    description: "Acentos violeta exclusivos para la interfaz.",
    level: 5,
    emoji: "🌌",
    accent: "#AF52DE",
  },
  {
    id: "pack-study",
    kind: "sticker",
    name: "Pack Estudio",
    description: "Dos stickers de repaso para el chat.",
    level: 6,
    emoji: "📚",
    accent: "#34C759",
  },
  {
    id: "badge-legend",
    kind: "badge",
    name: "Leyenda",
    description: "La insignia más alta del perfil.",
    level: 7,
    emoji: "👑",
    accent: "#FFCC00",
  },
];

function storageKey(userId: string): string {
  return `autopilot:gamification:${userId}`;
}

/** EXP acumulada necesaria para alcanzar un nivel. Nivel 1 = 0. */
export function xpForLevel(level: number): number {
  const safe = Math.max(1, Math.floor(level));
  return 50 * (safe - 1) * safe;
}

export function getLevelInfo(xp: number): LevelInfo {
  const safeXp = Math.max(0, Math.floor(xp));
  let level = 1;
  while (level < MAX_LEVEL && safeXp >= xpForLevel(level + 1)) level += 1;

  const currentLevelXp = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  const span = Math.max(1, nextLevelXp - currentLevelXp);
  const progress = Math.max(0, Math.min(1, (safeXp - currentLevelXp) / span));

  return {
    xp: safeXp,
    level,
    title: TITLES[Math.min(level - 1, TITLES.length - 1)],
    currentLevelXp,
    nextLevelXp,
    progress,
    toNext: Math.max(0, nextLevelXp - safeXp),
  };
}

export function getUnlockedRewards(level: number): CosmeticReward[] {
  return COSMETIC_REWARDS.filter((reward) => reward.level <= level);
}

export function getNextReward(level: number): CosmeticReward | null {
  return (
    COSMETIC_REWARDS.find((reward) => reward.level > level) ?? null
  );
}

export function getUnlockedStickers(level: number): ChatSticker[] {
  return CHAT_STICKERS.filter((sticker) => sticker.level <= level);
}

export function getSticker(id: string): ChatSticker | null {
  return CHAT_STICKERS.find((sticker) => sticker.id === id) ?? null;
}

export function stickerMessage(id: string): string {
  return `[[sticker:${id}]]`;
}

/**
 * Los stickers viajan como texto para que funcionen con el chat existente y
 * con los eventos WebSocket sin migraciones de base de datos.
 */
export function parseStickerMessage(content: string): ChatSticker | null {
  const match = content.trim().match(/^\[\[sticker:([a-z0-9-]+)\]\]$/);
  return match ? getSticker(match[1]) : null;
}

export function getGamification(userId: string): GamificationState {
  if (typeof window === "undefined" || !userId) {
    return {
      xp: 0,
      awardedTasks: [],
      equippedBadge: null,
      equippedTheme: null,
    };
  }
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) {
      return {
        xp: 0,
        awardedTasks: [],
        equippedBadge: null,
        equippedTheme: null,
      };
    }
    const parsed = JSON.parse(raw) as Partial<GamificationState>;
    return {
      xp: typeof parsed.xp === "number" && Number.isFinite(parsed.xp) ? Math.max(0, parsed.xp) : 0,
      awardedTasks: Array.isArray(parsed.awardedTasks)
        ? parsed.awardedTasks.filter((value): value is string => typeof value === "string")
        : [],
      equippedBadge:
        typeof parsed.equippedBadge === "string" ? parsed.equippedBadge : null,
      equippedTheme:
        typeof parsed.equippedTheme === "string" ? parsed.equippedTheme : null,
    };
  } catch {
    return {
      xp: 0,
      awardedTasks: [],
      equippedBadge: null,
      equippedTheme: null,
    };
  }
}

function writeGamification(userId: string, state: GamificationState): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(state));
  } catch {
    /* Sin almacenamiento, el progreso no persiste. */
  }
}

export function setEquippedBadge(userId: string, badgeId: string | null): boolean {
  if (!userId) return false;
  const state = getGamification(userId);
  const level = getLevelInfo(state.xp).level;
  const valid =
    badgeId === null ||
    getUnlockedRewards(level).some(
      (reward) => reward.kind === "badge" && reward.id === badgeId,
    );
  if (!valid) return false;
  writeGamification(userId, { ...state, equippedBadge: badgeId });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(COSMETICS_EVENT));
  }
  return true;
}

export function setEquippedTheme(userId: string, themeId: string | null): boolean {
  if (!userId) return false;
  const state = getGamification(userId);
  const level = getLevelInfo(state.xp).level;
  const valid =
    themeId === null ||
    getUnlockedRewards(level).some(
      (reward) => reward.kind === "theme" && reward.id === themeId,
    );
  if (!valid) return false;
  writeGamification(userId, { ...state, equippedTheme: themeId });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(COSMETICS_EVENT));
  }
  return true;
}

export function applyCosmeticTheme(themeId: string | null): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.cosmeticTheme = themeId ?? "";
}

export function awardXp(
  userId: string,
  amount: number,
  reason: string,
): LevelInfo | null {
  if (!userId || amount <= 0) return null;

  const state = getGamification(userId);
  const before = getLevelInfo(state.xp);
  const nextXp = state.xp + Math.round(amount);
  const after = getLevelInfo(nextXp);

  writeGamification(userId, { ...state, xp: nextXp });

  if (typeof window !== "undefined") {
    const unlocked = getUnlockedRewards(after.level).filter(
      (reward) => reward.level > before.level,
    );
    window.dispatchEvent(
      new CustomEvent(XP_EVENT, {
        detail: {
          userId,
          previousLevel: before.level,
          xp: after.xp,
          amount: Math.round(amount),
          reason,
          level: after.level,
          title: after.title,
          leveledUp: after.level > before.level,
          info: after,
          unlocked,
        },
      }),
    );
    if (after.level > before.level) {
      window.dispatchEvent(
        new CustomEvent(LEVEL_UP_EVENT, {
          detail: {
            level: after.level,
            title: after.title,
            xp: after.xp,
            unlocked,
          },
        }),
      );
    }
  }

  return after;
}

/** Premia una tarea una única vez. Devuelve true si se otorgó EXP. */
export function awardTaskXp(userId: string, taskId: string): boolean {
  if (!userId || !taskId) return false;
  const state = getGamification(userId);
  if (state.awardedTasks.includes(taskId)) return false;

  writeGamification(userId, {
    ...state,
    awardedTasks: [...state.awardedTasks, taskId].slice(-2000),
  });
  awardXp(userId, TASK_XP, "Tarea completada");
  return true;
}

export function awardFocusXp(userId: string): void {
  awardXp(userId, FOCUS_XP, "Sesión de enfoque completada");
}
