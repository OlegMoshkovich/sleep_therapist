"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import "./ra-theme.css";
import { Ic } from "./ra-icons";
import { Avatar } from "./ra-shared";
import {
  ACTION_CHIPS,
  SUGGESTIONS,
} from "./sleep-data";
import { RightDrawer, type DrawerId } from "./RightDrawer";
import { FeedbackControls, type FeedbackEntry, type FeedbackSignal } from "./FeedbackControls";
import type { Turn, TimedTraceEvent } from "../../../components/trace/TraceView";
import { AuthProvider, useAuth } from "../../../context/AuthContext";
import AuthModal from "../../../components/AuthModal";

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
const PANEL_TABS: DrawerId[] = ["modelsetup", "observability", "expert", "upload"];

// Panels that expose internal wiring (model/prompt setup, step-by-step traces).
// Only admins may see or open these; non-admins get the plain chat surface.
const ADMIN_ONLY_DRAWERS: DrawerId[] = ["modelsetup", "observability"];

const ADMIN_ITEMS = [
  // { icon: "Grid", label: "Admin dashboard", href: "/demo/sleep/expert-dashboard" },
  { icon: "Sliders", label: "Model setup", href: "/demo/sleep/studio/config" },
] as const;

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
              <span className="conv-lock"><Ic.Lock size={13} /></span>
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
  onClose,
  onOpenObservability,
  onToggleFeedbackMode,
  feedbackMode,
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
  onClose: () => void;
  onOpenObservability: () => void;
  onToggleFeedbackMode: () => void;
  feedbackMode: boolean;
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
          <div className="side-sub">Track · coach · rest</div>
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
        {menuOpen && (
          <div className="popover" role="menu" onClick={(e) => e.stopPropagation()}>
            {isAdmin && (
              <>
                <div className="pop-label adm">
                  <Ic.Shield size={13} /> Admin <span className="pill">admin only</span>
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
              className="pop-row danger"
              onClick={() => { setMenuOpen(() => false); onSignOut(); }}
            >
              <span className="ic"><Ic.SignOut size={17} /></span>Sign out
            </button>
          </div>
        )}
        <button
          className={"acct-chip" + (menuOpen ? " open" : "")}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
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
  onOpenObservability,
  onToggleFeedbackMode,
  onSignOut,
}: {
  userEmail: string;
  userImage?: string;
  isAdmin: boolean;
  feedbackMode: boolean;
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
            <Ic.Shield size={13} /> Admin <span className="pill">admin only</span>
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
      <button className="pop-row danger" onClick={onSignOut}>
        <span className="ic"><Ic.SignOut size={17} /></span>Sign out
      </button>
    </div>
  );
}

/* ---------------- compact (collapsed) sidebar rail ---------------- */
function SidebarRail({ onExpand }: { onExpand: () => void }) {
  return (
    <aside className="sidebar rail">
      <button className="rail-btn rail-flip" title="Expand sidebar" onClick={onExpand}>
        <Ic.Panel size={18} />
      </button>
    </aside>
  );
}

/* ---------------- compact (collapsed) right drawer rail ---------------- */
function RightRail({ onOpen }: { onOpen: (id: DrawerId) => void }) {
  return (
    <aside className="right-rail">
      <button className="rail-btn" title="Model Setup" onClick={() => onOpen("modelsetup")}>
        <Ic.Panel size={18} />
      </button>
    </aside>
  );
}

