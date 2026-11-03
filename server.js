require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');

const migrate = require('./src/migrate');
const { router: authRouter, requireAuth } = require('./src/auth');
const pool = require('./src/db');
const { encrypt, decrypt } = require('./src/crypto');
const zohoOAuth = require('./src/zoho');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());

app.use(authRouter);

// --- Zoho POS Invoice Format & Print Profile API ---
const TEMPLATE_PRESETS = {
  arora: {
    id: 'arora',
    name: 'Arora Handlooms A4 Tax Invoice (Reference PDF P2SI11)',
    profileFile: 'printProfileDetail_Arora_A4.json',
    fieldsFile: 'printFieldDetails_Arora_A4.json'
  },
  rfh: {
    id: 'rfh',
    name: 'A4 Royal Home Feel (Original JSON)',
    profileFile: 'printProfileDetail_A4RFH_b928674f.json',
    fieldsFile: 'printFieldDetails_A4RFH_073df05d.json'
  }
};

const PRESET_DIR = path.join(__dirname, 'public', 'assets', 'aistudio');

function presetAvailable(p) {
  return fs.existsSync(path.join(PRESET_DIR, p.profileFile)) && fs.existsSync(path.join(PRESET_DIR, p.fieldsFile));
}

// Returns the RAW file text as well as parsed JSON. The designer parses the raw
// text itself because res.json() would round numeric IDs longer than 15 digits.
function presetPayload(preset) {
  if (!presetAvailable(preset)) {
    const err = new Error(`Preset files not found. Expected ${preset.profileFile} and ${preset.fieldsFile} in public/assets/aistudio/.`);
    err.status = 404;
    throw err;
  }
  const profileText = fs.readFileSync(path.join(PRESET_DIR, preset.profileFile), 'utf8').replace(/^﻿/, '');
  const fieldsText = fs.readFileSync(path.join(PRESET_DIR, preset.fieldsFile), 'utf8').replace(/^﻿/, '');
  return {
    ok: true,
    preset: preset.id,
    name: preset.name,
    profileFileName: preset.profileFile,
    fieldsFileName: preset.fieldsFile,
    profileText,
    fieldsText,
    // parsed copies kept for older clients
    profile: JSON.parse(profileText),
    fields: JSON.parse(fieldsText)
  };
}

function sendPreset(res, preset) {
  try {
    res.json(presetPayload(preset));
  } catch (err) {
    if (!err.status) console.error('Failed to load invoice template:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to load template: ' + err.message });
  }
}

app.get('/api/invoice-template/presets', (req, res) => {
  const all = Object.values(TEMPLATE_PRESETS);
  res.json({
    presets: all.filter(presetAvailable).map(p => ({ id: p.id, name: p.name })),
    missing: all.filter(p => !presetAvailable(p)).map(p => p.id)
  });
});

app.get('/api/invoice-template/default', (req, res) => {
  const requested = req.query.preset && TEMPLATE_PRESETS[req.query.preset];
  const preset = requested || Object.values(TEMPLATE_PRESETS).find(presetAvailable) || TEMPLATE_PRESETS.arora;
  sendPreset(res, preset);
});

app.get('/api/invoice-template/:presetId', (req, res) => {
  const preset = TEMPLATE_PRESETS[req.params.presetId];
  if (!preset) return res.status(404).json({ error: 'Preset not found' });
  sendPreset(res, preset);
});

