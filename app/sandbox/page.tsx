"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import Canvas from "../components/canvas/Canvas";
import { compileCanvas } from "../components/canvas/compiler";
import type { CanvasDoc, CompiledToolDef } from "../components/canvas/types";
import {
  FIELD_TYPES,
  SEED_DOC,
  SEED_FIELDS,
  SEED_KNOWLEDGE,
  type FieldType,
  type KnowledgeBlock,
  type StateField,
} from "./seed";

function SectionContainer({
  eyebrow,
  title,
  subtitle,
  defaultOpen = true,
  action,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="block w-full text-left"
      >
        <div className="bg-[#1a3d2a] text-white rounded-lg px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-widest text-white/55 mb-2">
                {eyebrow}
              </p>
              <h3 className="text-2xl font-bold font-test-american-grotesk text-white mb-1 leading-tight">
                {title}
              </h3>
              <p className="text-xs font-mono text-white/50">→ {subtitle}</p>
            </div>
            <span
              aria-hidden
              className="text-2xl text-white/60 font-mono leading-none mt-1 select-none"
            >
              {open ? "−" : "+"}
            </span>
          </div>
        </div>
      </button>
      {open && (
        <div className="border border-t-0 border-[#c8c4b4] bg-[#ebe8d8] rounded-b-lg px-4 py-4 -mt-2 pt-4">
          {action && <div className="flex justify-end mb-3">{action}</div>}
          {children}
        </div>
      )}
    </div>
  );
}

interface ChatMedia {
  kind: "video";
  url: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  media?: ChatMedia[];
}

function resolveVideoEmbed(url: string): { kind: "iframe" | "file"; src: string } {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");

    if (host === "youtube.com" || host === "m.youtube.com") {
      const id = u.searchParams.get("v");
      if (id) return { kind: "iframe", src: `https://www.youtube.com/embed/${id}` };
      const m = u.pathname.match(/^\/(?:embed|shorts)\/([^/?#]+)/);
      if (m) return { kind: "iframe", src: `https://www.youtube.com/embed/${m[1]}` };
    }
    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      if (id) return { kind: "iframe", src: `https://www.youtube.com/embed/${id}` };
    }
    if (host === "vimeo.com") {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      if (id && /^\d+$/.test(id)) {
        return { kind: "iframe", src: `https://player.vimeo.com/video/${id}` };
      }
    }
  } catch {
    // fall through to file
  }
  return { kind: "file", src: url };
}

function uid() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10);
}

// One-time, in-place upgrade for canvases saved before the Wikipedia tool
// became an MCP reference: a legacy HTTP node pointing at the Wikipedia REST
// summary endpoint is rewritten to the { server: "wikipedia", tool:
// "readArticle" } binding (keeping the same URL as the REST fallback). Narrowly
// scoped and idempotent, so it only touches that exact seed node.
function upgradeLegacyWikipediaNode(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as { type?: string; data?: Record<string, unknown> };
  const data = n.data;
  if (!data) return node;

  const isToolCall = n.type === "tool_call" || data.actionType === "tool_call";
  if (!isToolCall || data.ref) return node;

  const url = typeof data.url === "string" ? data.url : "";
  const looksLikeWiki =
    data.toolName === "lookup_wikipedia" ||
    /en\.wikipedia\.org\/api\/rest_v1\/page\/summary/.test(url);
  const isHttp = data.sourceType === "http" || data.sourceType === undefined;
  if (!looksLikeWiki || !isHttp) return node;

  return {
    ...n,
    data: {
      ...data,
      sourceType: "mcp",
      ref: { server: "wikipedia", tool: "readArticle" },
      // `url` is kept as the REST fallback.
    },
  };
}

function docFromCanvases(
  canvases: Array<{ id: string; name: string; doc: unknown }>
): CanvasDoc {
  if (canvases.length === 0) return SEED_DOC;
  return {
    version: 2,
    activeId: canvases[0].id,
    canvases: canvases.map((c) => {
      const d = (c.doc ?? {}) as {
        freeText?: string;
        graph?: { nodes: unknown[]; edges: unknown[] };
      };
      const graph = d.graph ?? { nodes: [], edges: [] };
      return {
        id: c.id,
        name: c.name,
        freeText: d.freeText ?? "",
        graph: {
          nodes: (graph.nodes ?? []).map(upgradeLegacyWikipediaNode),
          edges: graph.edges ?? [],
        } as CanvasDoc["canvases"][number]["graph"],
      };
    }),
  };
}

