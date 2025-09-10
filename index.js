// routes/quotes.js
const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Prisma } = require('@prisma/client');

module.exports = function makeQuotesRouter(prisma, env = {}) {
  const router = express.Router();

  // ---- Config / Defaults
  const APP_BASE_URL = env.APP_BASE_URL || process.env.APP_BASE_URL || 'http://localhost:3000';
  const taxRate = Number(env.QUOTE_TAX_RATE ?? process.env.QUOTE_TAX_RATE ?? '0'); // e.g. 0.1 for 10%
  const MAIL_FROM = env.MAIL_FROM || process.env.MAIL_FROM || 'Quotes <no-reply@example.com>';

  const transporter = (env.SMTP_HOST || process.env.SMTP_HOST)
    ? nodemailer.createTransport({
        host: env.SMTP_HOST || process.env.SMTP_HOST,
        port: Number(env.SMTP_PORT || process.env.SMTP_PORT || 587),
        secure: false,
        auth: (env.SMTP_USER || process.env.SMTP_USER)
          ? { user: env.SMTP_USER || process.env.SMTP_USER, pass: env.SMTP_PASS || process.env.SMTP_PASS }
          : undefined,
      })
    : null;

  // ---- Helpers
  const newToken = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

  function publicLink(quote) {
    const u = new URL('/quote.html', APP_BASE_URL);
    u.searchParams.set('id', quote.id);
    u.searchParams.set('token', quote.shareToken);
    return u.toString();
  }

  async function recalcQuote(quoteId) {
    const q = await prisma.quote.findUnique({ where: { id: quoteId }, include: { items: true } });
    if (!q) throw new Error('Quote not found');

    let subtotal = new Prisma.Decimal(0);
    for (const it of q.items) {
      const should = new Prisma.Decimal(it.price).mul(it.qty);
      if (!it.subtotal.equals(should)) {
        await prisma.quoteItem.update({ where: { id: it.id }, data: { subtotal: should } });
      }
      subtotal = subtotal.add(should);
    }
    const tax = new Prisma.Decimal(taxRate).mul(subtotal).toDecimalPlaces(2);
    const total = subtotal.add(tax).toDecimalPlaces(2);

    return prisma.quote.update({
      where: { id: quoteId },
      data: { subtotal: subtotal.toDecimalPlaces(2), tax, total },
    });
  }

  // ---- Routes

  // Create a draft quote
  router.post('/', async (req, res) => {
    try {
      const { customerName, customerEmail, notes, currency } = req.body || {};
      const q = await prisma.quote.create({
        data: {
          shareToken: newToken(),
          customerName: customerName || null,
          customerEmail: customerEmail || null,
          notes: notes || null,
          currency: currency || 'AUD',
        },
      });
      res.json(q);
    } catch (e) {
      console.error('POST /quotes', e);
      res.status(500).json({ error: 'Failed to create quote' });
    }
  });

  // Get a quote (supports ?token= for public access)
  router.get('/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const token = (req.query.token || '').toString();

      const q = await prisma.quote.findUnique({ where: { id }, include: { items: true } });
      if (!q) return res.status(404).json({ error: 'Not found' });

      if (token && token !== q.shareToken) return res.status(403).json({ error: 'Invalid token' });
      res.json(q);
    } catch (e) {
      console.error('GET /quotes/:id', e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Add or increment an item on a quote
  router.post('/:id/items', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { stockCode, qty } = req.body || {};
      if (!stockCode) return res.status(400).json({ error: 'stockCode required' });

      const p = await prisma.product.findUnique({ where: { stockCode } });
      if (!p) return res.status(404).json({ error: 'Product not found' });

      const unitPrice = new Prisma.Decimal(p.price || 0);
      const quantity = Math.max(1, parseInt(qty || '1', 10));

      const existing = await prisma.quoteItem.findFirst({ where: { quoteId: id, stockCode } });

      if (existing) {
        const newQty = existing.qty + quantity;
        await prisma.quoteItem.update({
          where: { id: existing.id },
          data: { qty: newQty, subtotal: unitPrice.mul(newQty) },
        });
      } else {
        await prisma.quoteItem.create({
          data: {
            quoteId: id,
            productId: p.id,
            stockCode: p.stockCode,
            name: p.name || 'Untitled',
            description: p.description || null,
            sku: p.sku || null,
            origin: p.origin || null,
            length: p.length || null,
            width: p.width || null,
            size: p.size || null,
            price: unitPrice,
            qty: quantity,
            subtotal: unitPrice.mul(quantity),
          },
        });
      }

      await recalcQuote(id);
      const withItems = await prisma.quote.findUnique({ where: { id }, include: { items: true } });
      res.json(withItems);
    } catch (e) {
      console.error('POST /quotes/:id/items', e);
      res.status(500).json({ error: 'Failed to add item' });
    }
  });

  // Update item qty (or delete if qty=0)
  router.patch('/:id/items/:itemId', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const itemId = Number(req.params.itemId);
      const qty = Math.max(0, parseInt((req.body?.qty ?? '0'), 10));

      const item = await prisma.quoteItem.findUnique({ where: { id: itemId } });
      if (!item || item.quoteId !== id) return res.status(404).json({ error: 'Item not found' });

      if (qty === 0) {
        await prisma.quoteItem.delete({ where: { id: itemId } });
      } else {
        const newSubtotal = new Prisma.Decimal(item.price).mul(qty);
        await prisma.quoteItem.update({ where: { id: itemId }, data: { qty, subtotal: newSubtotal } });
      }

      await recalcQuote(id);
      const withItems = await prisma.quote.findUnique({ where: { id }, include: { items: true } });
      res.json(withItems);
    } catch (e) {
      console.error('PATCH /quotes/:id/items/:itemId', e);
      res.status(500).json({ error: 'Failed to update item' });
    }
  });

  // Remove item
  router.delete('/:id/items/:itemId', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const itemId = Number(req.params.itemId);
      await prisma.quoteItem.delete({ where: { id: itemId } });
      await recalcQuote(id);
      const withItems = await prisma.quote.findUnique({ where: { id }, include: { items: true } });
      res.json(withItems);
    } catch (e) {
      console.error('DELETE /quotes/:id/items/:itemId', e);
      res.status(500).json({ error: 'Failed to remove item' });
    }
  });

  // Update quote header/status
  router.patch('/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { customerName, customerEmail, notes, status } = req.body || {};
      const q = await prisma.quote.update({
        where: { id },
        data: {
          customerName: customerName ?? undefined,
          customerEmail: customerEmail ?? undefined,
          notes: notes ?? undefined,
          status: status ?? undefined,
        },
      });
      res.json(q);
    } catch (e) {
      console.error('PATCH /quotes/:id', e);
      res.status(500).json({ error: 'Failed to update quote' });
    }
  });

  // Email the quote (sends a link)
  router.post('/:id/send', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { toEmail, toName, message } = req.body || {};
      const q = await prisma.quote.findUnique({ where: { id }, include: { items: true } });
      if (!q) return res.status(404).json({ error: 'Not found' });

      const recipient = toEmail || q.customerEmail;
      if (!recipient) return res.status(400).json({ error: 'Recipient email required' });

      if (!transporter) return res.status(500).json({ error: 'SMTP not configured' });

      const link = publicLink(q);
      const html = `
        <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
          <h2>Quote #${q.id}</h2>
          ${q.customerName ? `<p>Hi ${q.customerName},</p>` : ''}
          ${message ? `<p>${message}</p>` : ''}
          <p>Please view your quote here:</p>
          <p><a href="${link}">${link}</a></p>
          <hr/>
          <p><strong>Summary</strong></p>
          <ul>${q.items.map(it => `<li>${it.qty} × ${it.name} — $${it.price} each</li>`).join('')}</ul>
          <p>Subtotal: $${q.subtotal}</p>
          ${Number(taxRate) ? `<p>Tax: $${q.tax}</p>` : ''}
          <p><strong>Total: $${q.total}</strong></p>
        </div>
      `;

      await transporter.sendMail({ from: MAIL_FROM, to: recipient, subject: `Your Quote #${q.id}`, html });
      await prisma.quote.update({ where: { id }, data: { status: 'SENT' } });

      res.json({ ok: true, sentTo: recipient, link });
    } catch (e) {
      console.error('POST /quotes/:id/send', e);
      res.status(500).json({ error: 'Failed to send quote' });
    }
  });

  return router;
};