// Standard Zoho POS & Zakya PrintModel Field Definitions
const ZOHO_POS_FIELDS = [
  // Store / Company Details
  { colName: 'PrintModel.ShopName', label: 'Store Name', category: 'Store / Company', sample: 'ROYAL FEEL HOME', desc: 'Display name of the store / organization' },
  { colName: 'PrintModel.ShopAddress', label: 'Store Address (Combined)', category: 'Store / Company', sample: '102 Main Street, High Street Complex', desc: 'Full store street address' },
  { colName: 'PrintModel.ShopAddress1', label: 'Store Address Line 1', category: 'Store / Company', sample: '102 Main Street', desc: 'Primary address line' },
  { colName: 'PrintModel.ShopAddress2', label: 'Store Address Line 2', category: 'Store / Company', sample: 'Near City Centre', desc: 'Secondary address / landmark' },
  { colName: 'PrintModel.ShopCity', label: 'Store City', category: 'Store / Company', sample: 'Mumbai', desc: 'Store city' },
  { colName: 'PrintModel.ShopState', label: 'Store State', category: 'Store / Company', sample: 'Maharashtra', desc: 'Store state' },
  { colName: 'PrintModel.ShopPincode', label: 'Store Pincode / Zip', category: 'Store / Company', sample: '400001', desc: 'Postal code' },
  { colName: 'PrintModel.ShopMobile', label: 'Store Mobile No.', category: 'Store / Company', sample: '+91 9876543210', desc: 'Store primary mobile contact' },
  { colName: 'PrintModel.ShopPhone', label: 'Store Landline Phone', category: 'Store / Company', sample: '022-28492019', desc: 'Store landline telephone' },
  { colName: 'PrintModel.ShopEmail', label: 'Store Email', category: 'Store / Company', sample: 'contact@royalfeelhome.com', desc: 'Store customer support email' },
  { colName: 'PrintModel.ShopGstNo', label: 'Store GSTIN / Tax ID', category: 'Store / Company', sample: '27AABCU9603R1ZN', desc: 'Store GST registration number' },
  { colName: 'PrintModel.ShopFssaiNo', label: 'Store FSSAI License', category: 'Store / Company', sample: '10014022002345', desc: 'FSSAI food license number' },
  { colName: 'PrintModel.ShopPanNo', label: 'Store PAN No.', category: 'Store / Company', sample: 'AABCU9603R', desc: 'Permanent Account Number' },
  { colName: 'PrintModel.ShopCinNo', label: 'Store CIN No.', category: 'Store / Company', sample: 'U72900MH2020PTC345678', desc: 'Corporate Identification Number' },
  { colName: 'PrintModel.ShopWebsite', label: 'Store Website', category: 'Store / Company', sample: 'www.royalfeelhome.com', desc: 'Store website URL' },

  // Invoice / Bill Header
  { colName: 'PrintModel.InvoiceNo', label: 'Invoice Number', category: 'Invoice Details', sample: 'INV-2026-0042', desc: 'Unique invoice sequential identifier' },
  { colName: 'PrintModel.BillNo', label: 'Bill / Receipt Number', category: 'Invoice Details', sample: 'BL-8841', desc: 'POS bill number' },
  { colName: 'PrintModel.BillDate', label: 'Invoice Date', category: 'Invoice Details', sample: '03-11-2026', desc: 'Billing transaction date' },
  { colName: 'PrintModel.BillTime', label: 'Invoice Time', category: 'Invoice Details', sample: '14:32:15', desc: 'Billing transaction time' },
  { colName: 'PrintModel.SalesManName', label: 'Salesperson Name', category: 'Invoice Details', sample: 'Rahul Sharma', desc: 'Assigned salesperson / staff' },
  { colName: 'PrintModel.CashierName', label: 'Cashier Name', category: 'Invoice Details', sample: 'Priya Mehta', desc: 'Cashier handling POS counter' },
  { colName: 'PrintModel.RegisterName', label: 'Register / POS Terminal', category: 'Invoice Details', sample: 'POS Counter 01', desc: 'Terminal / machine name' },
  { colName: 'PrintModel.ReferenceNo', label: 'Reference / Order No.', category: 'Invoice Details', sample: 'ORD-99120', desc: 'External or sales order reference' },
  { colName: 'PrintModel.PaymentMode', label: 'Payment Mode', category: 'Invoice Details', sample: 'UPI / Credit Card', desc: 'Tender payment mode' },

  // Customer Details
  { colName: 'PrintModel.CustomerName', label: 'Customer Name', category: 'Customer Details', sample: 'Akshat Kalani', desc: 'Billed customer name' },
  { colName: 'PrintModel.CustomerMobile', label: 'Customer Mobile', category: 'Customer Details', sample: '+91 9820012345', desc: 'Customer mobile phone' },
  { colName: 'PrintModel.CustomerPhone', label: 'Customer Phone', category: 'Customer Details', sample: '022-26789012', desc: 'Customer telephone' },
  { colName: 'PrintModel.CustomerEmail', label: 'Customer Email', category: 'Customer Details', sample: 'akshatkalani7@gmail.com', desc: 'Customer email' },
  { colName: 'PrintModel.CustomerAddress1', label: 'Customer Address Line 1', category: 'Customer Details', sample: '402, Sunshine Towers', desc: 'Customer delivery address line 1' },
  { colName: 'PrintModel.CustomerAddress2', label: 'Customer Address Line 2', category: 'Customer Details', sample: 'Linking Road, Bandra West', desc: 'Customer address line 2' },
  { colName: 'PrintModel.CustomerCity', label: 'Customer City', category: 'Customer Details', sample: 'Mumbai', desc: 'Customer city' },
  { colName: 'PrintModel.CustomerState', label: 'Customer State', category: 'Customer Details', sample: 'Maharashtra', desc: 'Customer state' },
  { colName: 'PrintModel.CustomerPincode', label: 'Customer Pincode', category: 'Customer Details', sample: '400050', desc: 'Customer postal code' },
  { colName: 'PrintModel.CustomerGstNumber', label: 'Customer GSTIN', category: 'Customer Details', sample: '27AADCB2230M1Z2', desc: 'Customer GST registration number (B2B)' },
  { colName: 'PrintModel.CustomerPan', label: 'Customer PAN', category: 'Customer Details', sample: 'AADCB2230M', desc: 'Customer PAN identifier' },
  { colName: 'PrintModel.LoyaltyPointsEarned', label: 'Loyalty Points Earned', category: 'Customer Details', sample: '120 pts', desc: 'Points earned this transaction' },
  { colName: 'PrintModel.LoyaltyPointsBalance', label: 'Loyalty Points Balance', category: 'Customer Details', sample: '1,450 pts', desc: 'Available reward points balance' },

  // Detail / Line Item Columns
  { colName: 'PrintModel.Products.Name', label: 'Product Name / Description', category: 'Line Items (Detail)', sample: 'Premium Velvet Cushion Cover', desc: 'Item description in line row' },
  { colName: 'PrintModel.Products.AliasName', label: 'Product Alias Name', category: 'Line Items (Detail)', sample: 'Velvet Cushion 16x16', desc: 'Alternative short item name' },
  { colName: 'PrintModel.Products.ItemCode', label: 'Product Code / SKU', category: 'Line Items (Detail)', sample: 'RFH-CC-09', desc: 'Unique product inventory code' },
  { colName: 'PrintModel.Products.Barcode', label: 'Item Barcode', category: 'Line Items (Detail)', sample: '8901030882194', desc: 'Product barcode / EAN number' },
  { colName: 'PrintModel.Products.HsnCode', label: 'HSN / SAC Code', category: 'Line Items (Detail)', sample: '6304', desc: 'Harmonized System Nomenclature code' },
  { colName: 'PrintModel.Products.Quantity', label: 'Quantity', category: 'Line Items (Detail)', sample: '2.00', desc: 'Sold units count' },
  { colName: 'PrintModel.Products.Unit', label: 'Unit of Measure', category: 'Line Items (Detail)', sample: 'PCS', desc: 'Item unit (PCS, KGS, MTR)' },
  { colName: 'PrintModel.Products.Mrp', label: 'MRP (Maximum Retail Price)', category: 'Line Items (Detail)', sample: '1,299.00', desc: 'Printed retail price' },
  { colName: 'PrintModel.Products.RateWithoutTax', label: 'Rate / Unit (Tax Exclusive)', category: 'Line Items (Detail)', sample: '950.00', desc: 'Base unit price before taxes' },
  { colName: 'PrintModel.Products.RateWithTax', label: 'Rate / Unit (Tax Inclusive)', category: 'Line Items (Detail)', sample: '1,121.00', desc: 'Unit price including taxes' },
  { colName: 'PrintModel.Products.TaxPercentage', label: 'Tax Percentage (%)', category: 'Line Items (Detail)', sample: '18%', desc: 'Combined GST / tax percentage' },
  { colName: 'PrintModel.Products.Tax', label: 'Tax Amount', category: 'Line Items (Detail)', sample: '171.00', desc: 'Calculated tax amount for item' },
  { colName: 'PrintModel.Products.CgstPercentage', label: 'CGST Percentage', category: 'Line Items (Detail)', sample: '9%', desc: 'Central GST rate' },
  { colName: 'PrintModel.Products.CgstAmount', label: 'CGST Amount', category: 'Line Items (Detail)', sample: '85.50', desc: 'Central GST amount' },
  { colName: 'PrintModel.Products.SgstPercentage', label: 'SGST Percentage', category: 'Line Items (Detail)', sample: '9%', desc: 'State GST rate' },
  { colName: 'PrintModel.Products.SgstAmount', label: 'SGST Amount', category: 'Line Items (Detail)', sample: '85.50', desc: 'State GST amount' },
  { colName: 'PrintModel.Products.ItemDiscountAmount', label: 'Item Discount Amount', category: 'Line Items (Detail)', sample: '50.00', desc: 'Discount subtracted per row' },
  { colName: 'PrintModel.Products.ItemAmount', label: 'Item Total / Line Amount', category: 'Line Items (Detail)', sample: '2,142.00', desc: 'Final total row amount' },

  // Totals & Footer Summary
  { colName: 'PrintModel.TotalPriceWithoutTax', label: 'Subtotal (Taxable Value)', category: 'Totals & Summary', sample: '10,550.85', desc: 'Total taxable turnover before taxes' },
  { colName: 'PrintModel.TotalDiscountAmount', label: 'Total Discount Amount', category: 'Totals & Summary', sample: '500.00', desc: 'Aggregated discounts across bill' },
  { colName: 'PrintModel.TotalTaxAmount', label: 'Total GST / Tax Amount', category: 'Totals & Summary', sample: '1,899.15', desc: 'Total taxes collected' },
  { colName: 'PrintModel.TotalCGSTAmount', label: 'Total CGST Amount', category: 'Totals & Summary', sample: '949.58', desc: 'Total Central GST' },
  { colName: 'PrintModel.TotalSGSTAmount', label: 'Total SGST Amount', category: 'Totals & Summary', sample: '949.58', desc: 'Total State GST' },
  { colName: 'PrintModel.TotalIGSTAmount', label: 'Total IGST Amount', category: 'Totals & Summary', sample: '0.00', desc: 'Total Integrated GST (Inter-state)' },
  { colName: 'PrintModel.RoundOff', label: 'Round Off Adjustment', category: 'Totals & Summary', sample: '0.00', desc: 'Rounding adjustment (+/-)' },
  { colName: 'PrintModel.TotalAmount', label: 'Grand Total Amount', category: 'Totals & Summary', sample: '12,450.00', desc: 'Final net payable bill amount' },
  { colName: 'PrintModel.TotalAmountInWords', label: 'Amount in Words', category: 'Totals & Summary', sample: 'Twelve Thousand Four Hundred Fifty Rupees Only', desc: 'Spelled out total amount' },
  { colName: 'PrintModel.TotalQuantity', label: 'Total Item Quantity', category: 'Totals & Summary', sample: '14.00', desc: 'Sum of units across lines' },
  { colName: 'PrintModel.TotalItemsCount', label: 'Total Unique Items Count', category: 'Totals & Summary', sample: '6', desc: 'Count of distinct rows' },
  { colName: 'PrintModel.PaidAmount', label: 'Tendered / Paid Amount', category: 'Totals & Summary', sample: '12,450.00', desc: 'Amount paid by customer' },
  { colName: 'PrintModel.BalanceAmount', label: 'Change / Balance Due', category: 'Totals & Summary', sample: '0.00', desc: 'Change returned' },

  // Tax Summary Table (ReportFooterTaxSummary)
  { colName: 'PrintModel.SaleTaxSummary.TotalTaxPercentage', label: 'Tax Rate %', category: 'Tax Summary', sample: '18.00%', desc: 'GST slab percentage' },
  { colName: 'PrintModel.SaleTaxSummary.TotalPriceWithoutTax', label: 'Taxable Turnover', category: 'Tax Summary', sample: '10,550.85', desc: 'Taxable value under this slab' },
  { colName: 'PrintModel.SaleTaxSummary.TotalCGSTAmount', label: 'CGST Amount', category: 'Tax Summary', sample: '949.58', desc: 'CGST collected under slab' },
  { colName: 'PrintModel.SaleTaxSummary.TotalSGSTAmount', label: 'SGST Amount', category: 'Tax Summary', sample: '949.58', desc: 'SGST collected under slab' },
  { colName: 'PrintModel.SaleTaxSummary.TotalIGSTAmount', label: 'IGST Amount', category: 'Tax Summary', sample: '0.00', desc: 'IGST collected under slab' },
  { colName: 'PrintModel.SaleTaxSummary.TotalTaxAmount', label: 'Total Tax in Slab', category: 'Tax Summary', sample: '1,899.15', desc: 'Sum of taxes under slab' }
];

