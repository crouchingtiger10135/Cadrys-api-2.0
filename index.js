require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { PrismaClient, Prisma } = require('@prisma/client');
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

// ---- Helpers ----
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function logAxiosError(err, url) {
  if (err.response) {
    console.error(`HTTP ${err.response.status} for ${url}`, typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data).slice(0, 800));
  } else if (err.request) {
    console.error(`No response from ${url}`);
  } else {
    console.error(`Axios error for ${url}:`, err.message);
  }
}

// GET with retry/backoff; treat 404 on paginated endpoints as end-of-pages
async function fetchWithRetry(url, options, retries = 5, backoffMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { timeout: 30000, ...options });
      return res.data;
    } catch (err) {
      if (err?.response?.status === 404) {
        console.warn(`404 on ${url} (treating as end-of-pages)`);
        return { __END__: true };
      }
      console.error(`Attempt ${attempt} failed for ${url}:`);
      logAxiosError(err, url);
      if (attempt === retries || (err.response && err.response.status >= 400 && err.response.status !== 504)) {
        throw err;
      }
      await sleep(backoffMs * attempt);
    }
  }
}

// ---- EXO fetchers ----
async function fetchExoProductsList() {
  let all = [];
  let page = 1;
  const pageSize = 50; // keep reasonable to avoid timeouts
  while (true) {
    const url = `${exoBaseUrl}/stockitem?page=${page}&pagesize=${pageSize}`;
    const data = await fetchWithRetry(url, { auth: exoAuth, headers: exoHeaders });
    if (data?.__END__) break;

    const products = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : null);
    if (!products) {
      console.error('Unexpected stock list shape on page', page, '→', typeof data === 'string' ? data : JSON.stringify(data).slice(0, 800));
      break;
    }

    if (products.length === 0) break;
    console.log(`Fetched page ${page} with ${products.length} products`);
    all = all.concat(products);
    page++;
  }
  return all;
}

async function fetchExoProductDetails(id) {
  const url = `${exoBaseUrl}/stockitem/${id}`;
  const data = await fetchWithRetry(url, { auth: exoAuth, headers: exoHeaders });
  if (!data || typeof data !== 'object') {
    throw new Error(`Unexpected product details for id ${id}: ${typeof data === 'string' ? data : JSON.stringify(data).slice(0, 800)}`);
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
      // determine a usable id from list item
      const briefId = brief?.id ?? brief?.stockcode ?? brief?.stockCode ?? brief?.barcode1;
      if (!briefId) {
        console.warn('Skipping brief product with no id/stockcode', brief);
        continue;
      }

      try {
        const details = await fetchExoProductDetails(briefId);

        const extrafields = Array.isArray(details?.extrafields) ? details.extrafields : [];
        const getXF = (name) => extrafields.find((f) => f?.name === name)?.value;

        const origin = getXF('Origin') || '';
        const lengthValue = getXF('Length');
        const widthValue = getXF('Width');

        const length = lengthValue != null && String(lengthValue).trim() !== '' ? parseFloat(String(lengthValue)) : null;
        const width = widthValue != null && String(widthValue).trim() !== '' ? parseFloat(String(widthValue)) : null;
        const size = length && width ? `${length} x ${width}` : '';

        const sku = details?.barcode1 || String(details?.id ?? briefId) || '';
        const webdescription = getXF('webdescription') || details?.notes || '';
        const stockCode = String(details?.id ?? briefId);

        // price as Decimal-safe string
        const rawPrice = details?.saleprices?.[0]?.price ?? details?.latestcost ?? 0;
        const price = String(rawPrice); // Prisma Decimal accepts string; avoids float rounding

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

// ---- Routes ----
app.get('/sync', async (_req, res) => {
  // fire-and-wait so errors surface to logs before responding
  await syncProducts();
  res.send('Product sync triggered');
});

app.get('/products', async (_req, res) => {
  try {
    const products = await prisma.product.findMany({ orderBy: { updatedAt: 'desc' } });
    res.json(products);
  } catch (err) {
    console.error('Failed to fetch products:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.get('/db-health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Sync a single product by id (handy to debug)
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
