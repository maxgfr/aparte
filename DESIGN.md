---
name: Aparté
description: A private AI chat that never leaves the browser; a quiet, warm room built for long reading.
colors:
  lamp-green: "#1d6b5a"
  lamp-green-hover: "#175a4b"
  lamp-green-soft: "#e3f1ec"
  lamp-green-ink: "#17604f"
  on-lamp-green: "#fffdf9"
  paper: "#f6f4ef"
  sidebar: "#efece5"
  surface: "#fffdf9"
  surface-pressed: "#f0ece4"
  surface-raised: "#fffdf9"
  ink: "#1b1a17"
  ink-secondary: "#57534b"
  ink-tertiary: "#6b665d"
  hairline: "#e6e1d7"
  hairline-strong: "#d3ccbf"
  control-border: "#8c8577"
  danger: "#b4322a"
  warning: "#8f4f08"
  success: "#2f6b2f"
  bubble-user: "#ebe6dc"
  code-bg: "#f3f0e9"
  tool-bg: "#f3f0e9"
  lock-bg: "#ebe7de"
  dark-ground: "#121110"
  dark-sidebar: "#171614"
  dark-surface: "#1d1c1a"
  dark-surface-raised: "#3a3734"
  dark-ink: "#efeae1"
  dark-ink-tertiary: "#a39c90"
  dark-lamp-green: "#7fcab4"
  dark-on-lamp-green: "#062019"
  dark-bubble-user: "#2a2724"
  dark-code-bg: "#1a1917"
  dark-lock-bg: "#0d0c0b"
typography:
  large-title:
    fontFamily: "ui-serif, 'New York', 'Iowan Old Style', 'Apple Garamond', Georgia, Cambria, 'Noto Serif', serif"
    fontSize: "2.125rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, Roboto, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 650
    lineHeight: 1.15
  title:
    fontSize: "1.25rem"
    fontWeight: 650
  body:
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  prose:
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  footnote:
    fontSize: "0.9375rem"
    fontWeight: 500
  caption:
    fontSize: "0.8125rem"
    fontWeight: 600
  code:
    fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "0.875rem"
    lineHeight: 1.5
rounded:
  small: "4px"
  control: "10px"
  surface: "12px"
  bubble: "18px"
  bubble-tail: "6px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
components:
  button-primary:
    backgroundColor: "{colors.lamp-green}"
    textColor: "{colors.on-lamp-green}"
    rounded: "{rounded.control}"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.lamp-green-hover}"
  button-secondary:
    backgroundColor: "{colors.lamp-green-soft}"
    textColor: "{colors.lamp-green-ink}"
    rounded: "{rounded.control}"
    height: "44px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "44px"
  list-group:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.surface}"
  bubble-user:
    backgroundColor: "{colors.bubble-user}"
    textColor: "{colors.ink}"
    rounded: "{rounded.bubble}"
    typography: "{typography.body}"
  answer:
    textColor: "{colors.ink}"
    typography: "{typography.prose}"
    width: "68ch"
  code-block:
    backgroundColor: "{colors.code-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    typography: "{typography.code}"
  tool-card:
    backgroundColor: "{colors.tool-bg}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.surface}"
    typography: "{typography.footnote}"
  composer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.bubble}"
    height: "48px"
  privacy-chip:
    rounded: "{rounded.pill}"
    typography: "{typography.caption}"
  lock-screen:
    backgroundColor: "{colors.lock-bg}"
    textColor: "{colors.ink}"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.surface}"
    typography: "{typography.footnote}"
---

# Design System: Aparté

## Overview

**Creative North Star: "The Private Room"**

Aparté is a room you close the door on. The interface is quiet so the conversation can be loud: warm paper and deep
ink in daylight, a lamplit charcoal room at night, and one lamp green that means "act here" or "this is protected".
Answers are read like a letter, as unboxed prose at a comfortable measure; the user's own words sit in a soft paper
bubble; everything the machine does on the side (tool calls, searches, sandbox runs) is set back as a recessed aside.

