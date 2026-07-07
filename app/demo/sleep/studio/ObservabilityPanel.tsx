"use client";

import { TraceView, type Turn } from "../../../components/trace/TraceView";

/**
 * Observability content for the Sleep Assistant — the step-by-step trace of each
 * turn (the same view used on the sandbox page, see
 * app/components/trace/TraceView.tsx).
 *
 * The Knowledge / State / Policy editors used to live here too; they now have
 * their own "Model Setup" tab (see ModelSetupPanel.tsx).
 *
 * It is rendered as one tab inside the shared RightDrawer; the drawer shell, tab
 * strip and close button live there. This component only renders the pane body.
 *
 * The Sleep chat endpoint (/api/chat/sleep/base) returns plain text, not the
 * sandbox's SSE trace, so the trace captured here is conversation-level: the
 * request the assistant received and the answer it produced, with timings.
 */
export function ObservabilityContent({
  turns,
  onClear,
}: {
  turns: Turn[];
  onClear: () => void;
}) {
  return (
    <div className="drawer-pane">
      <div className="drawer-subhead">
        <span className="obs-sub">Step-by-step trace of each turn</span>
        {turns.length > 0 && (
          <button type="button" onClick={onClear} className="obs-clear">
            Clear
          </button>
        )}
      </div>

      <div className="obs-body">
        <TraceView turns={turns} />
      </div>
    </div>
  );
}
