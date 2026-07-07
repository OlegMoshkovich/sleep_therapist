"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import SiteNavbar from "../../components/SiteNavbar";
import AuthModal from "../../components/AuthModal";
import { AuthProvider, useAuth } from "../../context/AuthContext";

type ChatRole = "assistant" | "user";

interface Message {
  role: ChatRole;
  text: string;
}

const GOVERNING_LOGIC = [
  {
    title: "Existing AI runtime",
    body:
      "This page calls the repo's existing /api/chat/sleep/base endpoint, which delegates to the shared stateful chat runtime in app/api/chat/route.ts.",
  },
  {
    title: "Sleep-specific model setup",
    body:
      "Requests from /sleep-assessment and /demo/sleep resolve to the sleep_inputs setup table and /demo/sleep/input model configuration instead of the default nutrition setup.",
  },
  {
    title: "Two-step reasoning loop",
    body:
      "Each turn first updates structured conversation state, then runs the policy prompt/canvas to decide what the sleep therapist should say next.",
  },
  {
    title: "State memory",
    body:
      "The runtime persists the conversation and current_state in Supabase, so the therapist can carry forward sleep goals, symptoms, schedule details, and prior answers.",
  },
  {
    title: "Expert-authored rules",
    body:
      "State schema, state-update prompt, policy prompt, guideline blocks, and optional policy/state canvases are loaded from the latest sleep setup row created in the model setup UI.",
  },
  {
    title: "Safety boundary",
    body:
      "The assistant should coach sleep habits and behavioral routines, while avoiding diagnosis, prescriptions, or emergency care. Red flags should route users toward clinicians or emergency resources.",
  },
  {
    title: "Traceability",
    body:
      "This page requests trace=true and shows the model calls, state extraction, tools, and current state returned by the existing API so users can inspect what governed the answer.",
  },
];

const STARTERS = [
  "I want to improve my sleep. Can you start with an intake?",
  "I can’t fall asleep for over an hour most nights.",
  "I wake up at 3am and struggle to get back to sleep.",
  "Help me build a 7-day sleep plan.",
];

function formatTrace(trace: unknown[]): string[] {
  return trace.slice(-6).map((event, index) => {
    if (!event || typeof event !== "object") return `Trace ${index + 1}: ${String(event)}`;
    const row = event as Record<string, unknown>;
    const kind = String(row.kind ?? "event");
    const model = typeof row.model === "string" ? ` · ${row.model}` : "";
    const finish = typeof row.finishReason === "string" ? ` · ${row.finishReason}` : "";
    const content = typeof row.content === "string" && row.content.trim()
      ? ` — ${row.content.trim().slice(0, 180)}${row.content.trim().length > 180 ? "…" : ""}`
      : "";
    return `${kind}${model}${finish}${content}`;
  });
}

