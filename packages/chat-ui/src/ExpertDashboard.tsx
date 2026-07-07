"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";

interface ConversationRow {
  id: string;
  title: string;
  updated_at: string;
  user_id: string;
  user_email: string | null;
  message_count: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface MessageComment {
  id: string;
  message_id: string;
  expert_id: string;
  expert_email: string | null;
  comment: string;
  created_at: string;
}

function stripStateBlock(text: string): string {
  return text.replace(/BEGIN STATE[\s\S]*?END STATE\s*/g, "").trim();
}

function formatDate(iso: string) {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time}`;
}

function CommentBlock({ comment }: { comment: MessageComment }) {
  return (
    <div className="mt-2 pl-3 border-l-2 border-gray-300">
      <p className="text-xs text-gray-500 mb-0.5">
        {comment.expert_email ?? "Expert"} · {formatDate(comment.created_at)}
      </p>
      <p className="text-xs text-gray-700 leading-relaxed">{comment.comment}</p>
    </div>
  );
}

function ConversationAccordion({
  conversation,
}: {
  conversation: ConversationRow;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [comments, setComments] = useState<Record<string, MessageComment[]>>({});
  const [commentingOn, setCommentingOn] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function toggle() {
    setOpen((o) => !o);
    if (messages === null && !loading) {
      setLoading(true);
      const [msgRes, cmtRes] = await Promise.all([
        fetch(`/api/admin/conversations/messages?conversationId=${conversation.id}`),
        fetch(`/api/admin/message-comments?conversationId=${conversation.id}`),
      ]);
      const msgJson = await msgRes.json();
      const cmtJson = await cmtRes.json();

      setMessages(msgJson.messages ?? []);

      const grouped: Record<string, MessageComment[]> = {};
      for (const c of (cmtJson.comments ?? []) as MessageComment[]) {
        if (!grouped[c.message_id]) grouped[c.message_id] = [];
        grouped[c.message_id].push(c);
      }
      setComments(grouped);
      setLoading(false);
    }
  }

  function openCommentForm(messageId: string) {
    setCommentingOn(messageId);
    setDraft("");
  }

  function cancelComment() {
    setCommentingOn(null);
    setDraft("");
  }

  async function saveComment(messageId: string) {
    if (!draft.trim()) return;
    setSaving(true);
    const res = await fetch("/api/admin/message-comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message_id: messageId,
        conversation_id: conversation.id,
        comment: draft.trim(),
      }),
    });
    const json = await res.json();
    if (json.comment) {
      setComments((prev) => ({
        ...prev,
        [messageId]: [...(prev[messageId] ?? []), json.comment],
      }));
    }
    setSaving(false);
    setCommentingOn(null);
    setDraft("");
  }

  return (
    <div className="border-b border-gray-300">
      {/* Header row */}
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-4 sm:px-6 py-4 text-left hover:bg-[#d8d5c8] transition-colors"
      >
        {/* Left: message count badge */}
        <div className="shrink-0 w-8 sm:w-10 mr-3 sm:mr-4 text-center">
          <span className="text-base sm:text-lg font-medium text-gray-900 leading-none">
            {conversation.message_count}
          </span>
          <p className="text-[9px] sm:text-[10px] text-gray-400 uppercase tracking-wide mt-0.5">
            msgs
          </p>
        </div>

        {/* Middle: title + meta */}
        <div className="flex-1 min-w-0 pr-3">
          <p className="text-sm font-medium text-gray-900 truncate">
            {conversation.title || "Untitled conversation"}
          </p>
          <p className="text-xs text-gray-500 mt-0.5 truncate">
            {conversation.user_email ?? conversation.user_id}
          </p>
          <p className="text-xs text-gray-400 mt-0">
            {formatDate(conversation.updated_at)}
          </p>
        </div>

        {/* Right: chevron */}
        <span className="text-gray-400 text-xs shrink-0">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {/* Message thread */}
      {open && (
        <div className="bg-[#eceadf] px-6 py-5 flex flex-col gap-3">
          {loading && (
            <p className="text-xs text-gray-400 text-center py-6">Loading…</p>
          )}
          {messages && messages.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-6">
              No messages.
            </p>
          )}
          {messages &&
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                {msg.role === "assistant" ? (
                  <div className="flex flex-col max-w-[75%]">
                    <div className="flex items-start gap-2">
                      <div className="px-4 py-3 text-sm leading-relaxed bg-white border border-gray-200 text-gray-900">
                        <div className="prose prose-sm max-w-none">
                          <ReactMarkdown>
                            {stripStateBlock(msg.content)}
                          </ReactMarkdown>
                        </div>
                      </div>
                      <button
                        onClick={() =>
                          commentingOn === msg.id
                            ? cancelComment()
                            : openCommentForm(msg.id)
                        }
                        title="Add comment"
                        className="shrink-0 mt-1 w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-800 transition-colors text-xl leading-[0]"
                      >
                        {commentingOn === msg.id ? "×" : "+"}
                      </button>
                    </div>

                    {/* Existing comments */}
                    {(comments[msg.id] ?? []).map((c) => (
                      <CommentBlock key={c.id} comment={c} />
                    ))}

                    {/* Inline comment form */}
                    {commentingOn === msg.id && (
                      <div className="mt-2 flex flex-col gap-1.5">
                        <textarea
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          rows={3}
                          placeholder="Add expert comment…"
                          className="w-full text-base border border-gray-300 bg-white px-3 py-2 leading-relaxed resize-none focus:outline-none focus:border-gray-500"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => saveComment(msg.id)}
                            disabled={saving || !draft.trim()}
                            className="text-xs px-3 py-1.5 bg-[#1E2938] text-[#E1DECF] disabled:opacity-40 hover:bg-[#2a3a4d] transition-colors"
                          >
                            {saving ? "Saving…" : "Save"}
                          </button>
                          <button
                            onClick={cancelComment}
                            className="text-xs px-3 py-1.5 text-gray-500 hover:text-gray-700 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="max-w-[75%] px-4 py-3 text-sm leading-relaxed bg-[#1E2938] text-[#E1DECF]">
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                  </div>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

type SortKey = "date" | "user" | "messages";

function sorted(list: ConversationRow[], by: SortKey): ConversationRow[] {
  return [...list].sort((a, b) => {
    if (by === "date") return b.updated_at.localeCompare(a.updated_at);
    if (by === "user") return (a.user_email ?? a.user_id).localeCompare(b.user_email ?? b.user_id);
    if (by === "messages") return b.message_count - a.message_count;
    return 0;
  });
}

export default function ExpertDashboard({ apiEndpoint = "/api/admin/conversations" }: { apiEndpoint?: string }) {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<SortKey>("date");

  useEffect(() => {
    fetch(apiEndpoint)
      .then((r) => r.json())
      .then((json) => {
        setConversations(json.conversations ?? []);
        setLoading(false);
      });
  }, [apiEndpoint]);

  const displayed = sorted(conversations, sortBy);

  return (
    <div className="py-4 sm:py-6">
      {loading && (
        <p className="text-sm text-gray-400 text-center py-12">
          Loading conversations…
        </p>
      )}

      {!loading && conversations.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-12">
          No conversations yet.
        </p>
      )}

      {!loading && conversations.length > 0 && (
        <div className="border border-gray-300 bg-[#E1DECF]">
          <div className="px-4 py-3 border-b border-gray-300 bg-[#d8d5c8] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <p className="text-xs tracking-widest uppercase text-gray-500 font-sans">
              {conversations.length} conversation
              {conversations.length !== 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-4 sm:gap-6">
            {(["date", "user", "messages"] as SortKey[]).map((key) => (
              <button
                key={key}
                onClick={() => setSortBy(key)}
                className={`text-xs tracking-widest uppercase transition-colors ${
                  sortBy === key
                    ? "text-gray-900 font-medium"
                    : "text-gray-400 hover:text-gray-700"
                }`}
              >
                {key}
              </button>
            ))}
            </div>
          </div>
          {displayed.map((c) => (
            <ConversationAccordion key={c.id} conversation={c} />
          ))}
        </div>
      )}
    </div>
  );
}
