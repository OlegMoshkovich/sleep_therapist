"use client";

import { useState } from "react";
import { Ic } from "./ra-icons";

// Feedback attached to a single chat bubble. Maps to the learning pipeline's
// signals: rating (±1) is the numeric score (F3); a note typed as
// "text_correction" is F2; "correct_output" is the ideal answer (F1);
// "comment" is a plain note. A message can carry several of these at once —
// one FeedbackEntry per signal.
export type FeedbackSignal = "score" | "text_correction" | "correct_output" | "comment";

export interface FeedbackEntry {
  rating: 1 | -1 | null;
  signal: FeedbackSignal | null;
  comment: string;
}

// The three text-bearing signals, in display order.
const NOTE_TYPES: Array<{ key: FeedbackSignal; label: string }> = [
  { key: "comment", label: "Note" },
  { key: "text_correction", label: "Text correction" },
  { key: "correct_output", label: "Ideal output" },
];

function ratingOf(entries: FeedbackEntry[]): 1 | -1 | null {
  return entries.find((e) => e.signal === "score")?.rating ?? null;
}

function textOf(entries: FeedbackEntry[], signal: FeedbackSignal): string {
  return entries.find((e) => e.signal === signal)?.comment ?? "";
}

function summarize(entries: FeedbackEntry[]): string {
  const bits: string[] = [];
  const rating = ratingOf(entries);
  if (rating === 1) bits.push("👍");
  if (rating === -1) bits.push("👎");
  for (const t of NOTE_TYPES) {
    const c = textOf(entries, t.key).trim();
    if (c) bits.push(`${t.label}: ${c.slice(0, 40)}${c.length > 40 ? "…" : ""}`);
  }
  return bits.join("  ·  ") || "Feedback";
}

export function FeedbackControls({
  mode,
  entries,
  editing,
  align,
  onToggle,
  onSave,
  onRemove,
}: {
  mode: boolean;
  entries: FeedbackEntry[];
  editing: boolean;
  align: "left" | "right";
  onToggle: () => void;
  onSave: (entries: FeedbackEntry[]) => void;
  onRemove: () => void;
}) {
  if (!mode) return null;

  if (editing) {
    return (
      <FeedbackEditor
        align={align}
        initial={entries}
        hasExisting={entries.length > 0}
        onSave={onSave}
        onCancel={onToggle}
        onRemove={onRemove}
      />
    );
  }

  return (
    <div className={"fb-row " + align}>
      {entries.length > 0 ? (
        <button className="fb-chip" onClick={onToggle} title="Edit feedback">
          <Ic.Edit size={13} /> {summarize(entries)}
        </button>
      ) : (
        <button className="fb-add" onClick={onToggle} title="Leave feedback">
          <Ic.Plus size={14} />
        </button>
      )}
    </div>
  );
}

function FeedbackEditor({
  align,
  initial,
  hasExisting,
  onSave,
  onCancel,
  onRemove,
}: {
  align: "left" | "right";
  initial: FeedbackEntry[];
  hasExisting: boolean;
  onSave: (entries: FeedbackEntry[]) => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const [rating, setRating] = useState<1 | -1 | null>(ratingOf(initial));
  // Per-signal text, kept independently so switching tabs never loses a note.
  const [texts, setTexts] = useState<Record<FeedbackSignal, string>>({
    score: "",
    comment: textOf(initial, "comment"),
    text_correction: textOf(initial, "text_correction"),
    correct_output: textOf(initial, "correct_output"),
  });
  const [noteType, setNoteType] = useState<FeedbackSignal>("comment");

  const setText = (key: FeedbackSignal, v: string) =>
    setTexts((prev) => ({ ...prev, [key]: v }));

  const anyText = NOTE_TYPES.some((t) => texts[t.key].trim().length > 0);
  const canSave = rating !== null || anyText;

  function save() {
    const entries: FeedbackEntry[] = [];
    if (rating !== null) entries.push({ rating, signal: "score", comment: "" });
    for (const t of NOTE_TYPES) {
      const c = texts[t.key].trim();
      if (c) entries.push({ rating: null, signal: t.key, comment: c });
    }
    onSave(entries); // empty array → parent clears all feedback on this message
  }

  return (
    <div className={"fb-row " + align}>
      <div className="fb-editor">
        <div className="fb-thumbs">
          <button
            className={"fb-thumb up" + (rating === 1 ? " active" : "")}
            onClick={() => setRating((r) => (r === 1 ? null : 1))}
            title="Thumbs up"
          >
            <Ic.Wave size={15} /> 👍
          </button>
          <button
            className={"fb-thumb down" + (rating === -1 ? " active" : "")}
            onClick={() => setRating((r) => (r === -1 ? null : -1))}
            title="Thumbs down"
          >
            👎
          </button>
        </div>

        <div className="fb-types">
          {NOTE_TYPES.map((t) => (
            <button
              key={t.key}
              className={
                "fb-type" +
                (noteType === t.key ? " active" : "") +
                (texts[t.key].trim() ? " filled" : "")
              }
              onClick={() => setNoteType(t.key)}
              title={texts[t.key].trim() ? "Has content" : undefined}
            >
              {t.label}
              {texts[t.key].trim() ? " •" : ""}
            </button>
          ))}
        </div>

        <textarea
          className="fb-textarea"
          placeholder={
            noteType === "text_correction"
              ? "How should this have been worded?"
              : noteType === "correct_output"
                ? "What would the ideal response have been?"
                : "Leave a note…"
          }
          value={texts[noteType]}
          onChange={(e) => setText(noteType, e.target.value)}
          rows={3}
          autoFocus
        />

        <div className="fb-actions">
          {hasExisting && (
            <button className="fb-btn danger" onClick={onRemove}>
              Remove
            </button>
          )}
          <span className="fb-spacer" />
          <button className="fb-btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="fb-btn primary" onClick={save} disabled={!canSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
