"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Send, Wand2, X } from "lucide-react";

import { MessageBubble, TypingBubble } from "@/components/studio/message-bubble";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { getOpenBook, subscribeOpenBook } from "@/lib/book-context";
import { errorMessage, tempId } from "@/lib/studio";
import type {
  AssistantMessage, AssistantStatus, ChatAttachment, DocumentFile, PanelContextItem, PanelPreview, PanelPreviewRequest,
} from "@/lib/types";

const PROVIDER_LABELS: Record<string, string> = {
  local: "Motor local",
  gemini: "Gemini",
  openai: "ChatGPT (OpenAI)",
  claude: "Claude",
  openrouter: "OpenRouter",
  custom: "IA personalizada",
};

const CONTEXT_LABELS: Record<PanelContextItem, string> = {
  history: "Mensajes anteriores de esta conversación",
  tasks: "Tareas pendientes",
  schedule: "Horario y disponibilidad",
  grades: "Notas y calificaciones",
  document: "Documento o PDF abierto",
  attachments: "Adjuntos",
};
const CONTEXT_ITEMS = Object.keys(CONTEXT_LABELS) as PanelContextItem[];
type PanelMessage = AssistantMessage & { role: "user" | "assistant" };

function readAttachment(file: File): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
    reader.onload = () => resolve({
      name: file.name.slice(0, 200),
      mime_type: file.type,
      data: String(reader.result).split(",", 2)[1],
    });
    reader.readAsDataURL(file);
  });
}

function PreviewSection({ entries }: { entries: NonNullable<PanelPreview["sections"]["message"]> }) {
  if (!entries.length) return <p className="text-xs text-muted-foreground">Sin contenido para enviar.</p>;
  return entries.map((entry, index) => (
    <div key={index} className="mb-2">
      <p className="text-xs font-medium">{entry.role === "assistant" ? "IA" : "Usuario"}</p>
      {typeof entry.content === "string" ? (
        <pre className="whitespace-pre-wrap break-words font-sans text-xs">{entry.content}</pre>
      ) : entry.content.map(({ image_url }, position) => (
        <Image key={position} src={image_url.url} alt={`Imagen ${position + 1} que se enviará`}
          unoptimized width={360} height={240} className="h-auto max-h-48 w-auto max-w-full object-contain" />
      ))}
    </div>
  ));
}

