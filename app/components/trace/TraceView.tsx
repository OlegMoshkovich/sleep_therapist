"use client";

import { useState } from "react";

// Shared trace viewer — the "step-by-step trace" UI first built inline on the
// sandbox page, extracted so other surfaces (e.g. the Sleep observability
// panel) can render the exact same view. The shapes mirror the SSE events the
// agentic chat route emits (app/api/chat/tools/route.ts).

export type TraceEvent =
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
 * own open-turn state. Pass the accumulated `turns`.
 */
export function TraceView({ turns }: { turns: Turn[] }) {
  const [openTurnId, setOpenTurnId] = useState<string | null>(null);

  return (
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
                      {turn.error && <span className="text-red-700 ml-1">· error</span>}
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
      )}
    </div>
  );
}
