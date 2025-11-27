# Contentful Entry Mover

Small Vite + React page that copies a Contentful entry (and every linked child entry) from one space/environment into another. It remaps locales (today `en-US` → `en-CA`), fixes all entry references to the new IDs, and republishes anything that was published in the source.

## What you need
- Node 18+ and npm.
- Contentful Management API tokens for both source and target environments with read/write/publish permissions.

## Quick start
1) `npm install`
2) `npm run dev`
3) Open the URL Vite prints (usually http://localhost:5173) and fill in the form.

## How to use the form
- Source: space ID, environment ID, and a management token that can read entries.
- Target: space ID, environment ID, and a management token that can create/update/publish.
- Root entry ID: the entry whose tree you want to copy.
- Hit **Run Migration**. Watch the log to see each step (collection, creation, reference rewrite, publish). Tokens never leave your machine—the app is entirely client-side.

## Locale mapping
Right now it copies content from `en-US` into `en-CA`. Edit `LOCALE_MAP` in `src/App.tsx` if you want different source/target locales or multiple targets per source.

## What the tool actually does
- Walks the source entry graph by following entry links and collects the whole set.
- Creates new entries in the target (unpublished) with fields remapped to the target locales.
- Rewrites every entry link to point at the new IDs, updates the target entries, and publishes them when the source was published.

## Build/ship
- `npm run build` to produce a production bundle in `dist/`.
- `npm run preview` to serve the built site locally and sanity check before hosting.

## Troubleshooting tips
- 401/403 errors usually mean the token lacks permissions or belongs to the wrong space/environment.
- If nothing shows up, double-check the root entry ID and environment names.
- Each run creates new entries in the target; clean up duplicates manually if you rerun with the same source tree.
