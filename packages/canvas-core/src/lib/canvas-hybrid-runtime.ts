export type FieldType = "string" | "integer" | "boolean" | "string[]" | "number" | "json";
export type StateSnapshot = Record<string, string>;
export type PromptValueSnapshot = Record<string, unknown>;

export interface RuntimeStateField {
  fieldName: string;
  type: FieldType;
  initialValue: string;
}

export type StateValueSource =
  | { kind: "constant"; value: string | number | boolean | null | string[] }
  | { kind: "prompt_variable"; name: string }
  | { kind: "current_build_snapshot" }
  | { kind: "conversation_turns" }
  | { kind: "latest_user_turn" }
  | { kind: "latest_assistant_turn" }
  | { kind: "latest_observation_event" }
  | { kind: "latest_observation_and_reward_event" }
  | { kind: "latest_primary_action_event" }
  | { kind: "agent_latest_observation" }
  | { kind: "extract_age" }
  | { kind: "extract_gender" }
  | { kind: "regex_capture"; pattern: string; flags?: string; group?: number }
  | { kind: "boolean_from_regex"; pattern: string; flags?: string };

export type StateCodeOperation =
  | { kind: "set_field"; field: string; source: StateValueSource; only_if_empty?: boolean }
  | { kind: "set_local"; name: string; source: StateValueSource; only_if_empty?: boolean }
  | { kind: "clear_field"; field: string }
  | {
      kind: "append_list_item";
      field: string;
      value?: string;
      source?: StateValueSource;
      unique?: boolean;
    };
