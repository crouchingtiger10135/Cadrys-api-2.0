require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000; // Railway will set PORT; fallback only for local
const prisma = new PrismaClient();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static frontend files

// Custom Exo client
const exoBaseUrl = process.env.EXO_BASE_URL || 'https://exo.api.myob.com';
const exoAuth = {
  username: process.env.EXO_USERNAME,
  password: process.env.EXO_PASSWORD
};
const exoHeaders = {
  'x-myobapi-key': process.env.EXO_DEV_KEY,
  'x-myobapi-exotoken': process.env.EXO_ACCESS_TOKEN
};

let isSyncing = false; // Lock to prevent concurrent syncs

// Function to fetch with retries
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

// Function to fetch all brief products list with pagination
async function fetchExoProductsList() {
  let allProducts = [];
  let page = 1;
  const pageSize = 100; // Max allowed is 100
  while (true) {
    const url = `${exoBaseUrl}/stockitem?page=${page}&pagesize=${pageSize}`;
    const products = await fetchWithRetry(url, { auth: exoAuth, headers: exoHeaders });
    if (products.length === 0) break; // No more pages
    allProducts = allProducts.concat(products);
    console.log(`Fetched page ${page} with ${products.length} products`);
    page++;
  }
  return allProducts;
}

// Function to fetch detailed product by id with retry
async function fetchExoProductDetails(id) {
  const url = `${exoBaseUrl}/stockitem/${id}`;
  return await fetchWithRetry(url, { auth: exoAuth, headers: exoHeaders });
}

// Function to sync products to DB with change detection
async function syncProducts() {
  if (isSyncing) {
    console.log('Sync already in progress, skipping');
    return;
  }
  isSyncing = true;
  try {
    const exoProductsList = await fetchExoProductsList();
    console.log(`Total fetched products: ${exoProductsList.length}`);

    for (const briefProduct of exoProductsList) {
      const details = await fetchExoProductDetails(briefProduct.id);
      console.log(`Fetched details for ${briefProduct.id}:`, details);

      const existingProduct = await prisma.product.findUnique({ where: { stockCode: details.id } });
      const exoLastModified = new Date(details.lastmodifieddateutc);
      if (existingProduct && existingProduct.lastModified >= exoLastModified) {
        console.log(`Product ${details.id} not changed, skipping update`);
        continue;
      }

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
          lastModified: exoLastModified,
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
          lastModified: exoLastModified,
        },
      });
      console.log(`Synced product: ${details.id}`);
    }
    console.log('Sync complete');
  } catch (error) {
    console.error('Sync error:', error);
  } finally {
    isSyncing = false;
  }
}

// API endpoint to trigger sync manually
app.get('/sync', async (req, res) => {
  syncProducts(); // Run in background
  res.send('Product sync triggered (running in background)');
});

// API endpoint to get all products
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

// Schedule sync every hour
cron.schedule('0 * * * *', syncProducts);

// Graceful shutdown handlers
const shutdown = async () => {
  console.log('Shutting down gracefully...');
  await prisma.$disconnect(); // Close Prisma connections
  process.exit(0); // Exit cleanly
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(port, '0.0.0.0', () => console.log(`App listening on port ${port}`));