app.get('/api/zoho/pos-fields', (req, res) => {
  res.json({
    ok: true,
    fields: ZOHO_POS_FIELDS
  });
});

// --- SSRF guard for the "custom plugin" mode: only public http(s) hosts ---
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') ||
      v.startsWith('fe80') || v.startsWith('::ffff:');
  }
  return true;
}

async function assertPublicHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Plugin API URL is not a valid URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Plugin API URL must start with http:// or https://');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) {
    throw new Error('Plugin API URL must point to a public server (private/internal addresses are blocked).');
  }
}

// --- Zoho POS & Custom Plugin API Proxy ---
app.get('/api/zoho/config', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT zoho_mode, zoho_org_id, zoho_access_token, zoho_custom_url, zoho_custom_headers, zoho_remember
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = result.rows[0];
    res.json({
      mode: user.zoho_mode || 'zoho_official',
      orgId: user.zoho_org_id || '',
      accessToken: user.zoho_remember ? (user.zoho_access_token || '') : '',
      apiUrl: user.zoho_custom_url || '',
      customHeaders: user.zoho_custom_headers || '{}',
      remember: !!user.zoho_remember
    });
  } catch (err) {
    console.error('Failed to fetch Zoho config:', err);
    res.status(500).json({ error: 'Failed to fetch integration settings' });
  }
});

