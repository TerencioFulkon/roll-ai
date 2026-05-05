# RollAI — UX/UI Plan: Unauthenticated User Flow

Scope: the complete pre-auth experience. Four screens, one continuous journey.
Auth, dashboard, settings, and post-signup onboarding are out of scope here.

---

## Flow overview

```
Landing / Upload → Processing → Analysis Output → Signup Prompt
```

All four can live on a single route with UI state driving transitions, or introduce
react-router-dom with `/job/:id` for deep-linkable processing and output screens.
Recommendation: start with state-driven transitions, add router when auth arrives.

---

## Design stack decision (resolve before starting)

The brief specifies Tailwind + shadcn/ui + lucide-react. None are currently installed.
The design system reference page (rollai-design-system.html) already defines all tokens
and components to the brief's spec.

**Recommendation: go Option B (Tailwind + shadcn) from the outset.**
Install once, build on it for every subsequent screen. Avoids rewriting CSS components twice.

Install list:
- `tailwindcss`, `postcss`, `autoprefixer`
- `shadcn/ui` (init + add components as needed)
- `lucide-react`
- Configure Tailwind theme extension with `--rollai-*` CSS variables from tokens.css

---

## Screen 1 — Landing / Upload (P0)

**Purpose:** sell the product and capture the video in one surface. No separate marketing page.

### Layout
- Single card, max-width 480px, centred, 16px horizontal padding on mobile
- Dark surface background (`--color-surface`) on dark page background (`--color-bg`)

### Content order
1. **Hero** — app name "RollAI" + one-line value prop: *"AI coaching commentary on your BJJ rolls."*
2. **Form fields** (in cognitive order):
   - What are you wearing? (text input)
   - Your photo (optional file input — helps AI identify you)
   - Select video (file input)
   - Voice selector (see below)
3. **Trust row** — "Max 10 min · MP4, MOV, WEBM, MKV" — caption/secondary beneath video input
4. **Primary CTA** — "Analyse Roll" button (accent, pill, full-width on mobile)
   - Disabled until: video selected + descriptor filled
   - Disabled state: 50% opacity, no pointer
   - Loading state: spinner + "Uploading…" while request is in flight

### Voice selector
- Shows selected voice name + gender tag
- Opens full-width bottom sheet on mobile (see design system reference)
- Bottom sheet lists all voices grouped by gender, with play-preview icon per voice
- Closes on selection or tap outside

### Errors
- Inline above CTA, in `--color-error`
- Distinguish: validation (client-side, immediate) vs upload failure (server response) vs voice load failure (non-blocking banner, fallback to Jordan)

### File constraints
- Communicated passively in trust row — not as error until violated
- On violation: specific message ("Video must be under 10 minutes", "Unsupported format")

---

## Screen 2 — Processing (P0)

**Purpose:** hold the user through a ~1–3 minute wait. Reduce abandonment, set expectations.

### Trigger
Replaces upload form immediately on successful job submission (job_id received).

### Layout
- Same card surface as upload screen — visual continuity
- No navigation away option (for now — revisit when router + job deep links exist)

### Content
1. **Stage indicator** — 4-step segmented progress or labelled step list:
   - Uploading → Analysing footage → Generating coach voice → Building video
2. **Stage copy** — maps from backend `status` + `progress` fields:
   - `pending` / `uploading` → "Uploading your roll…"
   - `processing` → "Analysing your footage…"
   - `generating_audio` → "Generating coach voice…"
   - `stitching_video` → "Building your video…"
3. **Elapsed timer** (optional) — "This usually takes 1–3 minutes" sets expectation without precise countdown
4. **Spinner** — accent colour, minimal, not distracting

### Poll behaviour
- 5s interval (existing) — no change needed
- On `failed`: show `error_message` from API, offer "Try again" (resets to upload screen)
- On poll network failure: "Still checking…" — retry silently, don't clear job state

---

## Screen 3 — Analysis Output (P1)

**Purpose:** deliver the coached video. Primary value moment.

### Trigger
Replaces processing screen when `status === "complete"`.

### Layout
- Video player full-width, native controls
- Below player: secondary actions

### Content
1. **Video player** — full-width, `max-width: 480px` on desktop, `width: 100%` on mobile
   - Native `<video controls>` — keyboard accessible, mobile-native controls
2. **Download** — `<a download href={outputUrl}>Download video</a>` styled as secondary button
   - Note: R2 public URLs don't expire — no "refresh link" needed
3. **"Analyse another roll"** — ghost button, resets all state back to upload screen
4. **Dev QA score** — hidden behind `VITE_SHOW_QA=true` env flag, never visible to athletes

### No share yet
Share functionality is a later epic — don't add placeholder UI.

---

## Screen 4 — Signup Prompt (P1)

**Purpose:** convert interested users after they've experienced the value. Low friction, not a gate.

### Trigger
Appears after analysis output is shown — either as a bottom sheet or inline below the output card.

### Content
- Headline: *"Save and revisit your analysis"*
- Subline: *"Sign up free to keep your coached videos and track your progress."*
- Primary CTA: "Create free account" (accent, pill)
- Secondary: "Maybe later" (ghost — dismisses and stays on output screen)

### Behaviour
- Dismissible — user stays on output screen if they decline
- If dismissed, don't show again in the same session
- Does not block access to Download or "Analyse another roll"

---

## States and resilience summary

| State | Behaviour |
|---|---|
| Voices loading | Select disabled, "Loading voices…" placeholder |
| Voices failed | Non-blocking banner, fallback Jordan voice, form still usable |
| Upload in flight | Button → spinner + "Uploading…", inputs disabled |
| Poll failure | Silent retry, "Still checking…" copy |
| Job failed | Error message + "Try again" CTA |
| Output URL missing | "Something went wrong" + retry option |

---

## Accessibility (this flow only)

- All inputs have associated `<label>` via `htmlFor` (already in place)
- Focus visible on all interactive elements — use `--color-accent` 2px outline, no browser default ring
- Voice selector bottom sheet: trap focus while open, close on Escape
- Video: native controls are keyboard accessible by default
- Touch targets ≥ 44px on primary button, file inputs, and voice selector
- Colour contrast: validate dark theme against WCAG AA

---

## Responsive

- Mobile-first, single column
- Card max-width 480px, centred on larger screens
- Video player full-width within card
- Bottom sheet voice selector spans full viewport width on mobile

---

## Phased delivery

| Phase | Work |
|---|---|
| 1 — Foundation | Install Tailwind + shadcn + lucide-react. Apply tokens. Rename to RollAI. Fix light/dark inconsistency. Hero copy. Button + input focus states. |
| 2 — Upload polish | Voice selector bottom sheet. Trust row. Inline error states. Upload loading state. |
| 3 — Processing UX | Stage-aware copy. Step indicator. Elapsed time. |
| 4 — Output + prompt | Output layout. Download link. "Analyse another" action. Signup prompt sheet. Dev QA flag. |

---

## Out of scope (this document)

Auth UI, post-signup onboarding, dashboard, video library, settings, Stripe, PWA, share, gym thread.
