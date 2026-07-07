"use client";

import type { CanvasHeader } from "./types";

interface CanvasHeaderCardProps extends CanvasHeader {
  /**
   * When defined, the card becomes a clickable toggle button. The +/− glyph
   * reflects the expanded state. When undefined, the card is a static label.
   */
  expanded?: boolean;
  onToggle?: () => void;
}

export default function CanvasHeaderCard({
  title,
  subtitle,
  expanded,
  onToggle,
}: CanvasHeaderCardProps) {
  const bg = "bg-[#1a3d2a]";
  const eyebrow = "Canvas";
  const interactive = typeof onToggle === "function";

  const body = (
    <div className={`${bg} text-white rounded-lg px-6 py-5 mb-4`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-widest text-white/55 mb-2">
            {eyebrow}
          </p>
          <h3 className="text-2xl font-bold font-test-american-grotesk text-white mb-1 leading-tight">
            {title}
          </h3>
          <p className="text-xs font-mono text-white/50">→ {subtitle}</p>
        </div>
        {interactive && (
          <span
            aria-hidden
            className="text-2xl text-white/60 font-mono leading-none mt-1 select-none"
          >
            {expanded ? "−" : "+"}
          </span>
        )}
      </div>
    </div>
  );

  if (!interactive) return body;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="block w-full text-left"
    >
      {body}
    </button>
  );
}