app.post('/api/zoho/config', requireAuth, async (req, res) => {
  const { mode, orgId, accessToken, apiUrl, customHeaders, remember } = req.body;

  try {
    await pool.query(
      `UPDATE users
       SET zoho_mode = $1,
           zoho_org_id = $2,
           zoho_access_token = $3,
           zoho_custom_url = $4,
           zoho_custom_headers = $5,
           zoho_remember = $6
       WHERE id = $7`,
      [
        mode || 'zoho_official',
        orgId || '',
        accessToken || '',
        apiUrl || '',
        customHeaders || '{}',
        !!remember,
        req.userId
      ]
    );
    res.json({ ok: true, message: 'Integration settings saved successfully.' });
  } catch (err) {
    console.error('Failed to save Zoho config:', err);
    res.status(500).json({ error: 'Failed to save integration settings' });
  }
});

// --- Zoho OAuth (per-user "Server-based Application") ---
// Each logged-in user creates their own app in the Zoho API Console using
// the shared Homepage URL / Authorized Redirect URI below, then pastes
// their own Client ID + Client Secret here. Tokens are stored per-user, so
// every account can connect a completely separate Zoho organization.

app.get('/api/zoho/oauth/redirect-info', requireAuth, (req, res) => {
  res.json({
    homepageUrl: zohoOAuth.getBaseUrl(req),
    redirectUri: zohoOAuth.getRedirectUri(req)
  });
});

