"use client";

import { useEffect, useState } from "react";
import { Ic } from "../ra-icons";
import type { FeedbackEntry } from "../FeedbackControls";
import { AssistantMark } from "./AssistantMark";
import { BubbleFullscreen } from "./BubbleFullscreen";
import {
  BubbleMarkdown,
  collapsedPlainPreview,
  looksLikeWorksheet,
  worksheetSectionCount,
} from "./BubbleMarkdown";
import { VoiceFeedbackButton } from "./VoiceFeedbackButton";
import type { Message, StudioChatConfig } from "./types";

export function Bubble({
  config,
  m,
  messageIndex = 0,
  messages: messagesProp,
  feedbackByIdx,
  onOpenTrace,
  onOpenPolicy,
  onOpenState,
  onOpenFeedback,
  hasState = false,
  feedbackMode = false,
  feedbackEntries,
  onSubmitFeedback,
  onSubmitFeedbackAt,
  collapsed = false,
  onToggleCollapse,
  hideControls = false,
  turnNumber,
}: {
  config: Pick<StudioChatConfig, "productName" | "assistantMark" | "avatarMono" | "avatarSrc" | "emptyStateHref">;
  m: Message;
  messageIndex?: number;
  messages?: Message[];
  feedbackByIdx?: Record<number, FeedbackEntry[]>;
  onOpenTrace?: (turnId: string) => void;
  onOpenPolicy?: (turnId: string) => void;
  onOpenState?: (turnId: string) => void;
  /** True when this turn extracted at least one piece of state (drives the State button). */
  hasState?: boolean;
  onOpenFeedback?: () => void;
  /** In feedback mode the fullscreen view becomes editable + submittable. */
  feedbackMode?: boolean;
  feedbackEntries?: FeedbackEntry[];
  onSubmitFeedback?: (entries: FeedbackEntry[]) => void;
  onSubmitFeedbackAt?: (index: number, entries: FeedbackEntry[]) => void;
  /** When true the bubble is tucked to a single line. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** When true, hide the bubble nav and footer chrome. */
  hideControls?: boolean;
  /** 1-based turn index shown in the bubble top nav. */
  turnNumber?: number;
}) {
  const messages = messagesProp ?? [m];
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  // When global chrome is hidden, a click can reveal nav/footer for THIS bubble only.
  const [revealControls, setRevealControls] = useState(false);
  useEffect(() => {
    setRevealControls(false);
  }, [hideControls]);
  const controlsVisible = !hideControls || revealControls;
  const isUser = m.role === "user";
  const turnId = m.turnId;
  // Tint the bubble once feedback has been left on this message.
  const hasFeedback = (feedbackEntries?.length ?? 0) > 0;
  // Observability/Policy are assistant-only (they inspect the model's work). State
  // + Feedback apply to both the patient and assistant bubble. Fullscreen is for
  // assistant replies (the long ones). All trace views need the turn (turnId).
  const showTrace = !isUser && !!turnId && !!onOpenTrace;
  const showPolicy = !isUser && !!turnId && !!onOpenPolicy;
  // State opens the fields extracted this turn (from the patient message).
  // Shown on both bubbles; on the assistant nav it sits after Policy trace.
  const showStateBtn = !!turnId && !!onOpenState && hasState;
  const showFeedback = !!onOpenFeedback;
  // Fullscreen is available on both patient and assistant bubbles.
  const showFullscreen = !!turnId;
  const showCollapse = !!onToggleCollapse;
  const showCopy = m.text.trim().length > 0;
  // Turn number + Policy/Observability/State in the top nav; Feedback stays in the footer.
  const showNavActions = showPolicy || showTrace || showStateBtn;
  const showTurnN = turnNumber != null;
  const showNav = showNavActions || showCollapse || showFullscreen || showTurnN || showCopy;
  const showFootActions = showFeedback;

  const navActions = showNavActions ? (
    <div className="trace-actions">
      {showPolicy && (
        <button type="button" className="trace-act" data-tip="Policy" aria-label="Policy" onClick={() => onOpenPolicy!(turnId!)}>
          <Ic.Sliders size={14} />
        </button>
      )}
      {showStateBtn && (
        <button type="button" className="trace-act" data-tip="State" aria-label="State" onClick={() => onOpenState!(turnId!)}>
          <Ic.List size={14} />
        </button>
      )}
      {showTrace && (
        <button type="button" className="trace-act" data-tip="Observability" aria-label="Observability" onClick={() => onOpenTrace!(turnId!)}>
          <Ic.Grid size={14} />
        </button>
      )}
    </div>
  ) : null;

  const footActions = showFootActions ? (
    <div className="bubble-foot-actions">
      <span />
      <div className="bubble-foot-feedback">
        <VoiceFeedbackButton
          existing={feedbackEntries ?? []}
          onSubmit={(entries) => onSubmitFeedback?.(entries)}
        />
        <button type="button" className="trace-act" data-tip="Feedback" aria-label="Feedback" onClick={() => onOpenFeedback!()}>
          <Ic.Edit size={14} />
        </button>
      </div>
    </div>
  ) : null;

  const collapseBtn = showCollapse ? (
    <button
      type="button"
      className="bubble-collapse"
      data-tip={collapsed ? "Expand" : "Collapse"}
      aria-label={collapsed ? "Expand message" : "Collapse message"}
      onClick={(e) => {
        e.stopPropagation();
        onToggleCollapse?.();
      }}
    >
      <Ic.Chevron size={14} style={collapsed ? undefined : { transform: "rotate(180deg)" }} />
    </button>
  ) : null;

  const fullscreenBtn = showFullscreen ? (
    <button
      type="button"
      className="trace-act bubble-fullscreen"
      data-tip="Fullscreen"
      aria-label="Fullscreen"
      onClick={(e) => {
        e.stopPropagation();
        setFullscreen(true);
      }}
    >
      <Ic.Expand size={14} />
    </button>
  ) : null;

  const copyBtn = showCopy ? (
    <button
      type="button"
      className="trace-act"
      data-tip={copied ? "Copied" : "Copy"}
      aria-label={copied ? "Copied" : "Copy message"}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(m.text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => {}
        );
      }}
    >
      <Ic.Copy size={14} />
    </button>
  ) : null;

  const overlay = fullscreen ? (
    <BubbleFullscreen
      productName={config.productName}
      messages={messages}
      startIndex={messageIndex}
      feedbackMode={feedbackMode}
      feedbackByIdx={feedbackByIdx}
      onSubmitFeedbackAt={onSubmitFeedbackAt ?? (onSubmitFeedback ? (_i, e) => onSubmitFeedback(e) : undefined)}
      onClose={() => setFullscreen(false)}
    />
  ) : null;

  // Body click: collapsed → expand + show controls; expanded → collapse + hide controls.
  const bodyToggleProps =
    onToggleCollapse || hideControls
      ? {
          role: "button" as const,
          tabIndex: 0,
          title: collapsed
            ? "Click to expand and show controls"
            : "Click to collapse",
          onClick: () => {
            const sel = typeof window !== "undefined" ? window.getSelection() : null;
            if (sel && !sel.isCollapsed && (sel.toString() || "").length > 0) return;
            if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
            if (collapsed) {
              onToggleCollapse?.();
              if (hideControls) setRevealControls(true);
              return;
            }
            onToggleCollapse?.();
            setRevealControls(false);
          },
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (collapsed) {
                onToggleCollapse?.();
                if (hideControls) setRevealControls(true);
                return;
              }
              onToggleCollapse?.();
              setRevealControls(false);
            }
          },
        }
      : {};

  const shellClass =
    (isUser ? "msg-user" : "bubble") +
    (hasFeedback ? " has-feedback" : "") +
    (collapsed ? " is-collapsed" : "");

  const shell = (
    <div className={shellClass + (!controlsVisible ? " hide-controls" : "")}>
      {controlsVisible && showNav && (
        <div className="bubble-nav">
          {showTurnN && !collapsed ? <span className="trace-turn-n">{turnNumber}.</span> : null}
          {navActions}
          <div className="bubble-nav-end">
            {copyBtn}
            {fullscreenBtn}
            {collapseBtn}
          </div>
        </div>
      )}
      <div
        className={
          "bubble-body" +
          (onToggleCollapse || hideControls ? " is-toggleable" : "")
        }
        {...bodyToggleProps}
      >
            {collapsed ? (
          <>
            {isUser && showTurnN ? (
              <span className="bubble-collapse-turn">{turnNumber}. </span>
            ) : null}
            {isUser ? (
              <span className="bubble-collapsed-preview">{collapsedPlainPreview(m.text)}</span>
            ) : looksLikeWorksheet(m.text) ? (
              <span className="bubble-form-collapsed">
                {(() => {
                  const n = worksheetSectionCount(m.text);
                  return n > 0 ? `Fill-in worksheet · ${n} sections` : "Fill-in worksheet";
                })()}
              </span>
            ) : (
              <span className="bubble-collapsed-preview">{collapsedPlainPreview(m.text)}</span>
            )}
          </>
        ) : isUser ? (
          m.text
        ) : (
          <BubbleMarkdown>{m.text}</BubbleMarkdown>
        )}
      </div>
      {controlsVisible && footActions && <div className="bubble-foot">{footActions}</div>}
    </div>
  );

  if (isUser) {
    return (
      <div className="msg-user-col">
        {shell}
        {overlay}
      </div>
    );
  }
  return (
    <div className="msg-ai">
      <AssistantMark variant="bubble" config={config} />
      <div className="bubble-col">
        {shell}
      </div>
      {overlay}
    </div>
  );
}
