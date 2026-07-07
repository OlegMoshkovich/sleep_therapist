"use client";

import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface MessageListProps {
  messages: Message[];
  streamingContent?: string;
  isThinking?: boolean;
  roleLabels?: Partial<Record<Message["role"], string>>;
}

function stripStateBlock(content: string): string {
  return content.replace(/^\s*BEGIN STATE[\s\S]*?END STATE\s*/i, "").trim();
}

export default function MessageList({
  messages,
  streamingContent,
  isThinking,
  roleLabels,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent, isThinking]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-6 overscroll-contain">
      {messages.length === 0 && !streamingContent && (
        <p className="text-center text-gray-400 text-sm mt-16 font-serif">
          Start a conversation
        </p>
      )}
      {messages.map((msg) => {
        const displayContent =
          msg.role === "assistant" ? stripStateBlock(msg.content) : msg.content;

        return (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[75%] px-4 py-3 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-[#1E2938] text-[#E1DECF]"
                  : "bg-white border border-gray-200 text-gray-900"
              }`}
            >
              {roleLabels?.[msg.role] ? (
                <div
                  className={`mb-1.5 text-[10px] font-mono uppercase tracking-[0.16em] ${
                    msg.role === "user" ? "text-[#b8c1b8]" : "text-gray-500"
                  }`}
                >
                  {roleLabels[msg.role]}
                </div>
              ) : null}
              {msg.role === "assistant" ? (
                <div className="prose prose-sm max-w-none">
                  <ReactMarkdown>{displayContent}</ReactMarkdown>
                </div>
              ) : (
                <span className="whitespace-pre-wrap">{displayContent}</span>
              )}
            </div>
          </div>
        );
      })}
      {streamingContent && (
        <div className="flex justify-start">
          <div className="max-w-[75%] px-4 py-3 text-sm leading-relaxed bg-white border border-gray-200 text-gray-900">
            <div className="prose prose-sm max-w-none">
              <ReactMarkdown>{stripStateBlock(streamingContent)}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
      {isThinking && !streamingContent && (
        <div className="flex justify-start" aria-live="polite">
          <div className="px-4 py-3 text-sm leading-relaxed bg-white border border-gray-200 text-gray-500 flex items-center gap-2">
            <span className="font-serif italic">Model is thinking</span>
            <span className="flex items-center gap-1" aria-hidden="true">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" />
            </span>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
