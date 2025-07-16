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

// Function to fetch all brief products list with pagination
async function fetchExoProductsList() {
  let allProducts = [];
  let page = 1;
  const pageSize = 100; // Max allowed is 100
  while (true) {
    try {
      const response = await axios.get(`${exoBaseUrl}/stockitem/search?q=*&page=${page}&pagesize=${pageSize}`, {
        auth: exoAuth,
        headers: exoHeaders
      });
      const products = response.data;
      if (products.length === 0) break; // No more pages
      allProducts = allProducts.concat(products);
      console.log(`Fetched page ${page} with ${products.length} products`);
      page++;
    } catch (error) {
      throw new Error(`Exo list fetch error on page ${page}: ${error.message}`);
    }
  }
  return allProducts;
}

// Function to fetch detailed product by id
async function fetchExoProductDetails(id) {
  try {
    const response = await axios.get(`${exoBaseUrl}/stockitem/${id}`, {
      auth: exoAuth,
      headers: exoHeaders
    });
    return response.data; // Detailed product object
  } catch (error) {
    throw new Error(`Exo details fetch error for ${id}: ${error.message}`);
  }
}

// Function to sync products to DB
async function syncProducts() {
  try {
    const exoProductsList = await fetchExoProductsList();
    console.log(`Total fetched products: ${exoProductsList.length}`, exoProductsList);

    for (const briefProduct of exoProductsList) {
      const details = await fetchExoProductDetails(briefProduct.id);
      console.log(`Fetched details for ${briefProduct.id}:`, details);

      await prisma.product.upsert({
        where: { stockCode: details.id },
        update: {
          description: details.description || 'Untitled',
          price: details.saleprices?.[0]?.price || details.latestcost || 0,
          stockLevel: details.totalinstock || 0,
          // Add more fields as needed
        },
        create: {
          stockCode: details.id,
          description: details.description || 'Untitled',
          price: details.saleprices?.[0]?.price || details.latestcost || 0,
          stockLevel: details.totalinstock || 0,
          // Add more fields as needed
        },
      });
      console.log(`Synced product: ${details.id}`);
    }
    console.log('Sync complete');
  } catch (error) {
    console.error('Sync error:', error);
  }
}

// API endpoint to trigger sync manually
app.get('/sync', async (req, res) => {
  await syncProducts();
  res.send('Product sync triggered');
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
