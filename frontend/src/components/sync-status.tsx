"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { api } from "@/lib/api";
import type { SyncLog } from "@/lib/types";

const PROVIDER_LABEL: Record<string, string> = {
  moodle: "Moodle",
  google_classroom: "Google Classroom",
  all: "Todas",
};

const STATUS_LABEL = { success: "Correcta", partial: "Parcial", error: "Error" };

function relativeTime(iso: string | null): string {
  if (!iso) return "nunca";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "hace instantes";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

/**
 * Panel de sincronizacion: dispara un sync manual y muestra el estado en vivo
 * (ultima ejecucion por proveedor, con auto-refresco cada 20s).
 */
export function SyncStatus({ onSynced }: { onSynced?: () => void }) {
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLogs(await api.syncStatus());
    } catch {
      /* silencio: el indicador no debe romper la UI */
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 20000);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const results = await api.triggerSync("all");
      const summary = results
        .map((r) => `${PROVIDER_LABEL[r.provider]}: +${r.created} ~${r.updated} -${r.removed}`)
        .join(" · ");
      setMessage(summary || "Sincronizado");
      await refresh();
      onSynced?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Error al sincronizar");
    } finally {
      setSyncing(false);
    }
  }, [refresh, onSynced]);

  const status = logs[0]?.status;
  const lastSync = logs[0]?.finished_at ?? logs[0]?.started_at ?? null;

  const detail = syncing ? "trabajando…" : message ??
    (status ? `${STATUS_LABEL[status]} · ${relativeTime(lastSync)}` : "Sin historial");

  return (
    <section className="flex items-center justify-between gap-2 px-1 text-muted-foreground" aria-label="Sincronización">
      <p className="flex min-w-0 items-center gap-2 text-[11px]">
        <span className="shrink-0 font-medium">Sincronización</span>
        <span role="status" className="truncate" title={detail}>{detail}</span>
      </p>
      <button
        type="button"
        onClick={handleSync}
        disabled={syncing}
        title="Sincronizar ahora"
        aria-label="Sincronizar ahora"
        className="app-glass-soft flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-slate-900/[0.05] hover:text-slate-800 disabled:opacity-50 dark:text-white/35 dark:hover:bg-white/[0.08] dark:hover:text-white/75"
      >
        {syncing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
      </button>
    </section>
  );
}
