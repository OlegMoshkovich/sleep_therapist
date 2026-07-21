"use client";

import React, { useEffect, useRef, useState } from "react";
import { Ic } from "../ra-icons";
import {
  CHAT_MODEL_OPTIONS,
  OPENAI_MODEL,
  type ChatModelId,
} from "../../../lib/openai-config";
import { VoiceReplyButton } from "./VoiceReplyButton";
import type { ActionChip } from "./types";

export function Composer({
  actionChips,
  value,
  setValue,
  onSend,
  inputRef,
  onExpertChat,
  onUpload,
  onMicToggle,
  isRecording,
  isTranscribing,
  autoSpeak,
  onToggleAutoSpeak,
  isSpeaking,
  onStopSpeaking,
  showThreadControls = false,
  onOpenThreadFullscreen,
  selectedModel = OPENAI_MODEL,
  onSelectModel,
  onOpenV2Modal,
}: {
  actionChips: ActionChip[];
  value: string;
  setValue: (v: string) => void;
  onSend: (t: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onExpertChat: () => void;
  onUpload: () => void;
  onMicToggle: () => void;
  isRecording: boolean;
  isTranscribing: boolean;
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
  isSpeaking: boolean;
  onStopSpeaking: () => void;
  showThreadControls?: boolean;
  onOpenThreadFullscreen?: () => void;
  selectedModel?: string;
  onSelectModel?: (model: ChatModelId) => void;
  onOpenV2Modal?: () => void;
}) {
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modelMenuOpen]);
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onSend(v);
  };
  const micTitle = isRecording
    ? "Stop recording"
    : isTranscribing
      ? "Transcribing…"
      : "Speak your message";
  const selectedModelLabel =
    CHAT_MODEL_OPTIONS.find((opt) => opt.id === selectedModel)?.label ?? selectedModel;
  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {actionChips.length > 0 && (
          <div className="action-chips">
            {actionChips.map((a) => {
              const I = Ic[a.icon as keyof typeof Ic];
              return (
                <button
                  key={a.label}
                  className="act-chip"
                  onClick={() => {
                    if (a.label === "Chat with the expert") {
                      onExpertChat();
                      return;
                    }
                    if (a.icon === "Upload" || a.label.startsWith("Upload")) {
                      onUpload();
                      return;
                    }
                    setValue(a.prefill ?? (a.label === "Create" ? "Help me create " : a.label + ": "));
                    inputRef.current?.focus();
                  }}
                >
                  <span className="ic"><I size={15} /></span>{a.label}
                </button>
              );
            })}
          </div>
        )}
        <div className="composer-stack">
        {showThreadControls && (
          <div className="composer-thread-controls">
            <div className="composer-thread-controls-desktop">
              <div className="composer-thread-controls-left">
                <button
                  type="button"
                  className="thread-collapse-all"
                  onClick={onOpenThreadFullscreen}
                  title="View conversation full screen from the first message"
                >
                  Fullscreen
                </button>
              </div>
              <div className="composer-thread-controls-right" ref={modelMenuRef}>
                <button
                  type="button"
                  className={"thread-collapse-all" + (modelMenuOpen ? " on" : "")}
                  onClick={() => setModelMenuOpen((v) => !v)}
                  title={`Chat model: ${selectedModelLabel}`}
                  aria-haspopup="menu"
                  aria-expanded={modelMenuOpen}
                >
                  Model
                </button>
                {modelMenuOpen && (
                  <div className="thread-model-menu" role="menu">
                    {CHAT_MODEL_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        role={opt.kind === "action" ? "menuitem" : "menuitemradio"}
                        aria-checked={opt.kind === "model" ? selectedModel === opt.id : undefined}
                        className={
                          "thread-model-option" +
                          (opt.kind === "model" && selectedModel === opt.id ? " selected" : "")
                        }
                        onClick={() => {
                          setModelMenuOpen(false);
                          if (opt.kind === "action") {
                            onOpenV2Modal?.();
                            return;
                          }
                          onSelectModel?.(opt.id);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        <div className="composer-row">
          <div className="composer">
            <input
              ref={inputRef}
              className="comp-input"
              placeholder={
                isRecording
                  ? "Listening… tap the mic to stop"
                  : isTranscribing
                    ? "Transcribing…"
                    : "Type a message or tap the mic to speak"
              }
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              disabled={isRecording || isTranscribing}
            />
            {!(isRecording || isTranscribing) && (
              <button
                className="comp-send"
                title="Send"
                aria-label="Send"
                disabled={!value.trim()}
                onClick={submit}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            )}
            {(isRecording || isTranscribing) && (
              <VoiceReplyButton
                className="comp-speaker"
                iconSize={16}
                autoSpeak={autoSpeak}
                onToggleAutoSpeak={onToggleAutoSpeak}
                isSpeaking={isSpeaking}
                onStopSpeaking={onStopSpeaking}
              />
            )}
            <button
              type="button"
              className="comp-mic"
              title={micTitle}
              aria-label={micTitle}
              aria-pressed={isRecording}
              disabled={isTranscribing}
              onClick={onMicToggle}
              style={
                isRecording
                  ? {
                      color: "#fff",
                      background: "#F05025",
                      opacity: 1,
                      animation: "voice-pulse 1.2s ease-in-out infinite",
                    }
                  : isTranscribing
                    ? { opacity: 0.55 }
                    : undefined
              }
            >
              {isTranscribing ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 1a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              )}
            </button>
          </div>
        </div>
        </div>
      </div>
      <style jsx>{`
        @keyframes voice-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(240, 80, 37, 0.55); }
          50% { box-shadow: 0 0 0 8px rgba(240, 80, 37, 0); }
        }
      `}</style>
    </div>
  );
}
