"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import "./ra-theme.css";
import { Ic, type IconName } from "./ra-icons";
import { Avatar } from "./ra-shared";
import {
  ACTION_CHIPS,
  SUGGESTIONS,
} from "./sleep-data";
import { RightDrawer, DRAWER_LABEL, type DrawerId } from "./RightDrawer";
import { SetupBar, turnExtractedStateKeys } from "./config/page";
import { SimulationPanel, type SimRunControls } from "./SimulationPanel";
import { FeedbackControls, type FeedbackEntry, type FeedbackSignal } from "./FeedbackControls";
import type { Turn, TimedTraceEvent } from "../../../components/trace/TraceView";
import { AuthProvider, useAuth } from "../../../context/AuthContext";
import AuthModal from "../../../components/AuthModal";
import SiteLogo from "../../../components/SiteLogo";
import { useVoiceRecorder, useTTS } from "./useVoice";
import Canvas, { type CanvasDoc, type CanvasFireSignal } from "../../../components/canvas/Canvas";
import { WORKFLOW_CANVAS_NODE_KINDS } from "../../../components/canvas/node-kinds";
import {
  WORKFLOW_OVERVIEW_CANVAS_MARKER,
  WORKFLOW_OVERVIEW_CANVAS_NAME,
} from "@airlab/orchestration-core/general-orchestration";

// Simulation conversations are titled "Simulation · …"; this prefix separates
// them from hand-typed chats (they show in the Simulation panel, not the sidebar).
const SIM_TITLE_PREFIX = "Simulation · ";

const TTS_PREF_KEY = "sleep-studio-tts-autoplay";
/* v2: black & white is the default; old key auto-wrote "0" for greige. */
const MONO_PREF_KEY = "sleep-studio-mono-theme-v2";

/** Strip common markdown so the TTS voice reads clean sentences instead of asterisks and backticks. */
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*#+\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

interface Message {
  role: "user" | "ai";
  text: string;
  /** Observability turn this reply belongs to — lets you click the bubble to
   *  jump to its trace. Only set for replies produced this session. */
  turnId?: string;
}
interface Conversation {
  id: string;
  title: string;
  /** Last-activity timestamp (ISO); shown as relative time in the simulation run list. */
  updatedAt?: string;
  /** Actual number of turns (assistant replies) — shown in the simulation run list. */
  turnCount?: number;
  /** For simulation runs: the patient scenario that drove the run. */
  scenario?: string | null;
}

// The function panels shown as drawer tabs on desktop. Opening any one of them
// opens the whole set (see openDrawer) so all tabs are visible.
const PANEL_TABS: DrawerId[] = ["modelsetup", "observability", "simulation" /*, "expert", "upload" */];

// Panels that expose internal wiring (model/prompt setup, step-by-step traces).
// Only admins may see or open these; non-admins get the plain chat surface.
const ADMIN_ONLY_DRAWERS: DrawerId[] = ["modelsetup", "observability", "simulation"];

const ADMIN_ITEMS = [
  // { icon: "Grid", label: "Admin dashboard", href: "/demo/sleep/expert-dashboard" },
  // Model setup / Observability live in the right drawer — not duplicated here.
  { icon: "Shield", label: "User roles", href: "/admin/users" },
] as const;

// Copy for the bottom-left "How to use the studio" help panel. Each section maps to a
// real part of the studio an expert works with, so the guidance stays accurate.
const HELP_SECTIONS: Array<{ title: string; body: React.ReactNode }> = [
  {
    title: "Conversations",
    body:
      "Start a fresh chat with “New conversation.” Search, rename, or delete past ones in the list — each keeps its own memory of what was said.",
  },
  {
    title: "Chatting",
    body:
      "Type a message and press Enter. While the assistant works, the indicator shows what it’s doing in real time — “Reviewing what you told me” → “Checking for anything urgent” → “Writing a reply” — the actual steps the system runs that turn.",
  },
  {
    title: "What the assistant tracks",
    body:
      "Every turn it updates a structured profile (age, gender, sleep concern, and more) and uses what’s still missing to decide what to ask next before giving advice.",
  },
  {
    title: "Feedback mode",
    body:
      "Turn on Feedback from the account menu, then annotate any reply: give it a Score (±1), a Note, a Text correction, or the Ideal output. Each is saved on that message and feeds model improvement.",
  },
  {
    title: "Observability & trace",
    body:
      "Open Observability to inspect a turn step by step — every model round trip, how long each took, and the raw trace. Use it to see exactly what ran and where the time went.",
  },
  {
    title: "Model setup",
    body:
      "Open Model Setup to edit the state schema, prompts, and the policy canvas — the flowchart of conditions and replies that decides how the assistant behaves.",
  },
];

/* ---------------- sidebar ---------------- */
/**
 * Drag handle living on a drawer's inner edge to resize it. Rendered as an
 * absolutely-positioned child of `.body` (which is position:relative), so it's
 * decoupled from the drawer components themselves.
 *
 * `side="right"` → handle on a LEFT drawer's right edge (drag right = wider).
 * `side="left"`  → handle on a RIGHT drawer's left edge (drag left = wider).
 * Double-click resets to `def`.
 */
function ResizeHandle({
  side,
  width,
  setWidth,
  min,
  max,
  def,
}: {
  side: "left" | "right";
  width: number;
  setWidth: (w: number) => void;
  min: number;
  max: number;
  def: number;
}) {
  const [active, setActive] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setActive(true);
    document.body.classList.add("ra-resizing");
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const next = side === "right" ? startW + dx : startW - dx;
      setWidth(Math.round(Math.max(min, Math.min(max, next))));
    };
    const onUp = () => {
      setActive(false);
      document.body.classList.remove("ra-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const style: React.CSSProperties =
    side === "right" ? { left: width - 5 } : { right: width - 5 };

  return (
    <div
      className={"resize-handle" + (active ? " active" : "")}
      style={style}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(def)}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel (double-click to reset)"
    />
  );
}

/**
 * The conversation list (kebab menu → Rename / Delete), shared by the desktop
 * sidebar and the mobile chats drawer so both behave identically. Owns the
 * kebab-open, inline-rename, and multi-select state locally; a fixed overlay
 * closes the menu on any outside click (same pattern as the topbar demo menu).
 */
