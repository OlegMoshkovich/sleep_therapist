"use client";

import { useEffect, useState } from "react";
import { AssistantMark } from "./AssistantMark";
import type { StudioChatConfig } from "./types";

export function ThreadHeader({
  config,
  showThreadControls = false,
  hideBubbleControls = true,
  onToggleHideBubbleControls,
  allCollapsed = false,
  onToggleCollapseAll,
  avatarOnly = false,
  onToggleAvatarOnly,
  showFeedbackToggle = false,
  highlightFeedback = false,
  onToggleHighlightFeedback,
}: {
  config: Pick<
    StudioChatConfig,
    "productName" | "assistantMark" | "avatarMono" | "avatarSrc" | "emptyStateHref"
  >;
  showThreadControls?: boolean;
  hideBubbleControls?: boolean;
  onToggleHideBubbleControls?: () => void;
  allCollapsed?: boolean;
  onToggleCollapseAll?: () => void;
  avatarOnly?: boolean;
  onToggleAvatarOnly?: () => void;
  /** Only when this conversation has at least one feedback entry. */
  showFeedbackToggle?: boolean;
  highlightFeedback?: boolean;
  onToggleHighlightFeedback?: () => void;
}) {
  // On mobile, Feedback is a round button in MobileNav — keep it out of the pill.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 900px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return (
    <div className={"thread-head" + (avatarOnly ? " is-avatar-only" : "")}>
      <button
        type="button"
        className="th-avatar-toggle"
        onClick={() => onToggleAvatarOnly?.()}
        title={avatarOnly ? "Expand header" : "Collapse to avatar"}
        aria-label={avatarOnly ? "Expand header" : "Collapse to avatar"}
        aria-expanded={!avatarOnly}
      >
        <AssistantMark variant="th" config={config} />
      </button>
      {!avatarOnly && (
        <div className="th-meta">
          <div className="th-name">{config.productName}</div>
          {showThreadControls && (
            <div className="thread-head-controls">
              <button
                type="button"
                className={"thread-collapse-all" + (!hideBubbleControls ? " on" : "")}
                onClick={onToggleHideBubbleControls}
                aria-pressed={!hideBubbleControls}
                title={
                  hideBubbleControls
                    ? "Show bubble nav and footer"
                    : "Hide bubble nav and footer"
                }
              >
                Controls
              </button>
              <button
                type="button"
                className="thread-collapse-all"
                onClick={onToggleCollapseAll}
                title={allCollapsed ? "Expand every message" : "Collapse every message to one line"}
              >
                <span className="thread-pill-swap">
                  <span className={allCollapsed ? "is-active" : ""} aria-hidden={!allCollapsed}>
                    Expand all
                  </span>
                  <span className={!allCollapsed ? "is-active" : ""} aria-hidden={allCollapsed}>
                    Collapse all
                  </span>
                </span>
              </button>
            </div>
          )}
          {showFeedbackToggle && !isMobile ? (
            <button
              type="button"
              className={"thread-collapse-all thread-feedback-toggle" + (highlightFeedback ? " on" : "")}
              onClick={onToggleHighlightFeedback}
              aria-pressed={highlightFeedback}
              title={
                highlightFeedback
                  ? "Hide feedback highlight on bubbles"
                  : "Highlight bubbles that have feedback"
              }
            >
              Feedback
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
