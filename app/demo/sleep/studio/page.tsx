"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import "./ra-theme.css";
import { Ic, type IconName } from "./ra-icons";
import { Avatar } from "./ra-shared";
import {
  ACTION_CHIPS,
  SUGGESTIONS,
} from "./sleep-data";
import { RightDrawer, DRAWER_LABEL, type DrawerId } from "./RightDrawer";
import { SetupBar } from "./config/page";
import { FeedbackControls, type FeedbackEntry, type FeedbackSignal } from "./FeedbackControls";
import type { Turn, TimedTraceEvent } from "../../../components/trace/TraceView";
import { AuthProvider, useAuth } from "../../../context/AuthContext";
import AuthModal from "../../../components/AuthModal";
import SiteLogo from "../../../components/SiteLogo";
import { useVoiceRecorder, useTTS } from "./useVoice";
import Canvas, { type CanvasDoc } from "../../../components/canvas/Canvas";
import { WORKFLOW_CANVAS_NODE_KINDS } from "../../../components/canvas/node-kinds";
import {
  WORKFLOW_OVERVIEW_CANVAS_MARKER,
  WORKFLOW_OVERVIEW_CANVAS_NAME,
} from "@airlab/orchestration-core/general-orchestration";

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
}
interface Conversation {
  id: string;
  title: string;
}

// The function panels shown as drawer tabs on desktop. Opening any one of them
// opens the whole set (see openDrawer) so all tabs are visible.
const PANEL_TABS: DrawerId[] = ["modelsetup", "observability" /*, "expert", "upload" */];

// Panels that expose internal wiring (model/prompt setup, step-by-step traces).
// Only admins may see or open these; non-admins get the plain chat surface.
const ADMIN_ONLY_DRAWERS: DrawerId[] = ["modelsetup", "observability"];

