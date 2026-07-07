# Sleep Assistant

A standalone extraction of the **Sleep Assistant** demo — an AI sleep coach with a
patient-facing assessment, a chat interface, and an expert **Studio** (canvas-based
policy/state configuration, observability, feedback, and dataset/guideline setup).

Extracted from the `airlab` monorepo. Built on Next.js 16 (App Router), React 19,
Tailwind 4, Clerk (auth), Supabase (data), and OpenAI.

## Surfaces

| Route | What it is |
|---|---|
| `/` | Landing page linking to the surfaces below |
| `/sleep-assessment`, `/sleep-assessment/hermes` | Patient-facing sleep assessment flow |
| `/demo/sleep` | The chat interface (`/api/chat/sleep/base`) |
| `/demo/sleep/studio` | Expert studio (mostly mock-driven; renders without a backend) |
| `/demo/sleep/studio/config` | Canvas policy/state configuration |
| `/demo/sleep/input` | Setup: state schema, prompts, datasets, guidelines, file uploads |
| `/demo/sleep/expert-dashboard` | Admin view of sleep conversations |

## Architecture

The heavy platform lives in `packages/@airlab/*` (canvas + orchestration + chat UI),
consumed through thin re-export wrappers under `app/components/*` and `app/lib/*`.
`next.config.ts` transpiles these workspace packages.

> Note: `app/api/` also contains non-sleep routes carried over for dependency
> completeness (`openclaw`, `corpus`, `general-orchestration-daemon`, `mcp`, `sandbox`,
> `test`). They are unused by the sleep surfaces and can be pruned.

## Local development

1. **Install** (Node 20+):
   ```bash
   npm install
   ```
2. **Environment:** copy `.env.example` → `.env.local` and fill in the values
   (see [Configuration](#configuration)).
3. **Database:** create the schema and seed data (see [Supabase](#supabase-setup)).
4. **Run:**
   ```bash
   npm run dev
   ```
   Open http://localhost:3000.

## Configuration

All variables are documented in `.env.example`. The essentials:

- **Supabase** — `NEXT_PUBLIC_AIRLAB_SUPABASE_URL`, `NEXT_PUBLIC_AIRLAB_SUPABASE_ANON_KEY`,
  `AIRLAB_SUPABASE_SERVICE_ROLE_KEY`. All data access uses the service-role key
  (server-side); keep it secret.
- **OpenAI** — `AIRLAB_OPENAI_API_KEY` (base chat + fine-tuned triage).
  `AIRLAB_FT_SLEEP_STAGE_1` sets the fine-tuned model id (a default is baked in).
- **Clerk** — `NEXT_PUBLIC_AIR_CLERK_PUBLISHABLE_KEY`, `AIR_CLERK_SECRET_KEY`.
  Create a Clerk application and paste its keys.

## Supabase setup

1. Create a new Supabase project.
2. Apply the schema + seed. Either with the Supabase CLI:
   ```bash
   supabase link --project-ref <your-ref>
   supabase db push        # applies supabase/migrations/*
   ```
   …or paste `supabase/migrations/0001_init.sql` then `0002_seed_sleep.sql`
   into the Supabase SQL editor and run them.
3. Create a **Storage bucket** named `sleep-input-files` (used by the input page's
   file uploads).

The seed inserts a default `sleep_inputs` row so `/demo/sleep/input` and the chat
have a working configuration on first run.

## Deploy to Vercel

1. Push this repo to GitHub (see below).
2. In Vercel, **New Project → import the repo**. Framework preset: **Next.js**
   (auto-detected). No special build settings needed — the `@airlab/*` workspace
   packages build via `transpilePackages`.
3. Add every variable from `.env.example` under **Project → Settings → Environment
   Variables** (Production + Preview).
4. Deploy. Point Clerk's allowed origins / redirect URLs at the Vercel domain.

Or with the CLI:
```bash
vercel link
vercel env pull            # optional: sync down
vercel --prod
```

## Push to a new GitHub repo

```bash
git init && git add -A && git commit -m "Initial extraction: Sleep Assistant"
gh repo create sleep-therapist --private --source=. --push
```