function LogicPanel({ trace, state }: { trace: string[]; state: Record<string, unknown> | null }) {
  return (
    <aside className="rounded-[2rem] border border-black/15 bg-[#f8f4e8] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.10)] lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto">
      <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#F05025]">Governance</p>
      <h2 className="mt-3 text-3xl font-bold leading-none text-black">Decisions and logic powering the sleep therapist</h2>
      <div className="mt-5 space-y-3">
        {GOVERNING_LOGIC.map((item, index) => (
          <div key={item.title} className="rounded-2xl border border-black/10 bg-white/70 p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black text-xs font-bold text-[#E1DECF]">
                {index + 1}
              </span>
              <div>
                <h3 className="font-bold text-black">{item.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-black/65">{item.body}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-2xl border border-[#F05025]/30 bg-[#F05025]/10 p-4 text-sm leading-relaxed text-black/75">
        <strong>Medical disclaimer:</strong> this is an AI sleep coach, not a licensed clinician. It must not diagnose sleep disorders or prescribe medication. For snoring with gasping, breathing pauses, sudden sleep attacks, severe daytime sleepiness, mania, or self-harm risk, seek professional care.
      </div>

      <div className="mt-5 rounded-2xl bg-black p-4 text-[#E1DECF]">
        <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-[#E1DECF]/70">Live state</h3>
        <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-white/10 p-3 text-xs leading-relaxed">
          {state ? JSON.stringify(state, null, 2) : "No state returned yet. Send a message to see what the AI extracts."}
        </pre>
      </div>

      <div className="mt-4 rounded-2xl bg-black p-4 text-[#E1DECF]">
        <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-[#E1DECF]/70">Latest AI trace</h3>
        {trace.length > 0 ? (
          <ul className="mt-3 space-y-2 text-xs leading-relaxed">
            {trace.map((item, index) => (
              <li key={`${item}-${index}`} className="rounded-xl bg-white/10 p-3">{item}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-[#E1DECF]/70">No trace yet. The first response will show the AI request/response events used by the existing runtime.</p>
        )}
      </div>
    </aside>
  );
}

function Bubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] rounded-3xl rounded-tr-md bg-black px-5 py-4 text-[15px] leading-relaxed text-[#E1DECF]">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black text-lg text-[#E1DECF]">☾</div>
      <div className="max-w-[82%] whitespace-pre-wrap rounded-3xl rounded-tl-md bg-white px-5 py-4 text-[15px] leading-relaxed text-black shadow-sm">
        {message.text}
      </div>
    </div>
  );
}

function AiSleepTherapist() {
  const { user, loading } = useAuth();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      text:
        "Hi — I’m the AI-powered sleep therapist already implemented in this repo. I can help with a sleep intake, sleep diary review, CBT-I-informed habits, and a practical plan. I’m not a doctor and can’t diagnose or prescribe. What would you like help with first?",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [trace, setTrace] = useState<string[]>([]);
  const [state, setState] = useState<Record<string, unknown> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const progressLabel = useMemo(() => {
    if (!conversationId) return "New AI session";
    return `Conversation ${conversationId.slice(0, 8)}`;
  }, [conversationId]);

  const ensureConversation = useCallback(async (firstMessage: string) => {
    if (conversationId) return conversationId;

    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: firstMessage.slice(0, 60), topic: "sleep" }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Could not create conversation (${res.status}).`);
    }

    const data = (await res.json()) as { id: string };
    setConversationId(data.id);
    return data.id;
  }, [conversationId]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setInput("");
    setSending(true);
    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);

    try {
      const id = await ensureConversation(trimmed);
      const res = await fetch("/api/chat/sleep/base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: id, userMessage: trimmed, trace: true }),
      });

      if (!res.ok) {
        const textBody = await res.text().catch(() => "");
        throw new Error(textBody || `Sleep therapist request failed (${res.status}).`);
      }

      const data = (await res.json()) as {
        content?: string;
        trace?: unknown[];
        state?: Record<string, unknown>;
      };

      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: data.content?.trim() || "I’m sorry, I didn’t receive a response. Please try again." },
      ]);
      setTrace(formatTrace(data.trace ?? []));
      setState(data.state ?? null);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text:
            error instanceof Error
              ? error.message
              : "Something went wrong while contacting the sleep therapist.",
        },
      ]);
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [ensureConversation, sending]);

  if (loading) {
    return <div className="flex min-h-[60dvh] items-center justify-center text-sm text-black/55">Loading…</div>;
  }

  if (!user) {
    return <AuthModal />;
  }

  return (
    <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 pb-10 pt-4 sm:px-6 lg:grid-cols-[420px_minmax(0,1fr)] lg:px-8">
      <LogicPanel trace={trace} state={state} />

      <section className="min-h-[720px] overflow-hidden rounded-[2rem] border border-black/15 bg-[#f8f4e8] shadow-[0_28px_100px_rgba(0,0,0,0.18)]">
        <div className="flex items-center justify-between gap-4 border-b border-black/10 bg-black px-5 py-4 text-[#E1DECF] sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#E1DECF] text-xl text-black">☾</div>
            <div>
              <p className="font-bold leading-tight">AI Sleep Therapist</p>
              <p className="text-xs text-[#E1DECF]/65">Powered by /api/chat/sleep/base</p>
            </div>
          </div>
          <div className="text-right text-xs text-[#E1DECF]/65">{progressLabel}</div>
        </div>

        <div className="flex h-[calc(100%-73px)] min-h-[646px] flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
            {messages.map((message, index) => (
              <Bubble key={index} message={message} />
            ))}
            {sending && <Bubble message={{ role: "assistant", text: "Thinking through the sleep setup, state, and policy…" }} />}
          </div>

          <div className="border-t border-black/10 bg-[#f2eddf] px-4 py-4 sm:px-6">
            <div className="mb-3 flex flex-wrap gap-2">
              {STARTERS.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => send(starter)}
                  disabled={sending}
                  className="rounded-full border border-black/15 bg-white px-3 py-2 text-sm text-black transition hover:border-black hover:bg-black hover:text-[#E1DECF] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {starter}
                </button>
              ))}
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                send(input);
              }}
            >
              <input
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Ask the AI sleep therapist…"
                className="min-w-0 flex-1 rounded-full border border-black/15 bg-white px-4 py-3 text-sm text-black outline-none focus:border-black"
              />
              <button
                type="submit"
                disabled={!input.trim() || sending}
                className="rounded-full bg-black px-5 py-3 text-sm font-bold text-[#E1DECF] transition hover:bg-[#F05025] disabled:cursor-not-allowed disabled:opacity-35"
              >
                Send
              </button>
            </form>
            <div className="mt-3 flex flex-wrap gap-3 text-xs text-black/50">
              <Link href="/sleep-assessment" className="underline underline-offset-4 hover:text-black">Structured non-AI intake</Link>
              <Link href="/demo/sleep/studio" className="underline underline-offset-4 hover:text-black">Full sleep studio</Link>
              <Link href="/demo/sleep/input" className="underline underline-offset-4 hover:text-black">Model setup</Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

export default function HermesSleepAssessmentPage() {
  return (
    <AuthProvider>
      <div className="h-dvh overflow-y-auto overflow-x-hidden overscroll-none bg-[#E1DECF]">
        <SiteNavbar />
        <AiSleepTherapist />
      </div>
    </AuthProvider>
  );
}