export function QuickAiPanel({ onClose, fromCookie }: { onClose: () => void; fromCookie: boolean }) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [selected, setSelected] = useState<PanelContextItem[]>(["history"]);
  const [files, setFiles] = useState<DocumentFile[] | null>(null);
  const [documentChoice, setDocumentChoice] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [review, setReview] = useState<{ payload: PanelPreviewRequest; preview: PanelPreview } | null>(null);
  const openBook = useSyncExternalStore(subscribeOpenBook, getOpenBook, () => null);
  const scroll = useRef<HTMLDivElement>(null);
  const messageField = useRef<HTMLTextAreaElement>(null);
  const missingKey = status && status.provider !== "local" && !status.has_api_key;
  const settingsNeeded = status && !status.configured;
  const busy = sending || reviewing;

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

  useEffect(() => {
    if (fromCookie) messageField.current?.focus({ preventScroll: true });
  }, [fromCookie]);

  function toggle(item: PanelContextItem, checked: boolean) {
    setReview(null);
    setNotice("");
    if (item === "attachments" && !checked) setAttachments([]);
    setSelected((items) => checked ? [...items, item] : items.filter((value) => value !== item));
    if (item === "document" && checked && !files) {
      void api.files().then(setFiles, () => setNotice("No se pudo cargar la lista de documentos."));
    }
  }

  async function refreshStatus() {
    try {
      setStatus(await api.assistantStatus());
    } catch {
      setStatus(null);
      setLoadFailed(true);
    }
  }

  async function previewMessage() {
    if (!status?.configured || missingKey || !draft.trim() || busy) return;
    setNotice("");
    setReview(null);
    setReviewing(true);
    try {
      const context: PanelPreviewRequest["context"] = { selected };
      if (selected.includes("history")) {
        if (messages.length > 120) throw new Error("Hay más de 120 mensajes. Desmarca el historial para continuar.");
        context.history = messages.map(({ role, content }) => ({ role, content }));
      }
      if (selected.includes("document")) {
        if (documentChoice === "open-pdf") {
          if (!openBook) throw new Error("Abre un PDF o selecciona un documento.");
          const { extractBookPage } = await import("@/lib/book-text");
          const page = await extractBookPage(openBook);
          context.page_text = page.text;
          context.page_label = page.label;
        } else if (documentChoice) {
          context.document_id = documentChoice;
        } else {
          throw new Error("Selecciona un documento o desmarca esta opción.");
        }
      }
      if (selected.includes("attachments")) {
        if (!attachments.length) throw new Error("Selecciona las imágenes o desmarca Adjuntos.");
        context.attachments = await Promise.all(attachments.map(readAttachment));
      }
      const payload = { message: draft.trim(), provider: status.provider, context };
      setReview({ payload, preview: await api.previewPanelChat(payload) });
    } catch (error) {
      setNotice(errorMessage(error));
      if (error instanceof ApiError && (error.status === 409 || error.status === 400)) await refreshStatus();
    } finally {
      setReviewing(false);
    }
  }

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!status?.configured || missingKey || !review || busy) return;
    const { payload, preview } = review;
    const message = payload.message;
    setNotice("");
    setSending(true);
    try {
      const result = await api.panelChat(payload, preview.approval);
      setMessages((previous) => [
        ...previous,
        { id: tempId("panel-user"), role: "user", content: message, source: null, document_id: null, created_at: result.created_at },
        { id: tempId("panel-ai"), role: "assistant", content: result.reply, source: result.source, document_id: null, created_at: result.created_at },
      ]);
      setDraft("");
      setReview(null);
    } catch (error) {
      setNotice(errorMessage(error));
      if (error instanceof ApiError && [400, 404, 409, 413].includes(error.status)) {
        setReview(null);
        if (error.status === 409 || error.status === 400) await refreshStatus();
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
      <form onSubmit={send} className="max-h-[65%] shrink-0 space-y-2 overflow-y-auto border-t border-border/50 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
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
        <fieldset disabled={busy} className="space-y-2 rounded-xl border border-border/50 bg-background/30 px-3 pb-3">
          <legend className="px-1 text-sm font-medium">Contexto del envío</legend>
          {CONTEXT_ITEMS.map((item) => (
            <div key={item}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={selected.includes(item)}
                  onChange={(event) => toggle(item, event.target.checked)} />
                {CONTEXT_LABELS[item]}
              </label>
              {item === "document" && selected.includes(item) && (
                <select aria-label="Elegir documento o PDF" value={documentChoice}
                  onChange={(event) => { setDocumentChoice(event.target.value); setReview(null); }}
                  className="mt-2 w-full rounded-lg border border-border bg-background p-2 text-sm">
                  <option value="">Elige un documento</option>
                  {openBook && <option value="open-pdf">PDF abierto · pág. {openBook.page}</option>}
                  {files?.filter((file) => /\.(pdf|txt|md|csv|docx|xlsx|xlsm)$/i.test(file.filename)).map((file) => (
                    <option key={file.id} value={file.id}>{file.filename}</option>
                  ))}
                </select>
              )}
              {item === "attachments" && selected.includes(item) && (
                <input type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="Seleccionar imágenes"
                  className="mt-2 w-full text-xs"
                  onChange={(event) => {
                    setReview(null);
                    const picked = Array.from(event.target.files ?? []);
                    const allowed = ["image/png", "image/jpeg", "image/webp"];
                    if (picked.length > 6 || picked.some((file) => !allowed.includes(file.type)) ||
                      picked.reduce((total, file) => total + file.size, 0) > 3 * 1024 * 1024) {
                      setAttachments([]);
                      event.target.value = "";
                      setNotice("Elige hasta seis imágenes PNG, JPG o WebP con un máximo de 3 MB en total.");
                    } else {
                      setAttachments(picked);
                      setNotice("");
                    }
                  }}
                />
              )}
              {review?.preview.sections[item] && (
                <details className="ml-5 mt-1 rounded-lg border border-border/50 p-2 text-xs">
                  <summary className="cursor-pointer">Vista previa · {CONTEXT_LABELS[item]}</summary>
                  <PreviewSection entries={review.preview.sections[item]} />
                </details>
              )}
            </div>
          ))}
        </fieldset>
        {review && (
          <div role="status" className="space-y-1 rounded-lg border border-border/50 p-2 text-xs">
            <p>Destino: {PROVIDER_LABELS[review.preview.provider] ?? review.preview.provider} · {review.preview.model}</p>
            <p>{review.preview.characters.toLocaleString("es")} caracteres de texto
              {review.preview.image_bytes > 0 ? ` · ≈ ${Math.ceil(review.preview.image_bytes / 1024)} KB de imágenes` : ""}</p>
            {(review.preview.characters > 24_000 || review.preview.image_bytes > 2 * 1024 * 1024) && (
              <p>El envío es grande. Puedes desmarcar elementos y revisarlo otra vez.</p>
            )}
            <details>
              <summary className="cursor-pointer">Vista previa · Mensaje actual</summary>
              <PreviewSection entries={review.preview.sections.message ?? []} />
            </details>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={messageField}
            aria-label="Mensaje para la IA"
            rows={2}
            maxLength={4000}
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setReview(null); }}
            readOnly={busy}
            placeholder="Escribe tu mensaje"
            className="min-w-0 flex-1 resize-none rounded-xl border border-border bg-background/50 p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="button" variant="outline" onClick={() => void previewMessage()}
            disabled={!status?.configured || Boolean(missingKey) || !draft.trim() || busy}>
            {reviewing ? "Revisando…" : "Revisar envío"}
          </Button>
          <Button type="submit" size="icon" aria-label="Enviar mensaje" disabled={!review || busy}>
            <Send className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </form>
    </>
  );
}