The identity is restraint with two fingerprints: the platform's own serif for the few large titles and the lock
screen, and the keyhole bubble mark. Security is shown as verifiable fact in small, exact type, never as shields,
padlock confetti or alarm colours. This is an Operate surface with long Read stretches inside it: native patterns,
44px targets and predictable navigation come first, and the reading experience is where the craft shows.

**Key Characteristics:**

- One accent, lamp green, for the primary action, selection, focus, links and verified protection states.
- Warm neutrals in both themes; dark is warm charcoal, never blue-black.
- Answers unbubbled at 68ch with 1.6 leading; user messages in a paper bubble; tool work in recessed cards.
- System stacks only: sans for the interface, platform serif for large titles, monospace strictly for code and data.
- Phone first: composer on the keyboard's top edge, safe areas respected, a sidebar only from 1000px.

## Colors

Warm, low-chroma neutrals with a single green voice. Light and dark are separate token sets in `web/src/ui/tokens.css`
(system preference, overridable by `data-theme` on `<html>`); every token has a value in both.

### Primary

- **Lamp Green** (lamp-green): primary buttons, the send action, focus ring, caret, current navigation item, links,
  the "encrypted on this device" and "synced" states. In dark it becomes the paler Lamp Green Night (dark-lamp-green)
  carrying dark ink (dark-on-lamp-green), at about 9:1.

### Neutral

- **Paper** (paper) and **Sidebar Linen** (sidebar): the two ground layers; the sidebar is one step deeper.
- **Surface** / **Surface Pressed**: groups, fields, the composer, hover and pressed rows. Surface is an off-white, not
  pure white, so long sessions stay soft on the eyes.
- **Surface Raised**: the selected segment in a pressed track; a distinctly lighter charcoal in dark.
- **Ink**, **Ink Secondary**, **Ink Tertiary**: text hierarchy. Ink Tertiary stays at or above 4.5:1 on every ground
  and surface, so it may carry text (timestamps, model names, token counts).
- **Hairline** / **Hairline Strong**: separators only. **Control Border** outlines fields and unfilled controls at 3:1
  or more against the ground, as WCAG 1.4.11 requires; hairlines never stand in for it.

### Status

Danger, warning and success each pair a strong tone with a soft background, used in chips, banners and the diff view.
Success is a leaf green deliberately yellower than Lamp Green, and is always paired with an icon and words.

### Chat, code and lock screen

- **Bubble User** (bubble-user): the paper tone of the user's own messages, neutral so it never competes with the accent.
- **Code** (code-bg plus `--syntax-*`): a seven-role syntax palette tuned per theme, every role at 5:1 or more on the
  code ground. Diffs use tinted rows (`--diff-add-*`, `--diff-del-*`) with ink of the same hue and a +/- marker.
- **Tool** (tool-bg): the recessed aside for tool calls and their results.
- **Lock** (lock-bg): the closed room, one tone deeper than the ground in each theme.

### Identity hues

Eight hues (`--course-blue … --course-graphite`, names kept from the cursus system so ported components work) tag
projects, providers or threads, shown only as a small dot or a 2px bar inside a chip. `course-teal` is a petrol cyan
and `course-green` a leaf green, both off the accent's hue.

### Named Rules

**The One Lamp Rule.** Lamp green means "act here", "you are here" or "verified protected". Never decoration, never
a background wash.
**The Truthful State Rule.** A protection or sync state is green only when the engine has verified it (the local data
is encrypted, the remote holds the latest ciphertext). Anything unverified is neutral; a failure is amber or red with
the recovery in words.
**The Quiet Alarm Rule.** Security information is set in Footnote or Caption with an icon, in the reading flow. No
full-screen warnings except the lock screen itself and a refusal to run (framed or opened by another page).

## Typography

**Interface:** the system sans stack (`--font-sans`). **Display:** the platform serif (`--font-display`: New York on
Apple platforms, then Iowan, Georgia, Noto Serif), used only for Large Title and the lock screen title.
**Code and data:** the system monospace stack (`--font-mono`). No web fonts are loaded or bundled: the
Content-Security-Policy allows fonts from the app's own path only, and none ship.

