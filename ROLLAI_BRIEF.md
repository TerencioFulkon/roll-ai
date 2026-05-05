# RollAI — Project Context & Requirements

## Overview

RollAI is a web app that analyses BJJ (Brazilian Jiu-Jitsu) training footage and produces a voiced coaching commentary video. A user uploads a video of their roll, the app analyses it using GPT-4o vision, generates a timestamped coaching script, converts it to speech using ElevenLabs TTS, and stitches the audio onto the original video using FFmpeg.

The product is aimed at BJJ practitioners who want coaching-quality feedback on their training without needing a coach present. The core insight: every BJJ practitioner wants better feedback but most only get it occasionally. RollAI solves a real, recurring problem.

-----

## Tech Stack

- **Backend:** Node.js + Express, deployed locally (Railway planned for production)
- **Frontend:** React + Vite, deployed locally (Vercel planned for production)
- **Database & Storage:** Supabase (PostgreSQL + object storage)
- **AI/Vision:** GPT-4o (two-pass analysis at 4fps)
- **TTS:** ElevenLabs (`eleven_turbo_v2_5` model)
- **Media processing:** FFmpeg (frame extraction, audio stitching, watermark)
- **Auth (planned):** Supabase Auth
- **Payments (planned):** Stripe

-----

## Analysis Pipeline

The pipeline runs in a background worker (`backend/jobs/processVideo.js`) and consists of four passes:

### Pass 1 — Visual Analysis

- FFmpeg extracts frames at 4fps from the uploaded video
- Frames sent to GPT-4o for holistic roll summary
- Returns: `summary`, `key_moments` (timestamped), `strengths`, `areas_to_improve`, `overall_theme`
- Has retry logic (up to 2 attempts) with JSON parse error handling

### Pass 2 — Coaching Script Generation

- Uses Pass 1 output + video duration to generate a timestamped coaching script
- Duration-aware: calculates `maxSegments = floor(videoDurationSeconds / (14 + 2))`
- GPT is told exactly how many segments to generate and the minimum spacing between them
- Returns: `segments` array of `{ timestamp: seconds, text: string }`
- Each segment: 1–2 sentences, max 35 words
- Has retry logic (up to 2 attempts)

### Pass 3 — Timing Validation

- Uses ffprobe to measure actual duration of each generated MP3
- Validates that no segment overlaps the next (minimum 2s gap after each clip ends)
- Drops segments that would start beyond the video duration
- Passes timing-safe segments to FFmpeg

### Pass 4 — QA Scoring (internal/developer only)

- After video generation, scores the pipeline output quality
- Sub-scores: visual_accuracy (25%), coaching_usefulness (20%), timing_accuracy (25%), speech_coverage (20%), output_compliance (10%)
- Hard score caps based on objective coverage metrics:
  - speech_coverage_pct < 25% → max 6.0
  - max_silent_gap > 25s → max 6.5
  - average_silent_gap > 15s → max 7.0
  - overlap_count > 0 → max 5.0
  - segment_count < 3 on video > 45s → max 5.5
- **Known bug (deferred):** GPT still overrides score caps. Fix: calculate `analysis_quality_score` entirely in code using `computeAnalysisQualityScoreCeiling`, remove it from GPT response shape. Deferred to core analysis optimisation phase.

### FFmpeg Stitch

- Each audio segment placed at its validated timestamp using `adelay` filter
- All segments mixed with `amix`
- `drawtext` watermark: "RollAI" bottom-right, white, 24px, 50% opacity
- Configurable via `WATERMARK_TEXT` env var

-----

## Coaching Prompt Design

The Pass 2 coaching prompt is carefully engineered:

- **Tense:** Past tense and retrospective framing throughout. Never present tense ("you're", "now you're"). Always "you were", "you had", "at this point you had moved into".
- **Perspective:** Always "you" — direct, personal coaching. Never "we".
- **Core principle — Causal Coaching:** Every observation must connect to a consequence and a correction. Format: what you did → why it was a problem → what you should have done instead.
- **Foresight:** References how early mistakes led to later problems across the full roll.
- **Opening:** Belt level + one physical characteristic visible in footage + central problem/theme.
- **Closing:** Most important thing to drill before next session + one genuine strength.

-----

## Voice System

Six voices available, selectable by user via dropdown:

