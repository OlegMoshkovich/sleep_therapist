"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { Ic } from "../ra-icons";
import { Avatar } from "../ra-shared";
import { BUBBLE_FONT_LABELS, type BubbleFontSize } from "./constants";
import { ConvList } from "./ConvList";
import type { Conversation } from "./types";

// Copy for the bottom-left "How to use the studio" help panel. Each section maps to a
// real part of the studio an expert works with, so the guidance stays accurate.
export const HELP_SECTIONS: Array<{ title: string; body: React.ReactNode }> = [
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

// The admin-only shortcuts shown in the account popover / mobile Account pane.
export const ADMIN_ITEMS = [
  { icon: "Shield", label: "User roles", href: "/admin/users" },
] as const;

export function Sidebar({
  productName,
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
  roundUi,
  onToggleRound,
  bubbleFontSize,
  onCycleBubbleFont,
  userEmail,
  userImage,
  isAdmin,
  onSignOut,
  width,
}: {
  productName: string;
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
  roundUi: boolean;
  onToggleRound: () => void;
  bubbleFontSize: BubbleFontSize;
  onCycleBubbleFont: () => void;
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
          <div className="side-title">{productName}</div>
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
              className="pop-row"
              onClick={() => { setMenuOpen(() => false); onToggleRound(); }}
            >
              <span className="ic"><Ic.Round size={17} /></span>
              Rounded UI{roundUi ? " ✓" : ""}
            </button>
            <button
              className="pop-row"
              onClick={() => { setMenuOpen(() => false); onCycleBubbleFont(); }}
            >
              <span className="ic"><Ic.Type size={17} /></span>
              Text size · {BUBBLE_FONT_LABELS[bubbleFontSize]}
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

/* ---------------- compact (collapsed) sidebar rail ---------------- */
export function SidebarRail({ onExpand, onNew }: { onExpand: () => void; onNew: () => void }) {
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
