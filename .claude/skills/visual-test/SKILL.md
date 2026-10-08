---
name: visual-test
description: Render the Jarvis renderer views (main-window tabs, Settings, About) headless from synthetic fixture data and save PNG screenshots, then look at them to verify a UI change. Use this after any change to src/renderer/**, src/plugins/**/*.tsx or a .css file, before declaring a UI change done — it is the only way to see the views without launching the Electron app.
---

Full instructions for this skill live in [.github/skills/visual-test/SKILL.md](../../../.github/skills/visual-test/SKILL.md). Read that file for complete guidance before proceeding.

Short version: `npm run screenshots` (or `npm run screenshots -- -t agent-sessions` for one view) writes PNGs to `screenshots/`; open the PNG with the Read tool and compare it against the intent of the change. One-time setup: `npm run test:views:install`.
