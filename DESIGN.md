---
name: Vault
description: Encrypted personal vault — warm, precise, quiet confidence. Dark stone palette with brass accent.
colors:
  accent:          "oklch(0.72 0.06 70)"
  accent-strong:   "oklch(0.78 0.07 70)"
  accent-dim:      "oklch(0.72 0.06 70 / 0.08)"
  green:           "oklch(0.78 0.12 145)"
  amber:           "oklch(0.82 0.1 85)"
  red:             "oklch(0.72 0.14 25)"
  bg:              "oklch(0.14 0.008 70)"
  bg-surface:      "oklch(0.17 0.007 70)"
  bg-raised:       "oklch(0.21 0.006 70)"
  bg-input:        "oklch(0.19 0.005 70)"
  txt:             "oklch(0.92 0.004 70)"
  txt-sec:         "oklch(0.68 0.006 70)"
  txt-muted:       "oklch(0.52 0.005 70)"
  txt-dim:         "oklch(0.4 0.004 70)"
  border:          "oklch(1 0 0 / 0.05)"
  border-h:        "oklch(1 0 0 / 0.09)"
  border-focus:    "oklch(0.72 0.06 70 / 0.5)"
typography:
  display:
    fontFamily: "Outfit, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Outfit, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Outfit, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Outfit, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Outfit, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.07em"
    textTransform: "uppercase"
  mono:
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "7px"
  md: "10px"
  lg: "14px"
  xl: "18px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
  page: "28px 32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg}"
    rounded: "{rounded.md}"
    padding: "9px 18px"
    typography: "600 12px Outfit"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.txt-sec}"
    rounded: "{rounded.md}"
    border: "1px solid {colors.border}"
    padding: "9px 18px"
    typography: "400 12px Outfit"
  button-danger:
    backgroundColor: "{colors.red-dim}"
    textColor: "{colors.red}"
    rounded: "{rounded.md}"
    padding: "9px 18px"
    typography: "500 12px Outfit"
  nav-btn-active:
    backgroundColor: "{colors.accent-dim}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: "9px 12px"
    typography: "500 12.5px Outfit"
  card-surface:
    backgroundColor: "{colors.bg-surface}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.lg}"
    padding: "18px"
  input-field:
    backgroundColor: "{colors.bg-input}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.md}"
    padding: "0 13px"
    typography: "400 12.5px Outfit"
  badge:
    backgroundColor: "{colors.bg-raised}"
    textColor: "{colors.txt-dim}"
    rounded: "{rounded.pill}"
    padding: "1px 6px"
    typography: "400 10px {typography.mono.fontFamily}"
  toast:
    backgroundColor: "{colors.bg-surface}"
    border: "1px solid {colors.border-h}"
    rounded: "{rounded.pill}"
    padding: "10px 22px"
    typography: "400 12px Outfit"
---

# Design System: Vault

## 1. Overview

**Creative North Star: "The Warm Vault"**

Vault feels like opening a personal safe made of dark walnut and aged brass. Every surface is quiet. Every accent is earned. The warm stone palette (hue 70°, lightness 14–21% for surfaces) wraps the user in something that feels considered and permanent — not a disposable SaaS dashboard, but a trusted daily companion.

This system rejects the reflexes that make AI tools look interchangeable: no glassmorphism, no gradient noise, no purple, no big-metric hero sections, no card grids with identical icon+heading+text triplets. Depth comes from tonal layering — five surface steps from `--bg` (14% lightness) to `--bg-raised` (21%) — and from the single brass accent that glows only where it matters. Shadows are structural, never decorative. Motion is state-only: elements respond, they don't perform.

**Key Characteristics:**
- **One accent, ≤10% surface coverage.** The warm brass (`oklch 0.72 0.06 70`) appears on active nav items, primary buttons, focus rings, and inline highlights. Restraint is the point.
- **Five-step tonal layering.** Surfaces ascend: bg → surface → raised → input → overlay. No two adjacent elements share the same ground.
- **Borders are whispers.** `--border` sits at 5% white opacity; `--border-h` at 9%. They define space without drawing lines.
- **Typography does the hierarchy work.** Outfit at 26/22/17/14/10px with letter-spacing tight on display, open on labels. JetBrains Mono for codes, usernames, and technical data.
- **Rounded corners follow a natural scale.** 4px on window controls, 7px on small elements, 10px on buttons/cards, 14px on larger containers, 18px on modals and the login card, 999px on pills.

## 2. Colors

The Vault palette is a single-hue warm stone system (hue 70°, neutral-to-brown) with three signal colors (green/amber/red) for status communication.

