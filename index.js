require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const prisma = new PrismaClient();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// EXO API Credentials
const exoBaseUrl = process.env.EXO_BASE_URL || 'https://exo.api.myob.com';
const exoAuth = {
  username: process.env.EXO_USERNAME,
  password: process.env.EXO_PASSWORD
};
const exoHeaders = {
  'x-myobapi-key': process.env.EXO_DEV_KEY,
  'x-myobapi-exotoken': process.env.EXO_ACCESS_TOKEN
};

// Retry helper
async function fetchWithRetry(url, options, retries = 5, backoff = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, options);
      return response.data;
    } catch (error) {
      console.error(`Attempt ${attempt} failed for ${url}:`, error.message);
      if (attempt === retries || (error.response && error.response.status !== 504)) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, backoff * attempt));
    }
  }
}

// Fetch paginated product list
async function fetchExoProductsList() {
  let allProducts = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const url = `${exoBaseUrl}/stockitem?page=${page}&pagesize=${pageSize}`;
    console.log(`Fetching: ${url}`);
    const products = await fetchWithRetry(url, {
      auth: exoAuth,
      headers: exoHeaders,
    });

    if (!products || products.length === 0) break;

    allProducts = allProducts.concat(products);
    console.log(`✅ Page ${page}: ${products.length} products`);

    if (products.length < pageSize) break; // End
    page++;
  }

  console.log(`✅ Total fetched products: ${allProducts.length}`);
  return allProducts;
}

// Fetch product details
async function fetchExoProductDetails(id) {
  const url = `${exoBaseUrl}/stockitem/${id}`;
  return await fetchWithRetry(url, { auth: exoAuth, headers: exoHeaders });
}

// Sync to DB
async function syncProducts() {
  try {
    const exoProductsList = await fetchExoProductsList();
    console.log(`🔄 Syncing ${exoProductsList.length} products...`);

    let savedCount = 0;
    for (const briefProduct of exoProductsList) {
      try {
        const details = await fetchExoProductDetails(briefProduct.id);
        console.log(`📦 ${briefProduct.id}: ${details.description}`);

        const extrafields = details.extrafields || [];
        const origin = extrafields.find(f => f.name === 'Origin')?.value || '';
        const length = parseFloat(extrafields.find(f => f.name === 'Length')?.value || '') || null;
        const width = parseFloat(extrafields.find(f => f.name === 'Width')?.value || '') || null;
        const size = (length && width) ? `${length} x ${width}` : '';
        const sku = details.barcode1 || details.id || '';
        const webdescription = extrafields.find(f => f.name === 'webdescription')?.value || details.notes || '';

        await prisma.product.upsert({
          where: { stockCode: details.id },
          update: {
            name: details.description || 'Untitled',
            description: webdescription,
            sku,
            price: details.saleprices?.[0]?.price || details.latestcost || 0,
            origin,
            length,
            width,
            size,
            stockLevel: details.totalinstock || 0,
          },
          create: {
            stockCode: details.id,
            name: details.description || 'Untitled',
            description: webdescription,
            sku,
            price: details.saleprices?.[0]?.price || details.latestcost || 0,
            origin,
            length,
            width,
            size,
            stockLevel: details.totalinstock || 0,
          },
        });

        savedCount++;
      } catch (detailError) {
        console.error(`❌ Failed product ${briefProduct.id}:`, detailError.message);
      }
    }

    console.log(`✅ Sync complete: ${savedCount} products saved`);
  } catch (error) {
    console.error('❌ Sync error:', error.message);
  }
}

// API: Trigger manual sync
app.get('/sync', async (req, res) => {
  await syncProducts();
  res.send('✅ Sync triggered.');
});

// API: Get products
app.get('/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany();
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// CRON: Run sync every hour
cron.schedule('0 * * * *', syncProducts);

// Graceful shutdown
const shutdown = async () => {
  console.log('🔻 Shutting down...');
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 App listening on port ${port}`);
});

