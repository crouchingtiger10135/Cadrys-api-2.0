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

// EXO auth config
const exoBaseUrl = process.env.EXO_BASE_URL || 'https://exo.api.myob.com';
const exoAuth = {
  username: process.env.EXO_USERNAME,
  password: process.env.EXO_PASSWORD
};
const exoHeaders = {
  'x-myobapi-key': process.env.EXO_DEV_KEY,
  'x-myobapi-exotoken': process.env.EXO_ACCESS_TOKEN
};

// Retry logic for network resilience
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

// ✅ Correctly paginated product list fetch
async function fetchExoProductsList() {
  let allProducts = [];
  let skip = 0;
  const top = 100;

  while (true) {
    const url = `${exoBaseUrl}/StockItem?$top=${top}&$skip=${skip}`;
    const products = await fetchWithRetry(url, { auth: exoAuth, headers: exoHeaders });

    if (!products || products.length === 0) break;
    allProducts.push(...products);
    console.log(`Fetched ${products.length} products at skip=${skip}`);

    skip += top;
  }

  return allProducts;
}

// Fetch full product detail by ID
async function fetchExoProductDetails(id) {
  const url = `${exoBaseUrl}/StockItem('${id}')`;
  return await fetchWithRetry(url, { auth: exoAuth, headers: exoHeaders });
}

// Save all products to DB
async function syncProducts() {
  try {
    const productList = await fetchExoProductsList();
    console.log(`Total products fetched: ${productList.length}`);

    let savedCount = 0;
    for (const briefProduct of productList) {
      try {
        const details = await fetchExoProductDetails(briefProduct.id);
        const extrafields = details.extrafields || [];

        const origin = extrafields.find(f => f.name === 'Origin')?.value || '';
        const lengthValue = extrafields.find(f => f.name === 'Length')?.value;
        const widthValue = extrafields.find(f => f.name === 'Width')?.value;
        const length = lengthValue ? parseFloat(lengthValue) : null;
        const width = widthValue ? parseFloat(widthValue) : null;
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

        console.log(`✅ Synced product: ${details.id}`);
        savedCount++;
      } catch (err) {
        console.error(`❌ Error syncing ${briefProduct.id}:`, err.message);
      }
    }

    console.log(`✅ Sync complete. Total saved: ${savedCount}`);
  } catch (err) {
    console.error('❌ Sync error:', err.message);
  }
}

// Manual sync trigger
app.get('/sync', async (req, res) => {
  await syncProducts();
  res.send('Product sync triggered');
});

// Fetch all products
app.get('/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Home route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ⏰ Scheduled sync every hour
cron.schedule('0 * * * *', syncProducts);

// Cleanup on shutdown
const shutdown = async () => {
  console.log('Shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// 🚀 Start app
app.listen(port, '0.0.0.0', () => console.log(`App listening on port ${port}`));