### Primary
- **Warm Brass Accent** (`oklch(0.72 0.06 70)`): The sole accent. Active nav items, primary button backgrounds, focus rings, password codes, generator output, tab headings, selection highlights. Everywhere it appears, it signals "this is the thing to interact with."
- **Accent Glow** (`oklch(0.72 0.06 70 / 0.12)`): 12% opacity wash for card hover elevation, login shield ambient glow.
- **Accent Strong** (`oklch(0.78 0.07 70)`): Hover state for primary buttons — slightly lighter and more saturated.

### Secondary (signal colors)
- **Signal Green** (`oklch(0.78 0.12 145)`): Success states. Accepted job applications, strong password indicators, copy-to-clipboard confirmation. Used at 8% opacity for tinted backgrounds (`--green-dim`).
- **Signal Amber** (`oklch(0.82 0.1 85)`): Waiting/caution. Pending job applications, fair password strength, 2FA icons. Tinted backgrounds at 8% (`--amber-dim`).
- **Signal Red** (`oklch(0.72 0.14 25)`): Destructive action, errors, trash countdown, breach warnings. Tinted backgrounds at 8% (`--red-dim`).

### Neutral
- **Foundation Dark** (`oklch(0.14 0.008 70)`): Page background. The deepest surface — 14% lightness with a barely perceptible warm tint.
- **Surface** (`oklch(0.17 0.007 70)`): Default card and list-row background. Sidebar content area.
- **Raised** (`oklch(0.21 0.006 70)`): Hover states, modal surfaces, stats cards, job table rows. The highest "normal" surface.
- **Input Ground** (`oklch(0.19 0.005 70)`): Form field backgrounds. Between Surface and Raised — reads as "something goes here."
- **Quiet Text** (`oklch(0.92 0.004 70)`): Primary text. Near-white with warm tint, never pure `#fff`.
- **Secondary Text** (`oklch(0.68 0.006 70)`): Nav labels, headings, usernames.
- **Muted Text** (`oklch(0.52 0.005 70)`): Helper text, descriptions, timestamps.
- **Dim Text** (`oklch(0.4 0.004 70)`): Placeholders, window controls, monospaced metadata.
- **Whisper Border** (`oklch(1 0 0 / 0.05)`): Default border. 5% white — barely visible, strictly structural.
- **Hover Border** (`oklch(1 0 0 / 0.09)`): Raised border on hover states.

### Named Rules

**The One Voice Rule.** The brass accent appears on ≤10% of any given screen. Its rarity is the point — when it glows, it means something. Nav buttons use a tinted background (`accent-dim` at 8%), not the raw accent color. Only primary buttons and password codes use the full saturated accent.

**The Nine-Five Rule.** Neutral surfaces never reach pure black or pure white. The darkest surface (`--bg`) is 14% lightness, not 0%. The brightest text (`--txt`) is 92% lightness, not 100%. The warm tint (chroma 0.004–0.008) prevents the sterile coldness of a pure gray ramp.

## 3. Typography

**Display Font:** Outfit (with -apple-system, BlinkMacSystemFont, Segoe UI, system-ui fallbacks)
**Body Font:** Outfit — same family used at every scale step
**Label/Mono Font:** JetBrains Mono (with Fira Code, ui-monospace fallbacks)

**Character:** Outfit carries the warmth — rounded, humanist sans that feels friendly without being casual. It tightens with negative letter-spacing at display sizes (editorial headline feel) and opens to neutral tracking at body sizes (long-form readability). JetBrains Mono handles the technical layer — passwords, codes, usernames, timestamps — providing clear visual distinction between human language and machine data.

### Hierarchy
- **Display** (600, 26px, 1.2, -0.02em): Login card heading ("Vault"), 2FA heading. Used once per screen maximum. The largest type on the page.
- **Headline** (600, 22px, 1.3, -0.015em): Tab titles ("Passwords", "Notes", "Job Tracker"). Screen-level identity.
- **Title** (600, 17px, 1.4, -0.01em): Modal headings ("Add password"), settings section titles. Container-level identity.
- **Body** (400, 14px, 1.5, 0): All running text. Navigation labels, form values, descriptions, list content. Max line length ~70ch on wider surfaces.
- **Label** (500, 10px, 1.4, 0.07em, uppercase): Form field labels, sidebar section headers, column headers, status words. Always uppercase with wide letter-spacing.
- **Mono** (400, 12px, 1.5, 0): Passwords (masked), usernames, email addresses, timestamps, sort indicators, password strength labels, error messages, badge counts. The typewriter voice.

### Named Rules

**The Mono Boundary Rule.** Monospace type is used exclusively for data the user did not write in prose: passwords (shown or masked), usernames, emails, codes, timestamps, metadata tags. Never for headings, navigation, or body copy. The mono/sans boundary lets the user instantly distinguish "content I wrote" from "data the system manages."

**The Letter-Spacing Axis.** Display sizes use negative tracking (tighter, more impactful). Labels use positive tracking (wider, more scannable). Body stays at zero. This axis — tightening upward, opening downward — replaces the need for weight bombs everywhere.

