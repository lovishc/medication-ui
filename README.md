# Medicine Search App (NADAC + openFDA)

A React app and data pipeline to explore Medicaid NADAC pricing and find generic alternatives, enriched with openFDA NDC metadata.

## Quick Setup

```bash
# Install dependencies
npm install

# Fetch latest datasets, process+chunk them, and build the app
npm run setup

# Start the dev server
npm start
```

After `npm run setup`, processed outputs live in `public/data/`.

## Matching logic (enriched data)

The UI is unchanged. The app now relies on pre-enriched datasets produced by the data pipeline and loads them at runtime for fast, accurate lookups.

- **Data loaded at startup**
  - `public/data/enriched-chunks/chunks-manifest.json`: list of chunk files.
  - `public/data/search-index-enriched.json`: list of searchable `ndc_description` strings.
  - `public/data/description-classification.json`: maps exact `ndc_description` → classification (`B`/`G`).
  - Chunks are pre-fetched in parallel and cached in-memory for responsiveness.

- **Suggestions and filter**
  - Suggestions are substring matches from `search-index-enriched.json`.
  - Branded/Generic filter uses `description-classification.json` to include only `B` or `G` matches (or all).

- **Selection and FDA context**
  - Exact match by `ndc_description` is required for selection.
  - From the selected record, the app chooses the first available `fdaMatches[0]` as the authoritative FDA context (generic name, brand name, dosage form, labeler, ingredients, routes).

- **Finding generics**
  - Scan all records with `fdaMatches` and include those where any match’s `brandName` or `genericName` case-insensitively contains the selected record’s FDA `brandName` or `genericName`.
  - Exclude branded entries (`classification_for_rate_setting === 'B'`).
  - Exclude the selected medicine itself using a de-dup key: `description | price | labeler`.
  - De-duplicate remaining results using the same key.

- **Relevancy ranking**
  - Compute a simple dosage-strength score as the sum of numeric values parsed from FDA active ingredient strengths (falls back to `dosageStrength`, then numbers in `ndc_description`).
  - Sort ascending by absolute difference between each candidate’s score and the selected record’s score.

- **Performance and UX**
  - Chunks are cached (`filename → array`) to avoid re-fetching.
  - The suggestions dropdown is driven directly by a memoized list; no redundant suggestion state.

Notes:
- The app uses the enriched FDA context (`fdaMatches`) instead of raw openFDA at runtime; all correlation is performed offline during preprocessing.

## App walkthrough for newcomers (src/App.js)

This section explains, step-by-step, what the UI does and how the core logic works in `src/App.js`.

### What loads on startup
- The app fetches three small index files:
  - `./data/enriched-chunks/chunks-manifest.json` → list of chunk filenames containing the enriched medication rows
  - `./data/search-index-enriched.json` → a flat list of `ndc_description` strings used for fast suggestions
  - `./data/description-classification.json` → a map from exact `ndc_description` to `classification_for_rate_setting` (B = brand, G = generic)
- Then, the app prefetches all chunk files listed in the manifest in parallel and stores them in memory. These chunks are the full dataset split into manageable JSON files.
  - Each chunk is cached in a `Map` (`filename → array`) so that repeated fetches are avoided.
  - After prefetching, the chunks are flattened into a single array in memory (`medicationsData`).

### State the UI keeps
- `searchTerm` → what the user typed
- `drugFilter` → one of `all`, `branded`, `generic`
- `searchIndex` → the list of all `ndc_description` values for suggestions
- `descClassMap` → a quick lookup of description → classification
- `medicationsData` → all enriched rows loaded from chunk files
- `selectedMedicine` → the item the user selected to focus on
- `matchedGenerics` → the list of alternative generic options related to the selection
- `loading`, `dataLoaded`, `showSuggestions` → UX flags

### How suggestions work
- When the user types at least 2 characters, the app filters `searchIndex.descriptions` by case-insensitive substring match against the input.
- The drug filter is applied to the suggestions:
  - `branded` → keep items with classification `B`
  - `generic` → keep items with classification `G`
  - `all` → no extra filtering
- Only the first 10 suggestions are shown to keep the list snappy.

