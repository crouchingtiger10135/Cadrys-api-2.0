require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const http = require('http');
const https = require('https');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000; // Railway sets PORT in prod
const prisma = new PrismaClient();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static frontend files

// ---- EXO client config ----
const exoBaseUrl = process.env.EXO_BASE_URL || 'https://exo.api.myob.com';
const exoAuth = {
  username: process.env.EXO_USERNAME,
  password: process.env.EXO_PASSWORD,
};
const exoHeaders = {
  'x-myobapi-key': process.env.EXO_DEV_KEY,
  'x-myobapi-exotoken': process.env.EXO_ACCESS_TOKEN,
  Accept: 'application/json',
};

// ---- Axios client with keep-alive ----
const axiosClient = axios.create({
  timeout: 45000,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// ---- Helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(function envPreflight() {
  const required = ['DATABASE_URL', 'EXO_BASE_URL', 'EXO_USERNAME', 'EXO_PASSWORD', 'EXO_DEV_KEY', 'EXO_ACCESS_TOKEN'];
  const missing = required.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
  if (missing.length) {
    console.warn('⚠️ Missing env vars:', missing.join(', '));
  } else {
    console.log('✅ Env looks good.');
  }
})();

function logAxiosError(err, url) {
  if (err.response) {
    const body = typeof err.response.data === 'string'
      ? err.response.data
      : JSON.stringify(err.response.data);
    console.error(`HTTP ${err.response.status} for ${url} →`, body.slice(0, 800));
  } else if (err.request) {
    console.error(`No response from ${url}`);
  } else {
    console.error(`Axios error for ${url}:`, err.message);
  }
}

// GET with retry/backoff; treat 404 on paginated endpoints as end-of-pages
async function fetchWithRetry(url, options, retries = 6, baseBackoffMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axiosClient.get(url, { ...options });
      return res.data;
    } catch (err) {
      const code = err?.response?.status;
      // 404 on a list page often means end-of-pages
      if (code === 404) {
        console.warn(`404 on ${url} (treating as end-of-pages)`);
        return { __END__: true };
      }
      console.warn(`Attempt ${attempt} failed for ${url} → ${code || err.code || err.message}`);
      logAxiosError(err, url);

      const transient =
        code >= 500 ||
        ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNABORTED'].includes(err?.code);
      if (!transient || attempt === retries) throw err;

      await sleep(baseBackoffMs * attempt);
    }
  }
}

// ---------- Extra field utilities (robust origin/length/width/size) ----------
function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // strip spaces/punct
}

