"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ic } from "../ra-icons";
import { FeedbackMenuEditor, type FeedbackEntry } from "../FeedbackControls";
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
  feedbackEditing = false,
  onSubmitFeedback,
  onSubmitFeedbackAt,
  onRemoveFeedback,
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
  /** True while the per-bubble feedback dropdown is open. */
  feedbackEditing?: boolean;
  onSubmitFeedback?: (entries: FeedbackEntry[]) => void;
  onSubmitFeedbackAt?: (index: number, entries: FeedbackEntry[]) => void;
  onRemoveFeedback?: () => void;
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
  // When global chrome is hidden, avatar click reveals nav/footer for THIS bubble only.
  const [revealControls, setRevealControls] = useState(false);
  /** Which Feedback control the open menu is anchored to (nav = top, foot = bottom). */
  const [feedbackAnchor, setFeedbackAnchor] = useState<"nav" | "foot">("nav");
  // Mobile: feedback opens as a centered modal instead of a bubble-anchored popover.
  const [isMobile, setIsMobile] = useState(false);
  // Bubble width (px); drag left or right edge — no visible handle.
  const [widthPx, setWidthPx] = useState<number | null>(null);
  // Left offset within thread-inner while custom-sized (keeps the opposite edge stable).
  const [leftPx, setLeftPx] = useState<number | null>(null);
  /** Hover/drag on either edge lights up both sides. */
  const [edgeHot, setEdgeHot] = useState(false);
  const edgeDraggingRef = useRef(false);
  /** Natural/default width to magnet-snap back to while dragging. */
  const defaultWidthRef = useRef<number | null>(null);
  /** For AI rows: distance from msg-ai left → bubble left (avatar + gap). */
  const aiChromeRef = useRef(41);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const fbNavRef = useRef<HTMLDivElement>(null);
  const fbFootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setRevealControls(false);
  }, [hideControls]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 900px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!feedbackEditing || isMobile) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (fbNavRef.current?.contains(t) || fbFootRef.current?.contains(t)) return;
      onOpenFeedback?.();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [feedbackEditing, onOpenFeedback, isMobile]);
  useEffect(() => {
    if (!feedbackEditing) setFeedbackAnchor("nav");
  }, [feedbackEditing]);
  useEffect(() => {
    if (!feedbackEditing || !isMobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenFeedback?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [feedbackEditing, isMobile, onOpenFeedback]);
  const controlsVisible = !hideControls || revealControls || feedbackEditing;
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
  // Turn number + Policy/Observability/State/Feedback in the top nav; Feedback also in the footer.
  const showNavActions = showPolicy || showTrace || showStateBtn || showFeedback;
  const showTurnN = turnNumber != null;
  const showNav = showNavActions || showCollapse || showFullscreen || showTurnN || showCopy;
  const showFootActions = showFeedback;

  const openFeedback = (anchor: "nav" | "foot") => (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (feedbackEditing && feedbackAnchor === anchor) {
      onOpenFeedback?.();
      return;
    }
    setFeedbackAnchor(anchor);
    if (!feedbackEditing) onOpenFeedback?.();
  };

  const feedbackEditor =
    showFeedback && feedbackEditing && onSubmitFeedback ? (
      <FeedbackMenuEditor
        entries={feedbackEntries ?? []}
        onSave={(entries) => onSubmitFeedback(entries)}
        onCancel={() => onOpenFeedback?.()}
        onRemove={() => onRemoveFeedback?.()}
      />
    ) : null;

  const feedbackPopover =
    !isMobile && feedbackEditor ? (
      <div
        className={"bubble-fb-menu" + (feedbackAnchor === "foot" ? " bubble-fb-menu--foot" : "")}
        role="dialog"
        aria-label="Feedback"
        onClick={(e) => e.stopPropagation()}
      >
        {feedbackEditor}
      </div>
    ) : null;

  // Portal into .ra-scope so theme tokens + .fb-* styles still apply.
  const feedbackModalHost =
    typeof document !== "undefined"
      ? document.querySelector(".ra-scope") ?? document.body
      : null;
  const feedbackModal =
    isMobile && feedbackEditor && feedbackModalHost
      ? createPortal(
          <div
            className="bubble-fb-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Feedback"
            onClick={() => onOpenFeedback?.()}
          >
            <div className="bubble-fb-modal" onClick={(e) => e.stopPropagation()}>
              {feedbackEditor}
            </div>
          </div>,
          feedbackModalHost
        )
      : null;

  const navFeedback = showFeedback ? (
    <div className="bubble-fb-wrap" ref={fbNavRef}>
      <button
        type="button"
        className={
          "trace-act" +
          (feedbackEditing && feedbackAnchor === "nav" ? " on" : "") +
          (hasFeedback ? " has-feedback" : "")
        }
        data-tip={feedbackEditing && feedbackAnchor === "nav" ? undefined : "Feedback"}
        aria-label="Feedback"
        aria-expanded={feedbackEditing && feedbackAnchor === "nav"}
        aria-haspopup="dialog"
        onClick={openFeedback("nav")}
      >
        <Ic.Edit size={14} />
      </button>
      {feedbackAnchor === "nav" ? feedbackPopover : null}
    </div>
  ) : null;

  const footFeedback = showFeedback ? (
    <div className="bubble-fb-wrap bubble-fb-wrap--foot" ref={fbFootRef}>
      <button
        type="button"
        className={
          "trace-act" +
          (feedbackEditing && feedbackAnchor === "foot" ? " on" : "") +
          (hasFeedback ? " has-feedback" : "")
        }
        data-tip={feedbackEditing && feedbackAnchor === "foot" ? undefined : "Feedback"}
        aria-label="Feedback"
        aria-expanded={feedbackEditing && feedbackAnchor === "foot"}
        aria-haspopup="dialog"
        onClick={openFeedback("foot")}
      >
        <Ic.Edit size={14} />
      </button>
      {feedbackAnchor === "foot" ? feedbackPopover : null}
    </div>
  ) : null;

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
      {showFeedback && (showPolicy || showTrace || showStateBtn) ? (
        <span className="trace-act-div" aria-hidden="true">
          |
        </span>
      ) : null}
      {navFeedback}
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
        {footFeedback}
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

  // Body click only expands/collapses — never reveals per-bubble controls.
  const bodyToggleProps = onToggleCollapse
    ? {
        role: "button" as const,
        tabIndex: 0,
        title: collapsed ? "Click to expand" : "Click to collapse",
        onClick: () => {
          const sel = typeof window !== "undefined" ? window.getSelection() : null;
          if (sel && !sel.isCollapsed && (sel.toString() || "").length > 0) return;
          if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
          onToggleCollapse();
        },
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleCollapse();
          }
        },
      }
    : {};

  // When global chrome is hidden, avatar click reveals/hides this bubble's controls.
  const avatarToggleProps = hideControls
    ? {
        type: "button" as const,
        className: "bubble-avatar-toggle" + (revealControls ? " on" : ""),
        title: revealControls ? "Hide controls" : "Show controls",
        "aria-label": revealControls ? "Hide message controls" : "Show message controls",
        "aria-pressed": revealControls,
        onClick: () => setRevealControls((v) => !v),
      }
    : null;

  const shellClass =
    (isUser ? "msg-user" : "bubble") +
    (hasFeedback ? " has-feedback" : "") +
    (collapsed ? " is-collapsed" : "");

  const onWidthDrag = (edge: "left" | "right") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = bubbleRef.current;
    if (!el) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const startRect = el.getBoundingClientRect();
    const startW = startRect.width;
    const main = el.closest(".main") as HTMLElement | null;
    const thread = el.closest(".thread") as HTMLElement | null;
    const inner = el.closest(".thread-inner") as HTMLElement | null;
    const boundsEl = main ?? thread;
    const br = boundsEl?.getBoundingClientRect();
    const padL =
      boundsEl === thread && thread
        ? parseFloat(getComputedStyle(thread).paddingLeft) || 0
        : 12;
    const padR =
      boundsEl === thread && thread
        ? parseFloat(getComputedStyle(thread).paddingRight) || 0
        : 12;
    const minLeft = br ? br.left + padL : 0;
    const maxRight = br ? br.right - padR : window.innerWidth - 12;
    // Anchor coords in thread-inner space (fallback: viewport).
    const originLeft = inner?.getBoundingClientRect().left ?? 0;
    const startLeft = leftPx ?? Math.round(startRect.left - originLeft);
    if (leftPx == null) setLeftPx(startLeft);

    if (widthPx == null || defaultWidthRef.current == null) {
      defaultWidthRef.current = startW;
    }
    let correctW = defaultWidthRef.current;
    if (!isUser) {
      const msgAi = el.closest(".msg-ai");
      if (msgAi) {
        aiChromeRef.current = Math.max(
          0,
          Math.round(startRect.left - msgAi.getBoundingClientRect().left)
        );
      }
      if (inner) {
        const chrome = aiChromeRef.current;
        correctW = Math.max(180, Math.floor(inner.clientWidth - chrome));
        if (widthPx == null) defaultWidthRef.current = correctW;
      }
    }
    const SNAP = 18;
    const minW = 180;
    const maxW = Math.max(minW, Math.floor(maxRight - minLeft));
    const startCenter = startRect.left + startW / 2;
    let lastW = startW;
    edgeDraggingRef.current = true;
    setEdgeHot(true);
    document.body.classList.add("ra-resizing");
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      // Either edge: grow/shrink equally from the center.
      const growth = edge === "right" ? dx : -dx;
      let nextW = Math.round(Math.max(minW, Math.min(maxW, startW + 2 * growth)));
      if (Math.abs(nextW - correctW) <= SNAP) nextW = correctW;
      let nextLeftAbs = startCenter - nextW / 2;
      nextLeftAbs = Math.max(minLeft, Math.min(maxRight - nextW, nextLeftAbs));
      const nextLeft = Math.round(nextLeftAbs - originLeft);
      lastW = nextW;
      setWidthPx(nextW);
      setLeftPx(nextLeft);
    };
    const onUp = () => {
      edgeDraggingRef.current = false;
      setEdgeHot(false);
      document.body.classList.remove("ra-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (Math.abs(lastW - correctW) <= SNAP) {
        setWidthPx(null);
        setLeftPx(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const edgeHit = (edge: "left" | "right") => (
    <div
      aria-hidden
      className={"bubble-edge-resize bubble-edge-resize--" + edge}
      onPointerDown={onWidthDrag(edge)}
      onPointerEnter={() => setEdgeHot(true)}
      onPointerLeave={() => {
        if (!edgeDraggingRef.current) setEdgeHot(false);
      }}
    />
  );

  const widthStyle =
    widthPx != null
      ? { width: widthPx, maxWidth: "none", flex: "0 0 auto" as const }
      : null;

  const shell = (
    <div
      ref={bubbleRef}
      className={
        shellClass +
        (!controlsVisible ? " hide-controls" : "") +
        (edgeHot ? " is-edge-hot" : "")
      }
      style={{
        position: "relative",
        ...widthStyle,
      }}
    >
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
        className={"bubble-body" + (onToggleCollapse ? " is-toggleable" : "")}
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
      {edgeHit("left")}
      {edgeHit("right")}
    </div>
  );

  const isWidthExpanded = widthPx != null;
  const resetBubbleWidth = () => {
    setWidthPx(null);
    setLeftPx(null);
  };
  // Absolutely positioned on the right so showing/hiding never shifts the bubble.
  const resetWidthBtn = isWidthExpanded ? (
    <button
      type="button"
      aria-label="Reset bubble width"
      title="Reset width"
      onClick={resetBubbleWidth}
      style={{
        position: "absolute",
        top: 2,
        left: "100%",
        marginLeft: 8,
        width: 28,
        height: 28,
        borderRadius: "50%",
        border: "1px solid var(--line)",
        background: "var(--surface)",
        color: "var(--text-2)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "pointer",
        lineHeight: 0,
        zIndex: 4,
      }}
    >
      <Ic.Minimize size={13} stroke={1.7} />
    </button>
  ) : null;

  // Attach reset control to the shell (already position:relative) without layout jump.
  const shellWithReset = (
    <>
      {shell}
      {resetWidthBtn}
    </>
  );

  if (isUser) {
    return (
      <div
        className="msg-user-col"
        style={
          isWidthExpanded
            ? {
                width: widthPx,
                maxWidth: "none",
                alignSelf: "flex-start",
                marginLeft: leftPx ?? undefined,
                boxSizing: "border-box",
                position: "relative",
                overflow: "visible",
              }
            : { position: "relative", overflow: "visible" }
        }
      >
        {shellWithReset}
        {overlay}
        {feedbackModal}
      </div>
    );
  }

  return (
    <div
      className="msg-ai"
      style={
        isWidthExpanded && leftPx != null
          ? {
              alignSelf: "flex-start",
              maxWidth: "none",
              width: "auto",
              overflow: "visible",
              // Position the row so the bubble's left edge matches leftPx.
              marginLeft: leftPx - aiChromeRef.current,
            }
          : undefined
      }
    >
      {avatarToggleProps ? (
        <button {...avatarToggleProps}>
          <AssistantMark variant="bubble" config={config} />
        </button>
      ) : (
        <AssistantMark variant="bubble" config={config} />
      )}
      <div
        className="bubble-col"
        style={
          isWidthExpanded
            ? {
                flex: "0 0 auto",
                width: widthPx,
                maxWidth: "none",
                overflow: "visible",
                position: "relative",
              }
            : { position: "relative", overflow: "visible" }
        }
      >
        {shellWithReset}
      </div>
      {overlay}
      {feedbackModal}
    </div>
  );
}
