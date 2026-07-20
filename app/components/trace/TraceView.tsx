"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";

// Shared trace viewer — the "step-by-step trace" UI first built inline on the
// sandbox page, extracted so other surfaces (e.g. the Sleep observability
// panel) can render the exact same view. The shapes mirror the SSE events the
// agentic chat route emits (app/api/chat/tools/route.ts).

/** Render prompt / reply text with markdown (headers, bold, lists).
 *  Embedded JSON objects/arrays are lifted into real <pre> blocks (not markdown
 *  fences) so they stay readable even inside lists / dense prompts. */
function TraceMarkdown({ children }: { children: string }) {
  const parts = splitProseAndJson(children);
  return (
    <div className="trace-md text-gray-700 break-words [&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-[13px] [&_h1]:font-semibold [&_h1]:text-gray-900 [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:text-gray-900 [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_h3]:text-[12px] [&_h3]:font-semibold [&_h3]:text-gray-900 [&_p]:my-1 [&_p]:leading-relaxed [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 [&_strong]:font-semibold [&_strong]:text-gray-900 [&_em]:italic [&_code]:rounded [&_code]:bg-[#ebe8dc] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[#ebe8dc] [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:leading-relaxed [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[12px] [&_pre_code]:whitespace-pre-wrap">
      {parts.map((part, i) =>
        part.type === "json" ? (
          <pre
            key={i}
            className="trace-json mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[#ebe8dc] p-2.5 font-mono text-[12px] leading-relaxed text-gray-800"
          >
            {part.text}
          </pre>
        ) : part.text.trim() ? (
          <ReactMarkdown
            key={i}
            components={{
              pre: ({ children: preChildren }) => (
                <pre className="trace-json mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[#ebe8dc] p-2.5 font-mono text-[12px] leading-relaxed text-gray-800">
                  {preChildren}
                </pre>
              ),
            }}
          >
            {part.text}
          </ReactMarkdown>
        ) : null
      )}
    </div>
  );
}

/** Find matching } or ] at `start`, tracking nested braces and brackets. */
function findMatchingBracket(text: string, start: number): number {
  const open = text[start];
  if (open !== "{" && open !== "[") return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        // Require the closer to match the opener kind.
        if ((open === "{" && ch === "}") || (open === "[" && ch === "]")) return i;
        return -1;
      }
    }
  }
  return -1;
}

/** Indent brace/bracket text that looks like JSON but isn't strictly parseable
 *  (e.g. schema examples with bare `string` / `integer` types). */
function softFormatObjectLike(slice: string): string {
  let result = "";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]!;
    if (inString) {
      result += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      result += ch + "\n" + "  ".repeat(depth);
      while (i + 1 < slice.length && /\s/.test(slice[i + 1]!)) i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth = Math.max(0, depth - 1);
      result += "\n" + "  ".repeat(depth) + ch;
      continue;
    }
    if (ch === ",") {
      result += ch + "\n" + "  ".repeat(depth);
      while (i + 1 < slice.length && /\s/.test(slice[i + 1]!)) i++;
      continue;
    }
    if (ch === ":") {
      result += ": ";
      while (i + 1 < slice.length && /\s/.test(slice[i + 1]!)) i++;
      continue;
    }
    if (/\s/.test(ch)) continue;
    result += ch;
  }
  return result;
}

