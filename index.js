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
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function getFirstDefined(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}
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
function parseMeasure(val) {
  if (val == null) return null;
  let s = String(val).trim();
  s = s.replace(/,/g, '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isNaN(n) ? null : n;
}
// ---------------------------------------------------------------------------

// ---- EXO fetchers ----
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
        break;
      } catch (e) {
        if (e?.response?.status === 504) {
          console.warn(`504 on page ${page} size ${size} → stepping down…`);
          await sleep(3000);
          continue;
        }
        throw e;
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
        await sleep(100);
        const details = await fetchExoProductDetails(briefId);

        const extras = getExtraFields(details);

        const originField = findExtraField(extras, ['origin','countryoforigin','country','madein','made']);
        const origin = String(extractValue(originField) ?? '').trim();

        const lengthField = findExtraField(extras, [
          'length','lengthcm','length(mm)','length(cm)','length(m)','ruglength','size length'
        ]);
        const widthField  = findExtraField(extras, [
          'width','widthcm','width(mm)','width(cm)','width(m)','rugwidth','size width'
        ]);

        let length = lengthField ? parseMeasure(extractValue(lengthField)) : null;
        let width  = widthField  ? parseMeasure(extractValue(widthField )) : null;

        if (length == null) length = parseMeasure(details?.length ?? details?.Length ?? details?.dimensions?.length);
        if (width  == null) width  = parseMeasure(details?.width  ?? details?.Width  ?? details?.dimensions?.width);

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
              size = sizeRaw;
            }
          }
        }

        const sku  = details?.barcode1 || String(details?.id ?? briefId) || '';
        const webDescField = findExtraField(extras, ['webdescription','web description','online description']);
        const webdescription = String(extractValue(webDescField) ?? '') || details?.notes || '';
        const stockCode = String(details?.id ?? briefId);

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

// Health
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, api: 'up', db: 'ok' });
  } catch (e) {
    res.status(500).json({ ok: false, api: 'up', db: String(e) });
  }
});

// EXO ping
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

// Debug extras
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
  await syncProducts();
  res.send('Product sync triggered');
});

// --- Products API ---
// List/search products: GET /products?q=...&take=200
app.get('/products', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const take = Math.min(parseInt(req.query.take || '500', 10), 1000);

    const where = q ? {
      OR: [
        { stockCode:  { contains: q, mode: 'insensitive' } },
        { sku:        { contains: q, mode: 'insensitive' } },
        { name:       { contains: q, mode: 'insensitive' } },
        { description:{ contains: q, mode: 'insensitive' } },
      ],
    } : {};

    const products = await prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' }, // change to updatedAt if desired
      take,
    });
    res.json(products);
  } catch (err) {
    console.error('Failed to fetch products:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Single product by stockCode (for product page)
app.get('/products/:stockCode', async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { stockCode: req.params.stockCode },
    });
    if (!product) return res.status(404).json({ error: 'Not found' });
    res.json(product);
  } catch (e) {
    console.error('GET /products/:stockCode', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve product page at /product?stockCode=ABC
app.get('/product', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'product.html'));
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
