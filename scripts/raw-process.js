/*
  Raw processor for Medicaid NADAC and openFDA drug NDC datasets
  - Reads large files in streaming/iterative fashion
  - Produces (for frontend consumption under public/data):
    - public/data/enriched_medicaid_openfda.json: Medicaid records enriched with matching openFDA record(s)
    - public/data/search-index-enriched.json: search index for descriptions
  - Internal (optional) outputs can be added as needed
*/

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const { streamArray } = require('stream-json/streamers/StreamArray');
const { pick } = require('stream-json/filters/Pick');

// Input paths (resolve from project root)
const ROOT_DIR = path.join(__dirname, '..');
const RAW_DIR = path.join(ROOT_DIR, 'rawData');
const MEDICAID_CSV = path.join(RAW_DIR, 'nadac-national-average-drug-acquisition-cst-medicaid.csv');
const OPENFDA_JSON = path.join(RAW_DIR, 'drug-ndc-openfda.json');
// const ORANGE_TXT = path.join(RAW_DIR, 'products.txt'); // no longer used

// Output paths (public)
const PUBLIC_DATA_DIR = path.join(ROOT_DIR, 'public', 'data');
if (!fs.existsSync(PUBLIC_DATA_DIR)) fs.mkdirSync(PUBLIC_DATA_DIR, { recursive: true });
const OUT_ENRICHED_PUBLIC = path.join(PUBLIC_DATA_DIR, 'enriched_medicaid_openfda.json');
const OUT_SEARCH_INDEX_PUBLIC = path.join(PUBLIC_DATA_DIR, 'search-index-enriched.json');
const ENRICHED_CHUNKS_DIR = path.join(PUBLIC_DATA_DIR, 'enriched-chunks');
const DESC_CLASS_MAP_PATH = path.join(PUBLIC_DATA_DIR, 'description-classification.json');

