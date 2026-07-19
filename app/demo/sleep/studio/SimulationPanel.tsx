"use client";

import React, { useEffect, useRef, useState } from "react";

type SimMsg = { role: "user" | "ai"; text: string };

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
  begin: (scenario: string) => void;
  /**
   * Send one user message through the REAL sleep-therapist pipeline and resolve
   * with the assistant's reply. Drives the main chat window, the observability
   * trace and the policy-canvas animation — same path a hand-typed message takes.
   */
  send: (text: string) => Promise<string | undefined>;
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
}: {
  controller: SimulationController;
  /** Reports the live run controls while running (Pause/Stop live in the drawer tab bar); null when idle. */
  onRunControls?: (controls: SimRunControls | null) => void;
}) {
  const [scenario, setScenario] = useState("");
  // Kept as a string so the field can be cleared while editing (e.g. wiping "110"
  // to type a new value). Normalized to a valid count on blur and when a run starts.
  const [turns, setTurns] = useState("4");
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const abortRef = useRef(false);
  const pausedRef = useRef(false);

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
      // titled as a simulation.
      controller.begin(scenario);

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

  return (
    <div className="sim-panel">
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

      <div className="sim-note">
        The run drives the real pipeline: the conversation appears in the main chat
        window and is saved as a “Simulation · …” chat, the step-by-step traces fill
        the Observability tab, and the policy canvas animates each turn. Switch to
        Observability or Model Setup while it runs to watch.
      </div>
    </div>
  );
}
