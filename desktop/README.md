# InvoiceIQ Desktop

Electron desktop wrapper for the InvoiceIQ Vite + React renderer. It packages
the production renderer build (`renderer/dist`) into a native Windows app and
produces an NSIS installer via `electron-builder`.

## Project layout

```
desktop/
  electron/        Electron main + preload (plain CommonJS, no build step)
  renderer/        Vite + React + TypeScript SPA (built separately)
  build/icon.ico   Windows app icon
  package.json     Electron app + electron-builder config
```

## Prerequisites

The renderer reads its backend URL from `import.meta.env.VITE_API_BASE_URL` at
**build time**. You must set this to the deployed Cloudflare Worker URL before
building, otherwise the packaged app has no backend to talk to:

```bash
VITE_API_BASE_URL=https://invoiceiq.<acct>.workers.dev npm run dist
```

## Build a Windows installer

```bash
npm install          # install electron + electron-builder (dev deps)
npm run dist         # builds the renderer, then runs electron-builder --win nsis
```

This produces the installer under `desktop/release/`, e.g.:

```
desktop/release/InvoiceIQ Setup 1.0.0.exe
```

> **Important:** `electron-builder` must run on **Windows** (or a Windows CI
> runner) to produce the NSIS `.exe`. On Linux/macOS the NSIS target generally
> cannot be built. The official signed installer comes from the Windows CI job
> (see `.github/workflows/release.yml`).

## Linux/macOS: unpacked build only

On a non-Windows machine you can still produce an **unpacked** directory build
for local testing (no NSIS installer):

```bash
npm run dist:dir     # builds the renderer, then electron-builder --win dir
```

The unpacked app appears under `desktop/release/`.

## Run locally (dev)

```bash
# Production mode: load the already-built renderer/dist via file://
npm start

# Dev mode: point Electron at a running Vite dev server
ELECTRON_RENDERER_URL=http://localhost:5173 npm start
```

## Scripts

| Script                 | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `npm start`            | Runs Electron on the built renderer (`renderer/dist` must exist).   |
| `npm run build:renderer` | Installs renderer deps and runs its production build.             |
| `npm run dist`         | Builds renderer, then `electron-builder --win nsis` (NSIS installer). |
| `npm run dist:dir`     | Builds renderer, then `electron-builder --win dir` (unpacked).      |

## Releases via CI

Pushing a tag matching `v*` (e.g. `v1.0.0`) triggers the GitHub Actions workflow
`.github/workflows/release.yml` on a `windows-latest` runner. It builds the
installer and attaches the `.exe` to a GitHub Release for that tag, so the
download link is `https://github.com/<owner>/<repo>/releases/tag/<tag>`.
Set the `VITE_API_BASE_URL` repository variable/secret so CI builds point at the
deployed Worker.