app.get('/api/zoho/oauth/status', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT zoho_client_id, zoho_org_id, zoho_dc, zoho_oauth_connected, zoho_oauth_scope
       FROM users WHERE id = $1`,
      [req.userId]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      connected: !!user.zoho_oauth_connected,
      hasCredentials: !!user.zoho_client_id,
      clientId: user.zoho_client_id || '',
      orgId: user.zoho_org_id || '',
      dc: user.zoho_dc || 'in',
      scope: user.zoho_oauth_scope || '',
      homepageUrl: zohoOAuth.getBaseUrl(req),
      redirectUri: zohoOAuth.getRedirectUri(req)
    });
  } catch (err) {
    console.error('Failed to fetch Zoho OAuth status:', err);
    res.status(500).json({ error: 'Failed to fetch Zoho OAuth status' });
  }
});

// Save this user's Client ID / Client Secret / Org ID / Data Center. Saving
// new credentials invalidates any previously connected tokens, since a
// changed client id/secret means the old refresh token is no longer valid.
app.post('/api/zoho/oauth/credentials', requireAuth, async (req, res) => {
  const { clientId, clientSecret, orgId, dc } = req.body || {};
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'Client ID and Client Secret are required.' });
  }
  const dataCenter = zohoOAuth.DC_DOMAINS[dc] ? dc : 'in';
  try {
    await pool.query(
      `UPDATE users
       SET zoho_client_id = $1, zoho_client_secret = $2, zoho_org_id = $3, zoho_dc = $4,
           zoho_oauth_connected = false, zoho_refresh_token = '', zoho_oauth_access_token = '', zoho_oauth_expires_at = 0
       WHERE id = $5`,
      [clientId.trim(), encrypt(clientSecret.trim()), (orgId || '').trim(), dataCenter, req.userId]
    );
    res.json({ ok: true, message: 'Credentials saved. Click "Connect to Zoho" to authorize.' });
  } catch (err) {
    console.error('Failed to save Zoho OAuth credentials:', err);
    res.status(500).json({ error: 'Failed to save Zoho OAuth credentials' });
  }
});

// Kicks off the Zoho consent screen. Requires credentials to already be saved.
app.get('/api/zoho/oauth/connect', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT zoho_client_id, zoho_dc FROM users WHERE id = $1`,
      [req.userId]
    );
    const user = result.rows[0];
    if (!user || !user.zoho_client_id) {
      return res.status(400).json({ error: 'Save your Zoho Client ID and Client Secret first.' });
    }
    // State carries the user id (short-lived, signed) so the callback --
    // which Zoho hits directly and may arrive without full session context --
    // can be tied back to the right account without trusting the client.
    const state = jwt.sign({ uid: req.userId, purpose: 'zoho_oauth' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const redirectUri = zohoOAuth.getRedirectUri(req);
    const authUrl = zohoOAuth.buildAuthUrl({
      clientId: user.zoho_client_id,
      redirectUri,
      state,
      dc: user.zoho_dc || 'in'
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error('Failed to start Zoho OAuth flow:', err);
    res.status(500).json({ error: 'Failed to start Zoho OAuth flow' });
  }
});

// Zoho redirects the browser here after the user grants/denies access.
app.get('/api/zoho/oauth/callback', async (req, res) => {
  const { code, state, error: zohoError } = req.query;

  const fail = (msg) => res.redirect(`/builder.html?zoho=error&msg=${encodeURIComponent(msg)}`);

  if (zohoError) return fail(`Zoho denied access: ${zohoError}`);
  if (!code || !state) return fail('Missing authorization code from Zoho.');

  let userId;
  try {
    const payload = jwt.verify(state, process.env.JWT_SECRET);
    if (payload.purpose !== 'zoho_oauth') throw new Error('bad state');
    userId = payload.uid;
  } catch {
    return fail('Invalid or expired authorization request. Please try connecting again.');
  }

  try {
    const result = await pool.query(
      `SELECT zoho_client_id, zoho_client_secret, zoho_dc FROM users WHERE id = $1`,
      [userId]
    );
    const user = result.rows[0];
    if (!user || !user.zoho_client_id) return fail('No saved Zoho credentials found for this account.');

    const redirectUri = zohoOAuth.getRedirectUri(req);
    const tokenData = await zohoOAuth.exchangeCodeForTokens({
      code,
      clientId: user.zoho_client_id,
      clientSecret: decrypt(user.zoho_client_secret),
      redirectUri,
      dc: user.zoho_dc || 'in'
    });

    if (!tokenData.refresh_token) {
      // Happens if the user had already granted consent before and Zoho
      // skipped issuing a new refresh token; prompt=consent above should
      // normally prevent this, but guard anyway.
      return fail('Zoho did not return a refresh token. Please revoke access for this app in your Zoho account and try connecting again.');
    }

    const expiresAt = Date.now() + (Number(tokenData.expires_in) || 3600) * 1000;
    await pool.query(
      `UPDATE users
       SET zoho_refresh_token = $1, zoho_oauth_access_token = $2, zoho_oauth_expires_at = $3, zoho_oauth_scope = $4, zoho_oauth_connected = true
       WHERE id = $5`,
      [encrypt(tokenData.refresh_token), encrypt(tokenData.access_token), expiresAt, tokenData.scope || '', userId]
    );

    res.redirect('/builder.html?zoho=connected');
  } catch (err) {
    console.error('Zoho OAuth callback error:', err);
    return fail(err.message || 'Failed to complete Zoho authorization.');
  }
});

app.post('/api/zoho/oauth/disconnect', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET zoho_oauth_connected = false, zoho_refresh_token = '', zoho_oauth_access_token = '', zoho_oauth_expires_at = 0 WHERE id = $1`,
      [req.userId]
    );
    res.json({ ok: true, message: 'Disconnected from Zoho.' });
  } catch (err) {
    console.error('Failed to disconnect Zoho:', err);
    res.status(500).json({ error: 'Failed to disconnect Zoho' });
  }
});

app.post('/api/zoho/fetch', requireAuth, async (req, res) => {
  const { mode, apiUrl, orgId, accessToken, customHeaders } = req.body;

  try {
    if (mode === 'zoho_oauth') {
      let accessToken, dc, resolvedOrgId;
      try {
        ({ accessToken, dc, orgId: resolvedOrgId } = await zohoOAuth.getValidAccessToken(req.userId));
      } catch (tokenErr) {
        const status = tokenErr.code === 'not_connected' || tokenErr.code === 'reauth_required' ? 401 : 500;
        return res.status(status).json({ error: tokenErr.message, code: tokenErr.code });
      }
      const effectiveOrgId = (orgId || resolvedOrgId || '').trim();
      if (!effectiveOrgId) {
        return res.status(400).json({ error: 'Organization ID is required. Add it in the Zoho integration settings.' });
      }

      const targetUrl = `https://${zohoOAuth.dcInfo(dc).api}/inventory/v1/items?organization_id=${encodeURIComponent(effectiveOrgId)}`;
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        return res.status(response.status).json({ error: `Zoho API Error: ${response.status} - ${errorText}` });
      }

      const responseData = await response.json();
      return res.json(responseData);
    } else if (mode === 'zoho_official') {
      if (!orgId || !accessToken) {
        return res.status(400).json({ error: 'Organization ID and Access Token are required for Zoho official integration.' });
      }
      
      const dc = (req.body.dc || 'in').toLowerCase();
      const invDomain = dc === 'in' ? 'inventory.zoho.in' : (dc === 'com' ? 'inventory.zoho.com' : `inventory.zoho.${dc}`);
      const targetUrl = `https://${invDomain}/api/v1/items?organization_id=${encodeURIComponent(orgId)}`;
      
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
          'X-com-zoho-inventory-organizationid': orgId,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        return res.status(response.status).json({ error: `Zoho API Error: ${response.status} - ${errorText}` });
      }

      const responseData = await response.json();
      return res.json(responseData);
    } else if (mode === 'custom_plugin') {
      if (!apiUrl) {
        return res.status(400).json({ error: 'Plugin API URL is required for custom integration.' });
      }

      const headers = {
        'Content-Type': 'application/json'
      };

      if (customHeaders && typeof customHeaders === 'object') {
        Object.assign(headers, customHeaders);
      }

      try {
        await assertPublicHttpUrl(apiUrl);
      } catch (urlErr) {
        return res.status(400).json({ error: urlErr.message });
      }

      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        return res.status(response.status).json({ error: `Plugin API Error: Failed with status ${response.status}` });
      }

      const responseData = await response.json();
      return res.json(responseData);
    } else {
      return res.status(400).json({ error: 'Invalid integration mode specified.' });
    }
  } catch (err) {
    console.error('Zoho plugin integration error:', err);
    return res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

// Direct entry to Barcode Builder without login requirement
app.get(['/', '/index.html', '/login', '/login.html', '/signup', '/signup.html', '/dashboard', '/dashboard.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'builder.html'));
});

app.get('/builder.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'builder.html'));
});

// Invoice template designer (no login needed; Zoho sync endpoints stay behind login)
app.get(['/invoice', '/invoice-designer'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'invoice-designer.html'));
});

// --- Static frontend ---
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

async function start() {
  try {
    await migrate();
  } catch (err) {
    console.error('Could not run database migration on startup:', err.message);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nBarcode Sync SaaS running on port ${PORT}`);
  });
}

start();