**Character:** the sans is native and invisible; the serif is the one human note, like a name on a door.

### Hierarchy

- **Large Title** (serif 600, 2.125rem, -0.015em): one per screen at most; the lock screen title; empty-state title of
  a new thread.
- **Headline** (sans 650, 1.5rem): headings inside rendered answers (`h1`), sheet titles on large screens.
- **Title** (sans 650, 1.25rem): group headings, settings section titles, `h2` in answers.
- **Body** (400, 1.0625rem, 1.45): interface rows, user bubbles, fields.
- **Prose** (400, 1.0625rem, 1.6, measure 68ch): model answers and rendered documents.
- **Footnote** (500, 0.9375rem): context lines, tool-card summaries, the privacy chip's detail, sidebar rows.
- **Caption** (600, 0.8125rem): chips, timestamps, keycaps, token and request counts.
- **Code** (mono, 0.875rem, 1.5): code blocks, inline code, URLs and origins in the network log, hashes.

### Named Rules

**The Tabular Rule.** Figures are tabular everywhere (`font-variant-numeric: tabular-nums` on body); code turns it off.
**The 16px Floor.** Inputs, including the composer, never go below 16px so iOS never zooms.
**The Sentence-Case Rule.** Labels are sentence case at natural tracking; nothing is uppercased or letter-spaced to
look like a label, and no eyebrow sits above a heading.
**The Honest Mono Rule.** Monospace only for code, data and identifiers (origins, hashes, model ids), never as a
"technical" costume for headings or buttons.

## Layout

A 4px rhythm and a fixed rem scale. The thread is a single column capped at `--content-max` (720px) with the gutter
`max(16px, safe-area insets)`; prose inside it stops at 68ch. Heights use `100dvh`, and the app root is a flex column so
the composer pins to the bottom without measuring.

- **Under 1000px (phones, iPad portrait):** the thread fills the screen; a compact top bar (threads, title, model chip,
  new thread). The composer sits on the on-screen keyboard's top edge (`--kb-inset`, written from `visualViewport`) and
  above the bottom safe area; any bottom bar (`[data-tabbar]`) hides while the keyboard is open.
- **From 1000px:** a 260px sidebar (new thread, search, the thread list, settings and the transparency panel at the
  foot) beside the thread.
- Settings and the transparency panel are grouped inset lists, as in the cursus system.

## Elevation & Depth

Flat and tonal. Surfaces separate from the ground by colour and the single 1px lift (`--lift`). Tool cards go the
other way: they recess one tone below the surface with a hairline, so they read as set aside. Sheets and dialogs add
the scrim, not a bigger shadow.

### Named Rules

**The One-Pixel Rule.** No shadow beyond the 1px lift, anywhere. Declare elevation once: a lift or a border, not both.

## Shapes