|Key    |Name   |Gender|ElevenLabs ID       |
|-------|-------|------|--------------------|
|jordan |Jordan |Male  |obcEwiLH5xERuD4ZBXW4|
|george |George |Male  |JBFqnCBsd6RMkjVDRZzb|
|daniel |Daniel |Male  |onwK4e9ZLuTAKqWW03F9|
|brian  |Brian  |Male  |nPczCjzI2devNBz1zQrb|
|alice  |Alice  |Female|Xb7hH8MSUJpSbSDYk0k2|
|matilda|Matilda|Female|XrExE9yKIg1WjnnlVkGX|
|sarah  |Sarah  |Female|EXAVITQu4vr4xnSDxMaL|

- Default voice: `jordan`
- Voice key passed in upload request body as `voice_key`
- `GET /api/voices` returns available voices for frontend dropdown
- Voice settings: stability 0.45, similarity_boost 0.75, style 0.3, use_speaker_boost true

-----

## Database Schema (Supabase)

### `jobs`

Core job tracking table. Primary key is `sqlid` (uuid).

### `usage_logs`

Tracks token usage and cost per analysis job.

- `job_id` → `jobs(sqlid)`
- `pass1_prompt_tokens`, `pass1_completion_tokens`, `pass1_cost_usd`
- `pass2_prompt_tokens`, `pass2_completion_tokens`, `pass2_cost_usd`
- `tts_characters`, `tts_cost_usd`
- `total_cost_usd`
- `voice_key`, `video_duration_seconds`

### `quality_scores`

Internal QA scores per analysis job.

- `job_id` → `jobs(sqlid)`
- `analysis_quality_score` (numeric 4,1)
- `visual_accuracy`, `coaching_usefulness`, `timing_accuracy`, `speech_coverage`, `output_compliance` (all integer)
- `main_issues` (jsonb), `recommended_fix` (text)
- `coverage_metrics` (jsonb) — objective timing metrics

-----

## API Endpoints

|Method|Path              |Description                       |
|------|------------------|----------------------------------|
|POST  |/api/upload       |Upload video, returns job_id      |
|GET   |/api/jobs/:id     |Poll job status                   |
|GET   |/api/voices       |List available voices             |
|GET   |/api/admin/usage  |All usage_logs rows (dev only)    |
|GET   |/api/admin/quality|All quality_scores rows (dev only)|

-----

## Pricing Model

|Tier     |Price |Allowance            |
|---------|------|---------------------|
|Free     |£0    |2 rolls              |
|Pro      |£19/mo|30 rolls             |
|Unlimited|£39/mo|~100 rolls (soft cap)|

Unit cost per analysis: ~£0.31 (dominated by Pass 1 frame tokens at ~$0.30)

-----

## Design System

App name: **RollAI**

### Colour Tokens

```css
/* Dark theme */
--color-bg: #1F1F1E;
--color-surface: #2A2A28;
--color-surface-elevated: #333331;
--color-border: #3A3A38;
--color-accent: #E8FF47;
--color-accent-hover: #D4EB3A;
--color-text-primary: #F5F5F0;
--color-text-secondary: #909088;
--color-success: #4ADE80;
--color-error: #F87171;

/* Light theme */
--color-bg: #F5F4F0;
--color-surface: #FFFFFF;
--color-surface-elevated: #EFEFED;
--color-border: #E0DED8;
--color-accent: #C8E032;
--color-accent-hover: #B5CC2A;
--color-text-primary: #1A1A18;
--color-text-secondary: #6B6B68;
--color-success: #2D9E5F;
--color-error: #D94F4F;
```

### Typography — Inter

- Heading: 28px / 700 — section titles only
- Subheading: 18px / 600 — card titles
- Body: 15px / 400 — all content
- Caption: 12px / 400 — labels, metadata, helper text
- Line height: 1.5

### Spacing Scale

4px, 8px, 12px, 16px, 24px, 32px

### Layout Rules

- 16px horizontal padding on mobile
- 12–16px vertical spacing between components
- Cards: 16px internal padding

### Border Radius

- Small: 8px
- Default: 14px
- Pill: 24px

### Interaction States

All interactive components must have: Default, Hover, Active, Disabled (50% opacity), Focus (2px accent outline)

### Hierarchy Rules

- Only one primary CTA per screen uses accent background
- Accent colour must not exceed 15% of visible UI
- Secondary actions use outline or ghost styles

### Theme Toggle

- `useTheme` hook reads/writes `localStorage` key `rollai-theme`
- Default: dark
- `data-theme` attribute applied to `document.documentElement`
- `ThemeToggle` component uses Sun/Moon icons from lucide-react

### Tech

- Tailwind CSS configured with CSS variable tokens as custom colours
- shadcn/ui components in `frontend/src/components/ui/`
- Tokens in `frontend/src/styles/tokens.css`

