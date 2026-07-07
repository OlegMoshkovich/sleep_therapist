import type { CSSProperties, ReactNode } from "react";

const clampBaseStyle: CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

export function ClampedNodeText({
  children,
  className = "",
  lines = 4,
  title,
}: {
  children: ReactNode;
  className?: string;
  lines?: number;
  title?: string;
}) {
  return (
    <div
      className={className}
      style={{
        ...clampBaseStyle,
        WebkitLineClamp: lines,
      }}
      title={title}
    >
      {children}
    </div>
  );
}
