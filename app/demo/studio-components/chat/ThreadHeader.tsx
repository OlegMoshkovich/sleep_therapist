"use client";

import { AssistantMark } from "./AssistantMark";
import type { StudioChatConfig } from "./types";

export function ThreadHeader({
  config,
  showThreadControls = false,
  hideBubbleControls = true,
  onToggleHideBubbleControls,
  allCollapsed = false,
  onToggleCollapseAll,
}: {
  config: Pick<StudioChatConfig, "productName" | "assistantMark" | "avatarMono" | "avatarSrc" | "emptyStateHref">;
  showThreadControls?: boolean;
  hideBubbleControls?: boolean;
  onToggleHideBubbleControls?: () => void;
  allCollapsed?: boolean;
  onToggleCollapseAll?: () => void;
}) {
  return (
    <div className="thread-head">
      <AssistantMark variant="th" config={config} />
      <div className="th-meta">
        <div className="th-name">{config.productName}</div>
      </div>
      {showThreadControls && (
        <div className="thread-head-controls">
          <button
            type="button"
            className={"thread-collapse-all" + (hideBubbleControls ? " on" : "")}
            onClick={onToggleHideBubbleControls}
            title={
              hideBubbleControls
                ? "Show bubble nav and footer"
                : "Hide bubble nav and footer"
            }
          >
            <span className="thread-pill-swap">
              <span className={hideBubbleControls ? "is-active" : ""} aria-hidden={!hideBubbleControls}>
                Show controls
              </span>
              <span className={!hideBubbleControls ? "is-active" : ""} aria-hidden={hideBubbleControls}>
                Hide controls
              </span>
            </span>
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
    </div>
  );
}