function buildEnrichedSystemPrompt(
  basePrompt: string,
  fields: StateField[],
  knowledge: KnowledgeBlock[]
): string {
  const sections: string[] = [];
  if (basePrompt.trim()) sections.push(basePrompt.trim());

  const usableFields = fields.filter((f) => f.name.trim());
  if (usableFields.length > 0) {
    const lines = ["## State schema", "Track these fields across the conversation:"];
    for (const f of usableFields) {
      const init = f.initialValue.trim() ? ` (initial: ${f.initialValue.trim()})` : "";
      lines.push(`- ${f.name.trim()}: ${f.type}${init}`);
    }
    sections.push(lines.join("\n"));
  }

  const usableKnowledge = knowledge.filter((k) => k.topic.trim() || k.content.trim());
  if (usableKnowledge.length > 0) {
    const lines = ["## Domain knowledge", "Reference material the assistant should consult:"];
    for (const k of usableKnowledge) {
      const topic = k.topic.trim() || "(untitled)";
      const content = k.content.trim();
      lines.push(`### ${topic}`);
      if (content) lines.push(content);
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

interface Turn {
  id: string;
  userMessage: string;
  startedAt: number;
  trace: TimedTraceEvent[];
  finalAnswer?: string;
  error?: string;
}

type TimedTraceEvent = TraceEvent & { tMs: number };

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

type TraceEvent =
  | {
      kind: "openai_request";
      loop: number;
      model: string;
      messages: Array<{ role: string; preview: string; toolCalls?: number; toolCallId?: string }>;
      tools: Array<{ name: string; description?: string }>;
    }
  | {
      kind: "openai_response";
      loop: number;
      content: string;
      toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
      finishReason: string | null;
    }
  | {
      kind: "tool_dispatch";
      loop: number;
      tool: string;
      sourceType: string;
      urlTemplate: string;
      resolvedUrl: string;
      args: Record<string, unknown>;
    }
  | {
      kind: "tool_result";
      loop: number;
      tool: string;
      ok: boolean;
      bytes: number;
      preview: string;
      error?: string;
      transport?: "mcp" | "rest" | "internal" | "openclaw";
      transportNote?: string;
    };

// How the call was actually carried out, for the trace badge.
const TRANSPORT_LABEL: Record<"mcp" | "rest" | "internal" | "openclaw", string> = {
  mcp: "via MCP",
  rest: "via REST",
  internal: "internal",
  openclaw: "via OpenClaw",
};

const KIND_LABEL: Record<TraceEvent["kind"], string> = {
  openai_request: "→ OpenAI",
  openai_response: "← OpenAI",
  tool_dispatch: "→ Tool",
  tool_result: "← Tool",
};

const KIND_COLOR: Record<TraceEvent["kind"], string> = {
  openai_request: "border-blue-300 bg-blue-50",
  openai_response: "border-blue-400 bg-blue-100",
  tool_dispatch: "border-amber-300 bg-amber-50",
  tool_result: "border-amber-400 bg-amber-100",
};

function eventPreview(event: TraceEvent): string {
  switch (event.kind) {
    case "openai_request":
      return `${event.messages.length} msg · ${event.tools.length} tool${event.tools.length === 1 ? "" : "s"}`;
    case "openai_response":
      return event.toolCalls.length > 0
        ? `called ${event.toolCalls.map((c) => c.name).join(", ")}`
        : `${event.finishReason ?? "stop"} · ${event.content.length} chars`;
    case "tool_dispatch":
      return `${event.tool} · ${event.sourceType}`;
    case "tool_result":
      return `${event.tool} · ${event.ok ? "ok" : "error"}${
        event.transport ? ` · ${TRANSPORT_LABEL[event.transport]}` : ""
      } · ${event.bytes.toLocaleString()} bytes`;
  }
}

function TraceEventCard({
  event,
  durationMs,
  defaultOpen = true,
}: {
  event: TraceEvent;
  durationMs: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`border rounded text-xs font-mono ${KIND_COLOR[event.kind]}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-black/5"
      >
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="font-bold uppercase tracking-widest text-[10px] text-gray-700 shrink-0">
            {KIND_LABEL[event.kind]} · loop {event.loop}
          </span>
          {!open && (
            <span className="text-gray-600 truncate text-[11px]">
              {eventPreview(event)}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-gray-500 tabular-nums">
            {formatDuration(durationMs)}
          </span>
          <span aria-hidden className="text-base text-gray-500 leading-none select-none">
            {open ? "−" : "+"}
          </span>
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3">
      {event.kind === "openai_request" && (
        <div className="space-y-1.5 text-gray-800">
          <div>
            <span className="text-gray-500">model:</span> {event.model}
          </div>
          <div>
            <span className="text-gray-500">tools available:</span>{" "}
            {event.tools.length === 0 ? "(none)" : event.tools.map((t) => t.name).join(", ")}
          </div>
          <div className="text-gray-500">messages sent ({event.messages.length}):</div>
          <ul className="space-y-1 pl-3">
            {event.messages.map((m, i) => (
              <li key={i} className="border-l-2 border-blue-200 pl-2">
                <span className="text-blue-700 uppercase tracking-wider text-[10px]">
                  {m.role}
                </span>
                {m.toolCalls != null && (
                  <span className="text-amber-700 ml-1">[{m.toolCalls} tool call(s)]</span>
                )}
                <div className="text-gray-700 whitespace-pre-wrap break-words">{m.preview}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {event.kind === "openai_response" && (
        <div className="space-y-1.5 text-gray-800">
          <div>
            <span className="text-gray-500">finish_reason:</span> {event.finishReason ?? "(null)"}
          </div>
          {event.toolCalls.length > 0 ? (
            <div>
              <div className="text-gray-500">model requested {event.toolCalls.length} tool call(s):</div>
              <ul className="space-y-0.5 pl-3 mt-1">
                {event.toolCalls.map((c, i) => (
                  <li key={i}>
                    <span className="text-amber-700">{c.name}</span>(
                    <span className="text-gray-700">{JSON.stringify(c.args)}</span>)
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div>
              <div className="text-gray-500">final answer:</div>
              <div className="text-gray-700 whitespace-pre-wrap mt-1">{event.content}</div>
            </div>
          )}
        </div>
      )}
      {event.kind === "tool_dispatch" && (
        <div className="space-y-1 text-gray-800">
          <div>
            <span className="text-gray-500">tool:</span> {event.tool}{" "}
            <span className="text-gray-500">({event.sourceType})</span>
          </div>
          <div>
            <span className="text-gray-500">args:</span> {JSON.stringify(event.args)}
          </div>
          <div>
            <span className="text-gray-500">template:</span>{" "}
            <span className="break-all">{event.urlTemplate}</span>
          </div>
          <div>
            <span className="text-gray-500">fetching:</span>{" "}
            <span className="break-all text-amber-800">{event.resolvedUrl}</span>
          </div>
        </div>
      )}
      {event.kind === "tool_result" && (
        <div className="space-y-1 text-gray-800">
          <div>
            <span className="text-gray-500">tool:</span> {event.tool} ·{" "}
            <span className={event.ok ? "text-green-700" : "text-red-700"}>
              {event.ok ? "ok" : "error"}
            </span>{" "}
            <span className="text-gray-500">({event.bytes.toLocaleString()} bytes)</span>
          </div>
          {event.transport && (
            <div>
              <span className="text-gray-500">transport:</span>{" "}
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-sans uppercase tracking-wide ${
                  event.transport === "mcp"
                    ? "bg-[#3F6F8F]/15 text-[#3F6F8F]"
                    : event.transport === "rest"
                      ? "bg-amber-200/60 text-amber-800"
                      : "bg-gray-200 text-gray-600"
                }`}
              >
                {TRANSPORT_LABEL[event.transport]}
              </span>
              {event.transportNote && (
                <div className="text-gray-600 mt-0.5 leading-snug">{event.transportNote}</div>
              )}
            </div>
          )}
          <div>
            <span className="text-gray-500">preview:</span>
            <div className="text-gray-700 whitespace-pre-wrap break-words mt-0.5">
              {event.preview}
            </div>
          </div>
          {event.error && (
            <div className="text-red-700">
              <span className="text-gray-500">error:</span> {event.error}
            </div>
          )}
        </div>
      )}
        </div>
      )}
    </div>
  );
}

