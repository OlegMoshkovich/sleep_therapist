"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ic } from "../ra-icons";
import type { FeedbackEntry, FeedbackSignal } from "../FeedbackControls";
import { BubbleMarkdown } from "./BubbleMarkdown";
import { VoiceFeedbackButton } from "./VoiceFeedbackButton";
import type { Message } from "./types";

const SWIPE_MIN_DX = 56;
const SWIPE_MAX_DY = 72;

const NOTE_TYPES: Array<{ key: Exclude<FeedbackSignal, "score">; label: string; placeholder: string }> = [
  { key: "comment", label: "Note", placeholder: "Leave a note…" },
  { key: "text_correction", label: "Text correction", placeholder: "How should this have been worded?" },
  { key: "correct_output", label: "Ideal output", placeholder: "What would the ideal response have been?" },
];

function textOf(entries: FeedbackEntry[], signal: FeedbackSignal): string {
  return entries.find((e) => e.signal === signal)?.comment ?? "";
}

function ratingOf(entries: FeedbackEntry[]): 1 | -1 | null {
  return entries.find((e) => e.signal === "score")?.rating ?? null;
}

/**
 * Fullscreen overlay for a reply — mirrors the canvas full mode. Footer exposes
 * every feedback signal (thumbs, note, text correction, ideal) as icon actions.
 */