function ConvList({
  convos,
  activeId,
  query,
  onSelect,
  onDelete,
  onDeleteMany,
  onRename,
}: {
  convos: Conversation[];
  activeId: string | null;
  query: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDeleteMany: (ids: string[]) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [kebabId, setKebabId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const filtered = convos.filter((c) =>
    c.title.toLowerCase().includes(query.toLowerCase())
  );

  const startRename = (c: Conversation) => {
    setKebabId(null);
    setRenamingId(c.id);
    setDraft(c.title);
  };
  const commitRename = (id: string) => {
    const next = draft.trim();
    if (next) onRename(id, next);
    setRenamingId(null);
  };

  const exitSelecting = () => {
    setSelecting(false);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteSelected = () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const label =
      ids.length === 1
        ? "Delete this conversation?"
        : `Delete ${ids.length} conversations?`;
    if (!window.confirm(label)) return;
    onDeleteMany(ids);
    exitSelecting();
  };

  const selectedCount = selectedIds.size;

  return (
    <>
      <div className="recent-head">
        <span className="recent-label">
          <Ic.Clock size={13} /> Recent
          <span className="chev"><Ic.Chevron size={13} /></span>
        </span>
        {convos.length > 0 && (
          <div className="conv-select-bar">
            {selecting ? (
              <>
                <button
                  type="button"
                  className="conv-select-action danger"
                  onClick={deleteSelected}
                  disabled={selectedCount === 0}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="conv-select-action"
                  onClick={exitSelecting}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="conv-select-action"
                onClick={() => {
                  setKebabId(null);
                  setSelecting(true);
                }}
              >
                Select
              </button>
            )}
          </div>
        )}
      </div>
      {convos.length === 0 ? (
        <div className="conv-empty">
          <div className="ce-orb"><Ic.Chat size={18} /></div>
          <p>No conversations yet.<br />Start one below.</p>
        </div>
      ) : (
      <div className="conv-list">
        {kebabId && (
          <div
            onClick={() => setKebabId(null)}
            style={{ position: "fixed", inset: 0, zIndex: 20 }}
            aria-hidden="true"
          />
        )}
        {filtered.map((c) => {
          const isChecked = selectedIds.has(c.id);
          return (
            <div
              key={c.id}
              className={
                "conv-item" +
                (c.id === activeId && !selecting ? " active" : "") +
                (isChecked ? " selected" : "")
              }
              onClick={() => {
                if (renamingId === c.id) return;
                if (selecting) {
                  toggleSelected(c.id);
                  return;
                }
                onSelect(c.id);
              }}
            >
              {renamingId === c.id ? (
                <input
                  className="conv-rename"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(c.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={() => commitRename(c.id)}
                />
              ) : (
                <>
                  {selecting && (
                    <button
                      type="button"
                      className={"conv-check" + (isChecked ? " on" : "")}
                      aria-label={isChecked ? "Deselect conversation" : "Select conversation"}
                      aria-pressed={isChecked}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelected(c.id);
                      }}
                    >
                      {isChecked ? (
                        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                          <path
                            d="M3.5 8.2l2.8 2.8 6.2-6.4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : null}
                    </button>
                  )}
                  <span className="conv-title">{c.title}</span>
                  {!selecting && (
                    <button
                      className={"conv-kebab" + (kebabId === c.id ? " open" : "")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setKebabId((prev) => (prev === c.id ? null : c.id));
                      }}
                    >
                      <Ic.Dots size={16} />
                    </button>
                  )}
                  {!selecting && kebabId === c.id && (
                    <div className="conv-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                      <button className="pop-row" onClick={() => startRename(c)}>
                        <span className="ic"><Ic.Edit size={16} /></span>Rename
                      </button>
                      <button
                        className="pop-row danger"
                        onClick={() => {
                          setKebabId(null);
                          onDelete(c.id);
                        }}
                      >
                        <span className="ic"><Ic.Trash size={16} /></span>Delete
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="conv-empty"><p>No matches.</p></div>
        )}
      </div>
      )}
    </>
  );
}

function Sidebar({
  convos,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onDeleteMany,
  onRename,
  query,
  setQuery,
  menuOpen,
  setMenuOpen,
  infoOpen,
  setInfoOpen,
  onClose,
  onToggleFeedbackMode,
  feedbackMode,
  monoTheme,
  onToggleMono,
  userEmail,
  userImage,
  isAdmin,
  onSignOut,
  width,
}: {
  convos: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onDeleteMany: (ids: string[]) => void;
  onRename: (id: string, title: string) => void;
  query: string;
  setQuery: (v: string) => void;
  menuOpen: boolean;
  setMenuOpen: (fn: (o: boolean) => boolean) => void;
  infoOpen: boolean;
  setInfoOpen: (fn: (o: boolean) => boolean) => void;
  onClose: () => void;
  onToggleFeedbackMode: () => void;
  feedbackMode: boolean;
  monoTheme: boolean;
  onToggleMono: () => void;
  userEmail: string;
  userImage?: string;
  isAdmin: boolean;
  onSignOut: () => void;
  width: number;
}) {
  const router = useRouter();

  return (
    <aside
      className="sidebar"
      style={{ ["--side-w" as string]: `${width}px` } as React.CSSProperties}
    >
      <div className="side-head">
        <div>
          <div className="side-title">Sleep Assistant</div>
        </div>
        <button className="icon-btn side-close" title="Close sidebar" aria-label="Close sidebar" onClick={onClose}>
          <Ic.Close size={17} />
        </button>
      </div>

      <button className="newbtn" onClick={onNew}>
        <span className="nb-ic"><Ic.Plus size={17} /></span> New conversation
      </button>

      <div className="searchwrap">
        <span className="search-ic"><Ic.Search size={15} /></span>
        <input
          className="side-search"
          placeholder="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <ConvList
        convos={convos}
        activeId={activeId}
        query={query}
        onSelect={onSelect}
        onDelete={onDelete}
        onDeleteMany={onDeleteMany}
        onRename={onRename}
      />

      {/* account menu (admin popover) */}
      <div className="side-bottom">
        {infoOpen && (
          <div
            className="help-popover"
            role="dialog"
            aria-label="How to use the studio"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="help-head">
              <span className="help-title">
                <span className="ic"><Ic.Info size={15} /></span>How to use the studio
              </span>
              <button
                className="help-close"
                title="Close"
                aria-label="Close"
                onClick={() => setInfoOpen(() => false)}
              >
                <Ic.Close size={15} />
              </button>
            </div>
            <div className="help-body">
              <p className="help-intro">
                This studio is where you talk to the assistant and shape how it behaves.
                Here’s what each part does.
              </p>
              {HELP_SECTIONS.map((s) => (
                <div className="help-section" key={s.title}>
                  <div className="help-section-title">{s.title}</div>
                  <div className="help-section-body">{s.body}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {menuOpen && (
          <div className="popover" role="menu" onClick={(e) => e.stopPropagation()}>
            {isAdmin && (
              <>
                <div className="pop-label adm">
                  <Ic.Shield size={13} /> Admin
                </div>
                <div className="pop-adm">
                  {ADMIN_ITEMS.map((it) => {
                    const I = Ic[it.icon as keyof typeof Ic];
                    return (
                      <button
                        key={it.label}
                        className="pop-row"
                        onClick={() => { setMenuOpen(() => false); router.push(it.href); }}
                      >
                        <span className="ic"><I size={17} /></span>{it.label}
                      </button>
                    );
                  })}
                  <button
                    className="pop-row"
                    onClick={() => { setMenuOpen(() => false); onToggleFeedbackMode(); }}
                  >
                    <span className="ic"><Ic.Edit size={17} /></span>
                    Feedback{feedbackMode ? " ✓" : ""}
                  </button>
                </div>
                <div className="pop-div" />
              </>
            )}
            <div className="pop-label"><Ic.User size={13} /> Account</div>
            <button
              className="pop-row"
              onClick={() => { setMenuOpen(() => false); onToggleMono(); }}
            >
              <span className="ic"><Ic.Moon size={17} /></span>
              Black &amp; white{monoTheme ? " ✓" : ""}
            </button>
            <button
              className="pop-row danger"
              onClick={() => { setMenuOpen(() => false); onSignOut(); }}
            >
              <span className="ic"><Ic.SignOut size={17} /></span>Sign out
            </button>
          </div>
        )}
        <div className="side-bottom-row">
          <button
            className={"acct-chip" + (menuOpen ? " open" : "")}
            onClick={(e) => { e.stopPropagation(); setInfoOpen(() => false); setMenuOpen((o) => !o); }}
          >
            <Avatar kind="user" size={32} src={userImage} mono={(userEmail || "?").charAt(0).toUpperCase()} />
            <div className="acct-meta">
              <div className="acct-name-row">
                <span className="acct-name">{userEmail || "Account"}</span>
              </div>
              <div className="acct-sub">signed in</div>
            </div>
            <span className="chev"><Ic.Chevron size={16} /></span>
          </button>
          <button
            className={"help-btn" + (infoOpen ? " open" : "")}
            title="How to use the studio"
            aria-label="How to use the studio"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(() => false);
              setInfoOpen((o) => !o);
            }}
          >
            <Ic.Info size={18} />
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ---------------- unified mobile drawer panes ---------------- */
// On mobile every topbar icon opens the one bottom drawer (RightDrawer); these
// two panes back its "Chats" and "Account" tabs, reusing the sidebar markup.
function ChatsPane({
  convos,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onDeleteMany,
  onRename,
  query,
  setQuery,
}: {
  convos: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onDeleteMany: (ids: string[]) => void;
  onRename: (id: string, title: string) => void;
  query: string;
  setQuery: (v: string) => void;
}) {
  return (
    <div className="drawer-pane">
      <button className="newbtn" onClick={onNew}>
        <span className="nb-ic"><Ic.Plus size={17} /></span> New conversation
      </button>
      <div className="searchwrap">
        <span className="search-ic"><Ic.Search size={15} /></span>
        <input
          className="side-search"
          placeholder="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <ConvList
        convos={convos}
        activeId={activeId}
        query={query}
        onSelect={onSelect}
        onDelete={onDelete}
        onDeleteMany={onDeleteMany}
        onRename={onRename}
      />
    </div>
  );
}

function AccountPane({
  userEmail,
  userImage,
  isAdmin,
  feedbackMode,
  monoTheme,
  onToggleMono,
  onToggleFeedbackMode,
  onSignOut,
}: {
  userEmail: string;
  userImage?: string;
  isAdmin: boolean;
  feedbackMode: boolean;
  monoTheme: boolean;
  onToggleMono: () => void;
  onToggleFeedbackMode: () => void;
  onSignOut: () => void;
}) {
  const router = useRouter();
  return (
    <div className="drawer-pane">
      <div className="acct-chip" style={{ cursor: "default" }}>
        <Avatar kind="user" size={38} src={userImage} mono={(userEmail || "?").charAt(0).toUpperCase()} />
        <div className="acct-meta">
          <div className="acct-name-row">
            <span className="acct-name">{userEmail || "Account"}</span>
          </div>
          <div className="acct-sub">signed in</div>
        </div>
      </div>
      {isAdmin && (
        <>
          <div className="pop-label adm">
            <Ic.Shield size={13} /> Admin
          </div>
          <div className="pop-adm">
            {ADMIN_ITEMS.map((it) => {
              const I = Ic[it.icon as keyof typeof Ic];
              return (
                <button key={it.label} className="pop-row" onClick={() => router.push(it.href)}>
                  <span className="ic"><I size={17} /></span>{it.label}
                </button>
              );
            })}
            <button className="pop-row" onClick={onToggleFeedbackMode}>
              <span className="ic"><Ic.Edit size={17} /></span>
              Feedback{feedbackMode ? " ✓" : ""}
            </button>
          </div>
          <div className="pop-div" />
        </>
      )}
      <div className="pop-label"><Ic.User size={13} /> Account</div>
      <button className="pop-row" onClick={onToggleMono}>
        <span className="ic"><Ic.Moon size={17} /></span>
        Black &amp; white{monoTheme ? " ✓" : ""}
      </button>
      <button className="pop-row danger" onClick={onSignOut}>
        <span className="ic"><Ic.SignOut size={17} /></span>Sign out
      </button>
    </div>
  );
}

/* ---------------- compact (collapsed) sidebar rail ---------------- */
function SidebarRail({ onExpand, onNew }: { onExpand: () => void; onNew: () => void }) {
  return (
    <aside className="sidebar rail">
      <button className="rail-btn rail-flip" title="Expand sidebar" onClick={onExpand}>
        <Ic.Panel size={18} />
      </button>
      <button className="rail-btn" title="New conversation" aria-label="New conversation" onClick={onNew}>
        <Ic.Plus size={18} />
      </button>
    </aside>
  );
}

/* ---------------- mobile-only right-edge nav ---------------- */
// On mobile the docked sidebar and rails are hidden, so this floating vertical
// bar on the right edge is the only launcher for the bottom drawer. Each icon
// opens the sheet with its tab active; admin-only panels are filtered out.
const MOBILE_NAV: Array<{ id: DrawerId; icon: IconName }> = [
  { id: "chats", icon: "Chat" },
  { id: "account", icon: "User" },
];

function MobileNav({
  onOpen,
  isAdmin,
}: {
  onOpen: (id: DrawerId) => void;
  isAdmin: boolean;
}) {
  return (
    <nav className="mobile-railnav" aria-label="Panels">
      {MOBILE_NAV.filter(
        (n) => isAdmin || !ADMIN_ONLY_DRAWERS.includes(n.id)
      ).map((n) => {
        const I = Ic[n.icon];
        return (
          <button
            key={n.id}
            className="mrail-btn"
            title={DRAWER_LABEL[n.id]}
            aria-label={DRAWER_LABEL[n.id]}
            onClick={(e) => { e.stopPropagation(); onOpen(n.id); }}
          >
            <I size={15} />
          </button>
        );
      })}
    </nav>
  );
}

/* ---------------- compact (collapsed) right drawer rail ---------------- */
function RightRail({
  panelOpen,
  onTogglePanel,
  isAdmin,
  canvasOpen,
  onToggleCanvas,
  floating = false,
  rightOffset,
}: {
  panelOpen: boolean;
  onTogglePanel: () => void;
  isAdmin: boolean;
  canvasOpen: boolean;
  onToggleCanvas: () => void;
  /** When a right drawer is open, the rail floats at the drawer's left edge
   *  (`rightOffset` px from the body's right edge) instead of docking as a flex
   *  column, and follows the drawer as its width is resized. */
  floating?: boolean;
  rightOffset?: number;
}) {
  return (
    <aside
      className={"right-rail" + (floating ? " floating" : "")}
      style={floating && rightOffset != null ? { right: rightOffset } : undefined}
    >
      {/* Panel icon opens the right drawer. Hidden once it's open — the drawer
          has its own × to close, so the launcher would be redundant. */}
      {isAdmin && !panelOpen && (
        <button
          className="rail-btn"
          title="Open Model Setup"
          aria-label="Open Model Setup"
          onClick={onTogglePanel}
        >
          <Ic.Panel size={18} />
        </button>
      )}
      {/* Workflow launcher, docked in the rail directly under the drawer icon.
          Hidden while the workflow is open (it has its own × to close). */}
      {!canvasOpen && (
        <button
          className="rail-btn"
          title="Open workflow"
          aria-label="Open workflow"
          onClick={onToggleCanvas}
        >
          <Ic.Workflow size={18} />
        </button>
      )}
    </aside>
  );
}

/* ---------------- thread pieces ---------------- */
function ThreadHeader() {
  return (
    <div className="thread-head">
      <Avatar kind="assistant" size={18} ring mono="SA" />
      <div className="th-meta">
        <div className="th-name">Sleep Assistant</div>
      </div>
    </div>
  );
}

/* Speaker (voice-reply) toggle — lives in the composer, left of the mic while recording. */
function VoiceReplyButton({
  autoSpeak,
  onToggleAutoSpeak,
  isSpeaking,
  onStopSpeaking,
  className,
  iconSize = 18,
}: {
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
  isSpeaking: boolean;
  onStopSpeaking: () => void;
  className: string;
  iconSize?: number;
}) {
  return (
    <button
      type="button"
      className={className}
      title={autoSpeak ? "Voice replies on — click to mute" : "Voice replies off — click to enable"}
      aria-label={autoSpeak ? "Turn off voice replies" : "Turn on voice replies"}
      aria-pressed={autoSpeak}
      onClick={() => {
        if (isSpeaking) onStopSpeaking();
        onToggleAutoSpeak();
      }}
      style={autoSpeak ? { color: "var(--accent, #F05025)" } : { opacity: 0.55 }}
    >
      {autoSpeak ? (
        isSpeaking ? (
          <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        ) : (
          <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
        )
      ) : (
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </svg>
      )}
    </button>
  );
}

/**
 * Mic next to Feedback: click to speak, stop to transcribe and save as the
 * ideal-output feedback signal (same signal the fullscreen editor submits).
 */
function VoiceFeedbackButton({
  existing,
  onSubmit,
}: {
  existing: FeedbackEntry[];
  onSubmit: (entries: FeedbackEntry[]) => void;
}) {
  const [hint, setHint] = useState("");
  const { isRecording, isTranscribing, toggle } = useVoiceRecorder({
    onTranscript: (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        setHint("No speech heard");
        window.setTimeout(() => setHint(""), 1800);
        return;
      }
      const kept = existing.filter((e) => e.signal !== "correct_output");
      onSubmit([
        ...kept,
        { rating: null, signal: "correct_output", comment: trimmed },
      ]);
      setHint("Saved");
      window.setTimeout(() => setHint(""), 1600);
    },
    onError: (message) => {
      setHint(message);
      window.setTimeout(() => setHint(""), 2200);
    },
  });

  const label = isTranscribing
    ? "Saving…"
    : isRecording
      ? "Listening…"
      : hint || "Voice feedback";

  return (
    <button
      type="button"
      className={
        "trace-act bubble-voice-fb" +
        (isRecording ? " recording" : "") +
        (hint === "Saved" ? " saved" : "")
      }
      title={
        isRecording
          ? "Stop recording — saves as ideal feedback"
          : "Speak the ideal response; saves as ideal feedback"
      }
      aria-label={label}
      aria-pressed={isRecording}
      disabled={isTranscribing}
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
    >
      <Ic.Mic size={13} /> {label}
    </button>
  );
}

/**
 * Fullscreen overlay for a reply — mirrors the canvas full mode. It has its own
 * Feedback button: pressing it turns the reply into an editable input with a
 * Submit button; submitting saves the edited text as the "ideal output" feedback
 * signal, which tints the bubble and shows in the message's feedback component.
 */
function BubbleFullscreen({
  text,
  feedbackMode,
  initialEntries,
  onSubmitFeedback,
  onClose,
}: {
  text: string;
  feedbackMode?: boolean;
  initialEntries?: FeedbackEntry[];
  onSubmitFeedback?: (entries: FeedbackEntry[]) => void;
  onClose: () => void;
}) {
  const canFeedback = !!onSubmitFeedback;
  const existingIdeal = initialEntries?.find((e) => e.signal === "correct_output")?.comment ?? "";
  const existingRating = initialEntries?.find((e) => e.signal === "score")?.rating ?? null;
  // Feedback edit mode: opened by the Feedback button (or straight away when the
  // studio's global feedback mode is on). Prefill with a prior correction if any.
  const [editing, setEditing] = useState(!!feedbackMode && canFeedback);
  const [draft, setDraft] = useState(existingIdeal || text);
  const [rating, setRating] = useState<1 | -1 | null>(existingRating);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    if (!onSubmitFeedback) return;
    // Preserve any other signals already on this message; replace score + ideal.
    const kept = (initialEntries ?? []).filter(
      (e) => e.signal !== "score" && e.signal !== "correct_output"
    );
    const entries: FeedbackEntry[] = [...kept];
    if (rating !== null) entries.push({ rating, signal: "score", comment: "" });
    const corrected = draft.trim();
    if (corrected && corrected !== text.trim()) {
      entries.push({ rating: null, signal: "correct_output", comment: corrected });
    }
    onSubmitFeedback(entries);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };

  // Mount inside `.ra-scope` so theme tokens (mono accent, surfaces) apply —
  // portaling to <body> left the modal on the fallback orange accent.
  const host =
    (typeof document !== "undefined" &&
      (document.querySelector(".ra-scope") as HTMLElement | null)) ||
    document.body;

  return createPortal(
    <div className="bubble-fs-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="bubble-fs" onClick={(e) => e.stopPropagation()}>
        <div className="bubble-fs-head">
          <div className="bubble-fs-head-left">
            {canFeedback && !editing && (
              <button type="button" className="bubble-fs-fb" onClick={() => setEditing(true)}>
                <Ic.Edit size={15} /> Feedback
              </button>
            )}
            {editing && (
              <>
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
                <span className="bubble-fs-hint">Edit the answer, then submit it as the ideal response.</span>
              </>
            )}
          </div>
          <div className="bubble-fs-head-right">
            {editing && (
              <>
                <button
                  type="button"
                  className="bubble-fs-cancel"
                  onClick={() => { setEditing(false); setDraft(existingIdeal || text); }}
                >
                  Cancel
                </button>
                <button type="button" className="bubble-fs-submit" onClick={submit}>
                  {saved ? "Saved" : "Submit feedback"}
                </button>
              </>
            )}
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
            <textarea
              className="bubble-fs-textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck
              autoFocus
            />
          ) : (
            <ReactMarkdown>{text}</ReactMarkdown>
          )}
        </div>
      </div>
    </div>,
    host
  );
}

function Bubble({
  m,
  onOpenTrace,
  onOpenPolicy,
  onOpenState,
  onOpenFeedback,
  hasState = false,
  feedbackMode = false,
  feedbackEntries,
  onSubmitFeedback,
  collapsed = false,
  onToggleCollapse,
  hideControls = false,
  turnNumber,
}: {
  m: Message;
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
  /** When true the bubble is tucked to a single line. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** When true, hide the bubble nav and footer chrome. */
  hideControls?: boolean;
  /** 1-based turn index shown before Observability on assistant bubbles. */
  turnNumber?: number;
}) {
  const [fullscreen, setFullscreen] = useState(false);
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
  const showNavActions = showTrace || showPolicy || showStateBtn;
  const showFootActions = showFeedback || showFullscreen;

  const navActions = showNavActions ? (
    <div className="trace-actions">
      {showTrace && (
        <button type="button" className="trace-act" title="Open the step-by-step Observability trace for this reply" onClick={() => onOpenTrace!(turnId!)}>
          {turnNumber != null ? <span className="trace-turn-n">{turnNumber}.</span> : null}
          <Ic.Grid size={13} />
          Observability
        </button>
      )}
      {showPolicy && (
        <button type="button" className="trace-act" title="Highlight this reply's path on the Policy canvas" onClick={() => onOpenPolicy!(turnId!)}>
          <Ic.Sliders size={13} /> Policy trace
        </button>
      )}
      {showStateBtn && (
        <button type="button" className="trace-act" title="Show the state extracted from this turn, highlighted in the State panel" onClick={() => onOpenState!(turnId!)}>
          <Ic.List size={13} /> State
        </button>
      )}
    </div>
  ) : null;

  const footActions = showFootActions ? (
    <div className="bubble-foot-actions">
      {showFullscreen ? (
        <button type="button" className="trace-act" title="View this message full screen" onClick={() => setFullscreen(true)}>
          <Ic.Expand size={13} /> Fullscreen
        </button>
      ) : (
        <span />
      )}
      {showFeedback ? (
        <div className="bubble-foot-feedback">
          <VoiceFeedbackButton
            existing={feedbackEntries ?? []}
            onSubmit={(entries) => onSubmitFeedback?.(entries)}
          />
          <button type="button" className="trace-act" title="Leave feedback on this message" onClick={() => onOpenFeedback!()}>
            <Ic.Edit size={13} /> Feedback
          </button>
        </div>
      ) : (
        <span />
      )}
    </div>
  ) : null;

  const collapseBtn = showCollapse ? (
    <button
      type="button"
      className="bubble-collapse"
      title={collapsed ? "Expand" : "Collapse"}
      aria-label={collapsed ? "Expand message" : "Collapse message"}
      onClick={(e) => {
        e.stopPropagation();
        onToggleCollapse?.();
      }}
    >
      <Ic.Chevron size={13} style={collapsed ? undefined : { transform: "rotate(180deg)" }} />
      {collapsed ? "Expand" : "Collapse"}
    </button>
  ) : null;

  const overlay = fullscreen ? (
    <BubbleFullscreen
      text={m.text}
      feedbackMode={feedbackMode}
      initialEntries={feedbackEntries}
      onSubmitFeedback={onSubmitFeedback}
      onClose={() => setFullscreen(false)}
    />
  ) : null;

  // Collapsed preview is plain one-line text (markdown blocks clip badly under clamp).
  const collapsedPreview = m.text.replace(/\s+/g, " ").trim();
  // Toggle only on the body so nav/footer clicks don't collapse.
  const bodyToggleProps = onToggleCollapse
    ? {
        role: "button" as const,
        tabIndex: 0,
        title: collapsed ? "Click to expand" : "Click to collapse",
        // Ignore clicks that finish a text selection so highlight-drag doesn't toggle.
        onClick: () => {
          const sel = typeof window !== "undefined" ? window.getSelection() : null;
          if (sel && !sel.isCollapsed && (sel.toString() || "").length > 0) return;
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

  const shellClass =
    (isUser ? "msg-user" : "bubble") +
    (hasFeedback ? " has-feedback" : "") +
    (collapsed ? " is-collapsed" : "");

  const shell = (
    <div className={shellClass + (hideControls ? " hide-controls" : "")}>
      {!hideControls && (
        <div className="bubble-nav">
          {navActions}
          {collapseBtn}
        </div>
      )}
      <div
        className={"bubble-body" + (onToggleCollapse ? " is-toggleable" : "")}
        {...bodyToggleProps}
      >
        {collapsed ? collapsedPreview : isUser ? m.text : <ReactMarkdown>{m.text}</ReactMarkdown>}
      </div>
      {!hideControls && footActions && <div className="bubble-foot">{footActions}</div>}
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
      <Avatar kind="assistant" size={28} mono="SA" />
      <div className="bubble-col">
        {shell}
      </div>
      {overlay}
    </div>
  );
}

function MessageRow({
  m,
  index,
  feedbackMode,
  entries,
  editing,
  onToggle,
  onSave,
  onRemove,
  onOpenTrace,
  onOpenPolicy,
  onOpenState,
  hasState,
  allowFeedback,
  collapsed,
  onToggleCollapse,
  hideControls,
  turnNumber,
}: {
  m: Message;
  index: number;
  feedbackMode: boolean;
  entries: FeedbackEntry[];
  editing: boolean;
  onToggle: (index: number) => void;
  onSave: (index: number, entries: FeedbackEntry[]) => void;
  onRemove: (index: number) => void;
  onOpenTrace?: (turnId: string) => void;
  onOpenPolicy?: (turnId: string) => void;
  onOpenState?: (turnId: string) => void;
  hasState?: boolean;
  allowFeedback?: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  hideControls: boolean;
  turnNumber?: number;
}) {
  return (
    <div className="msg-block">
      <Bubble
        m={m}
        onOpenTrace={onOpenTrace}
        onOpenPolicy={onOpenPolicy}
        onOpenState={onOpenState}
        hasState={hasState}
        // The Feedback button opens the editor inline for this message (patient or assistant).
        onOpenFeedback={allowFeedback ? () => onToggle(index) : undefined}
        // In feedback mode the fullscreen view can edit + submit the reply as feedback.
        feedbackMode={feedbackMode}
        feedbackEntries={entries}
        onSubmitFeedback={allowFeedback ? (e) => onSave(index, e) : undefined}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        hideControls={hideControls}
        turnNumber={turnNumber}
      />
      <FeedbackControls
        mode={feedbackMode}
        entries={entries}
        editing={editing}
        align={m.role === "user" ? "right" : "left"}
        onToggle={() => onToggle(index)}
        onSave={(e) => onSave(index, e)}
        onRemove={() => onRemove(index)}
      />
    </div>
  );
}

function Thread({
  messages,
  typing,
  typingLabel,
  streaming,
  feedbackMode,
  feedbackByIdx,
  editingIdx,
  onToggleFeedback,
  onSaveFeedback,
  onRemoveFeedback,
  onOpenTrace,
  onOpenPolicy,
  onOpenState,
  stateTurnIds,
  allowFeedback,
  collapsedByIdx,
  setCollapsedByIdx,
  hideBubbleControls,
}: {
  messages: Message[];
  typing: boolean;
  typingLabel: string;
  streaming: string;
  feedbackMode: boolean;
  feedbackByIdx: Record<number, FeedbackEntry[]>;
  editingIdx: number | null;
  onToggleFeedback: (index: number) => void;
  onSaveFeedback: (index: number, entries: FeedbackEntry[]) => void;
  onRemoveFeedback: (index: number) => void;
  onOpenTrace?: (turnId: string) => void;
  onOpenPolicy?: (turnId: string) => void;
  onOpenState?: (turnId: string) => void;
  /** Turn ids that extracted at least one piece of state (drives the State button). */
  stateTurnIds?: Set<string>;
  /** Gates the per-reply Feedback button (admin-only, like the other panels). */
  allowFeedback?: boolean;
  collapsedByIdx: Record<number, boolean>;
  setCollapsedByIdx: React.Dispatch<React.SetStateAction<Record<number, boolean>>>;
  hideBubbleControls: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to the latest message as the conversation grows — but NOT when
  // a feedback editor opens (editingIdx), or it would jump away from the bubble
  // you just clicked. The editor renders inline under that bubble, already in view.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, typing, streaming]);
  // 1-based turn numbers for assistant replies (shared with the patient turn id).
  const turnNumberById = useMemo(() => {
    const map = new Map<string, number>();
    let n = 0;
    for (const m of messages) {
      if (m.role === "ai" && m.turnId && !map.has(m.turnId)) {
        map.set(m.turnId, ++n);
      }
    }
    return map;
  }, [messages]);
  return (
    <div className="thread">
      <div className="thread-inner">
        <div className="day-divider">TODAY</div>
        {messages.map((m, i) => (
          <MessageRow
            key={i}
            m={m}
            index={i}
            feedbackMode={feedbackMode}
            entries={feedbackByIdx[i] ?? []}
            editing={editingIdx === i}
            onToggle={onToggleFeedback}
            onSave={onSaveFeedback}
            onRemove={onRemoveFeedback}
            onOpenTrace={onOpenTrace}
            onOpenPolicy={onOpenPolicy}
            onOpenState={onOpenState}
            hasState={!!m.turnId && !!stateTurnIds?.has(m.turnId)}
            allowFeedback={allowFeedback}
            collapsed={!!collapsedByIdx[i]}
            onToggleCollapse={() =>
              setCollapsedByIdx((prev) => ({ ...prev, [i]: !prev[i] }))
            }
            hideControls={hideBubbleControls}
            turnNumber={m.turnId ? turnNumberById.get(m.turnId) : undefined}
          />
        ))}
        {streaming && <Bubble m={{ role: "ai", text: streaming }} />}
        {typing && !streaming && (
          <div className="typing">
            <Avatar kind="assistant" size={28} mono="SA" />
            <div className="typing-status">{typingLabel || "Thinking…"}</div>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// `compact` collapses the empty state to just the avatar (used while the canvas
// drawer is open, so the picture stays but the copy + suggestions are hidden).
function EmptyState({ onSuggest, compact = false }: { onSuggest: (t: string) => void; compact?: boolean }) {
  return (
    <div className={"empty" + (compact ? " compact" : "")}>
      <Avatar kind="assistant" size={96} ring mono="SA" className="empty-orb" />
      {!compact && (
        <>
          <div className="empty-title">Start a conversation</div>
          <div className="empty-sub">
            Sleep Assistant can review your sleep logs, summarise guidance, and help you
            build a routine that sticks.
          </div>
          <div className="suggests">
            {SUGGESTIONS.map((s) => {
              const I = Ic[s.icon as keyof typeof Ic];
              return (
                <button key={s.label} className="sug-chip" onClick={() => onSuggest(s.label)}>
                  <span className="ic"><I size={15} /></span>{s.label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Composer({
  value,
  setValue,
  onSend,
  inputRef,
  onExpertChat,
  onUpload,
  onMicToggle,
  isRecording,
  isTranscribing,
  autoSpeak,
  onToggleAutoSpeak,
  isSpeaking,
  onStopSpeaking,
  showThreadControls = false,
  allCollapsed = false,
  onToggleCollapseAll,
  hideBubbleControls = true,
  onToggleHideBubbleControls,
}: {
  value: string;
  setValue: (v: string) => void;
  onSend: (t: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onExpertChat: () => void;
  onUpload: () => void;
  onMicToggle: () => void;
  isRecording: boolean;
  isTranscribing: boolean;
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
  isSpeaking: boolean;
  onStopSpeaking: () => void;
  /** Collapse all / Hide controls — docked above the input. */
  showThreadControls?: boolean;
  allCollapsed?: boolean;
  onToggleCollapseAll?: () => void;
  hideBubbleControls?: boolean;
  onToggleHideBubbleControls?: () => void;
}) {
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onSend(v);
  };
  const micTitle = isRecording
    ? "Stop recording"
    : isTranscribing
      ? "Transcribing…"
      : "Speak your message";
  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        <div className="action-chips">
          {ACTION_CHIPS.map((a) => {
            const I = Ic[a.icon as keyof typeof Ic];
            return (
              <button
                key={a.label}
                className="act-chip"
                onClick={() => {
                  if (a.label === "Chat with the expert") {
                    onExpertChat();
                    return;
                  }
                  if (a.label === "Upload sleep data") {
                    onUpload();
                    return;
                  }
                  setValue(a.prefill ?? (a.label === "Create" ? "Help me create " : a.label + ": "));
                  inputRef.current?.focus();
                }}
              >
                <span className="ic"><I size={15} /></span>{a.label}
              </button>
            );
          })}
        </div>
        {showThreadControls && (
          <div className="composer-thread-controls">
            <button
              type="button"
              className="thread-collapse-all"
              onClick={onToggleCollapseAll}
              title={allCollapsed ? "Expand every message" : "Collapse every message to one line"}
            >
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
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
              {hideBubbleControls ? "Show controls" : "Hide controls"}
            </button>
          </div>
        )}
        <div className="composer-row">
          <div className="composer">
            <input
              ref={inputRef}
              className="comp-input"
              placeholder={
                isRecording
                  ? "Listening… tap the mic to stop"
                  : isTranscribing
                    ? "Transcribing…"
                    : "Type a message or tap the mic to speak"
              }
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              disabled={isRecording || isTranscribing}
            />
            {/* Hide the send arrow during voice input so the mic is the only
                action and the user isn't confused about what to press. */}
            {!(isRecording || isTranscribing) && (
              <button
                className="comp-send"
                title="Send"
                aria-label="Send"
                disabled={!value.trim()}
                onClick={submit}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            )}
            {/* Voice-reply mute: only beside the mic while listening / transcribing. */}
            {(isRecording || isTranscribing) && (
              <VoiceReplyButton
                className="comp-speaker"
                iconSize={16}
                autoSpeak={autoSpeak}
                onToggleAutoSpeak={onToggleAutoSpeak}
                isSpeaking={isSpeaking}
                onStopSpeaking={onStopSpeaking}
              />
            )}
            <button
              type="button"
              className="comp-mic"
              title={micTitle}
              aria-label={micTitle}
              aria-pressed={isRecording}
              disabled={isTranscribing}
              onClick={onMicToggle}
              style={
                isRecording
                  ? {
                      color: "#fff",
                      background: "#F05025",
                      opacity: 1,
                      animation: "voice-pulse 1.2s ease-in-out infinite",
                    }
                  : isTranscribing
                    ? { opacity: 0.55 }
                    : undefined
              }
            >
              {isTranscribing ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 1a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      <style jsx>{`
        @keyframes voice-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(240, 80, 37, 0.55); }
          50% { box-shadow: 0 0 0 8px rgba(240, 80, 37, 0); }
        }
      `}</style>
    </div>
  );
}

/* ---------------- bottom workflow drawer ---------------- */
// Same wiring as airlab's Primary / Environment Workflow canvas:
// WORKFLOW_CANVAS_NODE_KINDS (includes Stage) + an Overall Workflow overview
// tagged with the shared workflow-overview marker so stage nodes compile/inspect
// like the orchestration daemon's editable workflow surface.
const BOTTOM_WORKFLOW_SEED: CanvasDoc = {
  version: 2,
  activeId: "overall-workflow",
  canvases: [
    {
      id: "overall-workflow",
      name: WORKFLOW_OVERVIEW_CANVAS_NAME,
      freeText: [
        WORKFLOW_OVERVIEW_CANVAS_MARKER,
        "Primary agent: Sleep Assistant",
        "Editable overview of the main sleep-care stages. Edit stages, add loops, or partition a stage into a child workflow.",
      ].join("\n"),
      graph: {
        nodes: [
          {
            id: "wf-start",
            type: "start",
            position: { x: 80, y: 140 },
            data: {
              label:
                "Editable overview of the main workflow stages. Describe the high-level turn-taking process shared with the sleeper.",
              workflowOverview: true,
              runtimeRole: "workflow_overview",
              workflowCanvasId: "overall-workflow",
            },
          },
          {
            id: "wf-stage-intake",
            type: "stage",
            position: { x: 420, y: 120 },
            data: {
              label:
                "Intake\nGather the sleep complaint, schedule, and constraints.\nEntry: conversation opens.\nDone: enough history to assess.",
              workflowOverview: true,
              runtimeRole: "workflow_overview",
              workflowCanvasId: "overall-workflow",
              workflowStageId: "intake",
              workflowStageName: "Intake",
            },
          },
          {
            id: "wf-stage-assess",
            type: "stage",
            position: { x: 850, y: 120 },
            data: {
              label:
                "Assess\nIdentify patterns (onset, maintenance, schedule, habits).\nEntry: intake complete.\nDone: working hypothesis shared with the sleeper.",
              workflowOverview: true,
              runtimeRole: "workflow_overview",
              workflowCanvasId: "overall-workflow",
              workflowStageId: "assess",
              workflowStageName: "Assess",
            },
          },
          {
            id: "wf-stage-guide",
            type: "stage",
            position: { x: 1280, y: 120 },
            data: {
              label:
                "Guide\nOffer CBT-I style recommendations and next steps.\nEntry: assessment agreed.\nDone: plan accepted or revised.",
              workflowOverview: true,
              runtimeRole: "workflow_overview",
              workflowCanvasId: "overall-workflow",
              workflowStageId: "guide",
              workflowStageName: "Guide",
            },
          },
          {
            id: "wf-stage-followup",
            type: "stage",
            position: { x: 1710, y: 120 },
            data: {
              label:
                "Follow up\nCheck progress, adjust the plan, or loop back.\nEntry: plan in place.\nDone: sleeper is stable or returns to Assess.",
              workflowOverview: true,
              runtimeRole: "workflow_overview",
              workflowCanvasId: "overall-workflow",
              workflowStageId: "followup",
              workflowStageName: "Follow up",
            },
          },
        ],
        edges: [
          { id: "e-start-intake", source: "wf-start", target: "wf-stage-intake" },
          {
            id: "e-intake-assess",
            source: "wf-stage-intake",
            target: "wf-stage-assess",
            sourceHandle: "workflow-next-0",
            targetHandle: "workflow-previous-0",
          },
          {
            id: "e-assess-guide",
            source: "wf-stage-assess",
            target: "wf-stage-guide",
            sourceHandle: "workflow-next-0",
            targetHandle: "workflow-previous-0",
          },
          {
            id: "e-guide-followup",
            source: "wf-stage-guide",
            target: "wf-stage-followup",
            sourceHandle: "workflow-next-0",
            targetHandle: "workflow-previous-0",
          },
          {
            id: "e-followup-assess-loop",
            source: "wf-stage-followup",
            target: "wf-stage-assess",
            label: "loop / return",
            sourceHandle: "workflow-loop-0",
            targetHandle: "workflow-loop-target-0",
          },
        ],
      },
    },
  ],
};

// ── Workflow stage tracking ────────────────────────────────────────────────
// The Overall Workflow canvas (bottom drawer) mirrors the high-level sleep-care
// stages. As the conversation runs, we derive which stage the turn belongs to
// from its policy trace + state, and highlight that stage node in the workflow.
const WORKFLOW_STAGE_NODE: Record<string, string> = {
  intake: "wf-stage-intake",
  assess: "wf-stage-assess",
  guide: "wf-stage-guide",
  followup: "wf-stage-followup",
};
// Which policy canvas each workflow stage opens (Model Setup → Policy). Each
// stage now has its own canvas; clicking a workflow stage selects it.
const WORKFLOW_STAGE_POLICY_CANVAS: Record<string, string> = {
  intake: "intake", // "Sleep Intake"
  assess: "assess",
  guide: "guide",
  followup: "followup",
};

/** Derive the active workflow stage for a completed turn from its trace + state. */
function deriveWorkflowStage(turn: Turn | null | undefined): string | null {
  if (!turn) return null;
  const refs = turn.nodeRefs ?? [];
  // The Sleep Intake subtree ran this turn → still gathering history.
  if (refs.some((r) => r.canvasId === "intake")) return "intake";
  const state = (turn.state ?? {}) as Record<string, unknown>;
  const isEmpty = (v: unknown) =>
    v === null || v === undefined || (Array.isArray(v) ? v.length === 0 : String(v).trim() === "" || String(v) === "null");
  // Emergency short-circuits into guidance (urgent advice).
  if (!isEmpty(state.emergency) && String(state.emergency).toLowerCase() !== "false") return "guide";
  // Once the core intake fields are captured, the assistant moves to guidance.
  const intakeCoreFilled =
    !isEmpty(state.sleep_concern) &&
    !isEmpty(state.bedtime_weeknight) &&
    !isEmpty(state.wake_time);
  if (intakeCoreFilled) return "guide";
  return "intake";
}

/**
 * A full-width drawer docked to the bottom of the window. It behaves like the
 * right side drawer but slides up from the bottom (the horizontal analogue): it
 * spans the whole window width, can be resized by dragging its top grabber, and
 * is dismissed with the × in its bar. Hosts a Canvas editor that fills the
 * drawer's width.
 */
function BottomCanvasDrawer({
  open,
  onClose,
  height,
  setHeight,
  doc,
  onDocChange,
  onSave,
  saving,
  saved,
  fireSignal,
  onStageClick,
}: {
  open: boolean;
  onClose: () => void;
  height: number;
  setHeight: (h: number) => void;
  doc: CanvasDoc | null;
  onDocChange: (doc: CanvasDoc) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  /** Highlights the active workflow stage as the conversation progresses. */
  fireSignal?: CanvasFireSignal | null;
  /** Clicking a workflow stage node opens its policy canvas + trace. */
  onStageClick?: (stageId: string) => void;
}) {
  // VS Code-style splitter: the drawer's top edge is a full-width drag handle
  // that highlights while hovered/dragged. Drag up = taller (up to near the top
  // of the window); the layout above reflows into the remaining space.
  const [resizing, setResizing] = useState(false);
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      const next = startH + (startY - ev.clientY);
      setHeight(Math.round(Math.max(240, Math.min(window.innerHeight - 72, next))));
    };
    const onUp = () => {
      setResizing(false);
      document.body.classList.remove("ra-resizing-v");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    document.body.classList.add("ra-resizing-v");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  if (!open) return null;
  return (
    <div className="bottom-drawer" style={{ height }} role="dialog" aria-label="Workflow">
      <div
        className={"bottom-drawer-resize" + (resizing ? " active" : "")}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize workflow (drag up or down; double-click to reset)"
        title="Drag to resize"
        onPointerDown={onResizeDown}
        onDoubleClick={() => setHeight(Math.round(window.innerHeight / 3))}
      />
      {/* Fallback close for narrow widths where the canvas tab bar (and its inline
          close) is hidden, so the drawer is never stuck open. Hidden on lg+. */}
      <button
        type="button"
        className="bottom-drawer-close-fallback"
        aria-label="Close workflow"
        title="Close workflow"
        onClick={onClose}
      >
        <Ic.Close size={18} />
      </button>
      <div className="bottom-drawer-body">
        <Canvas
          value={doc}
          seedDoc={BOTTOM_WORKFLOW_SEED}
          // Same node registry as airlab's RuntimeWorkflowCanvas (includes Stage).
          nodeKinds={WORKFLOW_CANVAS_NODE_KINDS}
          // Drives the workflow-specific "How it works" info in the canvas (i).
          inspectorContext={{ executionPhase: "workflow" }}
          // Highlights the active stage node as the conversation progresses.
          fireSignal={fireSignal}
          // Clicking a stage node opens its policy canvas + trace.
          onNodeActivate={(node) => {
            const stageId = (node.data as Record<string, unknown>)?.workflowStageId;
            if (typeof stageId === "string") onStageClick?.(stageId);
          }}
          fillHeight
          // Wide bottom drawer: canvas | Inspector/Compiler side by side.
          // (Side drawer Model Setup keeps the stacked column layout.)
          panelLayout="split"
          onChange={({ doc }) => onDocChange(doc)}
          // Save stays in the bottom-right chrome; × sits top-right next to (i).
          tabBarTrailing={
            <button
              type="button"
              className="obs-setup-action"
              onClick={onSave}
              disabled={saving}
              title="Save workflow"
            >
              {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
            </button>
          }
          tabBarEnd={
            <button
              type="button"
              className="rf-canvas-tab-btn rf-canvas-tab-btn--icon bottom-drawer-close h-[46px]"
              aria-label="Close workflow"
              title="Close workflow"
              onClick={onClose}
            >
              <Ic.Close size={16} />
            </button>
          }
        />
      </div>
    </div>
  );
}

/* ---------------- page ---------------- */
function SleepStudioChat() {
  const { user, isAdmin, signOut, roleLoaded } = useAuth();
  // The studio assembles behind the splash overlay; this flag tells the splash
  // when the initial data (role + conversations) is ready so it can fade out.
  const [convosLoaded, setConvosLoaded] = useState(false);
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Mirror of activeId that is safe to read from a long-lived closure (the
  // Simulation loop reuses one captured send() across turns). Kept in sync
  // below AND written synchronously in send() the moment a conversation is
  // created, so back-to-back sends target the same conversation.
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  // When set (by the Simulation panel), the next conversation send() creates is
  // titled as a simulation instead of using the first user message.
  const simulationTitleRef = useRef<string | null>(null);
  // The patient scenario that drove that run, saved on the conversation so
  // selecting the run later can repopulate the Patient scenario field.
  const simulationScenarioRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  // Black & white theme preference (persisted). Default ON — adds `.ra-mono`
  // to the root scope. Explicit "0" in localStorage keeps the greige palette.
  const [monoTheme, setMonoTheme] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem(MONO_PREF_KEY) !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MONO_PREF_KEY, monoTheme ? "1" : "0");
    } catch {
      // ignore
    }
  }, [monoTheme]);
  // Voice: TTS auto-play preference (persisted to localStorage) and hooks.
  const [autoSpeak, setAutoSpeak] = useState(false);
  const autoSpeakRef = useRef(autoSpeak);
  useEffect(() => {
    autoSpeakRef.current = autoSpeak;
  }, [autoSpeak]);
  // Set true right before we kick off a send() so the next assistant message
  // triggers TTS. Cleared on conversation switch so historical loads don't play.
  const speakNextAssistantRef = useRef(false);
  const { speak, stop: stopSpeaking, isSpeaking } = useTTS();
  // Live description of what the server is doing this turn (streamed stage events),
  // shown in place of the anonymous typing dots.
  const [typingLabel, setTypingLabel] = useState("");
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // "How to use the studio" help panel, anchored bottom-left of the sidebar.
  const [infoOpen, setInfoOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Thread chrome (Collapse all / Hide controls) — lifted so it can dock above
  // the composer input; TODAY stays at the top of the message list.
  const [collapsedByIdx, setCollapsedByIdx] = useState<Record<number, boolean>>({});
  const [hideBubbleControls, setHideBubbleControls] = useState(true);
  useEffect(() => {
    setHideBubbleControls(true);
    setCollapsedByIdx({});
  }, [activeId]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 900px)");
    const sync = () => { if (mq.matches) setHideBubbleControls(true); };
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  // Bottom canvas drawer: a full-width sheet that slides up from the bottom and
  // hosts a Canvas editor. Its doc and height are kept here so they survive
  // open/close.
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [canvasDoc, setCanvasDoc] = useState<CanvasDoc | null>(null);
  // Workflow persistence: the overview canvas is stored as `workflow_canvases`
  // on the sleep setup config. Load it once so edits survive reload, and expose
  // a Save that PUTs it back (the endpoint needs `config`, so we round-trip it).
  const [workflowSaving, setWorkflowSaving] = useState(false);
  const [workflowSaved, setWorkflowSaved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/setup/sleep");
        if (!res.ok) return;
        const { workflowCanvases } = (await res.json()) as {
          workflowCanvases?: Array<{ canvas_id?: string; name?: string; sort_order?: number; canvas: CanvasDoc["canvases"][number] }>;
        };
        if (cancelled || !Array.isArray(workflowCanvases) || workflowCanvases.length === 0) return;
        const canvases = [...workflowCanvases]
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((row) => ({ ...row.canvas, id: row.canvas_id || row.canvas.id, name: row.name || row.canvas.name }));
        setCanvasDoc({ version: 2, activeId: canvases[0].id, canvases });
      } catch {
        /* keep the seeded default */
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const saveWorkflow = useCallback(async () => {
    if (!canvasDoc || workflowSaving) return;
    setWorkflowSaving(true);
    try {
      // The PUT requires `config`; fetch the current one so we don't clobber it.
      const cur = await fetch("/api/admin/setup/sleep");
      const config = (cur.ok ? (await cur.json())?.config : null) ?? {};
      const workflowCanvases = canvasDoc.canvases.map((canvas, index) => ({
        canvas_id: canvas.id,
        name: canvas.name,
        sort_order: index,
        canvas,
      }));
      const res = await fetch("/api/admin/setup/sleep", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, workflowCanvases }),
      });
      if (res.ok) {
        setWorkflowSaved(true);
        setTimeout(() => setWorkflowSaved(false), 1800);
      }
    } catch {
      /* best-effort */
    } finally {
      setWorkflowSaving(false);
    }
  }, [canvasDoc, workflowSaving]);
  // Bottom workflow drawer: open at ~1/3 of the viewport height.
  const [canvasHeight, setCanvasHeight] = useState(360);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setCanvasHeight(Math.round(window.innerHeight / 3));
  }, []);
  // When the bottom drawer opens/resizes, nudge fillHeight canvases (e.g. the
  // Policy canvas in the right drawer) to re-measure against the newly reserved
  // bottom space. They listen for window resize; dispatch one after layout.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(id);
  }, [canvasOpen, canvasHeight]);
  // Secondary right-side panels share ONE drawer; multiple open ones become tabs.
  const [openDrawers, setOpenDrawers] = useState<DrawerId[]>([]);
  const [activeDrawer, setActiveDrawer] = useState<DrawerId | null>(null);
  // Live simulation controls, lifted from SimulationPanel so Pause/Stop can dock
  // in the drawer tab bar (next to ×) while a run is in progress — or float when
  // the drawer is closed so the run stays controllable.
  const [simRunControls, setSimRunControls] = useState<SimRunControls | null>(null);
  // The Model Setup pane's container inside the drawer. The page-level SetupBar
  // portals its docked view here; keeping SetupBar mounted at the page level (not
  // inside the drawer) lets its popped-out floating window survive drawer close.
  const [modelSetupSlot, setModelSetupSlot] = useState<HTMLElement | null>(null);
  // Simulation pane slot — same pattern as Model Setup so a live run survives
  // the drawer closing.
  const [simulationSlot, setSimulationSlot] = useState<HTMLElement | null>(null);
  // Height reserved at the top of the frame for the top-docked Model Setup window
  // so the chat and side panels reflow below it instead of hiding behind it.
  const [topDockH, setTopDockH] = useState(0);
  const openDrawer = useCallback((id: DrawerId) => {
    // Non-admins can never open the internal panels, even if some stray caller
    // asks for one.
    if (!isAdmin && ADMIN_ONLY_DRAWERS.includes(id)) return;
    // Opening any function panel opens the whole set, so the desktop drawer
    // always shows all tabs (the clicked one becomes active). Non-admins get the
    // set with the admin-only panels filtered out. Chats/Account are mobile-only
    // sheet tabs and open on their own.
    if (PANEL_TABS.includes(id)) {
      const panelTabs = isAdmin
        ? PANEL_TABS
        : PANEL_TABS.filter((d) => !ADMIN_ONLY_DRAWERS.includes(d));
      setOpenDrawers((prev) => {
        const extras = prev.filter((d) => !PANEL_TABS.includes(d));
        return [...panelTabs, ...extras];
      });
    } else {
      setOpenDrawers((prev) => (prev.includes(id) ? prev : [...prev, id]));
    }
    setActiveDrawer(id);
  }, [isAdmin]);
  const closeDrawer = useCallback((id: DrawerId) => {
    setOpenDrawers((prev) => {
      const next = prev.filter((d) => d !== id);
      setActiveDrawer((cur) => (cur === id ? next[next.length - 1] ?? null : cur));
      return next;
    });
  }, []);
  const closeAllDrawers = useCallback(() => {
    setOpenDrawers([]);
    setActiveDrawer(null);
  }, []);
  const [turns, setTurns] = useState<Turn[]>([]); // observability trace, one per send
  // Turn ids that extracted at least one piece of state this turn — drives which
  // replies show a "State" button (and it highlights those exact fields).
  const stateTurnIds = useMemo(
    () => new Set(turnExtractedStateKeys(turns).keys()),
    [turns]
  );
  // The latest completed turn (drives the live workflow-stage highlight).
  const lastCompletedTurn = useMemo<Turn | null>(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.finalAnswer != null || t.error != null) return t;
    }
    return null;
  }, [turns]);
  // Clicking an assistant bubble opens Observability and expands that turn's
  // trace. `n` bumps on every click so re-clicking the same bubble re-focuses.
  const [traceFocus, setTraceFocus] = useState<{ id: string; n: number }>({
    id: "",
    n: 0,
  });
  const focusTrace = useCallback(
    (turnId: string) => {
      if (!isAdmin) return; // Observability is admin-only.
      setTraceFocus((prev) => ({ id: turnId, n: prev.n + 1 }));
      openDrawer("observability");
    },
    [isAdmin, openDrawer]
  );
  // Policy-canvas trace focus: clicking a reply's "Policy trace" button opens
  // Model Setup (which lands on Policy) and re-animates that specific turn's path
  // on the canvas. `n` bumps each click so re-clicking the same reply re-fires.
  const [policyFocus, setPolicyFocus] = useState<{ id: string; n: number }>({
    id: "",
    n: 0,
  });
  const focusPolicy = useCallback(
    (turnId: string) => {
      if (!isAdmin) return; // Model Setup / Policy is admin-only.
      openDrawer("modelsetup");
      // Also open the workflow so its stage highlight (following this turn) is visible.
      setCanvasOpen(true);
      setPolicyFocus((prev) => ({ id: turnId, n: prev.n + 1 }));
    },
    [isAdmin, openDrawer]
  );
  // Workflow-stage highlight: normally the latest completed turn, but when a
  // reply's Policy trace is opened, it follows THAT turn — so the Overall Workflow
  // canvas highlights the stage the traced node belongs to.
  const workflowTurn = useMemo<Turn | null>(() => {
    if (policyFocus.id) {
      const t = turns.find((x) => x.id === policyFocus.id);
      if (t) return t;
    }
    return lastCompletedTurn;
  }, [policyFocus.id, turns, lastCompletedTurn]);
  const workflowFireSignal = useMemo<CanvasFireSignal | null>(() => {
    const stage = deriveWorkflowStage(workflowTurn);
    if (!stage || !workflowTurn) return null;
    // Find the stage node by workflowStageId in the live doc (seed or saved).
    const wfDoc = canvasDoc ?? BOTTOM_WORKFLOW_SEED;
    for (const canvas of wfDoc.canvases) {
      const node = canvas.graph.nodes.find(
        (n) => (n.data as Record<string, unknown>)?.workflowStageId === stage
      );
      if (node) {
        return {
          // Include the focus nonce so re-clicking a bubble's Policy trace re-fires.
          id: `${workflowTurn.id}#wf-${stage}#${policyFocus.n}`,
          tools: [],
          exactNodeRefs: [{ nodeId: node.id, canvasId: canvas.id }],
        };
      }
    }
    return null;
  }, [workflowTurn, canvasDoc, policyFocus.n]);
  // State-panel focus: clicking a reply's "State" button opens Model Setup on the
  // State section and highlights the fields that reply extracted.
  const [stateFocus, setStateFocus] = useState<{ id: string; n: number }>({
    id: "",
    n: 0,
  });
  const focusState = useCallback(
    (turnId: string) => {
      if (!isAdmin) return; // Model Setup / State is admin-only.
      openDrawer("modelsetup");
      setStateFocus((prev) => ({ id: turnId, n: prev.n + 1 }));
    },
    [isAdmin, openDrawer]
  );
  // Clicking a workflow stage opens Model Setup → Policy and selects that stage's
  // dedicated policy canvas (Intake → Sleep Intake, Assess → Assess, …).
  const [policyCanvasSelect, setPolicyCanvasSelect] = useState<{ canvasId: string; n: number }>({
    canvasId: "",
    n: 0,
  });
  const onWorkflowStageClick = useCallback(
    (stageId: string) => {
      if (!isAdmin) return;
      const canvasId = WORKFLOW_STAGE_POLICY_CANVAS[stageId] ?? "main";
      openDrawer("modelsetup");
      setPolicyCanvasSelect((prev) => ({ canvasId, n: prev.n + 1 }));
    },
    [isAdmin, openDrawer]
  );
  const [feedbackMode, setFeedbackMode] = useState(false); // per-bubble feedback
  const [feedbackByIdx, setFeedbackByIdx] = useState<Record<number, FeedbackEntry[]>>({});
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(300); // px, resizable
  // Right drawer width. `null` means "use the CSS default" (half the screen, via
  // `--obs-w` falling back to 50vw) — so the drawer opens at half the screen by
  // default, immune to persistence/effect races. A number is set only once the
  // user actually drags to resize, and that px width is what we persist.
  const [obsWidth, setObsWidth] = useState<number | null>(null);
  // Right drawer resize bounds, derived from the viewport on mount (kept in state
  // to avoid touching `window` during SSR/hydration). `def` = half the screen.
  const [obsBounds, setObsBounds] = useState({ min: 320, max: 680, def: 400 });
  // restore persisted drawer widths (client-only, avoids hydration mismatch)
  useEffect(() => {
    const s = Number(localStorage.getItem("ra-sidebar-w"));
    if (s) setSidebarWidth(Math.max(240, Math.min(520, s)));
    // Half the screen is the default width; allow dragging up to 75% of it.
    const half = Math.round(window.innerWidth / 2);
    const min = 320;
    const max = Math.max(half, Math.round(window.innerWidth * 0.75));
    setObsBounds({ min, max, def: half });
    // Only adopt a persisted width if the user previously resized; otherwise stay
    // null so the CSS 50vw default applies.
    const o = Number(localStorage.getItem("ra-obs-w2"));
    if (o) setObsWidth(Math.max(min, Math.min(max, o)));
  }, []);
  useEffect(() => {
    localStorage.setItem("ra-sidebar-w", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    if (obsWidth != null) localStorage.setItem("ra-obs-w2", String(obsWidth));
  }, [obsWidth]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Hydrate TTS preference from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setAutoSpeak(window.localStorage.getItem(TTS_PREF_KEY) === "1");
    } catch {
      // localStorage may throw in private mode — safe to ignore.
    }
  }, []);

  // Persist TTS preference; stop any playing audio when the user turns it off.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(TTS_PREF_KEY, autoSpeak ? "1" : "0");
    } catch {
      // ignore
    }
    if (!autoSpeak) stopSpeaking();
  }, [autoSpeak, stopSpeaking]);

  // Play the newest assistant reply when speakNextAssistantRef was armed by send().
  // The flag ensures we only speak fresh replies, not history loaded on convo switch.
  useEffect(() => {
    if (!speakNextAssistantRef.current) return;
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "ai") return;
    speakNextAssistantRef.current = false;
    if (!autoSpeakRef.current) return;
    const clean = stripMarkdownForSpeech(last.text);
    if (clean) void speak(clean);
  }, [messages, speak]);

  // Voice input: browser SpeechRecognition streams interim text live while the
  // user speaks, MediaRecorder + Whisper produces the final canonical transcript
  // on stop, and any pre-existing typed input is preserved as a prefix.
  const voiceBaselineRef = useRef("");
  const joinVoice = (base: string, spoken: string) => {
    const b = base.trim();
    const s = spoken.trim();
    if (!b) return s;
    if (!s) return b;
    return `${b} ${s}`;
  };
  const { isRecording, isTranscribing, toggle: toggleMicInner } = useVoiceRecorder({
    onInterim: (text) => {
      setInput(joinVoice(voiceBaselineRef.current, text));
    },
    onTranscript: (text) => {
      const combined = joinVoice(voiceBaselineRef.current, text);
      voiceBaselineRef.current = "";
      void send(combined);
    },
    onError: (msg) => {
      // Roll the input back to whatever they had typed before hitting the mic
      // so a failed voice attempt doesn't destroy their draft.
      setInput(voiceBaselineRef.current);
      voiceBaselineRef.current = "";
      setMessages((prev) => [...prev, { role: "ai", text: `Voice input: ${msg}` }]);
    },
  });
  const toggleMic = useCallback(() => {
    // Snapshot the current typed input before we start recording so we can
    // (a) prefix live interim text with it, and (b) restore it on error.
    if (!isRecording) {
      voiceBaselineRef.current = input;
    }
    toggleMicInner();
  }, [isRecording, input, toggleMicInner]);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations?topic=sleep");
      if (!res.ok) { setConvos([]); return; }
      const { conversations } = (await res.json()) as {
        conversations: Array<{ id: string; title: string; updated_at?: string; turn_count?: number; scenario?: string | null }>;
      };
      setConvos((conversations ?? []).map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updated_at,
        turnCount: c.turn_count,
        scenario: c.scenario,
      })));
    } catch {
      setConvos([]);
    } finally {
      setConvosLoaded(true);
    }
  }, []);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  const loadMessages = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}/messages`);
      if (!res.ok) { setMessages([]); setTurns([]); return; }
      const { messages: rows } = (await res.json()) as {
        messages: Array<{
          id: string;
          role: string;
          content: string;
          created_at?: string;
          // Persisted per-turn observability metadata on assistant messages.
          trace?: {
            trace?: TimedTraceEvent[];
            nodeRefs?: { nodeId: string; canvasId?: string }[];
            state?: Record<string, unknown>;
          } | null;
        }>;
      };
      // Rebuild both the visible thread and the Observability `turns` so a
      // reopened conversation replays its trace and re-animates the policy canvas
      // (nodeRefs), instead of only working for messages sent this session.
      const rebuiltMessages: Message[] = [];
      const rebuiltTurns: Turn[] = [];
      let lastUserText = "";
      let lastUserIdx = -1;
      for (const m of rows ?? []) {
        if (m.role === "user") {
          lastUserText = m.content;
          rebuiltMessages.push({ role: "user", text: m.content });
          lastUserIdx = rebuiltMessages.length - 1;
          continue;
        }
        const meta = m.trace && typeof m.trace === "object" ? m.trace : null;
        let turnId: string | undefined;
        if (meta) {
          const startedAt = m.created_at ? Date.parse(m.created_at) : 0;
          turnId = m.id;
          rebuiltTurns.push({
            id: turnId,
            userMessage: lastUserText,
            startedAt,
            finalAnswer: m.content,
            state: meta.state,
            nodeRefs: meta.nodeRefs,
            trace: (meta.trace ?? []).map((e) => ({
              ...e,
              tMs: (e as { ts?: number }).ts ?? startedAt,
            })),
          });
          // Give the preceding patient message the same turn id so its bubble can
          // open the same turn's State/Feedback after a reload.
          if (lastUserIdx >= 0) rebuiltMessages[lastUserIdx].turnId = turnId;
        }
        rebuiltMessages.push({ role: "ai", text: m.content, turnId });
        lastUserIdx = -1;
      }
      setMessages(rebuiltMessages);
      setTurns(rebuiltTurns);
    } catch {
      setMessages([]);
      setTurns([]);
    }
  }, []);

  // Load any feedback already left on this conversation's bubbles. A message can
  // hold several signals (score, text_correction, correct_output, comment), so
  // entries are grouped into an array per message index.
  const loadFeedback = useCallback(async (id: string) => {
    setFeedbackByIdx({});
    try {
      const res = await fetch(`/api/feedback?conversationId=${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const { feedback } = (await res.json()) as {
        feedback: Array<{
          message_index: number;
          rating: number | null;
          signal: FeedbackSignal | null;
          comment: string | null;
        }>;
      };
      const map: Record<number, FeedbackEntry[]> = {};
      for (const f of feedback ?? []) {
        (map[f.message_index] ??= []).push({
          rating: f.rating === 1 || f.rating === -1 ? f.rating : null,
          signal: f.signal ?? null,
          comment: f.comment ?? "",
        });
      }
      setFeedbackByIdx(map);
    } catch {
      /* best-effort — leave indicators empty */
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || typing) return;
      setInput("");
      // Any in-flight TTS should stop when the user sends a new message.
      stopSpeaking();
      // If voice replies are on, mark the next assistant message to be spoken.
      speakNextAssistantRef.current = autoSpeakRef.current;

      // Observability: ask the endpoint for the REAL server-side trace
      // (system prompt, model, every OpenAI round-trip) instead of faking it.
      const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      // Show the user message and open an observability turn up front, so even
      // a failure before the chat call (e.g. creating the conversation) is
      // visible in the thread and the trace — never a silent "nothing happens".
      // The user message shares the turn's id so its bubble can open the same
      // turn's State/Feedback (the state is extracted from what the patient said).
      setMessages((prev) => [...prev, { role: "user", text: trimmed, turnId }]);
      setTyping(true);
      setStreaming("");

      const startedAt = Date.now();
      setTurns((prev) => [
        ...prev,
        { id: turnId, userMessage: trimmed, startedAt, trace: [] },
      ]);
      const finishTurn = (patch: Partial<Turn>) =>
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, ...patch } : t))
        );

      try {
        let conversationId = activeIdRef.current;
        if (!conversationId) {
          const simTitle = simulationTitleRef.current;
          simulationTitleRef.current = null;
          const simScenario = simulationScenarioRef.current;
          simulationScenarioRef.current = null;
          const res = await fetch("/api/conversations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: simTitle ?? trimmed.slice(0, 60),
              topic: "sleep",
              // Persist the scenario for simulation runs (null for hand-typed chats).
              ...(simScenario !== null ? { scenario: simScenario } : {}),
            }),
          });
          if (!res.ok) {
            throw new Error(`Couldn't start a conversation (HTTP ${res.status}).`);
          }
          const { id } = await res.json();
          conversationId = id as string;
          setActiveId(conversationId);
          // Write the ref synchronously so the next send() in a simulation loop
          // (which reuses this same closure) targets this conversation instead
          // of creating another one.
          activeIdRef.current = conversationId;
          await loadConversations();
        }

        setTypingLabel("Thinking…");
        const res = await fetch("/api/chat/sleep/base", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            userMessage: trimmed,
            trace: true,
            stream: true,
          }),
        });
        if (!res.ok || !res.body) {
          throw new Error(`Chat request failed (HTTP ${res.status}).`);
        }

        // Read the SSE stream: "stage" events update the live description while the
        // turn runs; the single "result" event carries the final answer + trace.
        type ResultPayload = {
          content?: string;
          trace?: TimedTraceEvent[];
          state?: Record<string, unknown>;
          nodeRefs?: { nodeId: string; canvasId?: string }[];
        };
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let data: ResultPayload | null = null;
        let streamError: string | null = null;
        readLoop: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) >= 0) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const eventName = /^event: (.+)$/m.exec(rawEvent)?.[1];
            const dataLine = /^data: (.+)$/m.exec(rawEvent)?.[1];
            if (!dataLine) continue;
            const payload = JSON.parse(dataLine);
            if (eventName === "stage") {
              setTypingLabel(payload.text ?? "");
            } else if (eventName === "result") {
              data = payload as ResultPayload;
            } else if (eventName === "error") {
              streamError = payload.error ?? "Chat request failed.";
              break readLoop;
            }
          }
        }
        if (streamError) {
          throw new Error(streamError);
        }
        if (!data) {
          throw new Error("Chat request ended without a response.");
        }
        const answer = data.content ?? "";
        // Prefer the server-provided wall-clock (ts) so each row shows true
        // per-call latency; fall back to arrival time for older payloads.
        const stamped = (data.trace ?? []).map((e) => ({
          ...e,
          tMs: (e as { ts?: number }).ts ?? Date.now(),
        }));
        setMessages((prev) => [...prev, { role: "ai", text: answer, turnId }]);
        setStreaming("");
        loadConversations();
        finishTurn({
          finalAnswer: answer,
          trace: stamped,
          state: data.state,
          nodeRefs: data.nodeRefs,
        });
        return answer;
      } catch (err) {
        const message =
          err instanceof Error && err.message.trim()
            ? err.message.trim()
            : "Something went wrong while sending the message.";
        setMessages((prev) => [...prev, { role: "ai", text: message, turnId }]);
        setStreaming("");
        finishTurn({
          error: message,
          trace: [
            {
              kind: "openai_response",
              loop: 0,
              content: message,
              toolCalls: [],
              finishReason: "error",
              tMs: Date.now(),
            },
          ],
        });
        return message;
      } finally {
        setTyping(false);
        setTypingLabel("");
      }
    },
    [activeId, typing, loadConversations, stopSpeaking]
  );

  // Clears the thread + observability turns (which resets the policy-canvas trace
  // animation, since it's driven off the latest completed turn). Shared by the New
  // conversation button and by starting a simulation run.
  const resetConversation = () => {
    setActiveId(null);
    setMessages([]);
    setStreaming("");
    setInput("");
    setFeedbackByIdx({});
    setEditingIdx(null);
    setTurns([]); // reset the policy trace / observability
    speakNextAssistantRef.current = false;
    stopSpeaking();
  };
  const onNew = () => {
    resetConversation();
    setMenuOpen(false);
    // Start clean: hide all the panels (Model Setup / Observability / Simulation)
    // and the workflow canvas by default.
    closeAllDrawers();
    setCanvasOpen(false);
    setTimeout(() => inputRef.current?.focus(), 30);
  };
  // Start a fresh, empty conversation for a simulation run. The actual
  // conversation row is created lazily by the first send() (titled via
  // simulationTitleRef), so the whole run flows through the real chat pipeline —
  // messages land in the main window, the trace fills Observability, and the
  // policy canvas animates, exactly like a hand-typed conversation.
  const beginSimulation = useCallback(
    (scenario: string, turns: number) => {
      // Reset the thread + policy trace, but KEEP the Simulation panel open (unlike
      // the New conversation button, which hides the panels).
      resetConversation();
      // Title encodes the run's turn count + scenario so the Simulation panel's run
      // list can show them: "Simulation · {n} turns · {scenario}".
      const label = scenario.trim().slice(0, 80) || "Improvised patient";
      const plural = turns === 1 ? "turn" : "turns";
      simulationTitleRef.current = `Simulation · ${turns} ${plural} · ${label}`;
      // Save the exact scenario that drove the run (empty string for improvised).
      simulationScenarioRef.current = scenario;
    },
    // resetConversation is a stable inline function defined every render; the values
    // it touches are all setState/refs, so it's safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Simulation runs live in the Simulation panel's own list, not the main sidebar
  // conversation list. Split the conversations so each surface shows its own set.
  const simulationRuns = useMemo(
    () => convos.filter((c) => c.title.startsWith(SIM_TITLE_PREFIX)),
    [convos]
  );
  const regularConvos = useMemo(
    () => convos.filter((c) => !c.title.startsWith(SIM_TITLE_PREFIX)),
    [convos]
  );

  const onSelect = (id: string) => {
    setActiveId(id);
    setStreaming("");
    setEditingIdx(null);
    speakNextAssistantRef.current = false;
    stopSpeaking();
    loadMessages(id);
    loadFeedback(id);
    setMenuOpen(false);
  };
  const onRename = async (id: string, title: string) => {
    const next = title.trim();
    if (!next) return;
    // Optimistic — update the list immediately, then persist.
    setConvos((prev) => prev.map((c) => (c.id === id ? { ...c, title: next } : c)));
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
    } catch {
      // network error — reload to resync titles with the server
      loadConversations();
    }
  };
  const onDelete = async (id: string) => {
    try {
      await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    } catch {
      // network error — fall through and remove locally anyway
    }
    setConvos((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) {
      setActiveId(null);
      setMessages([]);
      setStreaming("");
      setFeedbackByIdx({});
      setEditingIdx(null);
    }
  };

  const onDeleteMany = async (ids: string[]) => {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) return;
    await Promise.all(
      unique.map(async (id) => {
        try {
          await fetch(`/api/conversations/${id}`, { method: "DELETE" });
        } catch {
          // network error — still drop locally
        }
      })
    );
    const removed = new Set(unique);
    setConvos((prev) => prev.filter((c) => !removed.has(c.id)));
    if (activeId && removed.has(activeId)) {
      setActiveId(null);
      setMessages([]);
      setStreaming("");
      setFeedbackByIdx({});
      setEditingIdx(null);
    }
  };

  // ── Per-bubble feedback ────────────────────────────────────────────────
  const onToggleFeedback = (index: number) =>
    setEditingIdx((prev) => (prev === index ? null : index));

  // Surfaces a failed feedback save/delete instead of letting it fail silently.
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const onSaveFeedback = async (index: number, entries: FeedbackEntry[]) => {
    // Empty set means the expert cleared everything → treat as remove.
    if (entries.length === 0) {
      onRemoveFeedback(index);
      return;
    }
    const msg = messages[index];
    if (!activeId || !msg) {
      // No conversation to attach to yet — don't drop the input silently.
      setFeedbackError("Can't save feedback: no active conversation for this reply.");
      return;
    }
    // Optimistic update; reconciled/reverted based on the server response.
    setFeedbackByIdx((prev) => ({ ...prev, [index]: entries }));
    setEditingIdx(null);
    setFeedbackError(null);
    try {
      // Persist the full signal set; the server reconciles (upserts present
      // signals, deletes cleared ones).
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: activeId,
          messageIndex: index,
          messageRole: msg.role,
          messageExcerpt: msg.text,
          entries: entries.map((e) => ({
            signal: e.signal,
            rating: e.rating,
            comment: e.comment,
          })),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Feedback save failed (HTTP ${res.status}).`);
      }
    } catch (err) {
      console.error("[feedback] save failed", err);
      setFeedbackError(
        err instanceof Error ? err.message : "Feedback save failed. Please try again."
      );
    }
  };

  const onRemoveFeedback = async (index: number) => {
    setFeedbackByIdx((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setEditingIdx(null);
    if (!activeId) return;
    setFeedbackError(null);
    try {
      const res = await fetch(
        `/api/feedback?conversationId=${encodeURIComponent(activeId)}&messageIndex=${index}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Feedback delete failed (HTTP ${res.status}).`);
      }
    } catch (err) {
      console.error("[feedback] delete failed", err);
      setFeedbackError(
        err instanceof Error ? err.message : "Feedback delete failed. Please try again."
      );
    }
  };

  return (
    <div
      className={"ra-scope" + (monoTheme ? " ra-mono" : "")}
      onClick={() => {
        if (menuOpen) setMenuOpen(false);
        if (infoOpen) setInfoOpen(false);
      }}
    >
      {/* Splash overlay covers the app while it assembles, then fades out. */}
      <StudioSplash ready={roleLoaded && convosLoaded} />
      {/* Reserve space at the top (Model Setup top-dock) and bottom (canvas
          drawer) so the rest of the UI reflows into the remaining area instead of
          being covered — the bottom drawer pushes the chat up rather than
          overlaying it. */}
      <div
        className="app-frame"
        style={{
          ...(topDockH ? { paddingTop: topDockH } : {}),
          ...(canvasOpen ? { paddingBottom: canvasHeight } : {}),
          // Tell fillHeight canvases above the drawer how much bottom space is
          // reserved, so they shrink to fit instead of running under the drawer.
          // The bottom drawer overrides this back to 0 for its own canvas (CSS).
          ["--rf-fill-reserve-bottom" as string]: canvasOpen ? `${canvasHeight}px` : "0px",
        }}
      >
        <div className="body">
          {sidebarOpen ? (
            <>
              <Sidebar
                convos={regularConvos}
                activeId={activeId}
                onSelect={onSelect}
                onNew={onNew}
                onDelete={onDelete}
                onDeleteMany={onDeleteMany}
                onRename={onRename}
                query={query}
                setQuery={setQuery}
                menuOpen={menuOpen}
                setMenuOpen={setMenuOpen}
                infoOpen={infoOpen}
                setInfoOpen={setInfoOpen}
                onClose={() => setSidebarOpen(false)}
                onToggleFeedbackMode={() => setFeedbackMode((m) => !m)}
                feedbackMode={feedbackMode}
                monoTheme={monoTheme}
                onToggleMono={() => setMonoTheme((v) => !v)}
                userEmail={user?.email ?? ""}
                userImage={user?.imageUrl}
                isAdmin={isAdmin}
                onSignOut={signOut}
                width={sidebarWidth}
              />
              <ResizeHandle
                side="right"
                width={sidebarWidth}
                setWidth={setSidebarWidth}
                min={240}
                max={520}
                def={300}
              />
            </>
          ) : (
            <SidebarRail onExpand={() => setSidebarOpen(true)} onNew={onNew} />
          )}
          <main className="main">
            {feedbackMode && (activeId || messages.length > 0) ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "8px 0 0" }}>
                <span className="fb-banner">
                  Feedback mode — tap + under any message
                  <button onClick={() => { setFeedbackMode(false); setEditingIdx(null); }}>
                    Exit
                  </button>
                </span>
              </div>
            ) : null}
            {/* Show the thread as soon as there's a message, even before a
                conversation row exists — otherwise a failed conversation
                create would leave the user staring at the empty state. */}
            {activeId || messages.length > 0 ? <ThreadHeader /> : null}
            {activeId || messages.length > 0 ? (
              <Thread
                messages={messages}
                typing={typing}
                typingLabel={typingLabel}
                streaming={streaming}
                feedbackMode={feedbackMode}
                feedbackByIdx={feedbackByIdx}
                editingIdx={editingIdx}
                onToggleFeedback={onToggleFeedback}
                onSaveFeedback={onSaveFeedback}
                onRemoveFeedback={onRemoveFeedback}
                onOpenTrace={isAdmin ? focusTrace : undefined}
                onOpenPolicy={isAdmin ? focusPolicy : undefined}
                onOpenState={isAdmin ? focusState : undefined}
                stateTurnIds={stateTurnIds}
                allowFeedback={isAdmin}
                collapsedByIdx={collapsedByIdx}
                setCollapsedByIdx={setCollapsedByIdx}
                hideBubbleControls={hideBubbleControls}
              />
            ) : (
              <EmptyState onSuggest={send} compact={canvasOpen} />
            )}
            {feedbackError && (
              <div className="fb-error-toast" role="alert">
                <span>{feedbackError}</span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => setFeedbackError(null)}
                >
                  <Ic.Close size={14} />
                </button>
              </div>
            )}
            <Composer
              value={input}
              setValue={setInput}
              onSend={send}
              inputRef={inputRef}
              onExpertChat={() => openDrawer("expert")}
              onUpload={() => openDrawer("upload")}
              onMicToggle={toggleMic}
              isRecording={isRecording}
              isTranscribing={isTranscribing}
              autoSpeak={autoSpeak}
              onToggleAutoSpeak={() => setAutoSpeak((v) => !v)}
              isSpeaking={isSpeaking}
              onStopSpeaking={stopSpeaking}
              showThreadControls={messages.length > 0}
              allCollapsed={
                messages.length > 0 && messages.every((_, i) => !!collapsedByIdx[i])
              }
              onToggleCollapseAll={() => {
                if (messages.length > 0 && messages.every((_, i) => !!collapsedByIdx[i])) {
                  setCollapsedByIdx({});
                  return;
                }
                const next: Record<number, boolean> = {};
                for (let i = 0; i < messages.length; i++) next[i] = true;
                setCollapsedByIdx(next);
              }}
              hideBubbleControls={hideBubbleControls}
              onToggleHideBubbleControls={() => setHideBubbleControls((v) => !v)}
            />
          </main>

          {/* Right rail: Workflow launcher; admins also get Model Setup.
              Docked at the right edge when no drawer is open; when a drawer IS
              open it floats at the drawer's left edge and tracks its width. */}
          <RightRail
            panelOpen={openDrawers.length > 0}
            onTogglePanel={() =>
              openDrawers.length > 0 ? closeAllDrawers() : openDrawer("modelsetup")
            }
            isAdmin={isAdmin}
            canvasOpen={canvasOpen}
            onToggleCanvas={() => setCanvasOpen((v) => !v)}
            floating={openDrawers.length > 0}
            rightOffset={obsWidth ?? obsBounds.def}
          />
          {openDrawers.length === 0 && (
            <MobileNav
              onOpen={openDrawer}
              isAdmin={isAdmin}
            />
          )}
          {openDrawers.length > 0 && (
            <ResizeHandle
              side="left"
              width={obsWidth ?? obsBounds.def}
              setWidth={setObsWidth}
              min={obsBounds.min}
              max={obsBounds.max}
              def={obsBounds.def}
            />
          )}
          <RightDrawer
            open={openDrawers}
            active={activeDrawer}
            setActive={setActiveDrawer}
            onClose={closeDrawer}
            isAdmin={isAdmin}
            turns={turns}
            onClearTurns={() => setTurns([])}
            traceFocus={traceFocus}
            width={obsWidth ?? undefined}
            onDismiss={closeAllDrawers}
            chatsContent={
              <ChatsPane
                convos={regularConvos}
                activeId={activeId}
                onSelect={(id) => { onSelect(id); closeDrawer("chats"); }}
                onNew={() => { onNew(); closeDrawer("chats"); }}
                onDelete={onDelete}
                onDeleteMany={onDeleteMany}
                onRename={onRename}
                query={query}
                setQuery={setQuery}
              />
            }
            accountContent={
              <AccountPane
                userEmail={user?.email ?? ""}
                userImage={user?.imageUrl}
                isAdmin={isAdmin}
                feedbackMode={feedbackMode}
                monoTheme={monoTheme}
                onToggleMono={() => setMonoTheme((v) => !v)}
                onToggleFeedbackMode={() => { setFeedbackMode((m) => !m); closeDrawer("account"); }}
                onSignOut={signOut}
              />
            }
            modelSetupContent={<div className="drawer-pane" ref={setModelSetupSlot} />}
            simulationContent={<div className="drawer-pane" ref={setSimulationSlot} />}
            tabBarControls={
              simRunControls ? (
                <div className="sim-run-controls">
                  {simRunControls.paused ? (
                    <button type="button" className="sim-btn sim-btn-run" onClick={simRunControls.resume}>Resume</button>
                  ) : (
                    <button type="button" className="sim-btn" onClick={simRunControls.pause}>Pause</button>
                  )}
                  <button type="button" className="sim-btn" onClick={simRunControls.stop}>Stop</button>
                </div>
              ) : null
            }
            activeConversationId={activeId}
          />
          {/* Pause/Stop stay available while a run is in progress even if the
              drawer is closed (the tab bar is gone in that case). */}
          {simRunControls && openDrawers.length === 0 && (
            <div className="sim-run-controls-float" role="toolbar" aria-label="Simulation controls">
              <span className="sim-run-controls-float-label">
                {simRunControls.paused ? "Paused" : "Running"}
              </span>
              {simRunControls.paused ? (
                <button type="button" className="sim-btn sim-btn-run" onClick={simRunControls.resume}>Resume</button>
              ) : (
                <button type="button" className="sim-btn" onClick={simRunControls.pause}>Pause</button>
              )}
              <button type="button" className="sim-btn" onClick={simRunControls.stop}>Stop</button>
            </div>
          )}
          {/* SetupBar is mounted here (page level), not inside the drawer, so its
              popped-out floating window survives the drawer closing. It portals
              its docked view into the drawer's Model Setup slot when open. */}
          {isAdmin && <SetupBar turns={turns} slot={modelSetupSlot} onTopDockChange={setTopDockH} policyFocus={policyFocus} stateFocus={stateFocus} policyCanvasSelect={policyCanvasSelect} />}
          {/* SimulationPanel is mounted here (page level) for the same reason:
              closing the drawer must not tear down a live run or clear Pause/Stop. */}
          {isAdmin && (
            <SimulationPanel
              controller={{
                begin: beginSimulation,
                send,
                renameCurrent: (title) => {
                  const id = activeIdRef.current;
                  if (id) void onRename(id, title);
                },
              }}
              onRunControls={setSimRunControls}
              runs={simulationRuns}
              activeRunId={activeId}
              onSelectRun={onSelect}
              onDeleteRun={onDelete}
              slot={simulationSlot}
            />
          )}

          {/* Bottom canvas drawer. Its launcher lives in the right rail, under
              the Model Setup (drawer) icon — see RightRail. */}
          <BottomCanvasDrawer
            open={canvasOpen}
            onClose={() => setCanvasOpen(false)}
            height={canvasHeight}
            setHeight={setCanvasHeight}
            doc={canvasDoc}
            onDocChange={setCanvasDoc}
            onSave={saveWorkflow}
            saving={workflowSaving}
            saved={workflowSaved}
            fireSignal={workflowFireSignal}
            onStageClick={onWorkflowStageClick}
          />
        </div>
      </div>
    </div>
  );
}

/* ---------------- auth gate ---------------- */
// Mirror the other demos (e.g. app/demo/sleep/page.tsx): the chat APIs require a
// signed-in user, so gate the studio on real auth instead of faking a signed-in
// account. Unauthenticated visitors get the sign-in modal rather than a silent
// 401 the first time they send a message.
// Shown during the pre-login auth handshake (in StudioGate). Same logo + size +
// background as the post-login splash, so the brand mark stays put across the
// auth → setup transition. Matches the landing splash in app/page.tsx (size 120).
function StudioLoading() {
  return (
    <div className="flex flex-1 items-center justify-center bg-white">
      <SiteLogo size={120} href="/demo/sleep/studio" />
    </div>
  );
}

// Post-login splash: an overlay that holds the brand logo for at least 3s while
// the studio assembles behind it, then fades out over 700ms and unmounts —
// mirroring the landing-page splash so the two feel like one continuous screen.
function StudioSplash({ ready }: { ready: boolean }) {
  const [phase, setPhase] = useState<"hold" | "fading" | "gone">("hold");
  const [minElapsed, setMinElapsed] = useState(false);
  // Drives the logo's fade-IN: starts hidden, flips visible on the next frame so
  // the opacity transition runs. The overlay's own opacity handles the fade-OUT.
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), 3000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (phase !== "hold" || !ready || !minElapsed) return;
    setPhase("fading");
    const t = setTimeout(() => setPhase("gone"), 700);
    return () => clearTimeout(t);
  }, [phase, ready, minElapsed]);

  if (phase === "gone") return null;

  return (
    <div
      className={
        "fixed inset-0 z-[200] flex items-center justify-center transition-opacity duration-700 " +
        // Block clicks to the still-assembling app while holding; let them pass
        // through once it starts fading so the revealed UI is immediately usable.
        (phase === "fading" ? "pointer-events-none opacity-0" : "opacity-100")
      }
      style={{ backgroundColor: "#ffffff" }}
    >
      <div
        className={
          "transition-opacity duration-700 " + (entered ? "opacity-100" : "opacity-0")
        }
      >
        <SiteLogo size={120} href="/demo/sleep/studio" />
      </div>
    </div>
  );
}

function StudioGate() {
  const { user, loading } = useAuth();

  if (loading) {
    return <StudioLoading />;
  }

  if (!user) {
    return <AuthModal />;
  }

  return <SleepStudioChat />;
}

export default function SleepStudioPage() {
  return (
    <AuthProvider>
      <div className="flex flex-col" style={{ height: "100dvh" }}>
        <StudioGate />
      </div>
    </AuthProvider>
  );
}