function TurnEvents({
  events,
  turnStartedAt,
}: {
  events: TimedTraceEvent[];
  turnStartedAt: number;
}) {
  // Bumping `version` remounts each TraceEventCard so its internal useState
  // re-initialises with the new defaultOpen — the simplest way to implement
  // expand-all / collapse-all without lifting per-card state.
  const [defaultOpen, setDefaultOpen] = useState(true);
  const [version, setVersion] = useState(0);

  function setAll(open: boolean) {
    setDefaultOpen(open);
    setVersion((v) => v + 1);
  }

  return (
    <>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] uppercase tracking-widest text-gray-500 font-sans mr-auto">
          {events.length} event{events.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={() => setAll(true)}
          className="text-[10px] font-sans uppercase tracking-widest border border-gray-400 text-gray-600 hover:bg-gray-100 rounded px-2 py-0.5"
        >
          Expand all
        </button>
        <button
          type="button"
          onClick={() => setAll(false)}
          className="text-[10px] font-sans uppercase tracking-widest border border-gray-400 text-gray-600 hover:bg-gray-100 rounded px-2 py-0.5"
        >
          Collapse all
        </button>
      </div>
      {events.map((event, i) => {
        const prevT = i === 0 ? turnStartedAt : events[i - 1].tMs;
        const durationMs = Math.max(0, event.tMs - prevT);
        return (
          <TraceEventCard
            key={`v${version}-${i}`}
            event={event}
            durationMs={durationMs}
            defaultOpen={defaultOpen}
          />
        );
      })}
    </>
  );
}

