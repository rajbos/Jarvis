---
name: visual-test
description: Render the Jarvis renderer views (main-window tabs, Settings, About) headless from synthetic fixture data and save PNG screenshots, then look at them to verify a UI change. Use this after any change to src/renderer/**, src/plugins/**/*.tsx or a .css file, before declaring a UI change done — it is the only way to see the views without launching the Electron app.
argument-hint: "[optional: view name to filter, e.g. agent-sessions]"
---

# Visual test: screenshot the views headless

The app's windows can be rendered without Electron: `tests/views/harness/` bundles
the real renderer with esbuild, serves it on `127.0.0.1`, and opens it in headless
Chromium (Playwright) with a fake `window.jarvis` fed from the synthetic fixtures in
`tests/views/harness/fixtures.ts`. `npm run screenshots` uses that harness to save
one PNG per view so you can **look at the result of a CSS or component change**.

## One-time setup

```shell
npm run test:views:install
```

Installs Playwright's Chromium. Without it the harness falls back to a locally
installed Edge or Chrome, if any.

## How to run

All views:

```shell
npm run screenshots
```

One view (the `-t` filter matches the screenshot name):

```shell
npm run screenshots -- -t agent-sessions
```

PNGs land in `screenshots/` at the repo root (gitignored). Override the folder with
the `JARVIS_SCREENSHOT_DIR` environment variable. The run takes roughly half a
minute for all views; the first run also bundles the renderer.

| Name | What it shows |
|------|---------------|
| `repo-dashboard` | Main window, Repo Dashboard tab with the fixture repos and status bar |
| `groups-dashboard` | Groups Dashboard tab |
| `agent-sessions` | Agent Sessions tab: every verdict (ready / waiting / no PR), a long check label ("Running 17/21"), a failed check, a draft PR, a "Not pushed" chip, a PR lookup error and cloud session chips |
| `browser` | Browser companion tab |
| `setup` | Setup tab, signed in |
| `setup-signed-out` | Setup tab with GitHub not connected |
| `dismissed` | Dismissed notifications history |
| `settings` | Settings window, full page |
| `about` | About window |

## Verify the change — do not skip this

1. Run the screenshot(s) for the view you touched.
2. Open the PNG with the **Read** tool (e.g. `screenshots/agent-sessions.png`).
3. Compare what you see against the intent of the change: are the elements where
   they should be, is nothing clipped, overlapping or wrapped unexpectedly, do the
   other rows / states still look right?
4. Only then declare the UI change done. If the image shows a problem, fix it and
   re-run. If a state you need is not in the fixtures, add it to
   `tests/views/harness/fixtures.ts` (synthetic data only — see below).

A run that fails before writing the PNG means the view did not render the expected
text (the `waitFor` list in `tests/views/screenshots.ts`), threw a page error, or
tried to reach the network. Read the failure output; that is a real bug in the view
or in your fixture, not a flaky screenshot.

## Why the output is deterministic

- The fixture clock and the page clock are pinned (`now` in `tests/views/screenshots.ts`).
- Fixed viewport (1600x900), locale `en-US`, timezone `UTC`, dark colour scheme.
- `prefers-reduced-motion: reduce` plus injected CSS that disables every animation
  and transition before the first paint (`deterministic: true` in
  `tests/views/harness/view-harness.ts`).

So two runs on the same code produce the same layout. Expect at most a handful of
±1 colour-channel differences on anti-aliased rounded corners (rasterizer noise), so
compare the images visually rather than by file hash.

## Adding a view or state

- Add an entry to `SHOTS` in `tests/views/screenshots.ts`: the view
  (`index` / `settings` / `about`), the tab to click, the text that proves the data
  loaded, and optional `responses` overrides for the fake API.
- Fixture data must stay synthetic: no names, repos, paths or logins from a real
  machine or account. `tests/views/fixtures-are-synthetic.view.test.ts` fails the
  build if the local user, host or git identity shows up in the fixtures.
- Keep `npm run test:views` green: the same fixtures drive the headless view tests.

## Related

- `npm run test:views` — the headless view tests (assertions, no PNGs); CI runs them.
- `tests/views/harness/view-harness.ts` — the harness both share.
