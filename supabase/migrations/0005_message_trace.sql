-- Persist per-turn observability metadata on assistant messages so a reopened
-- conversation can replay its Observability trace and animate the policy canvas.
-- Shape: { trace: TimedTraceEvent[], nodeRefs: {nodeId,canvasId}[], state: {...} }.
-- Null for user messages.
alter table public.messages
  add column if not exists trace jsonb;

comment on column public.messages.trace is
  'Observability turn metadata for assistant messages: { trace, nodeRefs, state }. Null for user messages. Lets a reopened conversation replay its trace and animate the policy canvas.';
