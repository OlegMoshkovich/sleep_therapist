/* ra-icons.tsx — simple inline line icons (stroke = currentColor).
   Ported from the handoff `ra-icons.jsx`. */
import React from "react";

export interface IconProps {
  size?: number;
  stroke?: number;
  fill?: string;
  [key: string]: unknown;
}

const mk = (paths: React.ReactNode) =>
  function Icon({ size = 18, stroke = 1.6, fill = "none", ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={fill}
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...rest}
      >
        {paths}
      </svg>
    );
  };

export const Ic = {
  Back: mk(<path d="M15 5l-7 7 7 7" />),
  Plus: mk(<><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>),
  Search: mk(<><circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></>),
  Mic: mk(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><line x1="12" y1="18" x2="12" y2="21" /></>),
  Speaker: mk(<><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M17 9a4 4 0 0 1 0 6" /></>),
  Copy: mk(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>),
  Share: mk(<><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="M12 16V4" /><path d="M8 8l4-4 4 4" /></>),
  Sparkle: mk(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />),
  Memo: mk(<><rect x="4" y="3" width="16" height="18" rx="2" /><line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="12" y2="16" /></>),
  Upload: mk(<><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /><path d="M12 16V4" /><path d="M8 8l4-4 4 4" /></>),
  Wave: mk(<><line x1="5" y1="10" x2="5" y2="14" /><line x1="9" y1="6" x2="9" y2="18" /><line x1="13" y1="9" x2="13" y2="15" /><line x1="17" y1="4" x2="17" y2="20" /><line x1="21" y1="10" x2="21" y2="14" /></>),
  Lock: mk(<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>),
  Dots: mk(<><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>),
  Trash: mk(<><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" /></>),
  Expand: mk(<><path d="M14 4h6v6" /><path d="M20 4l-8 8" /><path d="M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></>),
  Chevron: mk(<path d="M6 9l6 6 6-6" />),
  Shield: mk(<path d="M12 3l8 3v5c0 5-3.5 8-8 9.5C7.5 19 4 16 4 11V6z" />),
  Grid: mk(<><rect x="3.5" y="3.5" width="7" height="7" rx="1.4" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.4" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.4" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.4" /></>),
  /* Connected nodes — reads as a flow/graph, distinct from Grid (Observability). */
  Workflow: mk(<><rect x="3" y="3" width="6" height="6" rx="1.2" /><rect x="15" y="3" width="6" height="6" rx="1.2" /><rect x="15" y="15" width="6" height="6" rx="1.2" /><rect x="3" y="15" width="6" height="6" rx="1.2" /><path d="M9 6h6" /><path d="M18 9v6" /><path d="M15 18H9" /></>),
  List: mk(<><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="15" y2="18" /></>),
  Sliders: mk(<><line x1="4" y1="7" x2="20" y2="7" /><circle cx="15" cy="7" r="2.4" /><line x1="4" y1="16" x2="20" y2="16" /><circle cx="9" cy="16" r="2.4" /></>),
  User: mk(<><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1-3.6 4-5.2 7-5.2s6 1.6 7 5.2" /></>),
  SignOut: mk(<><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="M15 8l4 4-4 4" /><line x1="19" y1="12" x2="9" y2="12" /></>),
  Chat: mk(<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3.5V16H6a2 2 0 0 1-2-2z" />),
  Book: mk(<><path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" /><path d="M5 18a2 2 0 0 1 2-2h11" /></>),
  Edit: mk(<><path d="M5 19h14" /><path d="M14.5 5.5l3 3L9 17l-4 1 1-4z" /></>),
  Clock: mk(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  Moon: mk(<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />),
  Panel: mk(<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><line x1="9.5" y1="4.5" x2="9.5" y2="19.5" /></>),
  Close: mk(<><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></>),
  /* Square frame (no corner radius) — matches canvas step badges / sharp chrome. */
  Info: function InfoIcon({ size = 18, stroke = 1.6, fill = "none", ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={fill}
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="square"
        strokeLinejoin="miter"
        {...rest}
      >
        <rect x="3" y="3" width="18" height="18" />
        <line x1="12" y1="11" x2="12" y2="16.5" />
        <circle cx="12" cy="7.75" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  },
} as const;

export type IconName = keyof typeof Ic;
