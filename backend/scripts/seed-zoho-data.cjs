#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();

const { PrismaClient } = require('../src/generated/prisma');
const { decryptZohoSecret, encryptZohoSecret } = require('../dist/company/integrations/zoho/zoho-token.crypto.js');

let zohoSyncProducer = null;
let runZohoHistoricalSyncWorker = null;
try {
  ({ zohoSyncProducer } = require('../dist/company/queue/producer/zoho-sync.producer.js'));
  ({ runZohoHistoricalSyncWorker } = require('../dist/company/queue/workers/zoho-historical.worker.js'));
} catch {
  // Historical sync is optional for this script. If dist is unavailable, the seed still runs.
}

const prisma = new PrismaClient();

const DEFAULT_TARGET = process.argv[2] || 'vabhi.verma2678@gmail.com';
const DEFAULT_ENVIRONMENT = process.argv[3] || 'prod';
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const CRM_BATCH_SIZE = 50;
const TODAY = new Date();

const DEFAULT_COUNTS = {
  booksCustomers: 12,
  booksVendors: 8,
  booksInvoices: 18,
  booksEstimates: 10,
  booksBills: 10,
  booksSalesOrders: 8,
  booksPurchaseOrders: 8,
  booksCreditNotes: 6,
  booksCustomerPayments: 8,
  booksVendorPayments: 6,
  booksBankAccounts: 2,
  booksImportedStatementRows: 16,
  crmAccounts: 10,
  crmContacts: 18,
  crmLeads: 14,
  crmDeals: 16,
  crmCases: 12,
};

