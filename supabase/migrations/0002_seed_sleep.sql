-- 0002_seed_sleep.sql
-- Seeds a default sleep setup so the studio/input/chat pages have data on first
-- run. Modeled on app/demo/sleep/studio/sleep-data.ts (STATE_FIELDS, GUIDELINES,
-- STATE_PROMPT) and the SLEEP_SETUP_SOURCE endpoint '/demo/sleep/input'.
--
-- Why just ONE row is enough:
--   The chat runtime (packages/orchestration-runtime/src/chat-route.ts) only
--   requires a sleep_inputs row (matched by endpoint) with non-empty
--   `state_update_prompt` and `policy_prompt`, plus a non-empty `state_schema`.
--   Policy/state canvases and canvas_execution_plans are OPTIONAL — a null
--   canvas doc and a default '{}' execution plan are handled gracefully. Those
--   rows are generated when an expert clicks "compile/save" in the
--   /demo/sleep/input UI. We deliberately do NOT fabricate a canvas JSON shape
--   here to avoid violating any NOT NULL / structural expectation.
--
-- Fixed UUID so any future canvas seed can reference it deterministically:
--   00000000-0000-4000-8000-0000000005ee  (setup_id for sleep_inputs)

insert into public.sleep_inputs (
  id,
  endpoint,
  config_name,
  state_schema,
  state_update_prompt,
  policy_prompt,
  guideline_blocks,
  uploaded_files,
  datasets,
  typical_user_patterns,
  edge_cases_to_cover,
  created_at,
  updated_at
) values (
  '00000000-0000-4000-8000-0000000005ee',
  '/demo/sleep/input',
  'Sleep Assistant (default)',

  -- state_schema: [{ field_name, type, initial_value }] mirroring STATE_FIELDS.
  '[
    {"field_name": "age",                    "type": "integer",  "initial_value": null},
    {"field_name": "gender",                 "type": "string",   "initial_value": null},
    {"field_name": "emergency",              "type": "boolean",  "initial_value": "false"},
    {"field_name": "sleep_concern",          "type": "string",   "initial_value": null},
    {"field_name": "turn_count",             "type": "integer",  "initial_value": "0"},
    {"field_name": "complaint_history",      "type": "string",   "initial_value": null},
    {"field_name": "bedtime_weeknight",      "type": "string",   "initial_value": null},
    {"field_name": "bedtime_weekend",        "type": "string",   "initial_value": null},
    {"field_name": "sleep_onset_latency",    "type": "string",   "initial_value": null},
    {"field_name": "wake_time",              "type": "string",   "initial_value": null},
    {"field_name": "out_of_bed_time",        "type": "string",   "initial_value": null},
    {"field_name": "night_awakenings",       "type": "string",   "initial_value": null},
    {"field_name": "nocturia",               "type": "string",   "initial_value": null},
    {"field_name": "wake_causes",            "type": "string[]", "initial_value": "[]"},
    {"field_name": "returns_to_sleep",       "type": "string",   "initial_value": null},
    {"field_name": "daytime_function",       "type": "string",   "initial_value": null},
    {"field_name": "naps",                   "type": "string",   "initial_value": null},
    {"field_name": "caffeine",               "type": "string",   "initial_value": null},
    {"field_name": "alcohol",                "type": "string",   "initial_value": null},
    {"field_name": "other_evening_intake",   "type": "string",   "initial_value": null},
    {"field_name": "exercise",               "type": "string",   "initial_value": null},
    {"field_name": "sleep_environment",      "type": "string",   "initial_value": null},
    {"field_name": "mood_anxiety",           "type": "string",   "initial_value": null},
    {"field_name": "psychiatric_history",    "type": "string",   "initial_value": null},
    {"field_name": "medical_history",        "type": "string",   "initial_value": null},
    {"field_name": "current_medications",    "type": "string[]", "initial_value": "[]"},
    {"field_name": "sleep_medications_tried","type": "string",   "initial_value": null},
    {"field_name": "sleep_quality_rating",   "type": "integer",  "initial_value": null},
    {"field_name": "sleep_stress_rating",    "type": "integer",  "initial_value": null}
  ]'::jsonb,

  -- state_update_prompt (mirrors STATE_PROMPT in sleep-data.ts).
  'You are a careful state-tracking assistant for a sleep app.