const ADMIN_ITEMS = [
  // { icon: "Grid", label: "Admin dashboard", href: "/demo/sleep/expert-dashboard" },
  { icon: "Sliders", label: "Model setup", href: "/demo/sleep/studio/config" },
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
 * kebab-open and inline-rename state locally; a fixed overlay closes the menu
 * on any outside click (same pattern as the topbar demo menu).
 */
function ConvList({
  convos,
  activeId,
  query,
  onSelect,
  onDelete,
  onRename,
}: {
  convos: Conversation[];
  activeId: string | null;
  query: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [kebabId, setKebabId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
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

  if (convos.length === 0) {
    return (
      <div className="conv-empty">
        <div className="ce-orb"><Ic.Chat size={18} /></div>
        <p>No conversations yet.<br />Start one below.</p>
      </div>
    );
  }

  return (
    <div className="conv-list">
      {kebabId && (
        <div
          onClick={() => setKebabId(null)}
          style={{ position: "fixed", inset: 0, zIndex: 20 }}
          aria-hidden="true"
        />
      )}
      {filtered.map((c) => (
        <div
          key={c.id}
          className={"conv-item" + (c.id === activeId ? " active" : "")}
          onClick={() => renamingId !== c.id && onSelect(c.id)}
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
              <span className="conv-title">{c.title}</span>
              <button
                className={"conv-kebab" + (kebabId === c.id ? " open" : "")}
                onClick={(e) => {
                  e.stopPropagation();
                  setKebabId((prev) => (prev === c.id ? null : c.id));
                }}
              >
                <Ic.Dots size={16} />
              </button>
              {kebabId === c.id && (
                <div className="conv-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                  <button className="pop-row" onClick={() => startRename(c)}>
                    <span className="ic"><Ic.Edit size={16} /></span>Rename
                  </button>
                  <button
                    className="pop-row danger"
                    onClick={() => { setKebabId(null); onDelete(c.id); }}
                  >
                    <span className="ic"><Ic.Trash size={16} /></span>Delete
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ))}
      {filtered.length === 0 && (
        <div className="conv-empty"><p>No matches.</p></div>
      )}
    </div>
  );
}

function Sidebar({
  convos,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  query,
  setQuery,
  menuOpen,
  setMenuOpen,
  infoOpen,
  setInfoOpen,
  onClose,
  onOpenObservability,
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
  onRename: (id: string, title: string) => void;
  query: string;
  setQuery: (v: string) => void;
  menuOpen: boolean;
  setMenuOpen: (fn: (o: boolean) => boolean) => void;
  infoOpen: boolean;
  setInfoOpen: (fn: (o: boolean) => boolean) => void;
  onClose: () => void;
  onOpenObservability: () => void;
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
        <button className="icon-btn side-close" title="Collapse sidebar" onClick={onClose}>
          <Ic.Panel size={17} />
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

      <div className="recent-head">
        <Ic.Clock size={13} /> Recent
        <span className="chev"><Ic.Chevron size={13} /></span>
      </div>

      <ConvList
        convos={convos}
        activeId={activeId}
        query={query}
        onSelect={onSelect}
        onDelete={onDelete}
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
                    onClick={() => { setMenuOpen(() => false); onOpenObservability(); }}
                  >
                    <span className="ic"><Ic.Grid size={17} /></span>Observability
                  </button>
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
                {isAdmin && <span className="role-pill">ADMIN</span>}
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
  onRename,
  query,
  setQuery,
}: {
  convos: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
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
      <div className="recent-head">
        <Ic.Clock size={13} /> Recent
      </div>
      <ConvList
        convos={convos}
        activeId={activeId}
        query={query}
        onSelect={onSelect}
        onDelete={onDelete}
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
  onOpenObservability,
  onToggleFeedbackMode,
  onSignOut,
}: {
  userEmail: string;
  userImage?: string;
  isAdmin: boolean;
  feedbackMode: boolean;
  monoTheme: boolean;
  onToggleMono: () => void;
  onOpenObservability: () => void;
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
            {isAdmin && <span className="role-pill">ADMIN</span>}
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
            <button className="pop-row" onClick={onOpenObservability}>
              <span className="ic"><Ic.Grid size={17} /></span>Observability
            </button>
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
  autoSpeak,
  onToggleAutoSpeak,
  isSpeaking,
  onStopSpeaking,
}: {
  onOpen: (id: DrawerId) => void;
  isAdmin: boolean;
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
  isSpeaking: boolean;
  onStopSpeaking: () => void;
}) {
  return (
    <nav className="mobile-railnav" aria-label="Panels">
      <VoiceReplyButton
        className="mrail-btn"
        iconSize={15}
        autoSpeak={autoSpeak}
        onToggleAutoSpeak={onToggleAutoSpeak}
        isSpeaking={isSpeaking}
        onStopSpeaking={onStopSpeaking}
      />
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
  autoSpeak,
  onToggleAutoSpeak,
  isSpeaking,
  onStopSpeaking,
  floating = false,
  rightOffset,
}: {
  panelOpen: boolean;
  onTogglePanel: () => void;
  isAdmin: boolean;
  canvasOpen: boolean;
  onToggleCanvas: () => void;
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
  isSpeaking: boolean;
  onStopSpeaking: () => void;
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
      {/* Panel icon = toggle: opens the right drawer when closed, closes it when
          open. Highlighted while the drawer is open. */}
      {isAdmin && (
        <button
          className={"rail-btn" + (panelOpen ? " on" : "")}
          title={panelOpen ? "Close panel" : "Open Model Setup"}
          aria-label={panelOpen ? "Close panel" : "Open Model Setup"}
          aria-pressed={panelOpen}
          onClick={onTogglePanel}
        >
          <Ic.Panel size={18} />
        </button>
      )}
      {/* Workflow launcher, docked in the rail directly under the drawer icon. */}
      <button
        className={"rail-btn" + (canvasOpen ? " on" : "")}
        title={canvasOpen ? "Close workflow" : "Open workflow"}
        aria-label={canvasOpen ? "Close workflow" : "Open workflow"}
        aria-pressed={canvasOpen}
        onClick={onToggleCanvas}
      >
        <Ic.Workflow size={18} />
      </button>
      <VoiceReplyButton
        className="rail-btn"
        autoSpeak={autoSpeak}
        onToggleAutoSpeak={onToggleAutoSpeak}
        isSpeaking={isSpeaking}
        onStopSpeaking={onStopSpeaking}
      />
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
        <div className="th-sub">Here to help you rest</div>
      </div>
    </div>
  );
}

/* Speaker (voice-reply) toggle used inside the docked right rail and mobile nav.
   `className` is passed in so it inherits the surrounding rail's button style
   (`.rail-btn` on desktop, `.mrail-btn` on mobile) — same 12px rounded square
   as the neighbouring Panel button. */
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
      style={autoSpeak ? { color: "var(--accent, #F05025)" } : { opacity: 0.7 }}
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

function Bubble({ m }: { m: Message }) {
  if (m.role === "user") return <div className="msg-user">{m.text}</div>;
  return (
    <div className="msg-ai">
      <Avatar kind="assistant" size={28} mono="SA" />
      <div className="bubble">
        {m.text}
      </div>
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
}: {
  m: Message;
  index: number;
  feedbackMode: boolean;
  entries: FeedbackEntry[];
  editing: boolean;
  onToggle: (index: number) => void;
  onSave: (index: number, entries: FeedbackEntry[]) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="msg-block">
      <Bubble m={m} />
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
}) {
  const endRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to the latest message as the conversation grows — but NOT when
  // a feedback editor opens (editingIdx), or it would jump away from the bubble
  // you just clicked. The editor renders inline under that bubble, already in view.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, typing, streaming]);
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
            sourceHandle: "workflow-next-2",
            targetHandle: "workflow-previous-2",
          },
          {
            id: "e-assess-guide",
            source: "wf-stage-assess",
            target: "wf-stage-guide",
            sourceHandle: "workflow-next-2",
            targetHandle: "workflow-previous-2",
          },
          {
            id: "e-guide-followup",
            source: "wf-stage-guide",
            target: "wf-stage-followup",
            sourceHandle: "workflow-next-2",
            targetHandle: "workflow-previous-2",
          },
          {
            id: "e-followup-assess-loop",
            source: "wf-stage-followup",
            target: "wf-stage-assess",
            label: "loop / return",
            sourceHandle: "workflow-loop-2",
            targetHandle: "workflow-loop-target-2",
          },
        ],
      },
    },
  ],
};

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
}: {
  open: boolean;
  onClose: () => void;
  height: number;
  setHeight: (h: number) => void;
  doc: CanvasDoc | null;
  onDocChange: (doc: CanvasDoc) => void;
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
        onDoubleClick={() => setHeight(Math.round(window.innerHeight * 0.55))}
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
          fillHeight
          // Wide bottom drawer: canvas | Inspector/Compiler side by side.
          // (Side drawer Model Setup keeps the stacked column layout.)
          panelLayout="split"
          onChange={({ doc }) => onDocChange(doc)}
          // Dock the close button into the canvas's own tab bar so the drawer
          // header and the Overall Workflow · Tools · Collapse row share one line.
          tabBarTrailing={
            <button
              type="button"
              className="bottom-drawer-close"
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
  // Bottom canvas drawer: a full-width sheet that slides up from the bottom and
  // hosts a Canvas editor. Its doc and height are kept here so they survive
  // open/close.
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [canvasDoc, setCanvasDoc] = useState<CanvasDoc | null>(null);
  const [canvasHeight, setCanvasHeight] = useState(460);
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
  // The Model Setup pane's container inside the drawer. The page-level SetupBar
  // portals its docked view here; keeping SetupBar mounted at the page level (not
  // inside the drawer) lets its popped-out floating window survive drawer close.
  const [modelSetupSlot, setModelSetupSlot] = useState<HTMLElement | null>(null);
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
        conversations: Array<{ id: string; title: string }>;
      };
      setConvos((conversations ?? []).map((c) => ({ id: c.id, title: c.title })));
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
      if (!res.ok) { setMessages([]); return; }
      const { messages: rows } = (await res.json()) as {
        messages: Array<{ id: string; role: string; content: string }>;
      };
      setMessages(
        (rows ?? []).map((m) => ({
          role: m.role === "user" ? "user" : "ai",
          text: m.content,
        }))
      );
    } catch {
      setMessages([]);
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

      // Show the user message and open an observability turn up front, so even
      // a failure before the chat call (e.g. creating the conversation) is
      // visible in the thread and the trace — never a silent "nothing happens".
      setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
      setTyping(true);
      setStreaming("");

      // Observability: ask the endpoint for the REAL server-side trace
      // (system prompt, model, every OpenAI round-trip) instead of faking it.
      const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
        let conversationId = activeId;
        if (!conversationId) {
          const res = await fetch("/api/conversations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: trimmed.slice(0, 60), topic: "sleep" }),
          });
          if (!res.ok) {
            throw new Error(`Couldn't start a conversation (HTTP ${res.status}).`);
          }
          const { id } = await res.json();
          conversationId = id as string;
          setActiveId(conversationId);
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
        setMessages((prev) => [...prev, { role: "ai", text: answer }]);
        setStreaming("");
        loadConversations();
        finishTurn({
          finalAnswer: answer,
          trace: stamped,
          state: data.state,
          nodeRefs: data.nodeRefs,
        });
      } catch (err) {
        const message =
          err instanceof Error && err.message.trim()
            ? err.message.trim()
            : "Something went wrong while sending the message.";
        setMessages((prev) => [...prev, { role: "ai", text: message }]);
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
      } finally {
        setTyping(false);
        setTypingLabel("");
      }
    },
    [activeId, typing, loadConversations, stopSpeaking]
  );

  const onNew = () => {
    setActiveId(null);
    setMessages([]);
    setStreaming("");
    setInput("");
    setMenuOpen(false);
    setFeedbackByIdx({});
    setEditingIdx(null);
    speakNextAssistantRef.current = false;
    stopSpeaking();
    setTimeout(() => inputRef.current?.focus(), 30);
  };
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

  // ── Per-bubble feedback ────────────────────────────────────────────────
  const onToggleFeedback = (index: number) =>
    setEditingIdx((prev) => (prev === index ? null : index));

  const onSaveFeedback = (index: number, entries: FeedbackEntry[]) => {
    // Empty set means the expert cleared everything → treat as remove.
    if (entries.length === 0) {
      onRemoveFeedback(index);
      return;
    }
    setFeedbackByIdx((prev) => ({ ...prev, [index]: entries }));
    setEditingIdx(null);
    const msg = messages[index];
    if (!activeId || !msg) return;
    // Persist the full signal set; the server reconciles (upserts present
    // signals, deletes cleared ones). Best-effort — the UI already updated.
    fetch("/api/feedback", {
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
    }).catch(() => {});
  };

  const onRemoveFeedback = (index: number) => {
    setFeedbackByIdx((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setEditingIdx(null);
    if (!activeId) return;
    fetch(
      `/api/feedback?conversationId=${encodeURIComponent(activeId)}&messageIndex=${index}`,
      { method: "DELETE" }
    ).catch(() => {});
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
                convos={convos}
                activeId={activeId}
                onSelect={onSelect}
                onNew={onNew}
                onDelete={onDelete}
                onRename={onRename}
                query={query}
                setQuery={setQuery}
                menuOpen={menuOpen}
                setMenuOpen={setMenuOpen}
                infoOpen={infoOpen}
                setInfoOpen={setInfoOpen}
                onClose={() => setSidebarOpen(false)}
                onOpenObservability={() => openDrawer("observability")}
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
              />
            ) : (
              <EmptyState onSuggest={send} compact={canvasOpen} />
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
            />
          </main>

          {/* Right rail: everyone gets the voice-reply toggle + Workflow launcher;
              admins get the Model Setup panel button. Docked at the right edge
              when no drawer is open; when a drawer IS open it floats at the
              drawer's left edge and tracks its width. */}
          <RightRail
            panelOpen={openDrawers.length > 0}
            onTogglePanel={() =>
              openDrawers.length > 0 ? closeAllDrawers() : openDrawer("modelsetup")
            }
            isAdmin={isAdmin}
            canvasOpen={canvasOpen}
            onToggleCanvas={() => setCanvasOpen((v) => !v)}
            autoSpeak={autoSpeak}
            onToggleAutoSpeak={() => setAutoSpeak((v) => !v)}
            isSpeaking={isSpeaking}
            onStopSpeaking={stopSpeaking}
            floating={openDrawers.length > 0}
            rightOffset={obsWidth ?? obsBounds.def}
          />
          {openDrawers.length === 0 && (
            <MobileNav
              onOpen={openDrawer}
              isAdmin={isAdmin}
              autoSpeak={autoSpeak}
              onToggleAutoSpeak={() => setAutoSpeak((v) => !v)}
              isSpeaking={isSpeaking}
              onStopSpeaking={stopSpeaking}
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
            width={obsWidth ?? undefined}
            onDismiss={closeAllDrawers}
            chatsContent={
              <ChatsPane
                convos={convos}
                activeId={activeId}
                onSelect={(id) => { onSelect(id); closeDrawer("chats"); }}
                onNew={() => { onNew(); closeDrawer("chats"); }}
                onDelete={onDelete}
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
                onOpenObservability={() => openDrawer("observability")}
                onToggleFeedbackMode={() => { setFeedbackMode((m) => !m); closeDrawer("account"); }}
                onSignOut={signOut}
              />
            }
            modelSetupContent={<div className="drawer-pane" ref={setModelSetupSlot} />}
            activeConversationId={activeId}
          />
          {/* SetupBar is mounted here (page level), not inside the drawer, so its
              popped-out floating window survives the drawer closing. It portals
              its docked view into the drawer's Model Setup slot when open. */}
          {isAdmin && <SetupBar turns={turns} slot={modelSetupSlot} onTopDockChange={setTopDockH} />}

          {/* Bottom canvas drawer. Its launcher lives in the right rail, under
              the Model Setup (drawer) icon — see RightRail. */}
          <BottomCanvasDrawer
            open={canvasOpen}
            onClose={() => setCanvasOpen(false)}
            height={canvasHeight}
            setHeight={setCanvasHeight}
            doc={canvasDoc}
            onDocChange={setCanvasDoc}
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
      <SiteLogo size={120} href="/sleep" />
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
        <SiteLogo size={120} href="/sleep" />
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
