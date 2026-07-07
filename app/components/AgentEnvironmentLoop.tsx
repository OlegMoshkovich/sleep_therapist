"use client";

/**
 * AgentEnvironmentLoop
 *
 * A self-contained SVG redraw of the agent ⇄ environment reinforcement-learning
 * loop: an Agent box (containing Policy and State update) exchanging Action with
 * an Environment box, which returns Observation and Reward.
 *
 * It is fully self-contained (no external assets) so it can be dropped anywhere.
 * All labels are overridable via props and it scales to its container width.
 */
export interface AgentEnvironmentLoopProps {
  className?: string;
  agentLabel?: string;
  policyLabel?: string;
  stateUpdateLabel?: string;
  environmentLabel?: string;
  actionLabel?: string;
  observationLabel?: string;
  rewardLabel?: string;
  /** Stroke color for boxes, arrows and labels. */
  ink?: string;
  /** Fill color for the inner Policy / State update / Environment boxes. */
  boxFill?: string;
  /**
   * Called when a label is clicked, with the matching accordion section key:
   * "agent" (Agent / Policy / State update), "action", "environment",
   * "observation", or "reward". When provided, labels render as clickable.
   */
  onLabelClick?: (sectionKey: string) => void;
}

const LABEL_FONT =
  '"Test American Grotesk", "Styrene A", system-ui, -apple-system, sans-serif';

export default function AgentEnvironmentLoop({
  className,
  agentLabel = "Agent",
  policyLabel = "Policy",
  stateUpdateLabel = "State update",
  environmentLabel = "Environment",
  actionLabel = "Action",
  observationLabel = "Observation",
  rewardLabel = "Reward",
  ink = "#3d5244",
  boxFill = "transparent",
  onLabelClick,
}: AgentEnvironmentLoopProps) {
  const labelProps = (sectionKey: string) =>
    onLabelClick
      ? {
          onClick: () => onLabelClick(sectionKey),
          style: {
            cursor: "pointer" as const,
          },
        }
      : {};
  return (
    <svg
      viewBox="0 0 1140 320"
      width="100%"
      height="auto"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`${agentLabel} and ${environmentLabel} interaction loop: ${actionLabel}, ${observationLabel}, ${rewardLabel}.`}
      className={className}
      style={{ fontFamily: LABEL_FONT }}
    >
      <defs>
        <marker
          id="ael-arrow"
          markerWidth="11"
          markerHeight="11"
          refX="7.5"
          refY="5"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path
            d="M1 1 L9 5 L1 9"
            fill="none"
            stroke={ink}
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      </defs>

      <g
        fill="none"
        stroke={ink}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Agent container */}
        <rect x="18" y="50" width="336" height="258" rx="12" />
        {/* Policy box */}
        <rect x="38" y="104" width="292" height="56" rx="14" fill={boxFill} />
        {/* State update box */}
        <rect x="38" y="220" width="292" height="64" rx="14" fill={boxFill} />
        {/* Environment box */}
        <rect x="892" y="104" width="220" height="180" rx="14" fill={boxFill} />

        {/* Action: Policy -> Environment */}
        <path d="M330 132 L886 132" markerEnd="url(#ael-arrow)" />
        {/* Observation: Environment -> State update */}
        <path d="M892 228 L336 228" markerEnd="url(#ael-arrow)" />
        {/* Reward: Environment -> State update */}
        <path d="M892 266 L336 266" markerEnd="url(#ael-arrow)" />
        {/* State update -> Policy (internal feedback) */}
        <path d="M305 220 L305 162" markerEnd="url(#ael-arrow)" />
      </g>

      <g fill={ink} fontWeight="400" style={{ fontFamily: LABEL_FONT }}>
        <text x="186" y="36" fontSize="30" textAnchor="middle" {...labelProps("agent")}>
          {agentLabel}
        </text>
        <text x="44" y="92" fontSize="26" {...labelProps("policy")}>
          {policyLabel}
        </text>
        <text x="44" y="208" fontSize="26" {...labelProps("state_update")}>
          {stateUpdateLabel}
        </text>
        <text x="1002" y="92" fontSize="30" textAnchor="middle" {...labelProps("environment")}>
          {environmentLabel}
        </text>
        <text x="608" y="116" fontSize="26" textAnchor="middle" {...labelProps("action")}>
          {actionLabel}
        </text>
        <text x="612" y="216" fontSize="26" textAnchor="middle" {...labelProps("observation")}>
          {observationLabel}
        </text>
        <text x="612" y="254" fontSize="26" textAnchor="middle" {...labelProps("reward")}>
          {rewardLabel}
        </text>
      </g>
    </svg>
  );
}
