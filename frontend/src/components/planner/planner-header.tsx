"use client";

import type * as React from "react";
import type { Dispatch, SetStateAction } from "react";
import { motion } from "framer-motion";
import { pageItem } from "@/components/page-animated-wrapper";
import { AlertCircle, CalendarClock, CalendarDays, CheckCircle2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type Notice } from "@/lib/planner";

type Props = {
  monthPendingExamCount: number;
  goToday: () => void;
  quickAddOpen: boolean;
  toggleQuickAdd: () => void;
  notice: Notice | null;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
};

export function PlannerHeader({
  monthPendingExamCount,
  goToday,
  quickAddOpen,
  toggleQuickAdd,
  notice,
  setNotice,
}: Props) {
  return (
<>
<motion.header variants={pageItem} className="flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <h1 className="text-[28px] font-light leading-[1.05] tracking-[-0.035em] text-slate-800 dark:text-white/90 sm:text-[33px]">
            Planificador
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {monthPendingExamCount > 0 && (
            <span className="inline-flex h-9 items-center gap-2 rounded-full border border-rose-400/20 bg-white/35 px-3.5 text-[11.5px] font-medium text-[#c92f28] shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] backdrop-blur-md dark:border-rose-300/15 dark:bg-white/[0.045] dark:text-[#ff9a91] dark:shadow-none">
              <CalendarClock className="h-3.5 w-3.5" />
              {monthPendingExamCount === 1
                ? "1 examen pendiente"
                : `${monthPendingExamCount} exámenes pendientes`}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={goToday}>
            <CalendarDays className="h-4 w-4" /> Hoy
          </Button>
          <Button size="sm" onClick={toggleQuickAdd} aria-expanded={quickAddOpen} aria-controls="planner-quick-event" aria-label={quickAddOpen ? "Cerrar formulario de evento" : "Añadir evento al calendario"}>
            {quickAddOpen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {quickAddOpen ? "Cerrar formulario" : "Nuevo Evento"}
          </Button>
        </div>
      </motion.header>

      {notice && (
        <motion.div variants={pageItem}
          role="status"
          aria-live="polite"
          className={cn(
            "mt-4 flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-[12.5px] shadow-sm",
            notice.tone === "error"
              ? "border-rose-300/70 bg-rose-50/75 text-rose-700 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-200"
              : notice.tone === "success"
                ? "border-emerald-300/70 bg-emerald-50/75 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-200"
                : "border-white/60 bg-white/35 text-slate-600 dark:border-white/10 dark:bg-white/[0.05] dark:text-white/60",
          )}
        >
          {notice.tone === "error" ? (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="rounded-lg p-0.5 opacity-60 transition-opacity hover:opacity-100"
            aria-label="Cerrar aviso"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </motion.div>
      )}
</>
  );
}