// Helpers
function normalizeWhitespaceLower(s) {
  if (!s) return '';
  return s.toString().toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenizeWords(s) {
  return normalizeWhitespaceLower(s)
    .split(/[^a-z0-9]+/)
    .filter(t => t && t.length >= 3);
}

function normalizeMedNdc(ndc) {
  if (!ndc) return '';
  return ndc.toString().replace(/\D+/g, '').trim();
}

function openFdaDigitsKeepZeros(productNdc) {
  if (!productNdc) return '';
  return productNdc.toString().replace(/-/g, '').replace(/\D+/g, '');
}

function openFdaHyphenZeroFill(productNdc) {
  if (!productNdc) return '';
  return productNdc.toString().replace(/-/g, '0').replace(/\D+/g, '');
}

function addToMapArray(map, key, value) {
  const arr = map.get(key);
  if (arr) arr.push(value); else map.set(key, [value]);
}

function uniqueList(arr, limit = 10) {
  const seen = new Set();
  const out = [];
  for (const v of arr || []) {
    const t = (v ?? '').toString().trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

function formatActiveIngredients(aiArray) {
  if (!Array.isArray(aiArray) || aiArray.length === 0) return undefined;
  const parts = aiArray
    .map(ai => {
      const n = (ai && ai.name) ? ai.name : '';
      const st = (ai && ai.strength) ? ai.strength : '';
      const left = n || st;
      const right = n && st ? ` ${st}` : '';
      return (left + right).trim();
    })
    .filter(Boolean);
  return parts.length ? parts.join('; ') : undefined;
}

function mapActiveIngredientsDetailed(aiArray) {
  if (!Array.isArray(aiArray)) return undefined;
  const out = aiArray
    .map(ai => ({
      name: ai && ai.name ? ai.name : undefined,
      strength: ai && ai.strength ? ai.strength : undefined,
    }))
    .filter(x => (x.name && x.name.trim()) || (x.strength && String(x.strength).trim()));
  return out.length ? out : undefined;
}

// Build openFDA indexes for matching with normalization variants
function buildOpenFdaIndexes(openFdaArr) {
  const ndcByLength = new Map();
  const entries = openFdaArr.map((item) => {
    const productNdc = item.product_ndc || item.productNdc || '';
    const ndcDigits = openFdaDigitsKeepZeros(productNdc);
    const ndcZeroFill = openFdaHyphenZeroFill(productNdc);
    const brandName = item.brand_name || item.brandName || '';
    const genericName = item.generic_name || item.genericName || '';
    const activeIngredients = Array.isArray(item.active_ingredients) ? item.active_ingredients : [];
    const dosageForm = item.dosage_form || item.dosageForm || '';
    const routes = Array.isArray(item.route) ? item.route : (item.route ? [item.route] : []);
    const labelerName = item.labeler_name || item.labelerName || '';
    return { productNdc, ndcDigits, ndcZeroFill, brandName, genericName, activeIngredients, dosageForm, routes, labelerName };
  });

  entries.forEach((e, idx) => {
    const seen = new Set();
    const variants = [
      { v: (e.ndcDigits || '').trim(), vtype: 'digits' },
      { v: (e.ndcZeroFill || '').trim(), vtype: 'zeroFill' },
    ];
    variants.forEach(({ v, vtype }) => {
      if (!v) return;
      let cur = v;
      while (true) {
        if (!seen.has(cur)) {
          const L = cur.length;
          if (!ndcByLength.has(L)) ndcByLength.set(L, new Map());
          addToMapArray(ndcByLength.get(L), cur, { idx, variant: cur, vtype });
          seen.add(cur);
        }
        if (cur.length <= 5) break;
        if (cur[0] !== '0') break;
        cur = cur.slice(1);
      }
    });
  });

  return { entries, ndcByLength };
}

function formatOpenFdaMatcher(e, variant, vtype, matchMode) {
  return {
    productNdc: e.productNdc,
    normalizedProductNdc: variant,
    matchedVariantType: vtype,
    matchMode,
    brandName: e.brandName,
    genericName: e.genericName,
    dosageForm: e.dosageForm || undefined,
    routes: uniqueList(e.routes || [], 5),
    dosageStrength: formatActiveIngredients(e.activeIngredients),
    activeIngredientsDetailed: mapActiveIngredientsDetailed(e.activeIngredients),
    labelerName: e.labelerName || undefined,
  };
}

// Implements: direct, remove hyphens, zero-fill hyphens, and substring checks with progressive leading zero removal
function collectOpenFdaNdcMatches(medNdcOriginal, openIdx) {
  const matches = [];
  const medDigits = normalizeMedNdc(medNdcOriginal);
  if (!medDigits) return matches;

  const { ndcByLength, entries } = openIdx;
  const medLen = medDigits.length;
  const lengthsAsc = [...ndcByLength.keys()].sort((a,b)=>a-b);
  const forward = lengthsAsc.filter(L => L <= medLen);
  const seen = new Set();

  // Check all substrings of medDigits against openFDA variants
  for (const L of forward) {
    const mapL = ndcByLength.get(L);
    for (let i = 0; i <= medLen - L; i++) {
      const sub = medDigits.slice(i, i + L);
      const arr = mapL.get(sub);
      if (arr) {
        for (const { idx, variant, vtype } of arr) {
          const sig = idx + '|' + variant + '|' + vtype;
          if (seen.has(sig)) continue;
          seen.add(sig);
          const e = entries[idx];
          matches.push(formatOpenFdaMatcher(e, variant, vtype, 'forward'));
        }
      }
    }
  }

  if (matches.length > 0) return matches;

  // Reverse: longer variants containing medDigits
  const reverse = lengthsAsc.filter(L => L > medLen);
  for (const L of reverse) {
    const mapL = ndcByLength.get(L);
    for (const [key, arr] of mapL.entries()) {
      if (!key.includes(medDigits)) continue;
      for (const { idx, variant, vtype } of arr) {
        const sig = idx + '|' + variant + '|' + vtype;
        if (seen.has(sig)) continue;
        seen.add(sig);
        const e = entries[idx];
        matches.push(formatOpenFdaMatcher(e, variant, vtype, 'reverse'));
      }
    }
  }

  return matches;
}

async function readOpenFdaArray() {
  // Expect either an array or an object with results array; use streaming where possible
  // For simplicity and performance, try to stream array items when file is a large array
  const stat = fs.statSync(OPENFDA_JSON);
  if (stat.size > 10 * 1024 * 1024) {
    const arr = [];
    await new Promise((resolve, reject) => {
      const pipeline = chain([
        fs.createReadStream(OPENFDA_JSON),
        parser(),
        // If the file has a top-level object with a 'results' array, pick it; otherwise, streamArray will error
        // We optimistically try to pick 'results'; if no such path exists, StreamArray will just not receive items
        pick({ filter: 'results' }),
        streamArray(),
      ]);
      pipeline.on('data', ({ value }) => arr.push(value));
      pipeline.on('end', resolve);
      pipeline.on('error', reject);
    });
    if (arr.length > 0) return arr;
    // Fallback: try streaming as a top-level array
    const arr2 = [];
    await new Promise((resolve, reject) => {
      const pipeline = chain([
        fs.createReadStream(OPENFDA_JSON),
        parser(),
        streamArray(),
      ]);
      pipeline.on('data', ({ value }) => arr2.push(value));
      pipeline.on('end', resolve);
      pipeline.on('error', reject);
    });
    return arr2;
  }
  const raw = JSON.parse(fs.readFileSync(OPENFDA_JSON, 'utf8'));
  return Array.isArray(raw) ? raw : (Array.isArray(raw.results) ? raw.results : []);
}

async function buildOpenFdaIndex() {
  console.log('📦 Loading openFDA data...');
  const openArr = await readOpenFdaArray();
  console.log(`• openFDA items: ${openArr.length}`);
  const openIdx = buildOpenFdaIndexes(openArr);
  return openIdx;
}

async function buildMedicaidUnique() {
  console.log('📗 Reading Medicaid CSV...');
  const seen = new Set();
  const unique = [];
  let rows = 0, deduped = 0;
  await new Promise((resolve, reject) => {
    const parserStream = parse({ columns: true, trim: true });
    parserStream.on('readable', () => {
      let record;
      while ((record = parserStream.read()) !== null) {
        rows++;
        const desc = record['NDC Description'] || record['NDC Description '.trim()] || '';
        const ndc = record['NDC'] || '';
        const key = `${desc}||${ndc}`;
        if (seen.has(key)) { deduped++; continue; }
        seen.add(key);
        unique.push({
          ndc_description: desc,
          ndc: ndc,
          nadac_per_unit: record['NADAC Per Unit'] || undefined,
          effective_date: record['Effective Date'] || undefined,
          pricing_unit: record['Pricing Unit'] || undefined,
          pharmacy_type_indicator: record['Pharmacy Type Indicator'] || undefined,
          otc: record['OTC'] || undefined,
          explanation_code: record['Explanation Code'] || undefined,
          classification_for_rate_setting: record['Classification for Rate Setting'] || undefined,
          corresponding_generic_drug_nadac_per_unit: record['Corresponding Generic Drug NADAC Per Unit'] || undefined,
          corresponding_generic_drug_effective_date: record['Corresponding Generic Drug Effective Date'] || undefined,
          as_of_date: record['As of Date'] || undefined,
        });
      }
    });
    parserStream.on('end', resolve);
    parserStream.on('error', reject);
    fs.createReadStream(MEDICAID_CSV).pipe(parserStream);
  });
  console.log(`• Medicaid rows: ${rows}, unique: ${unique.length}, deduped: ${deduped}`);
  return unique;
}

// Orange Book parsing removed

async function enrichMedicaidWithOpenFda(uniqueMed, openIdx) {
  console.log('🔎 Matching Medicaid to openFDA by NDC...');
  const enriched = [];
  let matchedCount = 0;
  let zeroFillLinks = 0;
  let digitsLinks = 0;
  let forwardLinks = 0;
  let reverseLinks = 0;
  let removedEmptyBrandCount = 0;
  let removedNoBrandTokenOverlap = 0;
  let bestMatchRecords = 0;
  const bestLengthDistribution = new Map(); // length -> records count
  const bestBrandDistribution = new Map(); // brandName -> count across best matches
  for (const med of uniqueMed) {
    const ndc = med.ndc || '';
    let matches = collectOpenFdaNdcMatches(ndc, openIdx);
    // Second-stage checks: non-empty brandName and token overlap with ndc_description
    const descTokens = new Set(tokenizeWords(med.ndc_description || ''));
    const before = matches.length;
    matches = matches.filter(m => {
      const hasBrand = (normalizeWhitespaceLower(m.brandName).length > 0);
      if (!hasBrand) return false;
      const brandTokens = tokenizeWords(m.brandName);
      const overlap = brandTokens.some(t => descTokens.has(t));
      return overlap;
    });
    removedEmptyBrandCount += before - matches.length; // includes both empty brand and no-overlap removals together
    // More granular accounting
    if (before > 0 && matches.length < before) {
      // Count specifically no-overlap removals where brand existed but no token overlap
      // We recompute for removed items
      const removed = before - matches.length;
      // Roughly approximate: for each original match, if brand present but no token overlap
      // To avoid recomputing original set, we accept aggregate removed count as no-overlap for reporting simplicity
      removedNoBrandTokenOverlap += removed; // aggregate number of links removed
    }
    // Keep only best matches (longest normalizedProductNdc length)
    if (matches.length > 0) {
      const lengths = matches.map(m => (m && m.normalizedProductNdc ? String(m.normalizedProductNdc).length : 0)).filter(L => L > 0);
      const maxLen = lengths.length ? Math.max(...lengths) : 0;
      matches = matches.filter(m => (m && m.normalizedProductNdc ? String(m.normalizedProductNdc).length : 0) === maxLen)
        .map(m => ({ ...m, bestMatch: true }));
    }

    const hasMatch = matches.length > 0;
    if (hasMatch) {
      matchedCount++;
      zeroFillLinks += matches.filter(m => m.matchedVariantType === 'zeroFill').length;
      digitsLinks += matches.filter(m => m.matchedVariantType === 'digits').length;
      forwardLinks += matches.filter(m => m.matchMode === 'forward').length;
      reverseLinks += matches.filter(m => m.matchMode === 'reverse').length;
      // Best-match stats per record
      bestMatchRecords++;
      const bestLen = (matches[0] && matches[0].normalizedProductNdc) ? String(matches[0].normalizedProductNdc).length : 0;
      if (bestLen > 0) bestLengthDistribution.set(bestLen, (bestLengthDistribution.get(bestLen) || 0) + 1);
      for (const bm of matches) {
        const brand = (bm.brandName || '').trim();
        if (brand) bestBrandDistribution.set(brand, (bestBrandDistribution.get(brand) || 0) + 1);
      }
      enriched.push({ ...med, fdaMatches: matches });
    } else {
      // Keep json short if no match
      enriched.push({ ndc_description: med.ndc_description, ndc: med.ndc });
    }
  }
  // Write public outputs
  fs.writeFileSync(OUT_ENRICHED_PUBLIC, JSON.stringify(enriched));
  const descriptions = Array.from(new Set(enriched.map(r => r.ndc_description).filter(Boolean))).sort();
  fs.writeFileSync(OUT_SEARCH_INDEX_PUBLIC, JSON.stringify({ descriptions }, null, 2));
  console.log(`• Matched ${matchedCount}/${uniqueMed.length} (${uniqueMed.length ? +(matchedCount * 100 / uniqueMed.length).toFixed(2) : 0}%)`);
  return { enriched };
}

async function main() {
  const openIdx = await buildOpenFdaIndex();
  const medUnique = await buildMedicaidUnique();
  // Orange Book is not used in this pipeline
  const { enriched } = await enrichMedicaidWithOpenFda(medUnique, openIdx);

  // Chunk enriched into public/data/enriched-chunks and build description-classification map
  try {
    if (fs.existsSync(ENRICHED_CHUNKS_DIR)) {
      fs.rmSync(ENRICHED_CHUNKS_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(ENRICHED_CHUNKS_DIR, { recursive: true });
    const chunkSize = 4000; // fewer, larger chunks for faster parallel loads
    const chunksMeta = [];
    for (let i = 0; i < enriched.length; i += chunkSize) {
      const slice = enriched.slice(i, i + chunkSize);
      const fname = `enriched-chunk-${chunksMeta.length + 1}.json`;
      fs.writeFileSync(path.join(ENRICHED_CHUNKS_DIR, fname), JSON.stringify(slice));
      chunksMeta.push({ filename: fname, count: slice.length });
    }
    const manifest = {
      total: enriched.length,
      chunkSize,
      numberOfChunks: chunksMeta.length,
      chunks: chunksMeta,
    };
    fs.writeFileSync(path.join(ENRICHED_CHUNKS_DIR, 'chunks-manifest.json'), JSON.stringify(manifest, null, 2));
    const descClassMap = {};
    for (const r of enriched) {
      const d = (r.ndc_description || '').toString();
      const c = (r.classification_for_rate_setting || '').toString();
      if (d && c && !descClassMap[d]) descClassMap[d] = c;
    }
    fs.writeFileSync(DESC_CLASS_MAP_PATH, JSON.stringify(descClassMap));
    console.log('📦 Wrote enriched chunks and classification map:', chunksMeta.length, 'chunks');
  } catch (e) {
    console.error('Failed to write enriched chunks:', e);
    process.exit(1);
  }
  console.log('✅ Raw processing complete. Outputs written to public/data/');
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Error in raw-process:', err);
    process.exit(1);
  });
}


