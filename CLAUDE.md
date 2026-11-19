# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Allusion is an Electron + React + MobX desktop app for organizing a visual reference library (images tagged and searched from watched folders, called *Locations*). This repo is a fork (konsnos/Allusion) of RafaUC/Allusion, itself a fork of allusion-app/Allusion; it upgrades Electron (now 45), electron-builder, better-sqlite3 and TypeScript, plus performance work on location import and thumbnails.

Versions use the format `MAJOR.MINOR.PATCH-konsnos` (e.g. `1.14.1-konsnos`). It must stay above upstream's `1.13.1-ruc` so the auto-updater offers updates. `yarn release` (`release.js`) prompts for the next version, keeping the suffix.

## Commands

Node 22.14+ and Yarn (v1, `yarn.lock`).

- `yarn install`: install dependencies
- `yarn dev`: webpack watch build (dev config) into `build/`
- `yarn start`: run Electron on `build/main.bundle.js` (in a second terminal; Ctrl/Cmd+R reloads the window after a rebuild)
- `yarn test`: Jest (ts-jest, node environment). This is what CI runs.
- Single test file: `yarn test tests/tag-store.test.ts`; single test by name: `yarn test -t "name pattern"`
- `yarn lint`: ESLint **with `--fix`** over `src/` and `widgets/` (it rewrites files). Not run in CI.
- `yarn build`: production webpack build + icons; `yarn package`: build + electron-builder installer into `dist/`
- `yarn build:masonry`, `yarn build:exr`: rebuild the Rust/WASM modules (needs a Rust toolchain; the outputs in `wasm/packages` are committed)

There is no separate type-check script; `ts-loader` type-checks during the webpack build.

### Running the app without touching the real library

`main.ts` uses `PORTABLE_EXECUTABLE_DIR` to redirect `userData` to `<dir>/Allusion`. Set it to a scratch directory when launching a test build, otherwise an unpackaged run uses `%APPDATA%\Electron` (and the installed app's library lives in `%APPDATA%\Allusion`). Run unpackaged builds from the **dev** bundle: the production bundle resolves exiftool via the packaged `resources` layout and fails to start unpackaged.

## Architecture

### Processes and windows

- **Main process** (`src/main.ts`, bundled by the first webpack config): windows, tray, menus, auto-updater, the web-clipper HTTP server (`src/clipper/server.ts`, port 5454), and the database-folder migration from `common/database-location.ts`.
- **Renderer** (`src/renderer.tsx`): runs with `nodeIntegration: true`, `nodeIntegrationInWorker: true` and `contextIsolation: false`, so renderer code and workers use Node APIs (`fs-extra`, `path`, `better-sqlite3`) directly. The same bundle serves two windows: the main app and a preview window (`index.html?preview=true`, detected via `IS_PREVIEW_WINDOW` in `common/window.ts`). Settings/Help/About are `window.open` popups the main window renders into (needs `sandbox: false` since Electron 45).
- **IPC** (`src/ipc/`): every channel is a constant in `messages.ts` with typed wrappers in `MainMessenger` (`ipc/main.ts`) and `RendererMessenger` (`ipc/renderer.ts`). Add a new message in all three places.

### Data layer ("backend")

Despite the name, `src/backend/` runs in the renderer, not the main process. It is a SQLite database (better-sqlite3 + Kysely with `CamelCasePlugin`: snake_case in SQL, camelCase in TS).

- `src/api/` defines the DTOs and the `DataStorage` / `DataBackup` interfaces the frontend talks to; `src/backend/backend.ts` implements `DataStorage`.
- With `USE_BACKEND_AS_WORKER = true` (`src/backend/config.ts`), `Backend` and `BackupScheduler` run inside Web Workers wrapped with Comlink (`src/frontend/workers/BackendService.ts`, `Backend.worket.ts`). Set it to `false` to debug the backend on the renderer thread.
- Schema changes are Kysely migrations in `src/backend/migrations/NNN_name.ts`, and each must also be registered by hand in `InlineMigrationProvider` in `src/backend/config.ts`. Update `schemaTypes.ts` to match.
- The database is `<userData>/allusion-db/Allusion.sqlite` (WAL mode). It moved out of `<userData>/databases`, which Chromium now deletes. `001_migrateJSON` imports a legacy IndexedDB/Dexie export; `src/backend/_deprecated/` is the old Dexie backend, kept for reference.

### Frontend state (MobX)

- `RootStore` (`src/frontend/stores/`) creates all stores (`TagStore`, `FileStore`, `LocationStore`, `UiStore`, `SearchStore`, `ExtraPropertyStore`, `TagPaletteStore`) with the backend and shared references; components get it through `StoreContext` and must be wrapped in `observer(...)`.
- MobX is configured with `observableRequiresReaction` / `reactionRequiresObservable`: state changes must happen in actions (`action`, `runInAction`).
- Entities (`src/frontend/entities/`, e.g. `ClientTag`, `ClientFile`, `ClientLocation`) are MobX domain objects that **persist themselves**: a `reaction` on their observable fields calls the store's `save`, so assigning `tag.name = 'x'` writes to the database. Each entity exists as an API DTO (`src/api/`), a DB row (`schemaTypes.ts`) and a client object.
- UI/file preferences are persisted to `localStorage` via debounced reactions in `renderer.tsx`.

### Files, locations and images

- `ClientLocation` scans and watches folders through `folderWatcher.worker.ts` (`@parcel/watcher`); image dimensions come from reading file headers (`common/imageHeader.ts`) rather than decoding images.
- `src/frontend/image/`: `ImageLoader` dispatches by format (TIFF, PSD via `ag-psd` in a worker, EXR via WASM); `ThumbnailGeneration.tsx` runs a pool of `thumbnailGenerator.worker.ts` workers scheduled by `TaskQueue`. `ImageLoader.ensureThumbnail` regenerates a thumbnail when the source file's mtime is newer than the thumbnail file's mtime (ctime is deliberately not used: it varies by OS/file system).
- `common/ExifIO.ts` wraps a bundled exiftool binary (`resources/exiftool`, shipped as `extraResources`) for reading and writing tag metadata in files.
- The grid's masonry layout is computed in WASM (`wasm/masonry`, scalar and SIMD builds chosen with `wasm-feature-detect`).

### Code organization

- `widgets/`: reusable React UI components, meant to be app-agnostic like an external library (a few import shared hooks/helpers from `src/frontend` and `common/`; keep app state out). Each component folder has one SASS file named after the folder.
- `common/`: helpers shared by main and renderer.
- `src/frontend/containers/`: the major UI regions (Outliner, ContentView, Inspector, AppToolbar, Settings, AdvancedSearch).
- Import paths use the webpack/tsconfig aliases `src/...`, `common/...`, `widgets/...`, `resources/...`, `wasm/...`. Jest resolves them through `modulePaths: ['<rootDir>']`.
- `src/clipper/web-extension/`: the browser extension (plain JS), published separately.

## Conventions

- Prettier: single quotes, trailing commas, 100-column width, 2 spaces. ESLint additionally requires `curly` braces and errors on unused vars; `src/backend/*`, entities and stores must declare explicit module-boundary types.
- Tests live in `tests/` (not next to sources). `tests/backend-sqlite.test.ts` runs the real SQLite backend against temp databases; `fake-indexeddb` and `tests/setup/jest.crypto.js` are loaded as Jest setup files.
