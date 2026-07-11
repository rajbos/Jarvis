# Product

## Register

product

## Users

Rob (and similarly-minded developers/power users) who maintain many GitHub repositories at once. They use Jarvis during focused work sessions to triage notifications, check CI/workflow health, and jump into repos that need attention. Context is a busy desktop environment — the app runs alongside an editor and terminal, so information density and fast scanning matter more than visual flourish.

## Product Purpose

Jarvis is a locally-hosted assistant for GitHub repository maintenance: it surfaces notifications, failed runs, and local repo state across dozens of repos in one dashboard, so the user can quickly spot what needs attention and act on it (dismiss, analyse, open) without leaving the app. Success = the user can tell "what's on fire" and "what's fine" within seconds, and clear their queue with minimal clicks.

## Brand Personality

Efficient, technical, no-nonsense — a mission-control panel for repos, not a consumer dashboard. Dark, calm, information-dense; confidence comes from clarity and control, not decoration.

## Anti-references

Generic cream/light SaaS admin templates, bouncy consumer-app motion, decorative gradients or glassmorphism, anything that adds visual noise to an already data-dense triage screen.

## Design Principles

- Density with clarity: pack in real data, but use spacing and hierarchy so status is scannable at a glance, not a wall of rows.
- Status is the hero: color and weight should draw the eye to what needs attention (failed runs, unread notifications) before anything else.
- Consistent, predictable structure: same card/row/badge vocabulary everywhere so muscle memory works across tabs.
- Actions stay close to context: dismiss/analyse/open live inline next to the item they act on, not in a separate panel.
- Respect the user's flow: no unnecessary motion or confirmation friction for routine triage actions.

## Accessibility & Inclusion

Standard WCAG AA contrast on the dark theme (body text ≥4.5:1, large/status text ≥3:1). Keyboard-navigable list/panel interactions. Respect `prefers-reduced-motion` for any transitions. No additional accessibility requirements stated by the user.
