"use client";

import type * as React from "react";
import type { RefObject, Dispatch, SetStateAction } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Course } from "@/lib/types";
import { cn } from "@/lib/utils";
import { selectClass } from "@/lib/planner";
export type QuickEventType = "exam" | "task" | "important_date";

const QUICK_EVENT_TABS: { id: QuickEventType; label: string }[] = [
  { id: "exam", label: "Examen" },
  { id: "task", label: "Tarea" },
  { id: "important_date", label: "Fecha importante" },
];


type Props = {
  open: boolean;
  quickFormRef: RefObject<HTMLElement>;
  setQuickType: Dispatch<SetStateAction<QuickEventType>>;
  quickType: QuickEventType;
  addQuickEvent: (event: React.FormEvent) => Promise<void>;
  quickTitleRef: RefObject<HTMLInputElement>;
  quickTitle: string;
  setQuickTitle: Dispatch<SetStateAction<string>>;
  quickDate: string;
  setQuickDate: Dispatch<SetStateAction<string>>;
  quickTime: string;
  setQuickTime: Dispatch<SetStateAction<string>>;
  quickCourseId: string;
  setQuickCourseId: Dispatch<SetStateAction<string>>;
  courses: Course[];
  quickNotes: string;
  setQuickNotes: Dispatch<SetStateAction<string>>;
  quickBusy: boolean;
};

export function PlannerQuickEventForm({
  open,
  quickFormRef,
  setQuickType,
  quickType,
  addQuickEvent,
  quickTitleRef,
  quickTitle,
  setQuickTitle,
  quickDate,
  setQuickDate,
  quickTime,
  setQuickTime,
  quickCourseId,
  setQuickCourseId,
  courses,
  quickNotes,
  setQuickNotes,
  quickBusy,
}: Props) {
  return (
<section id="planner-quick-event" hidden={!open} ref={quickFormRef} className="app-glass rounded-[26px] p-4">
            <h2 className="text-[18px] font-semibold tracking-[-0.03em] text-slate-800 dark:text-white/90">
              Añadir al calendario
            </h2>

            <div className="mt-3 grid grid-cols-3 gap-1 rounded-2xl bg-slate-900/[0.04] p-1 dark:bg-white/[0.05]">
              {QUICK_EVENT_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setQuickType(tab.id)}
                  aria-pressed={quickType === tab.id}
                  className={cn(
                    "rounded-xl px-1.5 py-2 text-[10px] font-semibold transition-all",
                    quickType === tab.id
                      ? "bg-white text-slate-800 shadow-sm dark:bg-white/15 dark:text-white"
                      : "text-slate-500 hover:text-slate-800 dark:text-white/45 dark:hover:text-white/80",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <form onSubmit={addQuickEvent} className="mt-3 space-y-2.5">
              <div className="space-y-1.5">
                <Label htmlFor="quick-event-title">Título</Label>
                <Input
                  id="quick-event-title"
                  ref={quickTitleRef}
                  value={quickTitle}
                  onChange={(event) => setQuickTitle(event.target.value)}
                  placeholder={
                    quickType === "exam"
                      ? "Examen de Redes"
                      : quickType === "task"
                        ? "Entregar práctica"
                        : "Matrícula, defensa, aviso..."
                  }
                  maxLength={300}
                />
              </div>

              <div className={cn("grid gap-2", quickType === "task" && "grid-cols-2")}>
                <div className="space-y-1.5">
                  <Label htmlFor="quick-event-date">Fecha</Label>
                  <Input
                    id="quick-event-date"
                    type="date"
                    value={quickDate}
                    onChange={(event) => setQuickDate(event.target.value)}
                    required
                    className="tabular"
                  />
                </div>
                {quickType === "task" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="quick-event-time">Hora</Label>
                    <Input
                      id="quick-event-time"
                      type="time"
                      value={quickTime}
                      onChange={(event) => setQuickTime(event.target.value)}
                      className="tabular"
                    />
                  </div>
                )}
              </div>

              {quickType !== "important_date" && (
                <div className="space-y-1.5">
                  <Label htmlFor="quick-event-course">Asignatura</Label>
                  <select
                    id="quick-event-course"
                    className={selectClass}
                    value={quickCourseId}
                    onChange={(event) => setQuickCourseId(event.target.value)}
                  >
                    <option value="">Sin asignatura</option>
                    {courses.map((course) => (
                      <option key={course.id} value={course.id}>
                        {course.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="quick-event-notes">Notas</Label>
                <Input
                  id="quick-event-notes"
                  value={quickNotes}
                  onChange={(event) => setQuickNotes(event.target.value)}
                  placeholder="Opcional"
                  maxLength={500}
                />
              </div>

              <Button type="submit" className="w-full" disabled={!quickTitle.trim() || quickBusy}>
                {quickBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {quickType === "exam"
                  ? "Añadir examen"
                  : quickType === "task"
                    ? "Añadir tarea"
                    : "Guardar fecha"}
              </Button>
            </form>

          </section>
  );
}
