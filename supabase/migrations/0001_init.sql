-- 0001_init.sql
-- Fresh Supabase Postgres schema for the standalone "sleep" demo.
--
-- IMPORTANT — RLS / data access model:
--   The Next.js app accesses ALL of these tables through the Supabase SERVICE
--   ROLE key (createSupabaseAdminClient), which BYPASSES Row Level Security.
--   User-level scoping is enforced in application code (every query filters by
--   user_id / conversation ownership). We therefore leave RLS DISABLED on these
--   tables to keep the standalone setup simple. Do NOT expose the anon key with
--   direct table access, since there are no RLS policies protecting these rows.
--
-- IMPORTANT — Storage bucket (not created by SQL):
--   The sleep setup/input page uploads reference files to a Storage bucket named
--   `sleep-input-files`. Buckets are created via the Supabase dashboard or the
--   Storage API, not via SQL. Create it manually (private) before using file
--   uploads in /demo/sleep/input. The DB column `sleep_inputs.uploaded_files`
--   (jsonb) stores the manifest of objects in that bucket.

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- profiles
--   Referenced only by app/api/conversations/route.ts (upsert { id } on
--   conflict id). Minimal shape.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- user_roles
--   Populated/read by orchestration-runtime/src/admin-auth.ts.
--   Columns read: user_id, email, role, expert_demos.
--   `role` is one of 'user' | 'expert' | 'admin' (AdminAuthRole).
--   `expert_demos` is a list of demo keys the user is an expert for
--   (e.g. ["sleep"]).
-- ---------------------------------------------------------------------------
create table if not exists public.user_roles (
  user_id       uuid primary key,
  email         text,
  role          text not null default 'user'
                  check (role in ('user', 'expert', 'admin')),
  expert_demos  jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists user_roles_email_idx on public.user_roles (email);

-- ---------------------------------------------------------------------------
-- conversations
--   Columns read/written across app/api/conversations/**, admin conversation
--   routes, and chat-route.ts (updates updated_at + current_state).
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  title          text not null default 'New conversation',
  topic          text,               -- e.g. 'sleep'; NULL for untopiced threads
  current_state  jsonb,              -- serialized state snapshot (chat-route.ts)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists conversations_user_id_idx  on public.conversations (user_id);
create index if not exists conversations_topic_idx     on public.conversations (topic);
create index if not exists conversations_user_topic_idx on public.conversations (user_id, topic);
create index if not exists conversations_updated_at_idx on public.conversations (updated_at desc);

-- ---------------------------------------------------------------------------
-- messages
--   Inserted by chat-route.ts (role 'user' / 'assistant', content); read
--   ordered by created_at ascending.
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null
                     references public.conversations (id) on delete cascade,
  role             text not null,   -- 'user' | 'assistant' | 'system'
  content          text not null default '',
  created_at       timestamptz not null default now()
);

create index if not exists messages_conversation_id_idx
  on public.messages (conversation_id);
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- sleep_inputs
--   The sleep demo's setup/config table (SLEEP_SETUP_SOURCE, endpoint
--   '/demo/sleep/input'). The chat runtime reads:
--     id, state_schema, state_update_prompt, policy_prompt, guideline_blocks
--   filtered by endpoint, ordered by updated_at desc.
--   The setup route (app/api/admin/setup/[demo]/route.ts) reads/writes the full
--   column set below (config_name, uploaded_files, typical_user_patterns,
--   edge_cases_to_cover, expert_id, environment_players) and datasets
--   (added by migration 20260514000002).
-- ---------------------------------------------------------------------------
create table if not exists public.sleep_inputs (
  id                    uuid primary key default gen_random_uuid(),
  endpoint              text not null,             -- '/demo/sleep/input'
  config_name           text,
  state_schema          jsonb not null default '[]'::jsonb,   -- [{field_name,type,initial_value}]
  state_update_prompt   text,                      -- required non-empty at chat time
  policy_prompt         text,                      -- required non-empty at chat time
  guideline_blocks      jsonb not null default '[]'::jsonb,   -- [{topic,content,problem,recommendation}]
  uploaded_files        jsonb not null default '[]'::jsonb,   -- manifest for `sleep-input-files` bucket
  environment_players   jsonb,                     -- read during setup PUT diff
  typical_user_patterns text,
  edge_cases_to_cover   text,
  datasets              jsonb not null default '[]'::jsonb,
  expert_id             uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists sleep_inputs_endpoint_idx
  on public.sleep_inputs (endpoint);
create index if not exists sleep_inputs_endpoint_updated_idx
  on public.sleep_inputs (endpoint, updated_at desc);

-- ---------------------------------------------------------------------------
-- policy_canvases
--   No CREATE exists in the repo migrations; per the state-canvases migration
--   comment it is the SAME shape as state_policy_canvases. Read by chat-route.ts
--   (canvas_id, name, sort_order, canvas) and upserted on
--   (setup_table, setup_id, canvas_id). Generated when an expert saves setup.
-- ---------------------------------------------------------------------------
create table if not exists public.policy_canvases (
  id          uuid primary key default gen_random_uuid(),
  setup_table text not null,
  setup_id    uuid not null,
  canvas_id   text not null,
  name        text not null default 'Canvas',
  sort_order  integer,
  canvas      jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists policy_canvases_setup_canvas_idx
  on public.policy_canvases (setup_table, setup_id, canvas_id);

-- ---------------------------------------------------------------------------
-- state_policy_canvases  (copied from 20260514000001_state_canvases.sql)
-- ---------------------------------------------------------------------------
create table if not exists public.state_policy_canvases (
  id          uuid primary key default gen_random_uuid(),
  setup_table text not null,
  setup_id    uuid not null,
  canvas_id   text not null,
  name        text not null default 'Canvas',
  sort_order  integer,
  canvas      jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists state_policy_canvases_setup_canvas_idx
  on public.state_policy_canvases (setup_table, setup_id, canvas_id);

-- state_system_canvases is created alongside state_policy_canvases in the
-- original migration; included for completeness (same shape).
create table if not exists public.state_system_canvases (
  id          uuid primary key default gen_random_uuid(),
  setup_table text not null,
  setup_id    uuid not null,
  canvas_id   text not null,
  name        text not null default 'Canvas',
  sort_order  integer,
  canvas      jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists state_system_canvases_setup_canvas_idx
  on public.state_system_canvases (setup_table, setup_id, canvas_id);

-- ---------------------------------------------------------------------------
-- canvas_execution_plans  (copied from 20260517_canvas_execution_plans.sql)
-- ---------------------------------------------------------------------------
create table if not exists public.canvas_execution_plans (
  id             uuid primary key default gen_random_uuid(),
  setup_table    text not null,
  setup_id       uuid not null,
  execution_plan jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists canvas_execution_plans_setup_idx
  on public.canvas_execution_plans (setup_table, setup_id);

-- ---------------------------------------------------------------------------
-- message_feedback  (final combined shape from 20260609000000 +
--   20260611000000_message_feedback_multi_signal.sql — one row per
--   (user_id, conversation_id, message_index, signal)).
--   NOTE: conversation_id is TEXT here (matches the migration), not a uuid FK.
-- ---------------------------------------------------------------------------
create table if not exists public.message_feedback (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  conversation_id  text not null,
  message_index    int  not null,
  message_role     text not null,
  message_excerpt  text not null default '',
  rating           int,
  signal           text not null default 'comment',
  comment          text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint message_feedback_user_convo_msg_signal_key
    unique (user_id, conversation_id, message_index, signal)
);

create index if not exists message_feedback_conversation_idx
  on public.message_feedback (user_id, conversation_id);

-- End of 0001_init.sql