export default function ToolsTestPage() {
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [canvasPrompt, setCanvasPrompt] = useState("");
  const [fields, setFields] = useState<StateField[]>(SEED_FIELDS);
  const [knowledge, setKnowledge] = useState<KnowledgeBlock[]>(SEED_KNOWLEDGE);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [openTurnId, setOpenTurnId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [configId, setConfigId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const justLoaded = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Keep the chat scrolled to the bottom whenever a new message arrives, a
  // turn finishes, or "thinking…" appears — so the latest content is always
  // visible without manual scrolling.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  // Tick an elapsed-time counter while a request is in flight so the user can
  // see how long the current operation has been running.
  useEffect(() => {
    if (!loading) {
      setElapsedMs(0);
      return;
    }
    const start = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - start), 100);
    return () => clearInterval(id);
  }, [loading]);

  // Load (or auto-create) the user's sandbox config on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/sandbox/state");
        if (!resp.ok) {
          if (!cancelled) setLoaded(true);
          return;
        }
        const json = (await resp.json()) as {
          configId: string;
          knowledgeBlocks: Array<{ id: string; topic: string; content: string }>;
          stateFields: Array<{
            id: string;
            name: string;
            type: string;
            initial_value: string;
          }>;
          canvases: Array<{ id: string; name: string; doc: unknown }>;
        };
        if (cancelled) return;
        justLoaded.current = true;
        setConfigId(json.configId);
        setKnowledge(
          json.knowledgeBlocks.map((b) => ({
            id: b.id,
            topic: b.topic,
            content: b.content,
          }))
        );
        setFields(
          json.stateFields.map((f) => ({
            id: f.id,
            name: f.name,
            type: (FIELD_TYPES.includes(f.type as FieldType)
              ? (f.type as FieldType)
              : "string") as FieldType,
            initialValue: f.initial_value,
          }))
        );
        setDoc(docFromCanvases(json.canvases));
      } catch (err) {
        console.error("[sandbox] load error:", err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced save when knowledge, fields, or canvas changes.
  useEffect(() => {
    if (!loaded || !configId || !doc) return;
    if (justLoaded.current) {
      justLoaded.current = false;
      return;
    }
    const timer = setTimeout(async () => {
      setSaving(true);
      try {
        await fetch("/api/sandbox/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            configId,
            knowledgeBlocks: knowledge.map((k) => ({
              id: k.id,
              topic: k.topic,
              content: k.content,
            })),
            stateFields: fields.map((f) => ({
              id: f.id,
              name: f.name,
              type: f.type,
              initial_value: f.initialValue,
            })),
            canvases: doc.canvases.map((c) => ({
              id: c.id,
              name: c.name,
              doc: { freeText: c.freeText, graph: c.graph },
            })),
          }),
        });
      } catch (err) {
        console.error("[sandbox] save error:", err);
      } finally {
        setSaving(false);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [loaded, configId, doc, fields, knowledge]);

  const tools = useMemo<CompiledToolDef[]>(() => {
    if (!doc) return [];
    return compileCanvas(doc).tools ?? [];
  }, [doc]);

  const enrichedSystemPrompt = useMemo(
    () => buildEnrichedSystemPrompt(canvasPrompt, fields, knowledge),
    [canvasPrompt, fields, knowledge]
  );

  async function send() {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setError(null);
    setStatus("Sending request…");

    const turnId = uid();
    const turnStartedAt = Date.now();
    // Create a turn placeholder up front so events can stream into it.
    setTurns((prev) => [
      ...prev,
      { id: turnId, userMessage: trimmed, startedAt: turnStartedAt, trace: [] },
    ]);
    setOpenTurnId(turnId);

    const trace: TimedTraceEvent[] = [];

    function appendEvent(event: TraceEvent) {
      trace.push({ ...event, tMs: Date.now() });
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId ? { ...t, trace: [...trace] } : t))
      );
    }

    try {
      const resp = await fetch("/api/chat/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          systemPrompt: enrichedSystemPrompt,
          messages: nextMessages,
          tools,
          configId,
          canvasId: doc?.activeId,
        }),
      });

      if (!resp.ok || !resp.body) {
        // Non-stream error path — try to parse JSON for a message.
        const text = await resp.text();
        let message = "Request failed";
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed.error === "string") message = parsed.error;
        } catch {
          if (text) message = text;
        }
        setError(message);
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, error: message } : t))
        );
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalAnswer: string | null = null;
      let streamError: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let frameEnd = buffer.indexOf("\n\n");
        while (frameEnd !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          frameEnd = buffer.indexOf("\n\n");

          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            let payload: {
              type?: string;
              text?: string;
              event?: TraceEvent;
              content?: string;
              trace?: TraceEvent[];
              message?: string;
            };
            try {
              payload = JSON.parse(line.slice(6));
            } catch {
              continue;
            }

            if (payload.type === "status" && typeof payload.text === "string") {
              setStatus(payload.text);
            } else if (payload.type === "event" && payload.event) {
              appendEvent(payload.event);
            } else if (payload.type === "done") {
              finalAnswer = payload.content ?? "";
            } else if (payload.type === "error") {
              streamError = payload.message ?? "Request failed";
            }
          }
        }
      }

      if (streamError) {
        setError(streamError);
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, error: streamError } : t))
        );
        return;
      }

      const answer = finalAnswer ?? "(empty)";
      const videoMedia: ChatMedia[] = [];
      for (const ev of trace) {
        if (
          ev.kind === "tool_dispatch" &&
          ev.sourceType === "video" &&
          typeof ev.resolvedUrl === "string" &&
          ev.resolvedUrl.trim()
        ) {
          videoMedia.push({ kind: "video", url: ev.resolvedUrl.trim() });
        }
      }
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: answer,
        ...(videoMedia.length > 0 ? { media: videoMedia } : {}),
      };
      setMessages([...nextMessages, assistantMessage]);
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId ? { ...t, finalAnswer: answer } : t))
      );

      // Only refetch if a knowledge_save tool actually fired this turn —
      // otherwise nothing in sandbox_knowledge_blocks could have changed and
      // we'd be flashing "Refreshing Domain Knowledge…" for no reason
      // (e.g. on plain "hello"-style messages).
      const knowledgeSavedThisTurn = trace.some(
        (e) => e.kind === "tool_dispatch" && e.sourceType === "knowledge_save"
      );
      if (knowledgeSavedThisTurn) {
        try {
          setStatus("Refreshing Domain Knowledge…");
          const stateResp = await fetch("/api/sandbox/state");
          if (stateResp.ok) {
            const stateJson = (await stateResp.json()) as {
              knowledgeBlocks: Array<{ id: string; topic: string; content: string }>;
            };
            justLoaded.current = true;
            setKnowledge(
              stateJson.knowledgeBlocks.map((b) => ({
                id: b.id,
                topic: b.topic,
                content: b.content,
              }))
            );
          }
        } catch (refetchErr) {
          console.error("[sandbox] refetch after chat error:", refetchErr);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      setError(message);
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId ? { ...t, error: message } : t))
      );
    } finally {
      setLoading(false);
      setStatus(null);
      inputRef.current?.focus();
    }
  }

  function reset() {
    setMessages([]);
    setTurns([]);
    setOpenTurnId(null);
    setError(null);
  }

  return (
    <div className="h-[100dvh] overflow-y-auto">
      <div className="p-6 max-w-[1400px] mx-auto">
      <div className="mb-4">
        <Link
          href="/demo"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors mb-3"
        >
          ← Back to models
        </Link>
        <h1 className="text-xl font-bold flex items-center gap-2">
          The Air Portal
          {saving && (
            <span className="text-[10px] font-mono uppercase tracking-widest text-gray-500">
              saving…
            </span>
          )}
        </h1>
        <p className="text-sm text-gray-600 font-serif mt-1">
          The Air Portal illustrates how interactions with the LLM are constructed, how
          tools are declared and how context is defined.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <SectionContainer
            eyebrow="Canvas"
            title="Logic canvas"
            subtitle="edit the tool node to change behavior"
            defaultOpen={false}
          >
            <Canvas
              value={doc}
              seedDoc={SEED_DOC}
              onChange={({ doc: next, text }) => {
                setDoc(next);
                setCanvasPrompt(text);
              }}
            />
          </SectionContainer>
          {/* State schema */}
          <SectionContainer
            eyebrow="State"
            title="State schema"
            subtitle="fields the model tracks across the conversation"
            defaultOpen={false}
            action={
              <button
                type="button"
                onClick={() =>
                  setFields((prev) => [
                    ...prev,
                    { id: uid(), name: "", type: "string", initialValue: "" },
                  ])
                }
                className="text-[10px] font-sans uppercase tracking-widest border border-gray-500 text-gray-700 hover:bg-gray-100 rounded px-2 py-1"
              >
                + Field
              </button>
            }
          >
            {fields.length === 0 ? (
              <p className="text-xs text-gray-500 font-serif italic">No fields yet.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                    <th className="pb-2 pr-2 font-normal">Name</th>
                    <th className="pb-2 pr-2 font-normal">Type</th>
                    <th className="pb-2 pr-2 font-normal">Initial</th>
                    <th className="pb-2 w-6" />
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f) => (
                    <tr key={f.id} className="border-t border-[#c8c4b4]">
                      <td className="py-1.5 pr-2">
                        <input
                          value={f.name}
                          onChange={(e) =>
                            setFields((prev) =>
                              prev.map((x) => (x.id === f.id ? { ...x, name: e.target.value } : x))
                            )
                          }
                          placeholder="field_name"
                          className="w-full bg-white border border-[#c8c4b4] rounded px-2 py-1 font-mono"
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <select
                          value={f.type}
                          onChange={(e) =>
                            setFields((prev) =>
                              prev.map((x) =>
                                x.id === f.id ? { ...x, type: e.target.value as FieldType } : x
                              )
                            )
                          }
                          className="bg-white border border-[#c8c4b4] rounded px-2 py-1 font-mono"
                        >
                          {FIELD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          value={f.initialValue}
                          onChange={(e) =>
                            setFields((prev) =>
                              prev.map((x) =>
                                x.id === f.id ? { ...x, initialValue: e.target.value } : x
                              )
                            )
                          }
                          placeholder="—"
                          className="w-full bg-white border border-[#c8c4b4] rounded px-2 py-1 font-mono"
                        />
                      </td>
                      <td className="py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => setFields((prev) => prev.filter((x) => x.id !== f.id))}
                          className="text-gray-400 hover:text-red-600 text-base leading-none"
                          aria-label="Remove field"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionContainer>

          {/* Domain knowledge */}
          <SectionContainer
            eyebrow="Knowledge"
            title="Domain knowledge"
            subtitle="reference material added to the system prompt as ### topic sections"
            defaultOpen={false}
            action={
              <button
                type="button"
                onClick={() =>
                  setKnowledge((prev) => [...prev, { id: uid(), topic: "", content: "" }])
                }
                className="text-[10px] font-sans uppercase tracking-widest border border-gray-500 text-gray-700 hover:bg-gray-100 rounded px-2 py-1"
              >
                + Block
              </button>
            }
          >
            {knowledge.length === 0 ? (
              <p className="text-xs text-gray-500 font-serif italic">No knowledge blocks yet.</p>
            ) : (
              <div className="space-y-3">
                {knowledge.map((k) => (
                  <div key={k.id} className="border border-[#c8c4b4] rounded p-2 bg-white">
                    <div className="flex items-center gap-2 mb-1">
                      <input
                        value={k.topic}
                        onChange={(e) =>
                          setKnowledge((prev) =>
                            prev.map((x) => (x.id === k.id ? { ...x, topic: e.target.value } : x))
                          )
                        }
                        placeholder="topic"
                        className="flex-1 text-xs font-mono bg-transparent border-b border-[#c8c4b4] focus:outline-none focus:border-gray-500 px-1 py-1"
                      />
                      <button
                        type="button"
                        onClick={() => setKnowledge((prev) => prev.filter((x) => x.id !== k.id))}
                        className="text-gray-400 hover:text-red-600 text-base leading-none"
                        aria-label="Remove block"
                      >
                        ×
                      </button>
                    </div>
                    <textarea
                      value={k.content}
                      onChange={(e) =>
                        setKnowledge((prev) =>
                          prev.map((x) => (x.id === k.id ? { ...x, content: e.target.value } : x))
                        )
                      }
                      placeholder="content the model should consider…"
                      rows={3}
                      className="w-full text-xs font-serif bg-transparent border border-[#c8c4b4] rounded px-2 py-1.5 focus:outline-none focus:border-gray-500 resize-y"
                    />
                  </div>
                ))}
              </div>
            )}
          </SectionContainer>

          <details className="text-xs font-mono bg-[#f3f1e6] border border-[#c8c4b4] rounded p-3">
            <summary className="cursor-pointer text-gray-600">
              Compiled tools ({tools.length})
            </summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(tools, null, 2)}
            </pre>
          </details>

          {/* Compiled system prompt preview */}
          <details className="text-xs font-mono bg-[#f3f1e6] border border-[#c8c4b4] rounded p-3">
            <summary className="cursor-pointer text-gray-600">
              Compiled system prompt ({enrichedSystemPrompt.length} chars)
            </summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-gray-800">
              {enrichedSystemPrompt || "(empty)"}
            </pre>
          </details>
        </div>

        <div className="flex flex-col gap-3">
          <div
            ref={chatScrollRef}
            className="border border-[#c8c4b4] bg-[#f3f1e6] rounded p-4 h-96 overflow-y-auto space-y-3"
          >
            {messages.length === 0 ? (
              <p className="text-sm text-gray-500 font-serif italic">
                Ask something like &ldquo;who is Ada Lovelace?&rdquo; or &ldquo;tell me about
                Mount Everest&rdquo;.
              </p>
            ) : (
              messages.map((m, i) => (
                <div key={i} className="text-sm">
                  <div className="text-[10px] uppercase tracking-widest text-gray-500 font-sans mb-0.5">
                    {m.role}
                  </div>
                  <div className="font-serif whitespace-pre-wrap text-gray-800">{m.content}</div>
                  {m.media && m.media.length > 0 && (
                    <div className="mt-2 space-y-2">
                      {m.media.map((media, mi) => {
                        if (media.kind !== "video") return null;
                        const embed = resolveVideoEmbed(media.url);
                        if (embed.kind === "iframe") {
                          return (
                            <div
                              key={mi}
                              className="relative w-full max-w-md aspect-video rounded border border-[#c8c4b4] bg-black overflow-hidden"
                            >
                              <iframe
                                src={embed.src}
                                title="embedded video"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                allowFullScreen
                                className="absolute inset-0 w-full h-full"
                              />
                            </div>
                          );
                        }
                        return (
                          <video
                            key={mi}
                            controls
                            src={embed.src}
                            className="w-full max-w-md rounded border border-[#c8c4b4] bg-black"
                          >
                            <a href={media.url} target="_blank" rel="noopener noreferrer">
                              {media.url}
                            </a>
                          </video>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))
            )}
            {loading && (
              <div className="text-xs text-gray-500 font-serif italic">thinking…</div>
            )}
            {error && (
              <div className="text-xs text-red-700 font-mono border border-red-300 bg-red-50 rounded p-2">
                {error}
              </div>
            )}
          </div>

          {/* Live action status — pinned just below the chat window in its
              own thin row so the detailed status doesn't interleave with
              USER/ASSISTANT bubbles inside the chat. The simple "thinking…"
              line above stays inside the chat aesthetic. */}
          <div className="border border-[#c8c4b4] bg-[#f3f1e6] rounded px-3 py-2 min-h-[2rem] flex items-center">
            {loading ? (
              <div className="flex items-center gap-2 text-[11px] font-mono text-gray-600 w-full">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                <span>{status ?? "thinking…"}</span>
                <span className="ml-auto tabular-nums text-gray-500">
                  {(elapsedMs / 1000).toFixed(1)}s
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-[11px] font-mono text-gray-400 w-full">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-300" />
                <span>status</span>
                <span className="ml-auto tabular-nums">—</span>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
              placeholder="Ask about a topic…"
              disabled={loading}
              className="flex-1 bg-[#cbc8b8] border border-[#c0bdb0] rounded px-3 py-2 text-sm font-serif text-gray-800 focus:outline-none focus:border-gray-500"
            />
            <button
              type="button"
              onClick={send}
              disabled={loading || !input.trim()}
              className="text-xs font-sans uppercase tracking-widest px-3 py-2 border border-gray-700 text-gray-900 bg-white hover:bg-gray-100 rounded disabled:opacity-40"
            >
              Send
            </button>
            <button
              type="button"
              onClick={reset}
              className="text-xs font-sans uppercase tracking-widest px-3 py-2 border border-gray-400 text-gray-600 bg-transparent hover:bg-gray-100 rounded"
            >
              Reset
            </button>
          </div>

          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
              Step-by-step trace · {turns.length} turn{turns.length === 1 ? "" : "s"}
            </div>
            {turns.length === 0 ? (
              <p className="text-xs text-gray-500 font-serif italic">
                (no turns yet — send a message to see what happens)
              </p>
            ) : (
              <div className="space-y-2">
                {turns.map((turn, idx) => {
                  const open = openTurnId === turn.id;
                  return (
                    <div
                      key={turn.id}
                      className="border border-[#c8c4b4] rounded bg-[#f3f1e6] overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() => setOpenTurnId(open ? null : turn.id)}
                        aria-expanded={open}
                        className="w-full flex items-start justify-between gap-3 px-3 py-2 text-left hover:bg-[#ebe8d8]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                            Turn {idx + 1} · {turn.trace.length} event
                            {turn.trace.length === 1 ? "" : "s"}
                            {turn.error && (
                              <span className="text-red-700 ml-1">· error</span>
                            )}
                          </div>
                          <div className="text-xs font-serif text-gray-800 truncate">
                            {turn.userMessage}
                          </div>
                        </div>
                        <span
                          aria-hidden
                          className="text-base font-mono text-gray-500 leading-none mt-1 select-none"
                        >
                          {open ? "−" : "+"}
                        </span>
                      </button>
                      {open && (
                        <div className="border-t border-[#c8c4b4] p-3 space-y-2 bg-white/50">
                          {turn.trace.length === 0 ? (
                            <p className="text-xs text-gray-500 font-serif italic">
                              No trace events captured.
                            </p>
                          ) : (
                            <TurnEvents events={turn.trace} turnStartedAt={turn.startedAt} />
                          )}
                          <details className="text-xs font-mono bg-[#f3f1e6] border border-[#c8c4b4] rounded p-2 mt-2">
                            <summary className="cursor-pointer text-gray-600">
                              Raw trace JSON
                            </summary>
                            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">
                              {JSON.stringify(turn.trace, null, 2)}
                            </pre>
                          </details>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