## 4. Elevation

Depth is conveyed through two channels working in tandem: (1) tonal spacing across five surface darknesses (see Neutral above), and (2) structural shadows that only appear on interactive elevation.

At rest, surfaces are flat — no ambient shadows on cards, rows, or containers at their default state. The tonal difference between `--bg-surface` (17%) and the row hover state on `--bg-raised` (21%) provides enough contrast to signal interactivity through color alone.

Shadows appear when elements lift out of the document flow:
- **ambient-rest** is not used — flat is the default.
- **hover-lift** (`--shadow-sm`): 0 1px 2px + 0 1px 1px black at 25%/15%. Applied on list row hover, login card. Subtle ground-hugging.
- **elevated-card** (`--shadow`): 0 4px 12px + 0 1px 3px black at 30%/20%. Used on button-primary hover, modal surfaces.
- **floating-panel** (`--shadow-lg`): 0 8px 32px + 0 2px 8px black at 40%/25%. Login card, modals, confirm dialogs, status popup, toast. The deepest shadow, reserved for things that float above everything else.

The `inset` highlight (`--shadow-in`: inset 0 1px 0 at 4% white) adds a hairline of light along the top edge of elevated surfaces, reinforcing the sense of a physical card catching light from above.

### Shadow Vocabulary
- **ambient-glow** (`0 0 40px oklch(0.72 0.06 70 / 0.06)`): Login shield icon only. The only non-structural, decorative shadow — and it's 6% opacity brass glow. Barely visible, purely atmospheric.
- **focus-ring** (`0 0 0 3px oklch(0.72 0.06 70 / 0.12)`): 3px brass-tinted spread on focused inputs and hovered google button. Not a box-shadow on the element — a glow around it.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. Shadows appear only as response to state (hover → `--shadow-sm`, floating → `--shadow-lg`). If every card had a shadow at rest, nothing would feel elevated.

**The Inset Highlight Rule.** Any surface that uses `--shadow-lg` (login card, modals) also gets `--shadow-in` on the same element. The hairline of white at the top edge turns a dark rectangle into something that feels like a physical object.

## 5. Components

### Buttons

- **Shape:** 10px corners (`--r`)
- **Primary:** Brass accent background (`oklch 0.72 0.06 70`), dark text (`--bg`), 600 weight 12px, 9px vertical × 18px horizontal padding. On hover: background shifts to accent-strong, lifts 1px up, `--shadow` appears plus `--accent-glow` spread. On active: returns to flat, shadow contracts to `--shadow-sm`.
- **Ghost:** Transparent, 1px `--border` stroke, `--txt-sec` text. On hover: fills `--bg-surface`, border darkens to `--border-h`, text brightens to `--txt`.
- **Danger:** `--red-dim` background fill, `--red` text, 500 weight. On hover: background deepens toward `--red` opacity 15%.
- **Google OAuth:** Full-width, `--bg-raised` fill with `--border` stroke. On hover: `--bg-input` fill, `--border-h` stroke, plus brass `--accent-glow` focus ring and 1px lift.

### Navigation (Sidebar)

- **Panel:** 218px fixed width, `--bg` background, 1px `--border` right edge.
- **Nav Items:** 7px corners (`--r-sm`), 9px × 12px padding, `--txt-sec` text. On hover: `--bg-surface` fill, `--txt` color. **Active state:** `--accent-dim` fill (8% brass), `--accent` text at 500 weight. No border-left stripe; active state is communicated through background tint + text color.
- **Badge (count):** `--bg-raised` fill, `--txt-dim` text, 10px mono, `--r-pill` (fully rounded), 1px × 6px padding. Active item badges: `--accent-dim` fill, `--accent` text.

### Cards / Containers

- **Corner Style:** 10px (`--r`) on password rows, note chips. 14px (`--r-lg`) on job stats, TOTP cards, monitor cards, settings panels. 18px (`--r-xl`) on login card, modals.
- **Background:** Default `--bg-surface`. Hover raises to `--bg-raised` with `--border` stroke.
- **Shadow Strategy:** No shadow at rest. Hover adds `--shadow-sm`. Login card and modals get `--shadow-lg` + `--shadow-in`.
- **Border:** Rest state: 1px transparent (for layout stability). Hover state: 1px `--border` visible.
- **Internal Padding:** 13–16px on list rows, 18px on stat cards/TOTP cards, 22px on settings cards, 30–32px on modals.

### Inputs / Fields

- **Shape:** 10px corners (`--r`), 38px height
- **Style:** `--bg-input` fill, 1px `--border` stroke, 13px horizontal padding. 12.5px Outfit, `--txt` text, `--txt-dim` placeholder.
- **Focus:** Border shifts to `--border-focus` (brass at 50% opacity), plus `--accent-glow` 3px spread.
- **Password Field:** Same but with mono typeface. Includes an inline eye-toggle button (26 × 20px hit area) positioned absolutely at right: 10px.
- **Textarea:** Same base but 80px minimum height, vertical resize enabled, 1.6 line-height for comfortable writing.