function looksLikeJsonObject(slice: string): boolean {
  const t = slice.trim();
  if (t.length < 20) return false;
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  // Quoted key, or schema-ish `{ "field": type` / `"field":`
  return /[{[]\s*"/.test(t) && (t.includes(":") || t.includes(","));
}

function formatJsonSlice(slice: string): string | null {
  const cleaned = slice
    .replace(/^\uFEFF/, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
  if (!looksLikeJsonObject(cleaned)) return null;
  try {
    return JSON.stringify(JSON.parse(cleaned), null, 2);
  } catch {
    // Already indented schema / near-JSON — still soft-format if minified-ish.
    const soft = softFormatObjectLike(cleaned);
    if (soft && soft !== cleaned) return soft;
    // If it already has newlines, keep as-is but still treat as JSON block.
    if (cleaned.includes("\n") && cleaned.split("\n").length >= 3) return cleaned;
    if (cleaned.length >= 36) return soft || cleaned;
    return null;
  }
}

type TextOrJsonPart = { type: "text" | "json"; text: string };

/**
 * Split prose and JSON-like payloads so JSON can render in a real <pre>
 * instead of depending on markdown fences (which often fail inside prompts).
 */
function splitProseAndJson(text: string): TextOrJsonPart[] {
  if (!text) return [{ type: "text", text: "" }];
  if (text.indexOf("{") < 0 && text.indexOf("[") < 0) {
    return [{ type: "text", text }];
  }

  // Skip regions already inside markdown fences.
  const fenceRanges: Array<{ start: number; end: number }> = [];
  const fenceRe = /```[\s\S]*?```/g;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(text))) {
    fenceRanges.push({ start: fm.index, end: fm.index + fm[0].length });
  }
  const inFence = (index: number) =>
    fenceRanges.some((r) => index >= r.start && index < r.end);

  const spans: Array<{ start: number; end: number; pretty: string }> = [];
  for (let i = 0; i < text.length; i++) {
    if (inFence(i)) continue;
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    // Prefer object starts; skip `[` that is clearly a tiny empty array token
    // mid-prose unless it looks like a JSON array of objects.
    if (ch === "[" && text.slice(i, i + 2) === "[]") continue;

    const end = findMatchingBracket(text, i);
    if (end < 0) continue;
    const slice = text.slice(i, end + 1);
    if (slice.length < 24) {
      i = end;
      continue;
    }
    const pretty = formatJsonSlice(slice);
    if (!pretty) {
      i = end;
      continue;
    }
    spans.push({ start: i, end, pretty });
    i = end;
  }

  if (spans.length === 0) return [{ type: "text", text }];

  const parts: TextOrJsonPart[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      parts.push({ type: "text", text: text.slice(cursor, span.start) });
    }
    parts.push({ type: "json", text: span.pretty });
    cursor = span.end + 1;
  }
  if (cursor < text.length) {
    parts.push({ type: "text", text: text.slice(cursor) });
  }
  return parts;
}

/** Pretty-print a string if it parses as JSON; otherwise null. */
function tryFormatJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Strip optional markdown fences around a JSON payload.
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return formatJsonSlice(unfenced);
}

function formatJsonValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Markdown for prose; indented <pre> when the payload is JSON. */
function TraceContent({ children }: { children: string }) {
  const pretty = tryFormatJson(children);
  if (pretty) {
    return (
      <pre className="trace-json mt-0.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[#ebe8dc] p-2.5 font-mono text-[12px] leading-relaxed text-gray-800">
        {pretty}
      </pre>
    );
  }
  return <TraceMarkdown>{children}</TraceMarkdown>;
}

