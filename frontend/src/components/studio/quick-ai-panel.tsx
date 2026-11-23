"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Send, Wand2, X } from "lucide-react";

import { MessageBubble, TypingBubble } from "@/components/studio/message-bubble";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { errorMessage, tempId } from "@/lib/studio";
import type { AssistantMessage, AssistantStatus } from "@/lib/types";

const PROVIDER_LABELS: Record<string, string> = {
  local: "Motor local",
  gemini: "Gemini",
  openai: "ChatGPT (OpenAI)",
  claude: "Claude",
  openrouter: "OpenRouter",
  custom: "IA personalizada",
};

export function QuickAiPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [sending, setSending] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const missingKey = status && status.provider !== "local" && !status.has_api_key;
  const settingsNeeded = status && !status.configured;

  useEffect(() => {
    let active = true;
    void api.assistantStatus().then(
      (value) => { if (active) setStatus(value); },
      () => { if (active) setLoadFailed(true); },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, sending]);

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!status?.configured || missingKey || !message || sending) return;
    setNotice("");
    setSending(true);
    try {
      const result = await api.panelChat(message, status.provider);
      setMessages((previous) => [
        ...previous,
        { id: tempId("panel-user"), role: "user", content: message, source: null, document_id: null, created_at: result.created_at },
        { id: tempId("panel-ai"), role: "assistant", content: result.reply, source: result.source, document_id: null, created_at: result.created_at },
      ]);
      setDraft("");
    } catch (error) {
      setNotice(errorMessage(error));
      if (error instanceof ApiError && (error.status === 409 || error.status === 400)) {
        try {
          setStatus(await api.assistantStatus());
        } catch {
          setStatus(null);
          setLoadFailed(true);
        }
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border/50 px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
          <Wand2 className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Panel de IA</h2>
          <p className="truncate text-xs text-muted-foreground">
            {status
              ? `Proveedor: ${PROVIDER_LABELS[status.provider] ?? status.provider}`
              : loadFailed ? "Proveedor no disponible" : "Consultando proveedor…"}
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label="Cerrar panel de IA" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </header>
      <div ref={scroll} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
        {sending && <TypingBubble />}
      </div>
      <form onSubmit={send} className="shrink-0 space-y-2 border-t border-border/50 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {settingsNeeded ? (
          <p role="status" className="text-sm">
            {missingKey ? "Falta tu clave de IA en Ajustes" : "Configura tu motor de IA en Ajustes."}{" "}
            <Link className="underline underline-offset-4" href="/settings?tab=integrations" onClick={onClose}>
              Abrir Ajustes de IA
            </Link>
          </p>
        ) : loadFailed ? (
          <p role="status" className="text-sm">No se pudo consultar el proveedor. Vuelve a abrir el panel.</p>
        ) : null}
        {notice && !(settingsNeeded && notice === "Falta tu clave de IA en Ajustes") && (
          <p role="alert" className="text-sm text-destructive">{notice}</p>
        )}
        <p id="quick-ai-scope" className="text-xs text-muted-foreground">Solo se envía el mensaje que escribes ahora.</p>
        <div className="flex items-end gap-2">
          <textarea
            aria-label="Mensaje para la IA"
            aria-describedby="quick-ai-scope"
            rows={2}
            maxLength={4000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            readOnly={sending}
            placeholder="Escribe tu mensaje"
            className="min-w-0 flex-1 resize-none rounded-xl border border-border bg-background/50 p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" size="icon" aria-label="Enviar mensaje" disabled={!status?.configured || Boolean(missingKey) || !draft.trim() || sending}>
            <Send className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </form>
    </>
  );
}
