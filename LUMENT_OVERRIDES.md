# Lument — Customizations Manifest

> **Purpose:** track every file in the upstream `space-agent` framework that has been
> modified for the **Lument** brand + premium UI. After any upstream `git pull`,
> re-check the entries below; if upstream changed a section near one of our edits,
> re-apply the patch and update this manifest.

## How to keep changes across updates

The space-agent framework is upstream code. There are three sane strategies:

1. **Fork-and-pull (recommended):** keep your work on a `lument` branch.
   Upstream pulls land on `main`; you `git merge main` into `lument` and
   resolve conflicts only in the few files listed below.
2. **Snapshot manifest (this file):** this document records every edit so it
   can be re-applied by hand or by an agent if upstream overwrites it.
3. **Layer override (deeper):** move long-term branding into a dedicated mod
   under `app/L0/_all/mod/lument-branding/` and load it after `_core`. CSS
   tokens are easy to override this way; UI string overrides are not (those
   require editing the source HTML/JS directly).

## Files modified

### Branding strings — `Space Agent` → `Lument`

- `server/pages/index.html`
  - `<title>`, all `<meta>` (`application-name`, `apple-mobile-web-app-title`,
    `theme-color` → `#05060c`, `description`, `og:*`, `twitter:*`).
- `app/L0/_all/mod/_core/onscreen_agent/store.js`
  - Composer placeholder strings (`Message Lument...`, `Ready. Message Lument...`).
- `app/L0/_all/mod/_core/agent/view.html`
  - `<h2>Lument</h2>`, intro paragraph, `aria-label="Lument highlights"`.
- `app/L0/_all/mod/_core/admin/views/shell/shell.html`
  - `<iframe title="Lument main app">`.
- `app/L0/_all/mod/_core/admin/views/dashboard/panel.html`
  - Admin info card copy.
- `app/L0/_all/mod/_core/spaces/view.html`
  - Agent-instructions textarea placeholder.
- `server/pages/login.html`
  - All `<meta>` rebrand, `<title>` → `Sign in · Lument`.
  - Hero: `<h1>Lument</h1>` + new `.lument-eyebrow` + new editorial tagline copy.
  - Primary submit button label → `Enter Lument` (also in the `submitButton.textContent = ...` line in the JS block).
  - `aria-label="Lument links"` on footer nav.
- `app/L0/_all/mod/_core/dashboard/view.html`
  - New `<header class="lument-hero">` band at top of `.dashboard-shell`.

### Premium dark UI

- `server/pages/index.html`
  - Inline `<style>` block: `--lument-ink`, `--lument-glow-*`, `--lument-accent`
    custom props, `html::before` ambient gradient, `html::after` film grain,
    `#space-boot` Lument splash + gold-accent spinner.
- `server/pages/login.html`
  - Premium override `<style>` block appended right before `</head>`:
    Lument tokens, ambient gradient + grain, editorial serif hero, glass
    login card with hairline gold border, gold primary button, refined
    inputs and separators.
- `app/L0/_all/mod/_core/dashboard/dashboard.css`
  - Appended `.lument-hero*` styles and re-tuned the
    `.dashboard-section-title` gradient to gold.
  - `modulepreload` + `preload` chain to flatten the framework module
    waterfall on first load.
- `app/L0/_all/mod/_core/framework/css/colors.css`
  - `--color-canvas`, `--color-canvas-elevated`, `--color-canvas-deep`,
    `--color-surface-1..3`, `--color-surface-glass`, `--color-border-soft`,
    `--color-border-strong` re-tuned for the Lument palette
    (deeper ink, warm border tone).

### Quality-of-life

- `server/router/router.js`
  - 4xx errors log a single concise `console.warn` line; 5xx still log a full
    stack trace. Eliminates the noisy expected-404 stack dumps.

### Grafiti widgets bundled into the empty-canvas onboarding grid
pages/login.html `
                 server/
- `app/L0/_all/mod/_core/spaces/onboarding/empty-canvas-exa.css `
                 app/L0/_all/mod/_core/dashboard/view.html `
                 app/L0/_all/mod/_core/dashboard/dashboardmples.yaml`
  - Added two entries: **Ontology** (`ontology-mini.yaml`) and **Clock**
    (`clock.yaml`).
- `app/L0/_all/mod/_core/spaces/onboarding/examples/clock.yaml` — new file.
- `app/L0/_all/mod/_core/spaces/onboarding/examples/ontology-mini.yaml` — new file.
- `app/L0/_all/mod/grafiti/clock/` — new module (routed `#/grafiti/clock`).
- `app/L0/_all/mod/grafiti/ontology/` — pre-existing routed module (unchanged).

## Re-apply checklist after `git pull` upstream

After pulling upstream changes, run:

```powershell
git diff HEAD -- server/pages/index.html `
                 server/router/router.js `
                 app/L0/_all/mod/_core/framework/css/colors.css `
                 app/L0/_all/mod/_core/onscreen_agent/store.js `
                 app/L0/_all/mod/_core/agent/view.html `
                 app/L0/_all/mod/_core/admin/views/shell/shell.html `
                 app/L0/_all/mod/_core/admin/views/dashboard/panel.html `
                 app/L0/_all/mod/_core/spaces/view.html `
                 app/L0/_all/mod/_core/spaces/onboarding/empty-canvas-examples.yaml
```

If any of those files come back as upstream-only (not your branch), re-apply
the corresponding edits from this manifest. The added files under
`app/L0/_all/mod/grafiti/` and the two new YAMLs in `examples/` are not in
upstream, so upstream pulls cannot overwrite them — they only need to be
checked into your repo.