-----

## App Flow (Planned)

The landing page and upload page are the same screen — the product sells itself by letting you use it immediately.

### Unauthenticated Flow

1. User lands on home screen — sees upload UI immediately
1. One-line hero explains what RollAI is
1. User fills in: what they're wearing, optional photo, selects video, selects voice
1. Upload triggers analysis pipeline
1. User sees progress/processing state
1. Analysis completes → output screen shows video with coaching commentary
1. Post-analysis signup prompt: "Save and share your analysis — sign up free"

### Authenticated Flow

1. User lands on dashboard showing their previous analyses
1. Can upload new roll from dashboard
1. Settings page for voice preference, profile, subscription

-----

## Key Screens to Build

1. **Home/Upload** (combined landing + upload) — highest priority
1. **Processing** — progress state while analysis runs
1. **Analysis Output** — video player + coaching commentary + quality score (dev only)
1. **Auth** — signup/login (Supabase Auth)
1. **Onboarding** — post-signup, belt level, goals
1. **Dashboard** — authenticated user's video library
1. **Settings** — voice, profile, subscription

-----

## Prioritised Task List

1. ✅ ElevenLabs TTS integration
1. ✅ Audio overlap/timing fix (3-pass timing system)
1. ✅ Voice selector dropdown
1. ✅ Token usage logging to Supabase
1. ✅ FFmpeg watermark
1. ✅ Quality scoring tool (Pass 4)
1. 🔄 Supabase Auth
1. Anonymous session for pre-auth analysis
1. Post-analysis signup prompt
1. Onboarding flow
1. Usage tracking + tier enforcement
1. Stripe integration
1. Video library
1. Analysis output screen improvements
1. Share functionality
1. PWA
1. Gym thread / community feature
1. Referral system

-----

## Known Issues & Deferred Work

### Quality Score Caps Not Enforced

GPT overrides hard score caps. Fix is to compute `analysis_quality_score` entirely in code:

```js
const weightedAverage = (visual_accuracy * 0.25) + (coaching_usefulness * 0.20) + 
  (timing_accuracy * 0.25) + (speech_coverage * 0.20) + (output_compliance * 0.10);
const analysis_quality_score = Math.min(weightedAverage, computeAnalysisQualityScoreCeiling(coverageMetrics));
```

Remove `analysis_quality_score` from GPT response shape entirely. **Deferred to core analysis optimisation phase.**

### dotenv Loading

Environment variables sometimes require inline forcing when running scripts:

```bash
ELEVENLABS_API_KEY=xxx node backend/scripts/listElevenLabsVoices.js
```

This is a known quirk of the project's dotenv setup for one-off scripts.

-----

## Cost Breakdown (per analysis)

|Component             |Cost                     |
|----------------------|-------------------------|
|Pass 1 (GPT-4o frames)|~$0.30                   |
|Pass 2 (GPT-4o script)|~$0.006                  |
|Pass 4 (GPT-4o QA)    |~$0.003                  |
|ElevenLabs TTS        |~$0.003 (at $0.0003/char)|
|**Total**             |**~£0.31**               |

-----

## Environment Variables Required

```env
# OpenAI
OPENAI_API_KEY=

# ElevenLabs
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_JORDAN=obcEwiLH5xERuD4ZBXW4
ELEVENLABS_VOICE_GEORGE=JBFqnCBsd6RMkjVDRZzb
ELEVENLABS_VOICE_DANIEL=onwK4e9ZLuTAKqWW03F9
ELEVENLABS_VOICE_BRIAN=nPczCjzI2devNBz1zQrb
ELEVENLABS_VOICE_ALICE=Xb7hH8MSUJpSbSDYk0k2
ELEVENLABS_VOICE_MATILDA=XrExE9yKIg1WjnnlVkGX
ELEVENLABS_VOICE_SARAH=EXAVITQu4vr4xnSDxMaL

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
SUPABASE_ANON_KEY=

# App
WATERMARK_TEXT=RollAI
VIDEO_PLAYBACK_SPEED=1
```

-----

## Revenue Potential

- **Realistic Year 1:** £3k–8k/month (200–400 Pro subscribers)
- **Optimistic Year 1-2:** £15k–40k/month (gym partnerships, influencer distribution, adjacent sports)
- **Ceiling:** Corporate wellness, university sports programs, national governing bodies — potential six-figure contracts at scale

Key growth levers: analysis quality, distribution via BJJ communities (Reddit, Instagram, YouTube), gym thread/community features for retention.
