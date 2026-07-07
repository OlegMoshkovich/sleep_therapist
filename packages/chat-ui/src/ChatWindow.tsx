"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import ConversationSidebar from "./ConversationSidebar";
import MessageList, { Message } from "./MessageList";
import MessageInput from "./MessageInput";

interface Conversation {
  id: string;
  title: string;
  updated_at: string;
}

interface ChatWindowProps {
  chatEndpoint?: string;
  topic?: string;
  demoTitle?: string;
  modelSetupHref?: string;
  modelSetupLabel?: string;
}

async function readChatErrorMessage(res: Response): Promise<string> {
  const fallbackMessage = `Chat request failed (${res.status})`;

  try {
    const bodyText = await res.text();
    if (!bodyText.trim()) {
      return fallbackMessage;
    }

    try {
      const parsed = JSON.parse(bodyText) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error.trim();
      }
    } catch {
      // Non-JSON error responses still sometimes contain useful plain text.
    }

    return bodyText.trim();
  } catch {
    return fallbackMessage;
  }
}

export default function ChatWindow({
  chatEndpoint = "/api/chat",
  topic,
  demoTitle,
  modelSetupHref,
  modelSetupLabel,
}: ChatWindowProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const loadConversations = useCallback(async () => {
    const url = topic
      ? `/api/conversations?topic=${encodeURIComponent(topic)}`
      : `/api/conversations`;
    const res = await fetch(url);
    if (!res.ok) {
      setConversations([]);
      return;
    }
    const { conversations: rows } = (await res.json()) as {
      conversations: Conversation[];
    };
    setConversations(rows ?? []);
  }, [topic]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  async function loadMessages(conversationId: string) {
    const res = await fetch(`/api/conversations/${conversationId}/messages`);
    if (!res.ok) {
      console.error("[chat] loadMessages failed:", res.status, await res.text().catch(() => ""));
      setMessages([]);
      return;
    }
    const { messages: rows } = (await res.json()) as {
      messages: Array<{ id: string; role: string; content: string }>;
    };
    setMessages(
      (rows ?? []).map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
      }))
    );
  }

  function handleSelectConversation(id: string) {
    setActiveConversationId(id);
    setStreamingContent("");
    loadMessages(id);
    setSidebarOpen(false);
  }

  async function handleDeleteConversation(id: string) {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConversationId === id) {
      setActiveConversationId(null);
      setMessages([]);
      setStreamingContent("");
    }
  }

  async function handleNewConversation() {
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(topic ? { topic } : {}),
    });
    if (!res.ok) return;
    const { id } = await res.json();
    await loadConversations();
    handleSelectConversation(id);
  }

  async function handleSend() {
    const text = inputValue.trim();
    if (!text || isStreaming) return;
    setInputValue("");

    let conversationId = activeConversationId;

    if (!conversationId) {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: text.slice(0, 60), ...(topic ? { topic } : {}) }),
      });
      if (!res.ok) return;
      const { id } = await res.json();
      conversationId = id;
      setActiveConversationId(id);
      await loadConversations();
    }

    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: tempId, role: "user", content: text },
    ]);

    setIsStreaming(true);
    setStreamingContent("");

    try {
      const requestBody = { conversationId, userMessage: text };
      console.log("%c[chat] → REQUEST", "color: #4A90E2; font-weight: bold", {
        endpoint: chatEndpoint,
        body: requestBody,
      });

      const res = await fetch(chatEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        throw new Error(await readChatErrorMessage(res));
      }

      if (!res.body) {
        throw new Error("Chat response was empty.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        accumulated += chunk;
        setStreamingContent(accumulated);
      }

      console.log("%c[chat] ← RESPONSE", "color: #27AE60; font-weight: bold", accumulated);

      const assistantId = `assistant-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: accumulated },
      ]);
      setStreamingContent("");
      loadConversations();
    } catch (err) {
      console.error("Send error:", err);
      setStreamingContent("");
      const errorMessage =
        err instanceof Error && err.message.trim()
          ? err.message.trim()
          : "Something went wrong while sending the message.";
      setMessages((prev) => [
        ...prev,
        { id: `assistant-error-${Date.now()}`, role: "assistant", content: errorMessage },
      ]);
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Navbar */}
      <div id="chat-navbar" className="flex items-center justify-between px-4 py-3 border-b border-gray-300 bg-[#E1DECF] shrink-0">
        <Link
          href="/demo"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          ← Back
        </Link>
        {/* Sidebar toggle — mobile only */}
        <button
          onClick={() => setSidebarOpen((o) => !o)}
          className="md:hidden text-sm text-gray-600 hover:text-gray-900 transition-colors"
        >
          {sidebarOpen ? "✕ Close" : "☰ Conversations"}
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0 relative">
        {/* Sidebar — always visible on desktop, toggled on mobile */}
        <div
          className={`
            ${sidebarOpen ? "flex flex-col w-full absolute inset-0 z-10" : "hidden"}
            md:flex md:relative md:w-64 md:inset-auto md:z-auto
          `}
        >
          <ConversationSidebar
            conversations={conversations}
            activeId={activeConversationId}
            onSelect={handleSelectConversation}
            onNew={handleNewConversation}
            onDelete={handleDeleteConversation}
            demoTitle={demoTitle}
            modelSetupHref={modelSetupHref}
            modelSetupLabel={modelSetupLabel}
          />
        </div>

        {/* Chat area — hidden on mobile when sidebar is open */}
        <div className={`flex-1 flex flex-col min-w-0 ${sidebarOpen ? "hidden md:flex" : "flex"}`}>
          <MessageList
            messages={messages}
            streamingContent={streamingContent}
            isThinking={isStreaming && !streamingContent}
          />
          <MessageInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            disabled={isStreaming}
          />
        </div>
      </div>
    </div>
  );
}