function getFirstDefined(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

// Try to read a value that might be nested
function extractValue(obj) {
  if (obj == null) return undefined;
  if (typeof obj === 'string' || typeof obj === 'number') return obj;
  return getFirstDefined(
    obj.value?.value,
    obj.value?.text,
    obj.value?.toString?.(),
    obj.value,
    obj.text,
    obj.val,
    obj.displayValue,
    obj.display,
    obj.data
  );
}

// Return extras from various shapes EXO might use
function getExtraFields(details) {
  const candidates = [
    details?.extrafields,
    details?.extraFields,
    details?.extrafieldvalues,
    details?.userfields,
    details?.userFields,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return Array.isArray(details?.extrafields) ? details.extrafields : [];
}

/**
 * Find a field by aliases across common label keys (case-insensitive)
 * aliases: ['origin','countryoforigin','madein'] etc.
 */
function findExtraField(extras, aliases) {
  if (!Array.isArray(extras) || extras.length === 0) return undefined;
  const want = new Set(aliases.map(normalizeKey));
  for (const f of extras) {
    const nameCandidates = [
      f?.name, f?.label, f?.caption, f?.description,
      f?.displayname, f?.displayName, f?.fieldname, f?.fieldName, f?.key,
    ];
    for (const cand of nameCandidates) {
      if (!cand) continue;
      if (want.has(normalizeKey(cand))) return f;
    }
  }
  // fuzzy contains as last resort
  for (const f of extras) {
    const nameCandidates = [f?.name, f?.label, f?.caption, f?.description, f?.displayname, f?.displayName];
    const joined = nameCandidates.filter(Boolean).map(String).join(' ').toLowerCase();
    if (!joined) continue;
    for (const alias of aliases) {
      if (joined.includes(alias.toLowerCase())) return f;
    }
  }
  return undefined;
}

// Parse a number out of "240", "240 cm", "2.4 m", "2,40", '170"'
function parseMeasure(val) {
  if (val == null) return null;
  let s = String(val).trim();
  s = s.replace(/,/g, '.'); // decimal comma → dot
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isNaN(n) ? null : n;
}
// ---------------------------------------------------------------------------

// ---- EXO fetchers ----
// Step-down pagination sizes to survive slow pages/timeouts
async function fetchExoProductsList() {
  let all = [];
  let page = 1;
  const pageSizes = [50, 25, 10, 5];

  while (true) {
    let pageData = null;
    let usedSize = null;

    for (const size of pageSizes) {
      const url = `${exoBaseUrl}/stockitem?page=${page}&pagesize=${size}`;
      try {
        const data = await fetchWithRetry(url, { auth: exoAuth, headers: exoHeaders });
        if (data?.__END__) { pageData = []; break; }

        const items = Array.isArray(data) ? data :
                      (Array.isArray(data?.items) ? data.items : null);

        if (!items) {
          console.error('Unexpected list shape on page', page, '→',
            (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 400));
          pageData = [];
        } else {
          pageData = items;
          usedSize = size;
        }
        break; // success for this page (or end)
      } catch (e) {
        if (e?.response?.status === 504) {
          console.warn(`504 on page ${page} size ${size} → stepping down…`);
          await sleep(3000);
          continue; // try smaller size
        }
        throw e; // bubble up non-transient or last retry
      }
    }

    if (!pageData || pageData.length === 0) break;
    console.log(`Fetched page ${page} (size ${usedSize}) with ${pageData.length} products`);
    all = all.concat(pageData);
    page++;
  }
  return all;
}

async function fetchExoProductDetails(id) {
  const url = `${exoBaseUrl}/stockitem/${id}`;
  const data = await fetchWithRetry(url, { auth: exoAuth, headers: exoHeaders });
  if (!data || typeof data !== 'object') {
    throw new Error(`Unexpected product details for id ${id}: ${
      (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 800)
    }`);
  }
  return data;
}

// ---- Sync logic ----
async function syncProducts() {
  try {
    const list = await fetchExoProductsList();
    console.log(`Total fetched products: ${list.length}`);

    let savedCount = 0;

    for (const brief of list) {
      const briefId = brief?.id ?? brief?.stockcode ?? brief?.stockCode ?? brief?.barcode1;
      if (!briefId) {
        console.warn('Skipping brief product with no id/stockcode', brief);
        continue;
      }

      try {
        // small throttle between detail calls to be gentle on EXO
        await sleep(100);
        const details = await fetchExoProductDetails(briefId);

        // ---------- robust Origin / Length / Width / Size extraction ----------
        const extras = getExtraFields(details);

        // Origin
        const originField = findExtraField(extras, ['origin','countryoforigin','country','madein','made']);
        const origin = String(extractValue(originField) ?? '').trim();

        // Length / Width (with common aliases)
        const lengthField = findExtraField(extras, [
          'length','lengthcm','length(mm)','length(cm)','length(m)','ruglength','size length'
        ]);
        const widthField  = findExtraField(extras, [
          'width','widthcm','width(mm)','width(cm)','width(m)','rugwidth','size width'
        ]);

        let length = lengthField ? parseMeasure(extractValue(lengthField)) : null;
        let width  = widthField  ? parseMeasure(extractValue(widthField )) : null;

        // Fallback to obvious top-level props
        if (length == null) length = parseMeasure(details?.length ?? details?.Length ?? details?.dimensions?.length);
        if (width  == null) width  = parseMeasure(details?.width  ?? details?.Width  ?? details?.dimensions?.width);

        // Combined "Size" like "240 x 170" → parse to fill missing sides
        let size = '';
        if (length && width) {
          size = `${length} x ${width}`;
        } else {
          const sizeField = findExtraField(extras, ['size','dimensions','size(cm)','overall size','rug size']);
          const sizeRaw = sizeField ? String(extractValue(sizeField) ?? '') : '';
          if (sizeRaw) {
            const nums = sizeRaw.replace(/,/g, '.').match(/-?\d+(\.\d+)?/g);
            if (nums && nums.length >= 2) {
              const a = parseFloat(nums[0]);
              const b = parseFloat(nums[1]);
              if (length == null && !Number.isNaN(a)) length = a;
              if (width  == null && !Number.isNaN(b)) width  = b;
              if (length && width) size = `${length} x ${width}`;
            } else {
              size = sizeRaw; // keep original if not parseable
            }
          }
        }
        // ---------------------------------------------------------------------

        const sku  = details?.barcode1 || String(details?.id ?? briefId) || '';
        const webDescField =
          findExtraField(extras, ['webdescription','web description','online description']);
        const webdescription =
          String(extractValue(webDescField) ?? '') || details?.notes || '';

        const stockCode = String(details?.id ?? briefId);

        // Decimal-safe price (Prisma Decimal accepts string)
        const rawPrice = details?.saleprices?.[0]?.price ?? details?.latestcost ?? 0;
        const price = String(rawPrice);

        const stockLevel = Number(details?.totalinstock ?? 0) || 0;
        const name = details?.description || 'Untitled';

        await prisma.product.upsert({
          where: { stockCode },
          update: { name, description: webdescription, sku, price, origin, length, width, size, stockLevel },
          create: { stockCode, name, description: webdescription, sku, price, origin, length, width, size, stockLevel },
        });

        savedCount++;
        if (savedCount % 50 === 0) console.log(`Synced ${savedCount} products so far...`);
      } catch (rowErr) {
        console.error(`Error syncing product ${briefId}:`, rowErr?.message || rowErr);
      }
    }

    console.log('Sync complete. Saved products:', savedCount);
  } catch (err) {
    console.error('Sync error (fatal):', err?.message || err);
  }
}

// ---- Diagnostics & API Routes ----

// Express + DB health
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, api: 'up', db: 'ok' });
  } catch (e) {
    res.status(500).json({ ok: false, api: 'up', db: String(e) });
  }
});