Radii each have one job: small (4px) for marks inside text (inline code, keycaps, diff markers); control (10px) for
buttons, fields and rows; surface (12px) for groups, cards, code blocks, tool cards, sheets and toasts; bubble (18px,
with the 6px tail corner on the speaker's side) for user messages and the composer; pill for chips and counts. Icons
are Lucide at 1.75 stroke.

The mark (`web/public/logo.svg`) is a speech bubble with a keyhole cut through it, in Paper on a Lamp Green square.
It carries no text, works on light and dark grounds, and is generated into favicon, PWA, maskable and Apple icons by
`web/pwa-assets.config.ts` (maskable and Apple icons padded with the same green so the platform mask never shows the
square's corners; splash screens on Paper and the dark ground).

## Components

### Buttons

- 44px minimum height (50px large), control radius. **Primary:** Lamp Green with off-white ink (dark: pale green with
  dark ink). **Secondary:** soft green with green ink. **Plain:** text-only green. **Danger:** soft red with red ink.
- States: hover darkens, press scales to 0.98, disabled at 45% opacity, loading shows a spinner and `aria-busy`.

### Fields

- Surface fill, 1px Control Border, 10px radius, 44px tall, 16px text. Focus turns the border green with the 2px ring;
  errors turn it red with the message below, naming the problem and the fix.

### Thread (signature)

- **User message:** right-aligned paper bubble (Bubble User, 18px radius, 6px bottom-right corner), Body type, max 85%
  of the column. Attachments (photos, files) sit above the text in the same bubble.
- **Answer:** no bubble, no avatar. Prose on the ground at 68ch, Headline and Title for its headings, lists and tables
  in the same rhythm. A one-line Caption under it carries the model and, on demand, tokens and timing.
- **Streaming:** text appears as it arrives with no typewriter effect and no blinking cursor block; a quiet Caption
  status ("Writing", "Calling search") is announced politely. A stream is never cut by an update, a lock or a sync.

### Code block

- 12px code surface with a hairline, Code type, horizontal scroll inside the block (the page never scrolls sideways).
  A header row with the language in Caption and a plain Copy button. Diffs show full-width tinted rows with +/-.

### Tool call card

- Recessed card (Tool Bg, hairline, 12px), collapsed by default to one Footnote line: icon, tool name, origin in mono,
  status. Expanded, it shows arguments and the result as code. Running, failed and refused states use the status
  tones with words; a call that needs approval shows Approve (primary) and Decline (plain) inside the card.

### Composer

- A Surface field with the bubble radius, at least 48px tall, growing to about six lines then scrolling. Send is a
  44px Lamp Green circle with an arrow icon; it becomes Stop while streaming. Attach and voice are plain icon buttons.
  On desktop, Enter sends and Shift+Enter adds a line; the hint shows only on `(hover: hover) and (pointer: fine)`.

### Privacy chip (signature)

- A pill in the thread header that states the truth about the current thread: "On this device" (neutral), "Encrypted
  and synced" (green), "Sync paused" (amber), "Not encrypted yet" (red, only possible before setup). Tapping it opens
  the transparency panel.

### Transparency panel

- A grouped list of every origin contacted this session: origin in mono, purpose as a chip (`provider`, `mcp`, `sync`,
  `download`, `catalog`, `app`), request count in Caption. Empty state: "Nothing has left this device yet."

### Lock screen (signature)

- Lock Bg, the mark centred, the app name in the serif Large Title, one passphrase field and Unlock. Nothing else:
  no thread titles, no counts, no previews while locked. The refusal-to-run screen (framed or opened by another page)
  reuses the same calm layout as static text.

### Sheet, toast, empty state

- Sheet: native modal `<dialog>`, bottom sheet under 600px, centred panel above.
- Toast: ink-on-paper 12px block in Footnote, above the composer and keyboard, with optional text actions; reversible
  deletes act at once and offer Undo.
- Empty thread: the serif Large Title asking a plain question, one sentence on where data lives, and the composer.

### Motion

- 200ms with an exponential ease-out (`--ease-out`), 150ms for small state changes. One authored moment: unlocking
  opens the room (the lock surface fades and the thread rises a few pixels). With reduced motion, durations drop to a
  short crossfade and nothing moves.

## Do's and Don'ts

### Do:

- **Do** keep lamp green for actions, selection, focus, links and verified protection.
- **Do** design both themes when adding a token; check text at 4.5:1 and control outlines at 3:1 in each.
- **Do** route every visible string through i18n and let it wrap; never fix text widths.
- **Do** show security as exact, inspectable facts (origins, counts, states) in small type.
- **Do** keep inputs at 16px or more and targets at 44px or more.
- **Do** keep answers unboxed at the prose measure; code scrolls inside its block, never the page.

### Don't:

- **Don't** load a web font, an icon font or any asset from another origin; the CSP forbids it and the product
  promise depends on it.
- **Don't** use shields, padlock illustrations, glowing "secure" badges or red alarm banners to signal safety.
- **Don't** give the assistant an avatar, a name or a persona; it is a model the user chose.
- **Don't** add gradients, glass, glow or shadows beyond the 1px lift.
- **Don't** put an eyebrow, kicker or uppercase tracked label above a heading.
- **Don't** use monospace for anything that is not code, data or an identifier.
- **Don't** let a status chip claim more than the engine has verified.
