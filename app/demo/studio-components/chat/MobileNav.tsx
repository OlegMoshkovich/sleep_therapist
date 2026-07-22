"use client";

import { useEffect, useRef, useState } from "react";
import { Ic } from "../ra-icons";
import {
  CHAT_MODEL_OPTIONS,
  OPENAI_MODEL,
  type ChatModelId,
} from "../../../lib/openai-config";

/* ---------------- mobile-only top-right nav ---------------- */
// On mobile the docked sidebar and rails are hidden, so a single hamburger
// opens the bottom sheet (Chats / Account / admin tabs live inside it).
// Thread actions (show controls / collapse / fullscreen) sit as icon buttons
// to the left of the model menu + hamburger.
export function MobileNav({
  onOpen,
  showThreadControls = false,
  allCollapsed = false,
  onToggleCollapseAll,
  hideBubbleControls = true,
  onToggleHideBubbleControls,
  onOpenThreadFullscreen,
  selectedModel = OPENAI_MODEL,
  onSelectModel,
  onOpenV2Modal,
  hidden = false,
}: {
  onOpen: () => void;
  isAdmin?: boolean;
  showThreadControls?: boolean;
  allCollapsed?: boolean;
  onToggleCollapseAll?: () => void;
  hideBubbleControls?: boolean;
  onToggleHideBubbleControls?: () => void;
  onOpenThreadFullscreen?: () => void;
  selectedModel?: string;
  onSelectModel?: (model: ChatModelId) => void;
  onOpenV2Modal?: () => void;
  /** When the header pill collapses to avatar-only, hide the whole rail. */
  hidden?: boolean;
}) {
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const threadMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!threadMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (threadMenuRef.current && !threadMenuRef.current.contains(e.target as Node)) {
        setThreadMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [threadMenuOpen]);

  const showControlsLabel = hideBubbleControls ? "Show controls" : "Hide controls";
  const collapseLabel = allCollapsed ? "Expand all" : "Collapse all";

  useEffect(() => {
    if (hidden) setThreadMenuOpen(false);
  }, [hidden]);

  if (hidden) return null;

  return (
    <nav className="mobile-railnav" aria-label="Menu">
      {showThreadControls && (
        <>
          <button
            type="button"
            className={"mrail-btn" + (allCollapsed ? " on" : "")}
            title={collapseLabel}
            aria-label={collapseLabel}
            aria-pressed={allCollapsed}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapseAll?.();
            }}
          >
            <Ic.Chevron size={18} style={allCollapsed ? undefined : { transform: "rotate(180deg)" }} />
          </button>
          <button
            type="button"
            className={"mrail-btn" + (!hideBubbleControls ? " on" : "")}
            title={showControlsLabel}
            aria-label={showControlsLabel}
            aria-pressed={!hideBubbleControls}
            onClick={(e) => {
              e.stopPropagation();
              onToggleHideBubbleControls?.();
            }}
          >
            <Ic.Sliders size={18} />
          </button>
          <button
            type="button"
            className="mrail-btn"
            title="Fullscreen"
            aria-label="Fullscreen"
            onClick={(e) => {
              e.stopPropagation();
              onOpenThreadFullscreen?.();
            }}
          >
            <Ic.Expand size={18} />
          </button>
          <div className="mrail-thread-controls" ref={threadMenuRef}>
            <button
              type="button"
              className={"mrail-btn" + (threadMenuOpen ? " on" : "")}
              title="Chat model"
              aria-label="Chat model"
              aria-haspopup="menu"
              aria-expanded={threadMenuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setThreadMenuOpen((v) => !v);
              }}
            >
              <Ic.Dots size={18} />
            </button>
            {threadMenuOpen && (
              <div className="thread-mobile-menu" role="menu">
                <div className="thread-mobile-menu-label">Model</div>
                {CHAT_MODEL_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    role={opt.kind === "action" ? "menuitem" : "menuitemradio"}
                    aria-checked={opt.kind === "model" ? selectedModel === opt.id : undefined}
                    className={
                      "thread-model-option" +
                      (opt.kind === "model" && selectedModel === opt.id ? " selected" : "")
                    }
                    onClick={() => {
                      setThreadMenuOpen(false);
                      if (opt.kind === "action") {
                        onOpenV2Modal?.();
                        return;
                      }
                      onSelectModel?.(opt.id);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      <button
        type="button"
        className="mrail-btn"
        title="Open menu"
        aria-label="Open menu"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        <Ic.Menu size={18} />
      </button>
    </nav>
  );
}
