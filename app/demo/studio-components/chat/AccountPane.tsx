"use client";

import { useRouter } from "next/navigation";
import { Ic } from "../ra-icons";
import { Avatar } from "../ra-shared";
import { BUBBLE_FONT_LABELS, type BubbleFontSize } from "./constants";
import { ADMIN_ITEMS } from "./Sidebar";

export function AccountPane({
  userEmail,
  userImage,
  isAdmin,
  feedbackMode,
  monoTheme,
  onToggleMono,
  roundUi,
  onToggleRound,
  bubbleFontSize,
  onCycleBubbleFont,
  onToggleFeedbackMode,
  onSignOut,
}: {
  userEmail: string;
  userImage?: string;
  isAdmin: boolean;
  feedbackMode: boolean;
  monoTheme: boolean;
  onToggleMono: () => void;
  roundUi: boolean;
  onToggleRound: () => void;
  bubbleFontSize: BubbleFontSize;
  onCycleBubbleFont: () => void;
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
      <button className="pop-row" onClick={onToggleRound}>
        <span className="ic"><Ic.Round size={17} /></span>
        Rounded UI{roundUi ? " ✓" : ""}
      </button>
      <button className="pop-row" onClick={onCycleBubbleFont}>
        <span className="ic"><Ic.Type size={17} /></span>
        Text size · {BUBBLE_FONT_LABELS[bubbleFontSize]}
      </button>
      <button className="pop-row danger" onClick={onSignOut}>
        <span className="ic"><Ic.SignOut size={17} /></span>Sign out
      </button>
    </div>
  );
}