export function BubbleFullscreen({
  productName,
  messages,
  startIndex,
  feedbackMode,
  feedbackByIdx,
  onSubmitFeedbackAt,
  onClose,
}: {
  productName: string;
  messages: Message[];
  startIndex: number;
  feedbackMode?: boolean;
  feedbackByIdx?: Record<number, FeedbackEntry[]>;
  onSubmitFeedbackAt?: (index: number, entries: FeedbackEntry[]) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(0, startIndex), Math.max(0, messages.length - 1))
  );
  const m = messages[index] ?? messages[0];
  const text = m?.text ?? "";
  const initialEntries = feedbackByIdx?.[index] ?? [];
  const canFeedback = !!onSubmitFeedbackAt;
  const existingRating = ratingOf(initialEntries);
  const existingIdeal = textOf(initialEntries, "correct_output");
  const existingNote = textOf(initialEntries, "comment");
  const existingCorrection = textOf(initialEntries, "text_correction");

  const [editing, setEditing] = useState(!!feedbackMode && canFeedback);
  const [noteType, setNoteType] = useState<Exclude<FeedbackSignal, "score">>(() => {
    if (existingIdeal.trim()) return "correct_output";
    if (existingCorrection.trim()) return "text_correction";
    return "comment";
  });
  const [draft, setDraft] = useState(existingIdeal || text);
  const [texts, setTexts] = useState({
    comment: existingNote,
    text_correction: existingCorrection,
    correct_output: existingIdeal || (feedbackMode ? text : ""),
  });
  const [rating, setRating] = useState<1 | -1 | null>(existingRating);
  const [saved, setSaved] = useState(false);

  const turnMeta = useMemo(() => {
    const turnIds: string[] = [];
    const turnOfIndex: number[] = [];
    const seen = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      const tid = messages[i].turnId;
      if (tid) {
        let n = seen.get(tid);
        if (n == null) {
          n = turnIds.length + 1;
          seen.set(tid, n);
          turnIds.push(tid);
        }
        turnOfIndex[i] = n;
      } else {
        const n = turnIds.length + 1;
        turnIds.push(`__orphan_${i}`);
        turnOfIndex[i] = n;
      }
    }
    return { turnTotal: turnIds.length, turnOfIndex };
  }, [messages]);

  const turnPos = turnMeta.turnOfIndex[index] ?? (messages.length === 0 ? 0 : 1);
  const turnTotal = turnMeta.turnTotal;
  const canPrev = index > 0;
  const canNext = index < messages.length - 1;
  const goPrev = () => setIndex((i) => Math.max(0, i - 1));
  const goNext = () => setIndex((i) => Math.min(messages.length - 1, i + 1));
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const onSwipeStart = (e: React.TouchEvent) => {
    if (editing) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, textarea, input, [role='button']")) return;
    swipeStart.current = { x: t.clientX, y: t.clientY };
  };

  const onSwipeEnd = (e: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || editing) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_DX || Math.abs(dy) > SWIPE_MAX_DY) return;
    if (Math.abs(dx) <= Math.abs(dy)) return;
    if (dx < 0) goNext();
    else goPrev();
  };

  const syncFromEntries = (entries: FeedbackEntry[], body: string, forceEdit: boolean) => {
    const ideal = textOf(entries, "correct_output");
    const note = textOf(entries, "comment");
    const correction = textOf(entries, "text_correction");
    const score = ratingOf(entries);
    setEditing(forceEdit);
    setRating(score);
    setTexts({
      comment: note,
      text_correction: correction,
      correct_output: ideal || (forceEdit ? body : ""),
    });
    setDraft(ideal || body);
    setNoteType(
      ideal.trim() ? "correct_output" : correction.trim() ? "text_correction" : "comment"
    );
    setSaved(false);
  };

  // Reset editor state when cycling to another message.
  useEffect(() => {
    const entries = feedbackByIdx?.[index] ?? [];
    const body = messages[index]?.text ?? "";
    syncFromEntries(entries, body, !!feedbackMode && canFeedback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, feedbackMode, canFeedback, feedbackByIdx, messages]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, messages.length]);

  const buildEntries = (
    nextRating: 1 | -1 | null,
    nextTexts: { comment: string; text_correction: string; correct_output: string }
  ): FeedbackEntry[] => {
    const entries: FeedbackEntry[] = [];
    if (nextRating !== null) entries.push({ rating: nextRating, signal: "score", comment: "" });
    for (const t of NOTE_TYPES) {
      const c = nextTexts[t.key].trim();
      if (c) entries.push({ rating: null, signal: t.key, comment: c });
    }
    return entries;
  };

  const persist = (entries: FeedbackEntry[]) => {
    onSubmitFeedbackAt?.(index, entries);
  };

  const toggleRating = (value: 1 | -1) => {
    const next = rating === value ? null : value;
    setRating(next);
    persist(
      buildEntries(next, {
        comment: existingNote,
        text_correction: existingCorrection,
        correct_output: existingIdeal,
      })
    );
  };

  const openEditor = (type: Exclude<FeedbackSignal, "score">) => {
    setNoteType(type);
    setTexts({
      comment: existingNote,
      text_correction: existingCorrection,
      correct_output:
        existingIdeal || (type === "correct_output" ? text : existingIdeal),
    });
    setDraft(existingIdeal || text);
    setRating(existingRating);
    setEditing(true);
  };

  const submit = () => {
    if (!onSubmitFeedbackAt) return;
    const nextTexts = { ...texts };
    // Keep the legacy draft field in sync when editing ideal from the body textarea.
    if (noteType === "correct_output" && editing) {
      nextTexts.correct_output = draft;
    }
    const entries = buildEntries(rating, nextTexts);
    persist(entries);
    setTexts(nextTexts);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
    setEditing(false);
  };

  const roleTitle = m?.role === "user" ? "You" : productName;

  const host =
    (typeof document !== "undefined" &&
      (document.querySelector(".ra-scope") as HTMLElement | null)) ||
    document.body;

  const nav = (
    <div className="bubble-fs-nav">
      <button
        type="button"
        className="bubble-fs-nav-btn"
        aria-label="Previous message"
        title="Previous message"
        disabled={!canPrev}
        onClick={goPrev}
      >
        <Ic.Chevron size={18} style={{ transform: "rotate(90deg)" }} />
      </button>
      <span className="bubble-fs-nav-count" aria-live="polite">
        {turnTotal === 0 ? "0 / 0" : `${turnPos} / ${turnTotal}`}
      </span>
      <button
        type="button"
        className="bubble-fs-nav-btn"
        aria-label="Next message"
        title="Next message"
        disabled={!canNext}
        onClick={goNext}
      >
        <Ic.Chevron size={18} style={{ transform: "rotate(-90deg)" }} />
      </button>
    </div>
  );

  const activePlaceholder =
    NOTE_TYPES.find((t) => t.key === noteType)?.placeholder ?? "Leave a note…";

  return createPortal(
    <div className="bubble-fs-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="bubble-fs"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onSwipeStart}
        onTouchEnd={onSwipeEnd}
      >
        <div className="bubble-fs-head">
          <div className="bubble-fs-head-left">
            <div className="bubble-fs-title-block">
              <div className="bubble-fs-title">{roleTitle}</div>
            </div>
            <div className="bubble-fs-nav-slot bubble-fs-nav-slot--head">{nav}</div>
          </div>
          <div className="bubble-fs-head-right">
            <button
              className="bubble-fs-close"
              type="button"
              aria-label="Exit full screen"
              title="Exit full screen"
              onClick={onClose}
            >
              <Ic.Close size={20} />
            </button>
          </div>
        </div>
        <div className="bubble-fs-body">
          {editing ? (
            <div className="bubble-fs-editor">
              <div className="bubble-fs-types">
                {NOTE_TYPES.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    className={
                      "bubble-fs-type" +
                      (noteType === t.key ? " active" : "") +
                      (texts[t.key].trim() ? " filled" : "")
                    }
                    onClick={() => {
                      if (noteType === "correct_output") {
                        setTexts((prev) => ({ ...prev, correct_output: draft }));
                      }
                      setNoteType(t.key);
                      if (t.key === "correct_output") {
                        setDraft(texts.correct_output || text);
                      }
                    }}
                  >
                    {t.label}
                    {texts[t.key].trim() ? " ·" : ""}
                  </button>
                ))}
              </div>
              <textarea
                className="bubble-fs-textarea"
                value={noteType === "correct_output" ? draft : texts[noteType]}
                onChange={(e) => {
                  const v = e.target.value;
                  if (noteType === "correct_output") {
                    setDraft(v);
                    setTexts((prev) => ({ ...prev, correct_output: v }));
                  } else {
                    setTexts((prev) => ({ ...prev, [noteType]: v }));
                  }
                }}
                placeholder={activePlaceholder}
                spellCheck
                autoFocus
              />
            </div>
          ) : m?.role === "user" ? (
            text
          ) : (
            <BubbleMarkdown>{text}</BubbleMarkdown>
          )}
        </div>
        <div className="bubble-fs-foot">
          {editing ? (
            <>
              <div className="bubble-fs-foot-left">
                <div className="bubble-fs-thumbs">
                  <button
                    type="button"
                    className={"bubble-fs-thumb" + (rating === 1 ? " active" : "")}
                    title="Thumbs up"
                    onClick={() => setRating((r) => (r === 1 ? null : 1))}
                  >
                    👍
                  </button>
                  <button
                    type="button"
                    className={"bubble-fs-thumb" + (rating === -1 ? " active" : "")}
                    title="Thumbs down"
                    onClick={() => setRating((r) => (r === -1 ? null : -1))}
                  >
                    👎
                  </button>
                </div>
                <span className="bubble-fs-hint">
                  {saved ? "Saved" : "Edit feedback, then save."}
                </span>
              </div>
              <div className="bubble-fs-foot-right">
                <button
                  type="button"
                  className="bubble-fs-cancel"
                  onClick={() => {
                    setEditing(false);
                    syncFromEntries(initialEntries, text, false);
                  }}
                >
                  Cancel
                </button>
                <button type="button" className="bubble-fs-submit" onClick={submit}>
                  {saved ? "Saved" : "Save"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="bubble-fs-foot-left bubble-fs-nav-slot bubble-fs-nav-slot--foot">{nav}</div>
              {canFeedback ? (
                <div className="bubble-fs-foot-right">
                  <button
                    type="button"
                    className={"bubble-fs-fb" + (existingRating === 1 ? " active" : "")}
                    title="Thumbs up"
                    aria-label="Thumbs up"
                    aria-pressed={existingRating === 1}
                    onClick={() => toggleRating(1)}
                  >
                    👍
                  </button>
                  <button
                    type="button"
                    className={"bubble-fs-fb" + (existingRating === -1 ? " active" : "")}
                    title="Thumbs down"
                    aria-label="Thumbs down"
                    aria-pressed={existingRating === -1}
                    onClick={() => toggleRating(-1)}
                  >
                    👎
                  </button>
                  <button
                    type="button"
                    className={"bubble-fs-fb" + (existingNote.trim() ? " filled" : "")}
                    title="Note"
                    aria-label="Note"
                    onClick={() => openEditor("comment")}
                  >
                    <Ic.Memo size={15} />
                  </button>
                  <button
                    type="button"
                    className={"bubble-fs-fb" + (existingCorrection.trim() ? " filled" : "")}
                    title="Text correction"
                    aria-label="Text correction"
                    onClick={() => openEditor("text_correction")}
                  >
                    <Ic.Edit size={15} />
                  </button>
                  <button
                    type="button"
                    className={"bubble-fs-fb" + (existingIdeal.trim() ? " filled" : "")}
                    title="Ideal output"
                    aria-label="Ideal output"
                    onClick={() => openEditor("correct_output")}
                  >
                    <Ic.Sparkle size={15} />
                  </button>
                  <VoiceFeedbackButton
                    existing={initialEntries}
                    onSubmit={(entries) => onSubmitFeedbackAt?.(index, entries)}
                  />
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>,
    host
  );
}