// EXO connectivity check (no DB)
app.get('/exo-health', async (_req, res) => {
  try {
    const url = `${exoBaseUrl}/stockitem?page=1&pagesize=1`;
    const r = await axiosClient.get(url, { auth: exoAuth, headers: exoHeaders, timeout: 30000 });
    const body = Array.isArray(r.data) ? r.data :
                 (Array.isArray(r.data?.items) ? r.data.items : r.data);
    res.json({ ok: true, status: r.status, sample: Array.isArray(body) ? body.slice(0, 1) : body });
  } catch (e) {
    res.status(500).json({
      ok: false,
      err: e?.response?.status ?? e.message,
      data: e?.response?.data ?? null
    });
  }
});

// Inspect raw extras for a single product id (helps verify label names)
app.get('/debug/extras/:id', async (req, res) => {
  try {
    const details = await fetchExoProductDetails(req.params.id);
    const extras = getExtraFields(details);
    const view = (extras || []).map(f => ({
      keys: {
        name: f?.name, label: f?.label, caption: f?.caption,
        description: f?.description, displayname: f?.displayname ?? f?.displayName,
        fieldname: f?.fieldname ?? f?.fieldName, key: f?.key
      },
      rawValue: f?.value,
      value: extractValue(f)
    }));
    res.json({ ok: true, count: view.length, extras: view.slice(0, 100) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Trigger full sync
app.get('/sync', async (_req, res) => {
  await syncProducts(); // wait so errors show in logs before responding
  res.send('Product sync triggered');
});

// List products (safe sort by createdAt; switch to updatedAt if your Prisma Client is fresh)
app.get('/products', async (_req, res) => {
  try {
    const products = await prisma.product.findMany({
      orderBy: { createdAt: 'desc' } // ← change to { updatedAt: 'desc' } after `npx prisma generate` in prod
    });
    res.json(products);
  } catch (err) {
    console.error('Failed to fetch products:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Count products
app.get('/products/count', async (_req, res) => {
  try {
    const n = await prisma.product.count();
    res.json({ count: n });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Sync a single product by id (handy for debugging)
app.get('/sync-one/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const details = await fetchExoProductDetails(id);
    const name = details?.description || 'Untitled';
    const stockCode = String(details?.id ?? id);

    await prisma.product.upsert({
      where: { stockCode },
      update: { name },
      create: { stockCode, name, price: '0', stockLevel: 0 },
    });

    res.json({ ok: true, id });
  } catch (e) {
    console.error('sync-one error:', e?.message || e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---- Cron (hourly) ----
cron.schedule('0 * * * *', () => {
  console.log('Cron: starting hourly sync...');
  syncProducts();
});

// ---- Shutdown ----
const shutdown = async () => {
  console.log('Shutting down gracefully...');
  try {
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---- Start ----
app.listen(port, '0.0.0.0', () => console.log(`App listening on port ${port}`));
