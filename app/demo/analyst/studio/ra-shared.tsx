/* ra-shared.tsx — presentational pieces shared by the chat and config surfaces. */
import React from "react";
import type { FlowNode, FlowEdge } from "./sleep-data";

// Canonical AIR logo: every cell black with white letters (the same look as
// SiteLogo), rendered at the scale each surface needs.
const BRAND_CELLS: [string, "wht" | "blk"][] = [
  ["T", "blk"], ["H", "blk"], ["E", "blk"],
  ["A", "blk"], ["I", "blk"], ["R", "blk"],
  ["L", "blk"], ["A", "blk"], ["B", "blk"],
];

export function BrandMark() {
  return (
    <div className="brandmark">
      {BRAND_CELLS.map(([c, k], i) => (
        <span key={i} className={k}>{c}</span>
      ))}
    </div>
  );
}

export function Logo() {
  return (
    <div className="sc-logo">
      {BRAND_CELLS.map(([c, k], i) => (
        <span key={i} className={k}>{c}</span>
      ))}
    </div>
  );
}

export function Avatar({
  kind = "assistant",
  size = 34,
  ring = false,
  mono,
  className,
  src,
}: {
  kind?: "assistant" | "user";
  size?: number;
  ring?: boolean;
  mono?: string;
  className?: string;
  /** User profile photo (e.g. from Clerk); falls back to the mono initial. */
  src?: string;
}) {
  const cls =
    "avatar" +
    (kind === "assistant" ? " assistant" : "") +
    (ring ? " ring" : "") +
    (className ? " " + className : "");
  return (
    <div className={cls} style={{ width: size, height: size }}>
      {kind === "assistant" ? (
        <img
          src="/sleep-assistant-avatar.jpg"
          alt="Financial Analyst"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : src ? (
        <img
          src={src}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        mono && <span className="mono">{mono}</span>
      )}
    </div>
  );
}

/* ── node-graph minimap (used on the config Overview + flow cards) ── */
const NC: Record<string, string> = {
  start: "#5aa86f", iff: "#caa83f", prompt: "#6f9fd8",
  transform: "#d98a4a", tool: "#a98ad0", display: "#5aa86f", endn: "#d98aa0",
};
const NF: Record<string, string> = {
  start: "#e7f1ea", iff: "#f6efd6", prompt: "#e9f0f9",
  transform: "#f8ead9", tool: "#f0e9f7", display: "#e7f1ea", endn: "#f7e7ed",
};

export function FlowThumb({
  nodes,
  edges,
  h = 118,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  h?: number;
}) {
  const W = 300, pad = 14;
  const xs = nodes.flatMap((n) => [n.x, n.x + n.w]);
  const ys = nodes.flatMap((n) => [n.y, n.y + n.h]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min((W - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY));
  const ox = (W - (maxX - minX) * s) / 2 - minX * s;
  const oy = (h - (maxY - minY) * s) / 2 - minY * s;
  const byId: Record<string, FlowNode> = {};
  nodes.forEach((n) => { byId[n.id] = n; });
  const ctr = (r: string | [number, number]): [number, number] =>
    Array.isArray(r)
      ? [ox + r[0] * s, oy + r[1] * s]
      : [ox + (byId[r].x + byId[r].w / 2) * s, oy + (byId[r].y + byId[r].h / 2) * s];

  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${W} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block" }}
    >
      {edges.map((e, i) => {
        const a = ctr(e.from), b = ctr(e.to);
        return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#a7a492" strokeWidth="1" />;
      })}
      {nodes.map((n) => (
        <rect
          key={n.id}
          x={ox + n.x * s}
          y={oy + n.y * s}
          width={n.w * s}
          height={n.h * s}
          rx={n.type === "endn" ? 8 : 3}
          fill={NF[n.type]}
          stroke={NC[n.type]}
          strokeWidth="1.1"
        />
      ))}
    </svg>
  );
}

/* ── knowledge thumbnail: an upload drop-zone over a list of file rows ──
   Same dotted-board canvas as the flow minimaps, but signals "upload information"
   rather than a graph. */
export function KnowledgeThumb({ h = 116 }: { h?: number }) {
  const W = 300;
  const accent = "#c2611f";
  const rows = [44, 66, 88]; // y positions of the file rectangles
  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${W} 116`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block" }}
    >
      {/* drop-zone */}
      <rect
        x="22" y="8" width="256" height="26" rx="7"
        fill="rgba(194,97,31,0.06)" stroke={accent} strokeWidth="1.3" strokeDasharray="5 4"
      />
      {/* upload arrow */}
      <g stroke={accent} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M150 27 L150 15" />
        <path d="M145 20 L150 15 L155 20" />
        <path d="M141 28 L159 28" />
      </g>
      {/* file rows */}
      {rows.map((y) => (
        <g key={y}>
          <rect x="44" y={y} width="212" height="16" rx="5" fill="#fdfbf4" stroke="#b8b5a3" strokeWidth="1.1" />
          <rect x="24" y={y + 2} width="13" height="12" rx="3" fill="#f6e7da" stroke={accent} strokeWidth="1.1" />
          <rect x="54" y={y + 5} width="118" height="3" rx="1.5" fill="#cfccbc" />
          <rect x="54" y={y + 9.5} width="78" height="3" rx="1.5" fill="#dcd9c9" />
        </g>
      ))}
    </svg>
  );
}

/* ── full-board geometry (focused editor) ── */
export function anchor(n: FlowNode, side?: string): [number, number] {
  switch (side) {
    case "b": return [n.x + n.w / 2, n.y + n.h];
    case "t": return [n.x + n.w / 2, n.y];
    case "l": return [n.x, n.y + n.h / 2];
    case "r": return [n.x + n.w, n.y + n.h / 2];
    default: return [n.x + n.w / 2, n.y + n.h];
  }
}
export function edgePath(p0: [number, number], p1: [number, number]) {
  const [sx, sy] = p0, [tx, ty] = p1;
  const dy = Math.max(40, Math.abs(ty - sy) * 0.45);
  return `M${sx},${sy} C${sx},${sy + dy} ${tx},${ty - dy} ${tx},${ty}`;
}
