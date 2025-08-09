const fs = require('fs');
const path = require('path');
const https = require('https');
const unzipper = require('unzipper');

const RAW_DIR = path.join(__dirname, '..', 'rawData');
const MEDICAID_META_URL = 'https://data.medicaid.gov/api/1/metastore/schemas/dataset/items';
const OPENFDA_ZIP_URL = 'https://download.open.fda.gov/drug/ndc/drug-ndc-0001-of-0001.json.zip';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow redirect
        return resolve(httpsGet(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`GET ${url} failed: ${res.statusCode}`));
      }
      resolve(res);
    }).on('error', reject);
  });
}

async function downloadToFile(url, destPath) {
  ensureDir(path.dirname(destPath));
  const res = await httpsGet(url);
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    res.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

async function fetchLatestNADAC() {
  console.log('🔎 Fetching Medicaid datasets metadata...');
  const res = await httpsGet(MEDICAID_META_URL);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const meta = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const items = Array.isArray(meta) ? meta : [];
  const nadacItems = items.filter((it) => String(it.title || '').startsWith('NADAC (National Average Drug Acquisition Cost)'));
  if (nadacItems.length === 0) throw new Error('No NADAC items found in Medicaid metadata');
  nadacItems.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  const latest = nadacItems[0];
  const dist = Array.isArray(latest.distribution) ? latest.distribution : [];
  const csv = dist.find((d) => String(d.format || '').toLowerCase() === 'csv' && d.downloadURL);
  if (!csv) throw new Error('No CSV distribution found for latest NADAC item');
  const out = path.join(RAW_DIR, 'nadac-national-average-drug-acquisition-cst-medicaid.csv');
  console.log('⬇️  Downloading NADAC CSV:', csv.downloadURL);
  await downloadToFile(csv.downloadURL, out);
  console.log('✅ Saved:', out);
}

async function fetchOpenFdaNdc() {
  console.log('⬇️  Downloading openFDA NDC ZIP:', OPENFDA_ZIP_URL);
  const tmpZip = path.join(RAW_DIR, 'drug-ndc.zip');
  await downloadToFile(OPENFDA_ZIP_URL, tmpZip);
  console.log('📦 Extracting JSON from ZIP...');
  await new Promise((resolve, reject) => {
    fs.createReadStream(tmpZip)
      .pipe(unzipper.Parse())
      .on('entry', (entry) => {
        const fileName = entry.path;
        if (fileName.toLowerCase().endsWith('.json')) {
          const outJson = path.join(RAW_DIR, 'drug-ndc-openfda.json');
          entry.pipe(fs.createWriteStream(outJson))
            .on('finish', () => {
              console.log('✅ Saved:', outJson);
              resolve();
            })
            .on('error', reject);
        } else {
          entry.autodrain();
        }
      })
      .on('error', reject)
      .on('close', () => resolve());
  });
  try { fs.unlinkSync(tmpZip); } catch (_) {}
}

async function main() {
  ensureDir(RAW_DIR);
  await fetchLatestNADAC();
  await fetchOpenFdaNdc();
  console.log('🎉 Fetch complete. You can now run: npm run process:raw');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌ Fetch failed:', e);
    process.exit(1);
  });
}


