# Super Cite Plugin

Chrome MV3 extension that adds a `Super Cite` button next to Google Scholar's `Cite` action.

## Features (v0.5)
- Injects `Super Cite` in each Scholar result item.
- Extracts title/authors/year/container from current Scholar entry.
- Enriches metadata via:
  - OpenAlex API
  - Crossref API
- Outputs citation formats:
  - APA (APA 7th)
  - MLA
  - Chicago (author-date style text output)
  - IEEE
  - GB/T 7714 (Numeric)
  - GB/T 7714 (Author-Year)
  - BibTeX
  - RIS
- One-click copy and click-to-copy/select interaction options.
- Custom citation template editor (drag/drop parts, reorder, text tokens, live preview).
- Improved loading UX: immediate modal feedback, slow-network hint, retry button, and short-lived response cache.

## Load in Chrome
1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select folder: `Super Cite Plugin`.
5. Go to `https://scholar.google.com` and test a search result.

## Notes
- Format output is generated from enriched metadata and may still need final human review for strict submission requirements.
- Only APA is explicitly targeted as 7th edition; other styles are best-effort and not strictly edition-locked.
- If external APIs return no strong match, plugin falls back to Scholar-only metadata.
- No API key is required for current OpenAlex/Crossref integration.

## Release Notes (0.5)
- Updated extension package metadata and icons for publishing readiness.
- Improved citation modal UI and interaction spacing.
- Added Scholar-like icon in the `Super Cite` entry.
- Added interaction settings panel optimizations and layout refinements.
- Added custom citation template editor (drag/drop parts, reorder, text token editing, live preview).
- Improved loading experience with immediate feedback, slow-network hint, retry support, and short-lived cache.
- Refined header action button visuals for cleaner icon-only controls.
