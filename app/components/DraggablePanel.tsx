"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface DraggablePanelProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Initial top-left position in viewport pixels. */
  initialPosition?: { x: number; y: number };
  /** Panel width in pixels. */
  width?: number;
}

/**
 * DraggablePanel
 *
 * A floating, draggable window rendered with `position: fixed` and NO backdrop,
 * so the background UI stays fully interactive while the panel is open. Drag it
 * by its header; close it with the × button.
 */
export default function DraggablePanel({
  title,
  onClose,
  children,
  initialPosition,
  width = 720,
}: DraggablePanelProps) {
  const [position, setPosition] = useState(
    initialPosition ?? { x: 120, y: 120 }
  );
  const dragState = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragState.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - position.x,
        offsetY: event.clientY - position.y,
      };
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
    },
    [position.x, position.y]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = dragState.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const maxX = window.innerWidth - 80;
      const maxY = window.innerHeight - 60;
      setPosition({
        x: Math.min(Math.max(event.clientX - state.offsetX, -width + 120), maxX),
        y: Math.min(Math.max(event.clientY - state.offsetY, 0), maxY),
      });
    },
    [width]
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragState.current?.pointerId === event.pointerId) {
        dragState.current = null;
      }
    },
    []
  );

  // Close on Escape.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label={title}
      className="fixed z-50 rounded-[20px] border border-[#c0bdb0] bg-[#e7e5d8] shadow-[0_24px_60px_rgba(24,63,46,0.22)]"
      style={{ left: position.x, top: position.y, width }}
    >
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex cursor-grab touch-none items-center justify-between gap-4 rounded-t-[20px] border-b border-[#cbc8b8] px-4 py-2.5 active:cursor-grabbing"
      >
        <span className="select-none text-[10px] font-mono uppercase tracking-[0.22em] text-[#5d6c62]">
          {title}
        </span>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-full border border-[#b3b0a0] bg-transparent px-2 py-0.5 text-[12px] leading-none text-[#224533] transition-colors hover:bg-[#d8d6c8]"
        >
          ✕
        </button>
      </div>
      <div className="px-4 py-4">{children}</div>
    </div>
  );
}