/* ---------------- thread pieces ---------------- */
function ThreadHeader() {
  return (
    <div className="thread-head">
      <Avatar kind="assistant" size={18} ring mono="SA" />
      <div className="th-meta">
        <div className="th-name">Sleep Assistant <span className="online-dot" /></div>
        <div className="th-sub">Here to help you rest</div>
      </div>
    </div>
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
            <div className="typing-dots"><span /><span /><span /></div>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function EmptyState({ onSuggest }: { onSuggest: (t: string) => void }) {
  return (
    <div className="empty">
      <Avatar kind="assistant" size={96} ring mono="SA" className="empty-orb" />
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
}: {
  value: string;
  setValue: (v: string) => void;
  onSend: (t: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onExpertChat: () => void;
  onUpload: () => void;
}) {
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onSend(v);
  };
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
            <button className="comp-plus" title="Add"><Ic.Plus size={18} /></button>
            <input
              ref={inputRef}
              className="comp-input"
              placeholder="Type a message…"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
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
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- page ---------------- */
function SleepStudioChat() {
  const { user, isAdmin, signOut } = useAuth();
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Secondary right-side panels share ONE drawer; multiple open ones become tabs.
  const [openDrawers, setOpenDrawers] = useState<DrawerId[]>([]);
  const [activeDrawer, setActiveDrawer] = useState<DrawerId | null>(null);
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
  const [obsWidth, setObsWidth] = useState(400); // px, resizable
  // restore persisted drawer widths (client-only, avoids hydration mismatch)
  useEffect(() => {
    const s = Number(localStorage.getItem("ra-sidebar-w"));
    if (s) setSidebarWidth(Math.max(240, Math.min(520, s)));
    const o = Number(localStorage.getItem("ra-obs-w"));
    if (o) setObsWidth(Math.max(300, Math.min(680, o)));
  }, []);
  useEffect(() => {
    localStorage.setItem("ra-sidebar-w", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem("ra-obs-w", String(obsWidth));
  }, [obsWidth]);
  const inputRef = useRef<HTMLInputElement>(null);

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

        const res = await fetch("/api/chat/sleep/base", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, userMessage: trimmed, trace: true }),
        });
        if (!res.ok) {
          throw new Error(`Chat request failed (HTTP ${res.status}).`);
        }

        const data = (await res.json()) as {
          content?: string;
          trace?: TimedTraceEvent[];
          state?: Record<string, unknown>;
          nodeRefs?: { nodeId: string; canvasId?: string }[];
        };
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
      }
    },
    [activeId, typing, loadConversations]
  );

  const onNew = () => {
    setActiveId(null);
    setMessages([]);
    setStreaming("");
    setInput("");
    setMenuOpen(false);
    setFeedbackByIdx({});
    setEditingIdx(null);
    setTimeout(() => inputRef.current?.focus(), 30);
  };
  const onSelect = (id: string) => {
    setActiveId(id);
    setStreaming("");
    setEditingIdx(null);
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
    <div className="ra-scope" onClick={() => menuOpen && setMenuOpen(false)}>
      <div className="app-frame">
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
                onClose={() => setSidebarOpen(false)}
                onOpenObservability={() => openDrawer("observability")}
                onToggleFeedbackMode={() => setFeedbackMode((m) => !m)}
                feedbackMode={feedbackMode}
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
            <SidebarRail onExpand={() => setSidebarOpen(true)} />
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
                streaming={streaming}
                feedbackMode={feedbackMode}
                feedbackByIdx={feedbackByIdx}
                editingIdx={editingIdx}
                onToggleFeedback={onToggleFeedback}
                onSaveFeedback={onSaveFeedback}
                onRemoveFeedback={onRemoveFeedback}
              />
            ) : (
              <EmptyState onSuggest={send} />
            )}
            <Composer value={input} setValue={setInput} onSend={send} inputRef={inputRef} onExpertChat={() => openDrawer("expert")} onUpload={() => openDrawer("upload")} />
          </main>

          {/* The collapsed right rail only opens Model Setup, so it is admin-only. */}
          {openDrawers.length === 0 && isAdmin && <RightRail onOpen={openDrawer} />}
          {openDrawers.length > 0 && (
            <ResizeHandle
              side="left"
              width={obsWidth}
              setWidth={setObsWidth}
              min={300}
              max={680}
              def={400}
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
            width={obsWidth}
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
                onOpenObservability={() => openDrawer("observability")}
                onToggleFeedbackMode={() => { setFeedbackMode((m) => !m); closeDrawer("account"); }}
                onSignOut={signOut}
              />
            }
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
function StudioGate() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-[#E1DECF]">
        <p className="text-gray-400 text-sm font-serif">Loading…</p>
      </div>
    );
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
