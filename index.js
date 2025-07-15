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
app.use(express.static(path.join(__dirname, 'public'))); // Serve static frontend files

// Custom Exo client
const exoBaseUrl = process.env.EXO_BASE_URL || 'https://exo.api.myob.com';
const exoAuth = {
  username: process.env.EXO_USERNAME,
  password: process.env.EXO_PASSWORD
};

// Function to fetch from Exo
async function fetchExoProducts() {
  try {
    const response = await axios.get(`${exoBaseUrl}/stockitem?search=*`, { auth: exoAuth });
    return response.data; // Assuming array of products
  } catch (error) {
    throw new Error(`Exo fetch error: ${error.message}`);
  }
}

// Function to sync products to DB
async function syncProducts() {
  try {
    const exoProducts = await fetchExoProducts();

    for (const exoProduct of exoProducts) {
      await prisma.product.upsert({
        where: { stockCode: exoProduct.STOCKCODE },
        update: {
          description: exoProduct.DESCRIPTION || 'Untitled',
          price: exoProduct.SELLPRICE1 || 0,
          stockLevel: exoProduct.STOCKLEVEL || 0,
          // Add more fields as needed
        },
        create: {
          stockCode: exoProduct.STOCKCODE,
          description: exoProduct.DESCRIPTION || 'Untitled',
          price: exoProduct.SELLPRICE1 || 0,
          stockLevel: exoProduct.STOCKLEVEL || 0,
          // Add more fields as needed
        },
      });
      console.log(`Synced product: ${exoProduct.STOCKCODE}`);
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

app.listen(port, () => console.log(`App listening on port ${port}`));