Update only the patient state using the previous known state plus the latest user message.
Return exactly one JSON object and nothing else.

State rules:
- If a field is unknown, leave it empty.
- Gender should be "male", "female", "other", or blank.
- Age should be digits only, or blank.
- sleep_concern should only include symptoms; blank for general conversation, otherwise a concise summary of symptoms.
- Update sleep_concern only if new additional concerns are shared.
- emergency must be true only when the situation appears urgent or dangerous (e.g. witnessed breathing pauses, gasping/choking, severe daytime sleepiness that is dangerous), otherwise false.
- Increment turn_count by 1 on each user turn.
- Fill the sleep-intake fields (bedtime, wake_time, awakenings, caffeine, alcohol, exercise, environment, mood, medications, etc.) only when the user provides that detail; otherwise leave them unchanged.

Return only the updated state object and nothing else.',

  -- policy_prompt: the assistant''s conversational policy.
  'You are a calm, helpful sleep assistant. You will be given the current
conversation plus an already-updated sleeper state. Use the updated state to
decide the next assistant step.

- If the emergency flag in the state is true, advise the sleeper to seek urgent
  medical help and stop routine coaching.
- Otherwise, continue the conversation naturally: gather missing sleep-intake
  details one or two at a time, and ground your coaching in the provided
  guideline knowledge.
- When a relevant guideline applies (sleep hygiene, caffeine, CBT-I stimulus
  control / sleep restriction, light &amp; circadian timing, screens, alcohol,
  napping, exercise, bedroom environment, racing mind, or sleep-apnea red
  flags), summarise its recommendation in plain language.
- Watch for sleep-apnea red flags (loud snoring, witnessed breathing pauses,
  gasping, heavy daytime sleepiness) and treat them as a clinical escalation
  rather than continuing coaching alone.
