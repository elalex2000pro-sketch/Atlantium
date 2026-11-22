"use client";

import { useEffect, useState } from "react";

import { usePreferences, type InterfaceStyle } from "@/components/preferences-provider";
import { cn } from "@/lib/utils";

const STYLES: { value: InterfaceStyle; label: string }[] = [
  { value: "glass", label: "Cristal" },
  { value: "solid", label: "Sólido" },
  { value: "wallpaper", label: "Fondo" },
];

export function InterfaceStylePicker({ label, value, onChange }: {
  label: string;
  value: InterfaceStyle;
  onChange: (style: InterfaceStyle) => void;
}) {
  const { animationLevel } = usePreferences();
  const [prefersReduction, setPrefersReduction] = useState(false);

  useEffect(() => {
    const queries = [
      window.matchMedia("(prefers-reduced-transparency: reduce)"),
      window.matchMedia("(prefers-reduced-motion: reduce)"),
    ];
    const sync = () => setPrefersReduction(queries.some((query) => query.matches));
    sync();
    for (const query of queries) query.addEventListener("change", sync);
    return () => {
      for (const query of queries) query.removeEventListener("change", sync);
    };
  }, []);

  return (
    <div className="space-y-2">
      <div role="group" aria-label={label} className="grid grid-cols-3 gap-2">
        {STYLES.map((style) => (
          <button
            key={style.value}
            type="button"
            aria-pressed={value === style.value}
            onClick={() => onChange(style.value)}
            className={cn(
              "min-w-0 space-y-2 rounded-xl border bg-card p-2 text-center text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
              value === style.value ? "border-primary ring-1 ring-primary" : "border-border",
            )}
          >
            <span aria-hidden className="interface-preview" data-preview={style.value}>
              <span />
              <span />
            </span>
            <span>{style.label}</span>
          </button>
        ))}
      </div>
      {prefersReduction || animationLevel === "reduced" ? (
        <p className="text-xs text-muted-foreground">Te sugerimos Sólido para reducir la transparencia.</p>
      ) : null}
    </div>
  );
}