export type TraceEvent =
  | {
      kind: "openai_request";
      loop: number;
      /** Which stage of the turn this call belongs to (state update vs policy). */
      phase?: "state" | "policy";
      model: string;
      messages: Array<{ role: string; preview: string; toolCalls?: number; toolCallId?: string }>;
      tools: Array<{ name: string; description?: string }>;
    }
  | {
      kind: "openai_response";
      loop: number;
      phase?: "state" | "policy";
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

export type TimedTraceEvent = TraceEvent & { tMs: number };

export interface Turn {
  id: string;
  userMessage: string;
  startedAt: number;
  trace: TimedTraceEvent[];
  finalAnswer?: string;
  error?: string;
  /** Patient state extracted this turn (age, gender, …) for the State pane. */
  state?: Record<string, unknown>;
  /** Exact canvas nodes the policy graph traversed this turn; drives the
   *  Policy canvas path animation. */
  nodeRefs?: { nodeId: string; canvasId?: string }[];
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function serializeTurn(turn: Turn, index: number) {
  return {
    turn: index + 1,
    id: turn.id,
    userMessage: turn.userMessage,
    finalAnswer: turn.finalAnswer,
    error: turn.error,
    startedAt: turn.startedAt,
    state: turn.state,
    nodeRefs: turn.nodeRefs,
    trace: turn.trace,
  };
}

function serializeAllTurns(turns: Turn[]) {
  return turns.map((t, i) => serializeTurn(t, i));
}

function CopyIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/** Small copy control with brief "Copied" feedback. */
function TraceCopyButton({
  getText,
  label = "Copy",
  title,
  className = "trace-copy-btn",
  iconOnly = false,
}: {
  getText: () => string;
  label?: string;
  title?: string;
  className?: string;
  /** Show clipboard icon instead of text (turn rows). */
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className + (copied ? " is-copied" : "") + (iconOnly ? " is-icon" : "")}
      title={copied ? "Copied" : title ?? label}
      aria-label={copied ? "Copied" : title ?? label}
      onClick={async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const ok = await copyToClipboard(getText());
        if (!ok) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }}
    >
      {iconOnly ? (
        copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />
      ) : copied ? (
        "Copied"
      ) : (
        label
      )}
    </button>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

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

// Alternating card tints: outgoing steps (request / tool dispatch) get the green
// tint, incoming steps (response / tool result) get the pink tint, so the trace
// reads as alternating rows.
const KIND_COLOR: Record<TraceEvent["kind"], string> = {
  openai_request: "border-[#cfe0c6] bg-[#E4EDE0]",
  openai_response: "border-[#e2d4d4] bg-[#EEE8E8]",
  tool_dispatch: "border-[#cfe0c6] bg-[#E4EDE0]",
  tool_result: "border-[#e2d4d4] bg-[#EEE8E8]",
};

// Plain-English "what is this step doing" line, shown on every trace row so the
// technical preview (msg/tools/chars) isn't the only cue.
function eventDescription(event: TraceEvent): string {
  switch (event.kind) {
    case "openai_request":
      if (event.phase === "state")
        return "Updating state: sends your latest message + current state so the model can extract the new values.";
      if (event.phase === "policy")
        return "Deciding the reply: sends the updated state + conversation to the policy prompt.";
      return event.tools.length > 0
        ? "Sends the prompt and conversation to the model, which may call a tool."
        : "Sends the prompt and conversation to the model and waits for its reply.";
    case "openai_response":
      if (event.toolCalls.length > 0)
        return `The model chose to call ${event.toolCalls.map((c) => c.name).join(", ")}.`;
      if (event.phase === "state")
        return `Returned the updated state (${event.content.length} characters of JSON).`;
      if (event.phase === "policy")
        return `Returned the assistant's reply (${event.content.length} characters).`;
      return `The model returned its answer (${event.content.length} characters).`;
    case "tool_dispatch":
      return `Runs the ${event.tool} tool and waits for the result.`;
    case "tool_result":
      return event.ok
        ? `The ${event.tool} tool returned ${event.bytes.toLocaleString()} bytes.`
        : `The ${event.tool} tool failed${event.error ? `: ${event.error}` : "."}`;
  }
}

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

export function TraceEventCard({
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
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left rounded hover:bg-black/5 outline-none focus:ring-2 focus:ring-inset focus:ring-[#385100]"
      >
        <span className="flex flex-col min-w-0 gap-0.5">
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
          <span className="font-sans normal-case text-[11px] leading-snug text-gray-500 truncate">
            {eventDescription(event)}
          </span>
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
              <li key={i} className="border-l-2 border-[#385100]/30 pl-2">
                <span className="text-[#385100] uppercase tracking-wider text-[10px]">
                  {m.role}
                </span>
                {m.toolCalls != null && (
                  <span className="text-amber-700 ml-1">[{m.toolCalls} tool call(s)]</span>
                )}
                <TraceContent>{m.preview}</TraceContent>
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
                    <span className="text-amber-700">{c.name}</span>
                    <pre className="trace-json mt-0.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[#ebe8dc] p-2 font-mono text-[12px] leading-relaxed text-gray-800">
                      {formatJsonValue(c.args)}
                    </pre>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div>
              <div className="text-gray-500">final answer:</div>
              <div className="mt-1">
                <TraceContent>{event.content}</TraceContent>
              </div>
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
            <span className="text-gray-500">args:</span>
            <pre className="trace-json mt-0.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[#ebe8dc] p-2 font-mono text-[12px] leading-relaxed text-gray-800">
              {formatJsonValue(event.args)}
            </pre>
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
            <div className="mt-0.5">
              <TraceContent>{event.preview}</TraceContent>
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

export function TurnEvents({
  events,
  turnStartedAt,
}: {
  events: TimedTraceEvent[];
  turnStartedAt: number;
}) {
  // Bumping `version` remounts each TraceEventCard so its internal useState
  // re-initialises with the new defaultOpen — the simplest way to implement
  // expand-all / collapse-all without lifting per-card state.
  // Events start collapsed (just the summary line); use Expand all / the + on a
  // card to drill in.
  const [defaultOpen, setDefaultOpen] = useState(false);
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

/**
 * The full "Step-by-step trace" section: a header, an empty state, and one
 * collapsible card per turn (with the per-turn events + raw JSON). Manages its
 * own open-turn state. Pass the accumulated `turns`. Supports a fullscreen
 * overlay so long traces are easier to read.
 */
export function TraceView({
  turns,
  focus,
}: {
  turns: Turn[];
  /** External request to expand + scroll to a turn; `n` bumps per click. */
  focus?: { id: string; n: number };
}) {
  const [openTurnId, setOpenTurnId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [fullscreen]);

  // When a chat bubble asks to see its trace, expand that turn and scroll it in.
  useEffect(() => {
    if (!focus || !focus.id) return;
    if (!turns.some((t) => t.id === focus.id)) return;
    setOpenTurnId(focus.id);
    const el = cardRefs.current[focus.id];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n, focus?.id]);

  const turnList =
    turns.length === 0 ? (
      <p className="text-xs text-gray-500 font-serif italic">
        (no turns yet — send a message to see what happens)
      </p>
    ) : (
      <div className="space-y-2">
        {turns.map((turn, idx) => {
          const open = openTurnId === turn.id;
          const focused = focus?.id === turn.id;
          return (
            <div
              key={turn.id}
              ref={(el) => {
                cardRefs.current[turn.id] = el;
              }}
              className={
                "border rounded bg-[#f3f1e6] overflow-hidden " +
                (focused ? "border-[#385100]" : "border-[#c8c4b4]")
              }
            >
              <div className="flex items-start gap-2 px-3 py-2 hover:bg-[#ebe8d8]">
                <button
                  type="button"
                  onClick={() => setOpenTurnId(open ? null : turn.id)}
                  aria-expanded={open}
                  aria-label={open ? `Collapse turn ${idx + 1}` : `Expand turn ${idx + 1}`}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                    Turn {idx + 1} · {turn.trace.length} event
                    {turn.trace.length === 1 ? "" : "s"}
                    {turn.error && <span className="text-red-700 ml-1">· error</span>}
                  </div>
                  <div className="text-xs font-serif text-gray-800 truncate">
                    {turn.userMessage}
                  </div>
                </button>
                <TraceCopyButton
                  iconOnly
                  title={`Copy turn ${idx + 1} trace`}
                  className="trace-copy-btn trace-copy-btn-turn shrink-0 mt-0.5"
                  getText={() => JSON.stringify(serializeTurn(turn, idx), null, 2)}
                />
              </div>
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
                    <summary className="cursor-pointer text-gray-600">Raw trace JSON</summary>
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
    );

  const copyAllBtn =
    turns.length > 0 ? (
      <TraceCopyButton
        label="Copy all"
        title="Copy all traces as JSON"
        className="trace-copy-btn"
        getText={() => JSON.stringify(serializeAllTurns(turns), null, 2)}
      />
    ) : null;

  const title = (
    <div className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
      Step-by-step trace · {turns.length} turn{turns.length === 1 ? "" : "s"}
    </div>
  );

  const inline = (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        {title}
        <div className="flex items-center gap-3 shrink-0">
          {copyAllBtn}
          <button
            type="button"
            className="trace-fs-open"
            title="Open trace in fullscreen"
            onClick={() => setFullscreen(true)}
          >
            Fullscreen
          </button>
        </div>
      </div>
      {!fullscreen ? turnList : null}
    </div>
  );

  const overlay =
    fullscreen && portalReady
      ? createPortal(
          <div
            className="trace-fs-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Step-by-step trace fullscreen"
            onClick={() => setFullscreen(false)}
          >
            <div className="trace-fs" onClick={(e) => e.stopPropagation()}>
              <div className="trace-fs-head">
                {title}
                <div className="flex items-center gap-3 shrink-0">
                  {copyAllBtn}
                  <button
                    type="button"
                    className="trace-fs-close"
                    aria-label="Close fullscreen"
                    title="Close fullscreen"
                    onClick={() => setFullscreen(false)}
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="trace-fs-body">{turnList}</div>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      {inline}
      {overlay}
    </>
  );
}