### What happens when a suggestion is chosen (or user presses Search)
1. The app sets `selectedMedicine` by finding all rows with an exact match on `ndc_description`.
2. From those, it picks a “preferred” row — the first one that has FDA data (`fdaMatches`) available; otherwise, it falls back to the first row.
3. It extracts the “best matcher” from FDA context: the first entry in `fdaMatches` provides fields like `genericName`, `brandName`, `dosageForm`, `routes`, `labelerName`, and `activeIngredientsDetailed`.
4. It displays the selected drug’s basic info (NDC, price, classification, OTC) and FDA context (generic name, brand, labeler, dosage form, routes, active ingredients).

### How matching generics are found
- The app searches through `medicationsData` looking at each item’s `fdaMatches`:
  - If any `fdaMatches` entry’s `brandName` or `genericName` case-insensitively contains the selected drug’s best `brandName` or `genericName`, it is considered related.
- From these related items, the app applies three important filters:
  1. Exclude branded entries where `classification_for_rate_setting === 'B'` (we want generics after a selection).
  2. Exclude the currently selected medicine itself.
  3. De-duplicate by a stable key: `description | price | labeler`.

### How results are ranked (relevance)
- The app computes a simple numeric “dosage-strength sum” for the selected medicine and each candidate:
  - Prefer `activeIngredientsDetailed[].strength` values from FDA context.
  - Fall back to `dosageStrength` from FDA.
  - If neither is present, fall back to numbers found in `ndc_description`.
- It then sorts candidates by the absolute difference between each candidate’s sum and the selected medicine’s sum — smaller difference appears first.

### Helpful formatting and UX details
- Empty-like values (`null`, `"", "NULL"`) are shown as `--`.
- Prices are formatted to 5 decimal places.
- Suggestions only appear for search terms of length ≥ 2.
- The header shows how many medications were loaded into memory.
- The UI shows up to 50 matching generic options by default.

### Key fields used in the UI
- From NADAC: `ndc_description`, `ndc`, `nadac_per_unit`, `pricing_unit`, `classification_for_rate_setting`, `otc`
- From FDA (via `fdaMatches[0]`): `genericName`, `brandName`, `dosageForm`, `routes`, `labelerName`, `activeIngredientsDetailed`, `dosageStrength`

### Error handling
- If any of the startup data files fail to load, the app logs an error and falls back to empty data structures so the UI remains responsive (though with no results).

## Scripts

- `npm run fetch:sources`
  - Downloads the latest NADAC CSV (by title and most recent `modified`) from Medicaid datasets index and the openFDA NDC JSON (unzipped) into `rawData/`.
- `npm run process:raw`
  - Enriches Medicaid records with openFDA, writes `public/data/` outputs, and chunkifies into `public/data/enriched-chunks/`.
- `npm run setup`
  - Runs `fetch-sources` → `process:raw` → `build`.
- `npm start` / `npm run build`
  - Start dev server / build production bundle.

## Data Sources

- Medicaid datasets index: https://data.medicaid.gov/api/1/metastore/schemas/dataset/items
- openFDA NDC JSON (zip): https://download.open.fda.gov/drug/ndc/drug-ndc-0001-of-0001.json.zip

## Outputs (frontend)

- `public/data/enriched_medicaid_openfda.json`
- `public/data/search-index-enriched.json`
- `public/data/description-classification.json`
- `public/data/enriched-chunks/` (manifest + chunks)

## Notes

- `rawData/` is populated by `npm run fetch:sources` and should not be committed to git.
- The UI excludes branded results, de-dups by description+price+labeler, and sorts by dosage-strength proximity to the selected medicine.

## Project structure (high level)

- `src/`
  - `App.js` → main React component implementing data loading, search/suggest, selection, matching, ranking, and rendering
  - `index.js`, `App.css` → standard React wiring and styles
- `public/data/`
  - `enriched-chunks/` → manifest + chunked enriched medication data
  - `search-index-enriched.json` → list of `ndc_description` strings for suggestions
  - `description-classification.json` → description → `B`/`G` map
- `scripts/`
  - `fetch-sources.js` → downloads raw datasets into `rawData/`
  - `raw-process.js` → enriches and chunks data into `public/data/`
- `rawData/` → raw source files (large; not for git)