- Keep replies concise, warm, and practical; fix one thing at a time.',

  -- guideline_blocks: [{ topic, content, problem, recommendation }] from GUIDELINES.
  '[
    {"topic": "Sleep hygiene",
     "content": "Sleep hygiene is the set of daily habits and environmental conditions that support consistent, high-quality sleep. The cornerstone is a regular sleep-wake schedule that keeps the circadian clock entrained, reinforced by a wind-down routine, limited evening light, and a cool, dark, quiet bedroom.",
     "problem": "Irregular bed and wake times disrupt the circadian rhythm.",
     "recommendation": "Keep a consistent schedule, even on weekends; wind down screen-free 30-60 min before bed."},
    {"topic": "Caffeine &amp; stimulants",
     "content": "Caffeine is an adenosine-receptor antagonist that blocks the brain''s accumulating sleep-pressure signal. Its half-life is roughly 5-6 hours, so a mid-afternoon dose can still carry meaningful levels into the night, lengthening sleep onset and reducing slow-wave (deep) sleep.",
     "problem": "Caffeine has a ~5-6 hour half-life, so late-day intake delays sleep onset and reduces deep sleep.",
     "recommendation": "Avoid caffeine within 8 hours of bedtime; flag heavy or late intake in the sleeper notes."},
    {"topic": "Insomnia — stimulus control (CBT-I)",
     "content": "Stimulus control is a core component of CBT-I that re-establishes the bed and bedroom as cues for sleep rather than for frustrated wakefulness. The sleeper uses the bed only for sleep and intimacy, gets up when unable to sleep, and keeps a fixed wake time.",
     "problem": "Lying awake in bed builds a learned association between the bed and wakefulness.",
     "recommendation": "Reserve the bed for sleep; leave it after ~20 minutes awake and return only when sleepy."},
    {"topic": "Insomnia — sleep restriction (CBT-I)",
     "content": "Sleep restriction therapy deliberately limits time in bed to approximately the time actually spent asleep, raising homeostatic sleep pressure so that sleep becomes deeper and more consolidated. Time in bed is extended as sleep efficiency improves.",
     "problem": "Spending long hours in bed to catch up fragments sleep and weakens sleep drive.",
     "recommendation": "Match time in bed to actual sleep time to build sleep pressure, then extend gradually as efficiency improves."},
    {"topic": "Light &amp; circadian timing",
     "content": "The circadian system is set primarily by light reaching the retina, which signals the suprachiasmatic clock that governs sleep timing, alertness, and melatonin release. Bright morning light advances the clock; late-evening light delays it.",
     "problem": "A drifting body clock makes it hard to fall asleep and wake at consistent times.",
     "recommendation": "Get bright light (ideally outdoors) within an hour of waking, and keep evenings dim to anchor the clock."},
    {"topic": "Screens &amp; blue light",
     "content": "Short-wavelength (blue) light from phones, tablets, and laptops is especially effective at suppressing melatonin and signalling daytime to the circadian clock, while engaging content keeps the mind aroused when it should be settling.",
     "problem": "Bright screens in the hour before bed suppress melatonin and delay sleep onset.",
     "recommendation": "Stop screens 30-60 min before bed, or dim displays and enable night mode if use is unavoidable."},
    {"topic": "Alcohol",
     "content": "Alcohol is a sedative that shortens sleep onset, which is why it is often mistaken for a sleep aid. As it is metabolized it produces rebound arousal, lighter fragmented second-half sleep, suppressed REM, and worsened snoring and apnea.",
     "problem": "Alcohol sedates at first but fragments second-half sleep and suppresses REM.",
     "recommendation": "Avoid alcohol within 3-4 hours of bedtime; note quantity and timing when sleep is disrupted."},
    {"topic": "Napping",
     "content": "Daytime naps discharge some of the homeostatic sleep pressure that builds across waking hours. A short early-afternoon nap can restore alertness, but long or late naps eat into the sleep drive needed at night.",
     "problem": "Long or late naps reduce night-time sleep drive and push back sleep onset.",
     "recommendation": "Keep naps under 20-30 minutes and before mid-afternoon to protect the night''s sleep."},
    {"topic": "Exercise &amp; activity",
     "content": "Regular physical activity deepens slow-wave sleep, shortens sleep onset, and reduces the anxiety and low mood that feed insomnia. The main caveat is timing, since vigorous exercise raises arousal.",
     "problem": "Inactivity weakens sleep drive, while vigorous exercise too close to bed can delay sleep onset.",
     "recommendation": "Encourage regular daytime activity; finish vigorous exercise at least 2-3 hours before bed."},
    {"topic": "Bedroom environment",
     "content": "Initiating sleep requires a drop in core body temperature, so a cooler room (~18C / 65F) supports both falling and staying asleep. Darkness preserves melatonin and quiet limits brief arousals.",
     "problem": "A warm, bright, or noisy room raises arousal and interrupts sleep.",
     "recommendation": "Keep the bedroom cool (~18C / 65F), dark, and quiet; address light and noise sources."},
    {"topic": "Racing mind &amp; worry",
     "content": "Cognitive arousal — rumination, planning, and clock-watching — is a leading driver of difficulty falling and staying asleep, and intensifies as anxiety about not sleeping grows. CBT-I moves worry out of the bed.",
     "problem": "Rumination and clock-watching at night drive arousal and prolong wakefulness.",
     "recommendation": "Schedule a worry window earlier in the evening and keep a notepad to offload thoughts before bed."},
    {"topic": "Sleep apnea screening",
     "content": "Obstructive sleep apnea involves repeated collapse of the upper airway during sleep, producing loud snoring, witnessed breathing pauses, gasping arousals, and unrefreshing sleep. It is a medical condition, not resolved by sleep-hygiene coaching.",
     "problem": "Loud snoring, witnessed breathing pauses, gasping, and heavy daytime sleepiness can signal obstructive sleep apnea.",
     "recommendation": "Treat as a clinical red flag: recommend evaluation by a clinician rather than coaching alone."}
  ]'::jsonb,

  '[]'::jsonb,   -- uploaded_files (no files seeded; bucket `sleep-input-files` created separately)
  '[]'::jsonb,   -- datasets
  'Adults seeking help with insomnia, irregular schedules, or poor sleep quality; some report daytime sleepiness.',
  'Emergency / sleep-apnea red flags (snoring + witnessed pauses + gasping), shift workers with inverted schedules, heavy late caffeine or alcohol use, and users who only make small talk (state must stay blank).',
  now(),
  now()
)
on conflict (id) do nothing;

-- No policy_canvases / state_policy_canvases / canvas_execution_plans rows are
-- seeded on purpose (see header). The seeded sleep_inputs row above is
-- sufficient to bootstrap /demo/sleep/input and the sleep chat runtime; canvases
-- are produced when an expert saves setup in the UI.

-- End of 0002_seed_sleep.sql
