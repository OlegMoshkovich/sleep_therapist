"use client";

import { useState } from "react";
import { TraceView, type Turn } from "../../../components/trace/TraceView";
import { Ic } from "./ra-icons";

/**
 * Observability content for the Financial Analyst — the step-by-step trace of each
 * turn (the same view used on the sandbox page, see
 * app/components/trace/TraceView.tsx).
 *
 * The Knowledge / State / Policy editors used to live here too; they now have
 * their own "Model Setup" tab (see ModelSetupPanel.tsx).
 *
 * It is rendered as one tab inside the shared RightDrawer; the drawer shell, tab
 * strip and close button live there. This component only renders the pane body.
 *
 * The Sleep chat endpoint (/api/chat/analyst/base) returns plain text, not the
 * sandbox's SSE trace, so the trace captured here is conversation-level: the
 * request the assistant received and the answer it produced, with timings.
 */
export function ObservabilityContent({
  turns,
  onClear,
  traceFocus,
}: {
  turns: Turn[];
  onClear: () => void;
  /** When bumped, expand + scroll to trace turn `id` (clicked from a bubble). */
  traceFocus?: { id: string; n: number };
}) {
  const [infoOpen, setInfoOpen] = useState(false);

  return (
    <div className="drawer-pane">
      <div className="drawer-subhead">
        <span className="obs-sub">Step-by-step trace of each turn</span>
        <div className="drawer-subhead-actions">
          {turns.length > 0 && (
            <button type="button" onClick={onClear} className="obs-clear">
              Clear
            </button>
          )}
          <button
            type="button"
            className="obs-info-btn"
            aria-label="How state & policy are compiled and sent to the model"
            title="How state & policy are compiled and sent to the model"
            onClick={() => setInfoOpen(true)}
          >
            <Ic.Info size={16} />
          </button>
        </div>
      </div>

      <div className="obs-body">
        <TraceView turns={turns} focus={traceFocus} />
      </div>

      {infoOpen && <CompilationInfoModal onClose={() => setInfoOpen(false)} />}
    </div>
  );
}

/**
 * Explains how the State and Policy canvases are compiled into prompts and sent
 * to the model each turn — the full prompt payload and the fixed order it is
 * assembled in. Purely informational. Opened from the trace header and from the
 * Model Setup nav (the "i" next to Knowledge / State / Policy).
 */
export function CompilationInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="obs-info-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="How state & policy are compiled"
      onClick={onClose}
    >
      <div className="obs-info-card" onClick={(e) => e.stopPropagation()}>
        <div className="obs-info-head">
          <span className="obs-info-title">How each turn reaches the model</span>
          <button
            type="button"
            className="obs-info-close"
            aria-label="Close"
            onClick={onClose}
          >
            <Ic.Close size={16} />
          </button>
        </div>

        <div className="obs-info-body">
          <p>
            Every turn runs in two stages. Each canvas you draw in{" "}
            <b>Model Setup</b> is <i>compiled</i> — its nodes and edges are turned
            into plain-prompt text — and that compiled text is what is actually
            sent to the model as the system prompt.
          </p>

          <div className="obs-info-step">
            <div className="obs-info-step-n">1</div>
            <div>
              <div className="obs-info-step-t">State canvas → updated state</div>
              <p>
                The <b>State canvas</b> compiles into a state-extraction prompt.
                The model is given the previously known state plus your latest
                message and returns an updated, structured state — the fields you
                see under <b>State variables</b> (age, gender, sleep_concern,
                turn_count, and the rest). Nothing here is shown to you as a
                reply; it only updates what the assistant knows.
              </p>
            </div>
          </div>

          <div className="obs-info-step">
            <div className="obs-info-step-n">2</div>
            <div>
              <div className="obs-info-step-t">Policy canvas → the reply</div>
              <p>
                The <b>Policy canvas</b> — the flowchart of{" "}
                <span className="obs-info-mono">IF</span> conditions and{" "}
                <span className="obs-info-mono">PROMPT</span> nodes — compiles into
                a single policy prompt. The model receives the freshly updated
                state plus the conversation history, walks the flowchart&apos;s
                conditions from the top, and produces the assistant&apos;s message
                for that turn.
              </p>
            </div>
          </div>

          <div className="obs-info-h">Order the information is sent in</div>
          <p>
            Within each of the two model calls above, the payload is assembled in
            a fixed order:
          </p>
          <ol className="obs-info-ol">
            <li>
              <b>System prompt</b> — the compiled canvas text: the assistant&apos;s
              role plus the extraction rules (stage&nbsp;1) or the flowchart
              instructions (stage&nbsp;2).
            </li>
            <li>
              <b>Conversation history</b> — the prior messages in this thread.
            </li>
            <li>
              <b>Current patient state (JSON)</b> — the structured state as it
              stands (the previous state in stage&nbsp;1, the freshly updated
              state in stage&nbsp;2).
            </li>
            <li>
              <b>Latest user message</b> plus a short execution instruction telling
              the model to return only the updated state (stage&nbsp;1) or only the
              assistant reply (stage&nbsp;2).
            </li>
          </ol>

          <div className="obs-info-h">Example</div>
          <p>
            You say: <span className="obs-info-quote">&ldquo;I can&apos;t fall
            asleep until 2&nbsp;a.m.&rdquo;</span>
          </p>
          <div className="obs-info-example">
            <div>
              <b>Stage 1 — State.</b> System = extraction rules · state ={" "}
              <span className="obs-info-mono">{"{}"}</span> · message = &ldquo;I
              can&apos;t fall asleep until 2&nbsp;a.m.&rdquo; → model returns{" "}
              <span className="obs-info-mono">
                {'{ sleep_concern: "sleep-onset difficulty", complaint_history: "Can\'t fall asleep until 2am", turn_count: 1 }'}
              </span>
            </div>
            <div>
              <b>Stage 2 — Policy.</b> System = compiled flowchart · history = the
              turn so far · state = the JSON just produced → the flowchart checks{" "}
              <span className="obs-info-mono">Emergency?</span> (no) →{" "}
              <span className="obs-info-mono">full history captured?</span> (no) →
              reaches the{" "}
              <span className="obs-info-mono">PROMPT</span> node &ldquo;Capture the
              presenting complaint&rdquo; → the assistant replies: &ldquo;How long
              has falling asleep been taking this late?&rdquo;
            </div>
          </div>

          <p className="obs-info-note">
            The compilation is deterministic: the same nodes always produce the
            same prompt. To see the exact text a canvas sends, open it and switch
            the Inspector to the <b>Compiler</b> tab. The trace below then shows,
            per turn, the request the model received and the answer it produced.
          </p>
        </div>
      </div>
    </div>
  );
}