const STAGES = ['Qualification', 'Needs Analysis', 'Proposal/Price Quote', 'Closed Won', 'Closed Lost'];
const CASE_STATUSES = ['New', 'On Hold', 'Open', 'Escalated'];
const CASE_PRIORITIES = ['High', 'Medium', 'Low'];
const LEAD_SOURCES = ['Website', 'Partner', 'Cold Call', 'Referral', 'LinkedIn'];
const INDUSTRIES = ['SaaS', 'Logistics', 'Healthcare', 'Retail', 'Fintech'];
const STATES = ['Karnataka', 'Maharashtra', 'Delhi', 'Telangana', 'Tamil Nadu'];
const CITIES = ['Bengaluru', 'Mumbai', 'Delhi', 'Hyderabad', 'Chennai'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chunk = (values, size) => {
  const out = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
};

const asString = (value) => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const addDays = (base, days) => {
  const copy = new Date(base.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
};

const currencyCode = () => (process.env.ZOHO_SEED_CURRENCY_CODE || 'INR').trim().toUpperCase();

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const buildSeedEmail = (prefix, index) => `${prefix}.${RUN_STAMP}.${index}@example.com`;

const buildPhone = (index) => `+91-9000${String(100000 + index).slice(-6)}`;

const buildAddress = (index) => ({
  attention: `Ops ${index}`,
  address: `${100 + index}, Seed Street`,
  street2: `Suite ${index}`,
  city: CITIES[index % CITIES.length],
  state: STATES[index % STATES.length],
  zip: `560${String(100 + index).slice(-3)}`,
  country: 'India',
  phone: buildPhone(index),
});

const summarizeErrors = (error) => {
  if (!error) return 'unknown_error';
  if (error instanceof Error) return error.message;
  return String(error);
};

async function resolveTargetCompany(target) {
  if (target.includes('@')) {
    const email = normalizeEmail(target);
    const user = await prisma.user.findFirst({
      where: { email },
      select: {
        id: true,
        email: true,
        adminMemberships: {
          where: { isActive: true },
          select: { companyId: true, role: true },
        },
        memberSessions: {
          select: { companyId: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!user) {
      throw new Error(`No user found for ${email}`);
    }

    const companyIds = [...new Set([
      ...user.adminMemberships.map((membership) => membership.companyId).filter(Boolean),
      ...user.memberSessions.map((session) => session.companyId).filter(Boolean),
    ])];

    if (companyIds.length === 0) {
      throw new Error(`No company membership found for ${email}`);
    }

    const company = await prisma.company.findFirst({
      where: { id: companyIds[0] },
      select: { id: true, name: true },
    });

    if (!company) {
      throw new Error(`Company ${companyIds[0]} was not found`);
    }

    return {
      companyId: company.id,
      companyName: company.name,
      resolvedFrom: email,
    };
  }

  const company = await prisma.company.findUnique({
    where: { id: target },
    select: { id: true, name: true },
  });

  if (!company) {
    throw new Error(`Company ${target} was not found`);
  }

  return {
    companyId: company.id,
    companyName: company.name,
    resolvedFrom: target,
  };
}

async function loadConnection(companyId, environment) {
  const connection = await prisma.zohoConnection.findUnique({
    where: {
      companyId_environment: {
        companyId,
        environment,
      },
    },
    select: {
      id: true,
      companyId: true,
      environment: true,
      providerMode: true,
      status: true,
      connectedAt: true,
      scopes: true,
      accessTokenEncrypted: true,
      refreshTokenEncrypted: true,
      accessTokenExpiresAt: true,
      refreshTokenExpiresAt: true,
      tokenCipherVersion: true,
      tokenMetadata: true,
    },
  });

  if (!connection || connection.status !== 'CONNECTED') {
    throw new Error(`Connected Zoho REST connection not found for ${companyId}/${environment}`);
  }
  if (connection.providerMode !== 'rest') {
    throw new Error(`Seed script supports REST-mode Zoho only. Found providerMode=${connection.providerMode}`);
  }
  return connection;
}

function createZohoSession(input) {
  let connection = input.connection;
  let accessToken = null;
  const apiBaseUrl = (
    asString(connection.tokenMetadata && connection.tokenMetadata.apiDomain)
    || asString(process.env.ZOHO_API_BASE_URL)
    || 'https://www.zohoapis.com'
  ).replace(/\/$/, '');
  const accountsBaseUrl = (
    asString(process.env.ZOHO_ACCOUNTS_BASE_URL)
    || 'https://accounts.zoho.com'
  ).replace(/\/$/, '');

  async function persistRefreshedToken(token, expiresInSeconds) {
    const encrypted = encryptZohoSecret(token);
    const expiresAt = new Date(Date.now() + Math.max(300, expiresInSeconds || 3600) * 1000);
    connection = await prisma.zohoConnection.update({
      where: {
        companyId_environment: {
          companyId: input.companyId,
          environment: input.environment,
        },
      },
      data: {
        accessTokenEncrypted: encrypted.cipherText,
        accessTokenExpiresAt: expiresAt,
        tokenCipherVersion: encrypted.version,
        lastTokenRefreshAt: new Date(),
      },
      select: {
        id: true,
        companyId: true,
        environment: true,
        providerMode: true,
        status: true,
        connectedAt: true,
        scopes: true,
        accessTokenEncrypted: true,
        refreshTokenEncrypted: true,
        accessTokenExpiresAt: true,
        refreshTokenExpiresAt: true,
        tokenCipherVersion: true,
        tokenMetadata: true,
      },
    });
    accessToken = token;
  }

  async function refreshToken() {
    const refreshTokenEncrypted = connection.refreshTokenEncrypted;
    if (!refreshTokenEncrypted) {
      throw new Error('Zoho refresh token is not stored in the company connection');
    }

    const clientId = asString(process.env.ZOHO_CLIENT_ID);
    const clientSecret = asString(process.env.ZOHO_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      throw new Error('ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET are required to refresh expired access tokens');
    }

    const refreshTokenValue = decryptZohoSecret(refreshTokenEncrypted);
    const response = await fetch(`${accountsBaseUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshTokenValue,
      }).toString(),
    });

    const raw = await response.text();
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { raw };
      }
    }

    if (!response.ok || !payload.access_token) {
      throw new Error(`Zoho refresh_token exchange failed (${response.status}): ${raw.slice(0, 500)}`);
    }

    const expiresIn = Number.parseInt(String(payload.expires_in || '3600'), 10);
    await persistRefreshedToken(payload.access_token, Number.isFinite(expiresIn) ? expiresIn : 3600);
    return accessToken;
  }

  async function getAccessToken() {
    if (accessToken) {
      return accessToken;
    }

    if (
      connection.accessTokenEncrypted
      && connection.accessTokenExpiresAt
      && connection.accessTokenExpiresAt.getTime() > Date.now() + 60_000
    ) {
      accessToken = decryptZohoSecret(connection.accessTokenEncrypted);
      return accessToken;
    }

    return refreshToken();
  }

  async function request(inputRequest, retry = true) {
    const token = await getAccessToken();
    const url = `${apiBaseUrl}${inputRequest.path.startsWith('/') ? inputRequest.path : `/${inputRequest.path}`}`;
    const headers = {
      Authorization: `Zoho-oauthtoken ${token}`,
      ...(inputRequest.headers || {}),
    };

    let body = inputRequest.body;
    if (
      body !== undefined
      && body !== null
      && !(body instanceof FormData)
      && !(body instanceof URLSearchParams)
      && typeof body !== 'string'
    ) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      body = JSON.stringify(body);
    }

    const response = await fetch(url, {
      method: inputRequest.method || 'GET',
      headers,
      body,
    });

    const raw = await response.text();
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = raw;
      }
    }

    if (
      retry
      && (response.status === 401 || (payload && typeof payload === 'object' && payload.code === 'INVALID_OAUTHTOKEN'))
    ) {
      await refreshToken();
      return request(inputRequest, false);
    }

    if (!response.ok) {
      throw new Error(`Zoho API failed (${response.status}) ${inputRequest.method || 'GET'} ${inputRequest.path}: ${raw.slice(0, 800)}`);
    }

    return payload;
  }

  return {
    getAccessToken,
    request,
    apiBaseUrl,
    accountsBaseUrl,
  };
}

function createBooksContactPayload(kind, index) {
  const seedIndex = index + 1;
  const namePrefix = kind === 'customer' ? 'Customer' : 'Vendor';
  return {
    contact_name: `${namePrefix} ${RUN_STAMP} ${seedIndex}`,
    company_name: `${namePrefix} Co ${seedIndex}`,
    contact_type: kind,
    email: buildSeedEmail(kind, seedIndex),
    phone: buildPhone(seedIndex),
    mobile: buildPhone(seedIndex + 100),
    payment_terms: kind === 'customer' ? 30 : 21,
    website: `https://${kind}${seedIndex}.seed.example.com`,
    notes: `${namePrefix} seed contact ${seedIndex} for ${RUN_STAMP}`,
    billing_address: buildAddress(seedIndex),
    shipping_address: buildAddress(seedIndex + 50),
    contact_persons: [{
      first_name: `${namePrefix}${seedIndex}`,
      last_name: 'Ops',
      email: buildSeedEmail(`${kind}.ops`, seedIndex),
      phone: buildPhone(seedIndex + 200),
      is_primary_contact: true,
    }],
  };
}

function createBooksLineItems(index) {
  const quantity = 1 + (index % 3);
  const rate = 12500 + (index * 850);
  return [{
    name: `Seed Service ${index + 1}`,
    description: `Structured seed line item ${index + 1} for ${RUN_STAMP}`,
    quantity,
    rate,
  }];
}

function extractBooksRecordId(moduleName, record) {
  if (!record || typeof record !== 'object') return undefined;
  const candidates = {
    contacts: ['contact_id', 'id'],
    invoices: ['invoice_id', 'id'],
    estimates: ['estimate_id', 'id'],
    creditnotes: ['creditnote_id', 'credit_note_id', 'id'],
    bills: ['bill_id', 'id'],
    salesorders: ['salesorder_id', 'sales_order_id', 'id'],
    purchaseorders: ['purchaseorder_id', 'purchase_order_id', 'id'],
    customerpayments: ['payment_id', 'customer_payment_id', 'id'],
    vendorpayments: ['payment_id', 'vendor_payment_id', 'vendorpayment_id', 'id'],
    bankaccounts: ['account_id', 'id'],
    banktransactions: ['transaction_id', 'bank_transaction_id', 'id'],
  }[moduleName] || ['id'];

  for (const key of candidates) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function createCrmLeadPayload(index) {
  const i = index + 1;
  return {
    Last_Name: `Lead_${RUN_STAMP}_${i}`,
    Company: `Lead Company ${i}`,
    Email: buildSeedEmail('crm.lead', i),
    Phone: buildPhone(500 + i),
    Lead_Source: LEAD_SOURCES[index % LEAD_SOURCES.length],
    Description: `Seed lead ${i} created for Zoho CRM retrieval and routing tests.`,
  };
}

function createCrmAccountPayload(index) {
  const i = index + 1;
  return {
    Account_Name: `RelicWave Seed Account ${RUN_STAMP} ${i}`,
    Industry: INDUSTRIES[index % INDUSTRIES.length],
    Phone: buildPhone(700 + i),
    Website: `https://crm-account-${i}.seed.example.com`,
    Billing_City: CITIES[index % CITIES.length],
    Billing_State: STATES[index % STATES.length],
    Description: `Seed account ${i} used for CRM account/contact/deal/case coverage.`,
  };
}

function createCrmContactPayload(index, accountId) {
  const i = index + 1;
  const payload = {
    First_Name: `CRM${i}`,
    Last_Name: `Contact_${RUN_STAMP}_${i}`,
    Email: buildSeedEmail('crm.contact', i),
    Phone: buildPhone(900 + i),
    Description: `Seed CRM contact ${i} linked to seeded accounts and deals.`,
  };
  if (accountId) {
    payload.Account_Name = { id: accountId };
  }
  return payload;
}

function createCrmDealPayload(index, accountId, contactId) {
  const i = index + 1;
  const payload = {
    Deal_Name: `Seed Deal ${RUN_STAMP} ${i}`,
    Stage: STAGES[index % STAGES.length],
    Amount: 25000 + (i * 15000),
    Closing_Date: addDays(TODAY, (index % 7) - 3),
    Description: `Seed deal ${i} to exercise pipeline summaries, retrieval, and note attachment flows.`,
  };
  if (accountId) {
    payload.Account_Name = { id: accountId };
  }
  if (contactId) {
    payload.Contact_Name = { id: contactId };
  }
  return payload;
}

function createCrmCasePayload(index, contactId, accountId) {
  const i = index + 1;
  const payload = {
    Subject: `Seed Case ${RUN_STAMP} ${i}`,
    Status: CASE_STATUSES[index % CASE_STATUSES.length],
    Priority: CASE_PRIORITIES[index % CASE_PRIORITIES.length],
    Description: `Seed case ${i} created for support retrieval and case summarization testing.`,
  };
  if (contactId) {
    payload.Contact_Name = { id: contactId };
  }
  if (accountId) {
    payload.Account_Name = { id: accountId };
  }
  return payload;
}

async function createBooksRecord(session, organizationId, moduleName, body) {
  const payload = await session.request({
    method: 'POST',
    path: `/books/v3/${moduleName}?organization_id=${encodeURIComponent(organizationId)}`,
    body,
  });

  const directKeys = {
    contacts: 'contact',
    invoices: 'invoice',
    estimates: 'estimate',
    creditnotes: 'creditnote',
    bills: 'bill',
    salesorders: 'salesorder',
    purchaseorders: 'purchaseorder',
    customerpayments: 'payment',
    vendorpayments: 'payment',
    bankaccounts: 'account',
    banktransactions: 'transaction',
  };

  const direct = payload && typeof payload === 'object' ? payload[directKeys[moduleName]] : null;
  if (direct && typeof direct === 'object') {
    return direct;
  }

  const listKeys = {
    contacts: 'contacts',
    invoices: 'invoices',
    estimates: 'estimates',
    creditnotes: 'creditnotes',
    bills: 'bills',
    salesorders: 'salesorders',
    purchaseorders: 'purchaseorders',
    customerpayments: 'customerpayments',
    vendorpayments: 'vendorpayments',
    bankaccounts: 'bankaccounts',
    banktransactions: 'banktransactions',
  };

  const list = payload && typeof payload === 'object' ? payload[listKeys[moduleName]] : null;
  if (Array.isArray(list) && list.length > 0) {
    return list[0];
  }

  return payload;
}

async function importBooksStatement(session, organizationId, accountId, rows) {
  return session.request({
    method: 'POST',
    path: `/books/v3/bankstatements?organization_id=${encodeURIComponent(organizationId)}`,
    body: {
      account_id: accountId,
      start_date: rows[0]?.date,
      end_date: rows[rows.length - 1]?.date,
      transactions: rows,
    },
  });
}

async function batchCreateCrmRecords(session, moduleName, rows) {
  const created = [];
  const errors = [];

  for (const group of chunk(rows, CRM_BATCH_SIZE)) {
    try {
      const response = await session.request({
        method: 'POST',
        path: `/crm/v2/${moduleName}`,
        body: { data: group },
      });
      const data = asArray(response && response.data);
      for (const item of data) {
        if (item && item.status === 'success' && item.details && item.details.id) {
          created.push({
            id: String(item.details.id),
            details: item.details,
          });
        } else {
          errors.push({
            moduleName,
            response: item,
          });
        }
      }
    } catch (error) {
      errors.push({
        moduleName,
        message: summarizeErrors(error),
      });
    }
    await sleep(150);
  }

  return { created, errors };
}

async function createCrmNote(session, moduleName, recordId, index) {
  return session.request({
    method: 'POST',
    path: `/crm/v8/${moduleName}/${encodeURIComponent(recordId)}/Notes`,
    body: {
      data: [{
        Note_Title: `Seed Note ${index + 1}`,
        Note_Content: `Seed note ${index + 1} for ${moduleName} ${recordId} during run ${RUN_STAMP}.`,
      }],
    },
  });
}

async function uploadCrmAttachment(session, moduleName, recordId, index) {
  const formData = new FormData();
  const content = `Seed attachment ${index + 1} for ${moduleName} ${recordId} at ${RUN_STAMP}\n`;
  formData.append(
    'file',
    new Blob([content], { type: 'text/plain' }),
    `seed-${moduleName.toLowerCase()}-${index + 1}.txt`,
  );

  return session.request({
    method: 'POST',
    path: `/crm/v8/${moduleName}/${encodeURIComponent(recordId)}/Attachments`,
    body: formData,
  });
}

function createStatementRows(accountId) {
  return Array.from({ length: DEFAULT_COUNTS.booksImportedStatementRows }).map((_, index) => {
    const isCredit = index % 3 !== 0;
    const amount = 8500 + (index * 775);
    return {
      transaction_id: `stmt-${RUN_STAMP}-${accountId}-${index + 1}`,
      date: addDays(TODAY, -1 * (DEFAULT_COUNTS.booksImportedStatementRows - index)),
      debit_or_credit: isCredit ? 'credit' : 'debit',
      amount,
      payee: isCredit ? `Customer Receipt ${index + 1}` : `Vendor Expense ${index + 1}`,
      description: isCredit
        ? `Imported customer receipt ${index + 1} for reconciliation coverage`
        : `Imported vendor expense ${index + 1} for reconciliation coverage`,
      reference_number: `BANK-${RUN_STAMP}-${index + 1}`,
    };
  });
}

async function seedBooks(session, context, summary) {
  const organizationsPayload = await session.request({
    method: 'GET',
    path: '/books/v3/organizations',
  });
  const organizations = asArray(organizationsPayload && organizationsPayload.organizations);
  const defaultOrg = organizations.find((organization) => organization && organization.is_default_org)
    || organizations[0];
  const organizationId = asString(defaultOrg && (defaultOrg.organization_id || defaultOrg.organizationId));

  if (!organizationId) {
    throw new Error('Zoho Books organizations could not be resolved for the connected tenant');
  }

  summary.books.organizationId = organizationId;
  summary.books.organizations = organizations.length;

  const customerContacts = [];
  const vendorContacts = [];
  for (let index = 0; index < DEFAULT_COUNTS.booksCustomers; index += 1) {
    try {
      const record = await createBooksRecord(session, organizationId, 'contacts', createBooksContactPayload('customer', index));
      customerContacts.push(record);
    } catch (error) {
      summary.errors.push({ area: 'books.contacts.customer', message: summarizeErrors(error) });
    }
    await sleep(100);
  }

  for (let index = 0; index < DEFAULT_COUNTS.booksVendors; index += 1) {
    try {
      const record = await createBooksRecord(session, organizationId, 'contacts', createBooksContactPayload('vendor', index));
      vendorContacts.push(record);
    } catch (error) {
      summary.errors.push({ area: 'books.contacts.vendor', message: summarizeErrors(error) });
    }
    await sleep(100);
  }

  summary.books.contacts = customerContacts.length + vendorContacts.length;

  const invoices = [];
  for (let index = 0; index < DEFAULT_COUNTS.booksInvoices; index += 1) {
    const customer = customerContacts[index % Math.max(1, customerContacts.length)];
    const customerId = extractBooksRecordId('contacts', customer);
    if (!customerId) continue;
    try {
      const invoice = await createBooksRecord(session, organizationId, 'invoices', {
        customer_id: customerId,
        date: addDays(TODAY, -1 * (15 + index)),
        due_date: addDays(TODAY, (index % 4 === 0 ? -5 : 10 + index)),
        payment_terms: 30,
        reference_number: `INV-SEED-${RUN_STAMP}-${index + 1}`,
        notes: `Seed invoice ${index + 1} for overdue and reminder workflows.`,
        line_items: createBooksLineItems(index),
      });
      invoices.push(invoice);
    } catch (error) {
      summary.errors.push({ area: 'books.invoices', message: summarizeErrors(error) });
    }
    await sleep(100);
  }
  summary.books.invoices = invoices.length;

  const estimates = [];
  for (let index = 0; index < DEFAULT_COUNTS.booksEstimates; index += 1) {
    const customer = customerContacts[index % Math.max(1, customerContacts.length)];
    const customerId = extractBooksRecordId('contacts', customer);
    if (!customerId) continue;
    try {
      const estimate = await createBooksRecord(session, organizationId, 'estimates', {
        customer_id: customerId,
        date: addDays(TODAY, -1 * (10 + index)),
        expiry_date: addDays(TODAY, 15 + index),
        reference_number: `EST-SEED-${RUN_STAMP}-${index + 1}`,
        notes: `Seed estimate ${index + 1} for email and status-transition workflows.`,
        line_items: createBooksLineItems(index + 25),
      });
      estimates.push(estimate);
    } catch (error) {
      summary.errors.push({ area: 'books.estimates', message: summarizeErrors(error) });
    }
    await sleep(100);
  }
  summary.books.estimates = estimates.length;

  const bills = [];
  for (let index = 0; index < DEFAULT_COUNTS.booksBills; index += 1) {
    const vendor = vendorContacts[index % Math.max(1, vendorContacts.length)];
    const vendorId = extractBooksRecordId('contacts', vendor);
    if (!vendorId) continue;
    try {
      const bill = await createBooksRecord(session, organizationId, 'bills', {
        vendor_id: vendorId,
        date: addDays(TODAY, -1 * (12 + index)),
        due_date: addDays(TODAY, (index % 3 === 0 ? -3 : 9 + index)),
        reference_number: `BILL-SEED-${RUN_STAMP}-${index + 1}`,
        notes: `Seed bill ${index + 1} for AP reconciliation flows.`,
        line_items: createBooksLineItems(index + 50),
      });
      bills.push(bill);
    } catch (error) {
      summary.errors.push({ area: 'books.bills', message: summarizeErrors(error) });
    }
    await sleep(100);
  }
  summary.books.bills = bills.length;

  const salesOrders = [];
  for (let index = 0; index < DEFAULT_COUNTS.booksSalesOrders; index += 1) {
    const customer = customerContacts[index % Math.max(1, customerContacts.length)];
    const customerId = extractBooksRecordId('contacts', customer);
    if (!customerId) continue;
    try {
      const salesOrder = await createBooksRecord(session, organizationId, 'salesorders', {
        customer_id: customerId,
        date: addDays(TODAY, -1 * (8 + index)),
        shipment_date: addDays(TODAY, 4 + index),
        reference_number: `SO-SEED-${RUN_STAMP}-${index + 1}`,
        notes: `Seed sales order ${index + 1} for downstream finance reads.`,
        line_items: createBooksLineItems(index + 70),
      });
      salesOrders.push(salesOrder);
    } catch (error) {
      summary.errors.push({ area: 'books.salesorders', message: summarizeErrors(error) });
    }
    await sleep(100);
  }
  summary.books.salesOrders = salesOrders.length;

  const purchaseOrders = [];
  for (let index = 0; index < DEFAULT_COUNTS.booksPurchaseOrders; index += 1) {
    const vendor = vendorContacts[index % Math.max(1, vendorContacts.length)];
    const vendorId = extractBooksRecordId('contacts', vendor);
    if (!vendorId) continue;
    try {
      const purchaseOrder = await createBooksRecord(session, organizationId, 'purchaseorders', {
        vendor_id: vendorId,
        date: addDays(TODAY, -1 * (6 + index)),
        delivery_date: addDays(TODAY, 6 + index),
        reference_number: `PO-SEED-${RUN_STAMP}-${index + 1}`,
        notes: `Seed purchase order ${index + 1} for AP document reads.`,
        line_items: createBooksLineItems(index + 90),
      });
      purchaseOrders.push(purchaseOrder);
    } catch (error) {
      summary.errors.push({ area: 'books.purchaseorders', message: summarizeErrors(error) });
    }
    await sleep(100);
  }
  summary.books.purchaseOrders = purchaseOrders.length;

  const creditNotes = [];
  for (let index = 0; index < DEFAULT_COUNTS.booksCreditNotes; index += 1) {
    const customer = customerContacts[index % Math.max(1, customerContacts.length)];
    const customerId = extractBooksRecordId('contacts', customer);
    if (!customerId) continue;
    try {
      const creditNote = await createBooksRecord(session, organizationId, 'creditnotes', {
        customer_id: customerId,
        date: addDays(TODAY, -1 * (4 + index)),
        reference_number: `CN-SEED-${RUN_STAMP}-${index + 1}`,
        notes: `Seed credit note ${index + 1} for refund and adjustment workflows.`,
        line_items: createBooksLineItems(index + 110),
      });
      creditNotes.push(creditNote);
    } catch (error) {
      summary.errors.push({ area: 'books.creditnotes', message: summarizeErrors(error) });
    }
    await sleep(100);
  }
  summary.books.creditNotes = creditNotes.length;

  const customerPayments = [];
  for (let index = 0; index < Math.min(DEFAULT_COUNTS.booksCustomerPayments, invoices.length); index += 1) {
    const invoice = invoices[index];
    const invoiceId = extractBooksRecordId('invoices', invoice);
    const customerId = asString(invoice && (invoice.customer_id || invoice.contact_id));
    const total = Number(invoice && (invoice.balance || invoice.total || 0)) || (12000 + index * 500);
    if (!invoiceId || !customerId) continue;
    try {
      const payment = await createBooksRecord(session, organizationId, 'customerpayments', {
        customer_id: customerId,
        payment_mode: 'banktransfer',
        amount: total,
        date: addDays(TODAY, -1 * (2 + index)),
        reference_number: `CPAY-SEED-${RUN_STAMP}-${index + 1}`,
        invoices: [{
          invoice_id: invoiceId,
          amount_applied: total,
        }],
      });
      customerPayments.push(payment);
    } catch (error) {
      summary.errors.push({ area: 'books.customerpayments', message: summarizeErrors(error) });
    }
    await sleep(100);
  }
  summary.books.customerPayments = customerPayments.length;

  const vendorPayments = [];
  for (let index = 0; index < Math.min(DEFAULT_COUNTS.booksVendorPayments, bills.length); index += 1) {
    const bill = bills[index];
    const billId = extractBooksRecordId('bills', bill);
    const vendorId = asString(bill && (bill.vendor_id || bill.contact_id));
    const total = Number(bill && (bill.balance || bill.total || 0)) || (10000 + index * 450);
    if (!billId || !vendorId) continue;
    try {
      const payment = await createBooksRecord(session, organizationId, 'vendorpayments', {
        vendor_id: vendorId,
        payment_mode: 'banktransfer',
        amount: total,
        date: addDays(TODAY, -1 * (1 + index)),
        reference_number: `VPAY-SEED-${RUN_STAMP}-${index + 1}`,
        bills: [{
          bill_id: billId,
          amount_applied: total,
        }],
      });
      vendorPayments.push(payment);
    } catch (error) {
      summary.errors.push({ area: 'books.vendorpayments', message: summarizeErrors(error) });
    }
    await sleep(100);
  }
  summary.books.vendorPayments = vendorPayments.length;

  const bankAccounts = [];
  for (let index = 0; index < DEFAULT_COUNTS.booksBankAccounts; index += 1) {
    try {
      const account = await createBooksRecord(session, organizationId, 'bankaccounts', {
        account_name: `Seed Bank ${RUN_STAMP} ${index + 1}`,
        account_type: 'bank',
        account_number: `SB-${RUN_STAMP}-${index + 1}`.slice(0, 40),
        bank_name: 'Zoho Seed Bank',
        currency_code: currencyCode(),
        is_primary_account: index === 0,
        description: `Seed bank account ${index + 1} for imported statement testing.`,
      });
      bankAccounts.push(account);
    } catch (error) {
      summary.errors.push({ area: 'books.bankaccounts', message: summarizeErrors(error) });
    }
    await sleep(100);
  }
  summary.books.bankAccounts = bankAccounts.length;

  if (bankAccounts.length > 0) {
    const accountId = extractBooksRecordId('bankaccounts', bankAccounts[0]);
    if (accountId) {
      try {
        const rows = createStatementRows(accountId);
        const statementPayload = await importBooksStatement(session, organizationId, accountId, rows);
        summary.books.importedStatementRows = rows.length;
        summary.books.lastImportedStatement = statementPayload;
      } catch (error) {
        summary.errors.push({ area: 'books.bankstatements', message: summarizeErrors(error) });
      }
    }
  }
}

async function seedCrm(session, context, summary) {
  const accountResult = await batchCreateCrmRecords(
    session,
    'Accounts',
    Array.from({ length: DEFAULT_COUNTS.crmAccounts }).map((_, index) => createCrmAccountPayload(index)),
  );
  const accounts = accountResult.created;
  summary.crm.accounts = accounts.length;
  summary.errors.push(...accountResult.errors.map((entry) => ({ area: 'crm.accounts', message: JSON.stringify(entry).slice(0, 500) })));

  const crmContactsPayload = Array.from({ length: DEFAULT_COUNTS.crmContacts }).map((_, index) =>
    createCrmContactPayload(index, accounts[index % Math.max(1, accounts.length)] && accounts[index % Math.max(1, accounts.length)].id));
  const contactResult = await batchCreateCrmRecords(session, 'Contacts', crmContactsPayload);
  const contacts = contactResult.created;
  summary.crm.contacts = contacts.length;
  summary.errors.push(...contactResult.errors.map((entry) => ({ area: 'crm.contacts', message: JSON.stringify(entry).slice(0, 500) })));

  const leadResult = await batchCreateCrmRecords(
    session,
    'Leads',
    Array.from({ length: DEFAULT_COUNTS.crmLeads }).map((_, index) => createCrmLeadPayload(index)),
  );
  const leads = leadResult.created;
  summary.crm.leads = leads.length;
  summary.errors.push(...leadResult.errors.map((entry) => ({ area: 'crm.leads', message: JSON.stringify(entry).slice(0, 500) })));

  const dealsPayload = Array.from({ length: DEFAULT_COUNTS.crmDeals }).map((_, index) =>
    createCrmDealPayload(
      index,
      accounts[index % Math.max(1, accounts.length)] && accounts[index % Math.max(1, accounts.length)].id,
      contacts[index % Math.max(1, contacts.length)] && contacts[index % Math.max(1, contacts.length)].id,
    ));
  const dealResult = await batchCreateCrmRecords(session, 'Deals', dealsPayload);
  const deals = dealResult.created;
  summary.crm.deals = deals.length;
  summary.errors.push(...dealResult.errors.map((entry) => ({ area: 'crm.deals', message: JSON.stringify(entry).slice(0, 500) })));

  const casesPayload = Array.from({ length: DEFAULT_COUNTS.crmCases }).map((_, index) =>
    createCrmCasePayload(
      index,
      contacts[index % Math.max(1, contacts.length)] && contacts[index % Math.max(1, contacts.length)].id,
      accounts[index % Math.max(1, accounts.length)] && accounts[index % Math.max(1, accounts.length)].id,
    ));
  const caseResult = await batchCreateCrmRecords(session, 'Cases', casesPayload);
  const cases = caseResult.created;
  summary.crm.cases = cases.length;
  summary.errors.push(...caseResult.errors.map((entry) => ({ area: 'crm.cases', message: JSON.stringify(entry).slice(0, 500) })));

  const noteTargets = [
    ...deals.slice(0, 6).map((record) => ({ moduleName: 'Deals', recordId: record.id })),
    ...cases.slice(0, 4).map((record) => ({ moduleName: 'Cases', recordId: record.id })),
    ...accounts.slice(0, 3).map((record) => ({ moduleName: 'Accounts', recordId: record.id })),
  ];

  let noteCount = 0;
  for (const [index, target] of noteTargets.entries()) {
    try {
      await createCrmNote(session, target.moduleName, target.recordId, index);
      noteCount += 1;
    } catch (error) {
      summary.errors.push({ area: 'crm.notes', message: summarizeErrors(error) });
    }
    await sleep(100);
  }
  summary.crm.notes = noteCount;

  const attachmentTargets = [
    ...deals.slice(0, 4).map((record) => ({ moduleName: 'Deals', recordId: record.id })),
    ...cases.slice(0, 2).map((record) => ({ moduleName: 'Cases', recordId: record.id })),
  ];

  let attachmentCount = 0;
  for (const [index, target] of attachmentTargets.entries()) {
    try {
      await uploadCrmAttachment(session, target.moduleName, target.recordId, index);
      attachmentCount += 1;
    } catch (error) {
      summary.errors.push({ area: 'crm.attachments', message: summarizeErrors(error) });
    }
    await sleep(100);
  }
  summary.crm.attachments = attachmentCount;
}

async function runHistoricalSync(companyId, connectionId, summary) {
  if (!zohoSyncProducer || !runZohoHistoricalSyncWorker) {
    summary.postSync = {
      skipped: true,
      reason: 'Historical sync worker dist modules are unavailable in this workspace state.',
    };
    return;
  }

  try {
    const queued = await zohoSyncProducer.enqueueInitialHistoricalSync({
      companyId,
      connectionId,
      trigger: 'seed_data_script',
    });
    await runZohoHistoricalSyncWorker(companyId);

    const latestJob = await prisma.zohoSyncJob.findFirst({
      where: { companyId, jobType: 'historical' },
      orderBy: { queuedAt: 'desc' },
      select: {
        id: true,
        status: true,
        progressPercent: true,
        processedBatches: true,
        totalBatches: true,
        errorMessage: true,
        finishedAt: true,
      },
    });

    summary.postSync = {
      skipped: false,
      enqueued: queued.enqueued,
      jobId: queued.jobId,
      latestJob,
    };
  } catch (error) {
    summary.postSync = {
      skipped: false,
      error: summarizeErrors(error),
    };
  }
}

async function main() {
  console.log(`[seed] resolving target=${DEFAULT_TARGET} env=${DEFAULT_ENVIRONMENT}`);
  const target = await resolveTargetCompany(DEFAULT_TARGET);
  const connection = await loadConnection(target.companyId, DEFAULT_ENVIRONMENT);
  const session = createZohoSession({
    companyId: target.companyId,
    environment: DEFAULT_ENVIRONMENT,
    connection,
  });

  const summary = {
    target,
    environment: DEFAULT_ENVIRONMENT,
    scopes: connection.scopes,
    books: {},
    crm: {},
    errors: [],
    postSync: null,
  };

  console.log('[seed] target resolved');
  console.log(JSON.stringify({
    companyId: target.companyId,
    companyName: target.companyName,
    resolvedFrom: target.resolvedFrom,
    environment: DEFAULT_ENVIRONMENT,
    scopes: connection.scopes,
    apiDomain: session.apiBaseUrl,
  }, null, 2));

  try {
    await seedBooks(session, target, summary);
  } catch (error) {
    summary.errors.push({ area: 'books.preflight', message: summarizeErrors(error) });
  }

  try {
    await seedCrm(session, target, summary);
  } catch (error) {
    summary.errors.push({ area: 'crm.preflight', message: summarizeErrors(error) });
  }

  await runHistoricalSync(target.companyId, connection.id, summary);

  console.log('[seed] completed');
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error('[seed] failed', summarizeErrors(error));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