### List Rows (Passwords, Trash, Notes)

- **Rest:** `--bg-surface` fill, no border, transparent stroke (for layout), 10px corners.
- **Hover:** `--bg-raised` fill, `--border` stroke visible, `--shadow-sm` shadow. Animation: `fadeUp` 180ms ease.
- **Action Buttons:** 30 × 30px icon buttons, 7px corners. Default: `--txt-dim`. Copy: `--green` + `--green-dim` fill. Delete: `--red` + `--red-dim` fill. Restore: `--green` + `--green-dim` fill.

### Toast

- **Position:** Fixed, bottom: 28px, centered with translateX(-50%).
- **Background:** `--bg-surface` with `--border-h` stroke, 16px backdrop blur.
- **Text:** 12px Outfit, `--txt` color, `--r-pill` (fully rounded), 10px × 22px padding.
- **Motion:** Opacity transition, 180ms ease. No translateY animation — clean on/off.

### Status Chips (Jobs)

- **Accepted:** `--green` text + `--green-dim` fill + 15% green border. `--status-accepted` class.
- **Waiting:** `--amber` text + `--amber-dim` fill + 15% amber border. `--status-wait` class.
- **Rejected:** `--red` text + `--red-dim` fill + 15% red border. `--status-rejected` class.
- **Pill shape:** `--r-pill` (fully rounded), 3px × 9px padding, 10px weight 500.

### TOTP Cards

- **Display:** `--bg-surface` fill, 14px corners (`--r-lg`), 18px padding. Auto-fill: `minmax(240px, 1fr)` grid.
- **Code:** 28px JetBrains Mono, `--accent` color, 0.12em letter-spacing, centered. Updates every second.
- **Progress Bar:** 3px height, `--bg-raised` track, `--accent` fill. Width updates every second (remaining 30s cycle).

### Confirm Dialog

- **Shape:** 350px wide modal variant, centered text, 36px padding.
- **Flow:** Large icon (36px emoji) → Title (16px semibold) → Message (12px `--txt-muted`, 1.7 line-height) → Action buttons (Cancel + action).

## 6. Do's and Don'ts

### Do:
- **Do** use the brass accent on ≤10% of any screen. Its scarcity creates meaning. When everything glows, nothing does.
- **Do** use `--bg-raised` for hover states. The five-step tonal ramp is the primary depth system — shadows are secondary.
- **Do** keep rows flat at rest. Show `--border` and `--shadow-sm` only on hover or focus.
- **Do** use JetBrains Mono for machine data (passwords, codes, usernames, timestamps) and Outfit for everything human-written.
- **Do** respect `--border` (5% white) as the default. Borders define space. They are never decorative.
- **Do** use `--shadow-lg` + `--shadow-in` together on the same element. One without the other breaks the physical-object metaphor.
- **Do** use opacity-based fills (8%/12%) for status tints, not opaque backgrounds. The surface should show through.
- **Do** animate only state transitions (hover, focus, active) using `--t-fast` (120ms) or `--t-base` (180ms) with `cubic-bezier(0.4, 0, 0.2, 1)`.
- **Do** use `prefers-reduced-motion: reduce` to kill all animation. (Already implemented in `app.css`.)

### Don't:
- **Don't** use `border-left` or `border-right` greater than 1px as a colored accent. Nav active state uses background tint, not a side stripe.
- **Don't** use `background-clip: text` with gradients. Gradient text is decorative noise.
- **Don't** use glassmorphism (backdrop-filter blurs) decoratively. It's used here on the titlebar and toast only — functional blur to read content underneath, never as a visual effect.
- **Don't** use the hero-metric template. No big number + small label + gradient glow. Job stats use the cards, not a hero banner.
- **Don't** build identical card grids. TOTP cards are the only grid use, and they have distinct internal structure (code + progress bar + icon). If a future grid looks like icon + heading + text repeated, rethink the layout.
- **Don't** wrap every element in a container. List rows are direct children of `.list`. Sidebar buttons are direct children of `.nav`. Avoid unnecessary wrapper divs.
- **Don't** use modals when inline would work. Job status changes use a popup, not a modal. Password strength is inline, not a modal.
- **Don't** use em dashes (—) in copy. Use commas, colons, semicolons, or parentheses.
- **Don't** let the accent #`. Don't add a second accent color unless there's a semantic reason (the three signal colors — green, amber, red — are the only exceptions, and they're for status only).
- **Don't** saturate neutrals.` range from chroma 0.004 to 0.008. If a gray looks gray, the chroma is too high.
