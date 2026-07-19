"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Avatar } from "./ra-shared";

/**
 * Expert-chat content: a side conversation with the human sleep expert. The
 * conversation is kept in component state and mirrored to localStorage (key
 * `ra-expert-chat`) so every message the user sends is stored and survives
 * reloads. There is no backend round-trip — each user message is acknowledged
 * immediately with a canned "received, will reply shortly" reply.
 *
 * Rendered as one tab inside the shared RightDrawer; the drawer shell, tab strip
 * and close button live there. This component renders only the pane body.
 */

export interface ExpertMessage {
  role: "user" | "expert";
  text: string;
  ts: number;
}

const STORAGE_KEY = "ra-expert-chat";
const ACK_REPLY = "The expert has received your message and will reply shortly.";

function loadStored(): ExpertMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ExpertMessage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function ExpertChatContent({ active }: { active: boolean }) {
  const [messages, setMessages] = useState<ExpertMessage[]>([]);
  const [value, setValue] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Hydrate from localStorage on mount (client-only, avoids hydration mismatch).
  useEffect(() => {
    setMessages(loadStored());
  }, []);

  // Persist every change so the whole history is stored.
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      /* ignore quota / private-mode errors */
    }
  }, [messages]);

  // Keep the latest message in view when this tab is shown. Don't auto-focus
  // the composer — on mobile that pops the keyboard the moment you switch to
  // the tab; let the user tap the field when they want to type.
  useEffect(() => {
    if (!active) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [active, messages]);

  const send = () => {
    const v = value.trim();
    if (!v) return;
    const now = Date.now();
    setMessages((prev) => [
      ...prev,
      { role: "user", text: v, ts: now },
      { role: "expert", text: ACK_REPLY, ts: now + 1 },
    ]);
    setValue("");
  };

  return (
    <div className="drawer-pane">
      <div className="drawer-subhead">
        <span className="obs-sub">Your messages are saved here</span>
        {messages.length > 0 && (
          <button type="button" onClick={() => setMessages([])} className="obs-clear">
            Clear
          </button>
        )}
      </div>

      <div className="obs-body expert-body">
        {messages.length === 0 ? (
          <div className="expert-empty">
            Send a message to your sleep expert. Everything you send is saved
            here, and they&apos;ll get back to you soon.
          </div>
        ) : (
          messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="msg-user">
                {m.text}
              </div>
            ) : (
              <div key={i} className="msg-ai">
                <Avatar kind="assistant" size={28} mono="EX" />
                <div className="bubble">
                  <ReactMarkdown>{m.text}</ReactMarkdown>
                </div>
              </div>
            )
          )
        )}
        <div ref={bottomRef} />
      </div>

      <div className="expert-composer">
        <input
          ref={inputRef}
          className="comp-input"
          placeholder="Message the expert…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          className="expert-send"
          onClick={send}
          disabled={!value.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
