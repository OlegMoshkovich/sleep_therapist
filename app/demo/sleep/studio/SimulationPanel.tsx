"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ic } from "./ra-icons";

type SimMsg = { role: "user" | "ai"; text: string };

/** A saved simulation conversation, shown in the panel's run history. */
export type SimRun = {
  id: string;
  title: string;
  updatedAt?: string;
  turnCount?: number;
  /** The patient scenario that drove the run (repopulated when the run is selected). */
  scenario?: string | null;
};

/** Split a simulation title into its parts. New runs are titled
 *  "Simulation · {n} turns · {scenario}"; legacy ones "Simulation · {scenario}". */
function parseRunTitle(title: string): { turns: string | null; scenario: string } {
  const parts = title.split(" · ");
  if (parts.length >= 3 && /\bturns?\b/i.test(parts[1])) {
    return { turns: parts[1], scenario: parts.slice(2).join(" · ").trim() || "Improvised patient" };
  }
  const rest = parts.slice(1).join(" · ").trim();
  return { turns: null, scenario: rest && rest !== "run" ? rest : "Improvised patient" };
}

/** Short relative time like "2h ago" / "3d ago" from an ISO timestamp. */
function relativeTime(iso?: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/**
 * The live run controls, lifted out of the panel body so the drawer tab bar can
 * render Pause/Stop next to its × while a run is in progress. `null` when idle.
 */
export type SimRunControls = {
  paused: boolean;
  pause: () => void;
  resume: () => void;
  stop: () => void;
};

export type SimulationController = {
  /** Clear the thread and arm the next send() to open a titled simulation conversation. */
  begin: (scenario: string, turns: number) => void;
  /**
   * Send one user message through the REAL sleep-therapist pipeline and resolve
   * with the assistant's reply. Drives the main chat window, the observability
   * trace and the policy-canvas animation — same path a hand-typed message takes.
   */
  send: (text: string) => Promise<string | undefined>;
  /** Rename the current simulation conversation (used to set a scenario-summary title). */
  renameCurrent?: (title: string) => void;
};

/**
 * Simulation tab: set up an automated run and watch a simulated patient talk to
 * the real sleep-therapist pipeline. Each turn is:
 *   /api/chat/sleep/simulate-user  → the patient's next message
 *   controller.send(message)       → the therapist's reply (your current setup)
 *
 * The conversation is driven through the main chat's send(), so it appears in the
 * regular chat window, is saved as a "Simulation · …" conversation, and its
 * traces show up in Observability while the policy canvas animates each turn.
 */
export function SimulationPanel({
  controller,
  onRunControls,
  runs = [],
  activeRunId,
  onSelectRun,
  onDeleteRun,
  slot,
}: {
  controller: SimulationController;
  /** Reports the live run controls while running (Pause/Stop live in the drawer tab bar); null when idle. */
  onRunControls?: (controls: SimRunControls | null) => void;
  /** Saved simulation conversations, most recent first. */
  runs?: SimRun[];
  /** The currently open conversation, highlighted if it's one of the runs. */
  activeRunId?: string | null;
  /** Open a past run's conversation in the main chat window. */
  onSelectRun?: (id: string) => void;
  /** Delete a past run. */
  onDeleteRun?: (id: string) => void;
  /**
   * Drawer pane to portal into. The panel is mounted at the page level so a live
   * run (and Pause/Stop) survives the drawer closing; UI only shows when this
   * slot exists.
   */
  slot?: HTMLElement | null;
}) {
  const [scenario, setScenario] = useState("");
  // Kept as a string so the field can be cleared while editing (e.g. wiping "110"
  // to type a new value). Normalized to a valid count on blur and when a run starts.
  const [turns, setTurns] = useState("4");
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  // The run whose scenario is shown in the info modal (null = closed).
  const [infoRun, setInfoRun] = useState<SimRun | null>(null);
  // How-to-use modal for the Simulation tab (same pattern as Observability).
  const [helpOpen, setHelpOpen] = useState(false);
  const abortRef = useRef(false);
  const pausedRef = useRef(false);

  useEffect(() => {
    if (!infoRun && !helpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (infoRun) setInfoRun(null);
      else setHelpOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [infoRun, helpOpen]);

  // Resolves once the run is un-paused (or aborted). Called between turns so the
  // trace for the turn that just finished stays put while you inspect it.
  const waitWhilePaused = async () => {
    while (pausedRef.current && !abortRef.current) {
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  const run = async () => {
    if (running) return;
    // Normalize the (possibly empty or in-progress) field to at least one turn.
    const turnCount = Math.max(1, Math.floor(Number(turns)) || 1);
    setTurns(String(turnCount));
    setRunning(true);
    setPaused(false);
    pausedRef.current = false;
    setError("");
    setStatus("Starting a simulation run…");
    abortRef.current = false;
    try {
      // Fresh, empty conversation. The first send() below creates the row,
      // titled as a simulation (scenario + turn count for the run history).
      controller.begin(scenario, turnCount);

      // Local mirror of the exchange, used only to prompt the simulated patient.
      const history: SimMsg[] = [];
      for (let t = 0; t < turnCount; t++) {
        if (abortRef.current) break;
        // Pause checkpoint between turns — the trace for the previous turn is
        // fully written by now, so this is the moment to freeze and look.
        await waitWhilePaused();
        if (abortRef.current) break;

        setStatus(`Turn ${t + 1}/${turnCount} · simulating the patient…`);
        const uRes = await fetch("/api/chat/sleep/simulate-user", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenario, history }),
        });
        if (!uRes.ok) {
          const j = await uRes.json().catch(() => ({}));
          throw new Error(j.error ?? "The simulated patient step failed.");
        }
        const { message: userMessage } = await uRes.json();
        if (abortRef.current) break;
        history.push({ role: "user", text: userMessage });

        setStatus(`Turn ${t + 1}/${turnCount} · sleep therapist replying…`);
        const reply = await controller.send(userMessage);
        history.push({ role: "ai", text: reply ?? "" });
      }
      setStatus(
        abortRef.current
          ? "Stopped."
          : "Simulation complete — see the conversation in the chat window and the traces in Observability."
      );

      // Give the run a descriptive title summarizing the patient scenario, so the
      // run list shows e.g. "45yo woman, 3am waking" instead of "Improvised patient".
      if (history.length > 0 && controller.renameCurrent) {
        try {
          const sRes = await fetch("/api/chat/sleep/summarize-scenario", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scenario, history }),
          });
          if (sRes.ok) {
            const { title } = (await sRes.json()) as { title?: string };
            if (title) controller.renameCurrent(`Simulation · ${turnCount} turns · ${title}`);
          }
        } catch {
          // Keep the placeholder title if summarization fails.
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed.");
      setStatus("");
    } finally {
      setRunning(false);
      setPaused(false);
      pausedRef.current = false;
    }
  };

  const pause = () => {
    pausedRef.current = true;
    setPaused(true);
    setStatus("Paused — inspect the traces in Observability, then Resume.");
  };

  const resume = () => {
    pausedRef.current = false;
    setPaused(false);
  };

  const stop = () => {
    abortRef.current = true;
    pausedRef.current = false;
    setPaused(false);
  };

  // Lift the live controls to the drawer tab bar while running, so Pause/Stop sit
  // next to the × up top. Report null when idle, and on unmount, so the tab bar
  // never keeps stale controls.
  useEffect(() => {
    onRunControls?.(running ? { paused, pause, resume, stop } : null);
  }, [running, paused, onRunControls]);
  useEffect(() => () => onRunControls?.(null), [onRunControls]);

  // Selecting a past run repopulates the Patient scenario with the scenario that
  // drove it (once per selection, and never mid-run so it can't clobber a live
  // run's setup). Runs from before scenarios were saved (null) leave it untouched.
  const populatedRunRef = useRef<string | null>(null);
  useEffect(() => {
    if (running) return;
    if (!activeRunId) { populatedRunRef.current = null; return; }
    if (populatedRunRef.current === activeRunId) return;
    const run = runs.find((r) => r.id === activeRunId);
    if (run && typeof run.scenario === "string") {
      setScenario(run.scenario);
      populatedRunRef.current = activeRunId;
    }
  }, [activeRunId, runs, running]);

  // Run state lives at the page level; docked chrome only when the drawer slot exists.
  if (!slot) return null;

  return createPortal(
    <div className="sim-panel">
      <div className="drawer-subhead">
        <span className="obs-sub">Run a simulated patient against your setup</span>
        <div className="drawer-subhead-actions">
          <button
            type="button"
            className="obs-info-btn"
            aria-label="How to use simulation"
            title="How to use simulation"
            onClick={() => setHelpOpen(true)}
          >
            <Ic.Info size={16} />
          </button>
        </div>
      </div>

      <div className="sim-setup">
        <label className="sim-label" htmlFor="sim-scenario">Patient scenario</label>
        <textarea
          id="sim-scenario"
          className="sim-textarea"
          placeholder="e.g. A 45-year-old woman with insomnia who wakes at 3am and can't fall back asleep; it started after a stressful job change. Leave blank to let the patient improvise."
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          disabled={running}
          rows={4}
        />
        <div className="sim-row">
          <label className="sim-label" htmlFor="sim-turns">Turns</label>
          <input
            id="sim-turns"
            className="sim-turns"
            type="text"
            inputMode="numeric"
            value={turns}
            // Accept only digits, and allow empty so the field can be cleared to retype.
            onChange={(e) => setTurns(e.target.value.replace(/[^0-9]/g, ""))}
            // Normalize to at least one turn once you leave the field.
            onBlur={() => setTurns((v) => String(Math.max(1, Math.floor(Number(v)) || 1)))}
            disabled={running}
          />
          {running ? (
            // Pause/Stop live in the drawer tab bar (next to ×) while running.
            <span className="sim-btn-lead sim-running-hint">
              {paused ? "Paused" : "Running…"}
            </span>
          ) : (
            <button type="button" className="sim-btn sim-btn-run sim-btn-lead" onClick={run}>Run simulation</button>
          )}
        </div>
        {status && <div className="sim-status">{status}</div>}
        {error && <div className="sim-error">{error}</div>}
      </div>

      <div className="sim-runs">
        <div className="sim-runs-head">
          Runs<span className="sim-runs-count">{runs.length}</span>
        </div>
        {runs.length === 0 ? (
          <div className="sim-runs-empty">No runs yet. Configure a scenario above and press Run.</div>
        ) : (
          <div className="sim-runs-list">
            {runs.map((r) => {
              const { turns: parsedTurns, scenario: scLabel } = parseRunTitle(r.title);
              // Prefer the actual number of turns the run produced (assistant
              // replies); fall back to the requested count parsed from the title.
              const turnsLabel =
                r.turnCount && r.turnCount > 0
                  ? `${r.turnCount} ${r.turnCount === 1 ? "turn" : "turns"}`
                  : parsedTurns;
              const when = relativeTime(r.updatedAt);
              return (
                <div
                  key={r.id}
                  className={"sim-run" + (r.id === activeRunId ? " active" : "")}
                  role="button"
                  tabIndex={0}
                  title="Open this run in the chat window"
                  onClick={() => onSelectRun?.(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectRun?.(r.id);
                    }
                  }}
                >
                  <div className="sim-run-body">
                    <div className="sim-run-scenario">{scLabel}</div>
                    <div className="sim-run-meta">
                      {turnsLabel && <span>{turnsLabel}</span>}
                      {turnsLabel && when && <span className="sim-run-dot">·</span>}
                      {when && <span>{when}</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="sim-run-info"
                    title="View this run's scenario"
                    aria-label="View this run's scenario"
                    onClick={(e) => {
                      e.stopPropagation();
                      setInfoRun(r);
                    }}
                  >
                    <Ic.Info size={15} />
                  </button>
                  {onDeleteRun && (
                    <button
                      type="button"
                      className="sim-run-del"
                      title="Delete this run"
                      aria-label="Delete this run"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteRun(r.id);
                      }}
                    >
                      <Ic.Trash size={15} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {helpOpen && <SimulationInfoModal onClose={() => setHelpOpen(false)} />}

      {infoRun && (
        <div className="sim-info-overlay" role="dialog" aria-modal="true" onClick={() => setInfoRun(null)}>
          <div className="sim-info" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="sim-info-close"
              aria-label="Close"
              title="Close"
              onClick={() => setInfoRun(null)}
            >
              <Ic.Close size={18} />
            </button>
            <div className="sim-info-eyebrow">Simulation run</div>
            <h3 className="sim-info-title">{parseRunTitle(infoRun.title).scenario}</h3>
            <div className="sim-info-meta">
              {[
                infoRun.turnCount && infoRun.turnCount > 0
                  ? `${infoRun.turnCount} ${infoRun.turnCount === 1 ? "turn" : "turns"}`
                  : parseRunTitle(infoRun.title).turns,
                relativeTime(infoRun.updatedAt),
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            <div className="sim-info-label">Patient scenario</div>
            <div className="sim-info-scenario">
              {typeof infoRun.scenario === "string"
                ? infoRun.scenario.trim() ||
                  "Improvised patient — no scenario was provided; the patient improvised."
                : "No scenario was saved for this run."}
            </div>
          </div>
        </div>
      )}
    </div>,
    slot
  );
}

/** How-to-use modal for the Simulation tab — same chrome as Observability’s info panel. */
function SimulationInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="obs-info-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="How to use simulation"
      onClick={onClose}
    >
      <div className="obs-info-card" onClick={(e) => e.stopPropagation()}>
        <div className="obs-info-head">
          <span className="obs-info-title">How to use simulation</span>
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
            Simulation runs a fake patient against your <b>real</b> sleep-therapist
            pipeline — the same path a hand-typed chat takes — so you can stress-test
            State, Policy, and prompts without typing every turn yourself.
          </p>

          <div className="obs-info-step">
            <div className="obs-info-step-n">1</div>
            <div>
              <div className="obs-info-step-t">Set the patient scenario</div>
              <p>
                Describe who the patient is and what they&apos;re dealing with
                (age, symptoms, recent events). Leave it blank to let the patient
                improvise from a generic sleeper profile.
              </p>
            </div>
          </div>

          <div className="obs-info-step">
            <div className="obs-info-step-n">2</div>
            <div>
              <div className="obs-info-step-t">Choose how many turns</div>
              <p>
                Each turn is one patient message plus one assistant reply. Start
                with a few turns to sanity-check the flow; raise the count when you
                want a longer conversation.
              </p>
            </div>
          </div>

          <div className="obs-info-step">
            <div className="obs-info-step-n">3</div>
            <div>
              <div className="obs-info-step-t">Run, pause, or stop</div>
              <p>
                Press <b>Run simulation</b>. While it&apos;s going, use{" "}
                <b>Pause</b> / <b>Stop</b> in the drawer tab bar (or the floating
                controls if the drawer is closed) to inspect a turn mid-run.
              </p>
            </div>
          </div>

          <div className="obs-info-h">What the run drives</div>
          <p>
            The run drives the real pipeline: the conversation appears in the main
            chat window and is saved as a run below, the step-by-step traces fill
            the <b>Observability</b> tab, and the policy canvas animates each turn.
            Switch to Observability or Model Setup while it runs to watch.
          </p>

          <p className="obs-info-note">
            Past runs stay in the <b>Runs</b> list. Click one to reopen it in chat;
            use its info icon to read the scenario that drove it.
          </p>
        </div>
      </div>
    </div>
  );
}
