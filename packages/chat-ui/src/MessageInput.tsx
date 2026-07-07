"use client";

import { useRef, useEffect, KeyboardEvent } from "react";

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
}

export default function MessageInput({
  value,
  onChange,
  onSend,
  disabled = false,
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [value]);

  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSend();
    }
  }

  return (
    <div className="flex items-end gap-2 border-t border-gray-300 p-4 bg-transparent">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder="Type a message…"
        rows={1}
        className="flex-1 resize-none bg-transparent border border-gray-400 px-3 py-2 text-base text-gray-900 placeholder-gray-500 outline-none focus:border-gray-900 rounded-none disabled:opacity-50"
      />
      <button
        onClick={onSend}
        disabled={disabled || !value.trim()}
        className="bg-[#1E2938] text-[#E1DECF] text-sm px-4 py-2 hover:bg-[#2d3d50] disabled:opacity-40 transition-colors shrink-0"
      >
        Send
      </button>
    </div>
  );
}
