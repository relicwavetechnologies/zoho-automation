#!/usr/bin/env node
/**
 * Seed realistic Zoho Books data for Relicwave Technologies.
 * Usage: node scripts/seed-zoho-data.mjs <access_token>
 */

const ACCESS_TOKEN = process.argv[2];
if (!ACCESS_TOKEN) { console.error('Usage: node seed-zoho-data.mjs <access_token>'); process.exit(1); }

const ORG_ID = '60072478024';
const BASE = 'https://www.zohoapis.in/books/v3';
const HEADERS = { 'Authorization': `Zoho-oauthtoken ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(method, path, body) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}organization_id=${ORG_ID}`;
  const opts = { method, headers: HEADERS };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (data.code !== 0 && data.code !== undefined) {
    console.error(`  FAIL ${method} ${path}: ${data.message || JSON.stringify(data)}`);
    return null;
  }
  return data;
}

// ─── Step 1: Clean existing data ─────────────────────────────────────────────
async function cleanExisting() {
  console.log('\n=== CLEANING EXISTING DATA ===');

  // Delete invoices first (they reference contacts)
  const invRes = await api('GET', '/invoices');
  for (const inv of invRes?.invoices || []) {
    if (inv.status !== 'draft') {
      await api('POST', `/invoices/${inv.invoice_id}/status/void`);
      await sleep(300);
    }
    await api('DELETE', `/invoices/${inv.invoice_id}`);
    console.log(`  Deleted invoice ${inv.invoice_number}`);
    await sleep(300);
  }

  // Delete bills
  const billRes = await api('GET', '/bills');
  for (const b of billRes?.bills || []) {
    if (b.status !== 'draft') {
      await api('POST', `/bills/${b.bill_id}/status/void`);
      await sleep(300);
    }
    await api('DELETE', `/bills/${b.bill_id}`);
    console.log(`  Deleted bill ${b.bill_number}`);
    await sleep(300);
  }

  // Delete items
  const itemRes = await api('GET', '/items');
  for (const it of itemRes?.items || []) {
    await api('DELETE', `/items/${it.item_id}`);
    console.log(`  Deleted item ${it.name}`);
    await sleep(300);
  }

  // Delete contacts
  const conRes = await api('GET', '/contacts');
  for (const c of conRes?.contacts || []) {
    await api('DELETE', `/contacts/${c.contact_id}`);
    console.log(`  Deleted contact ${c.contact_name}`);
    await sleep(300);
  }

  console.log('  Cleanup done.\n');
}

// ─── Step 2: Create Items/Services ───────────────────────────────────────────
const ITEMS = [
  { name: 'Software Development', unit: 'hrs', rate: 3500, description: 'Full-stack software development services', product_type: 'service', item_type: 'sales' },
  { name: 'UI/UX Design', unit: 'hrs', rate: 2800, description: 'User interface and experience design', product_type: 'service', item_type: 'sales' },
  { name: 'DevOps Consulting', unit: 'hrs', rate: 4000, description: 'Cloud infrastructure and CI/CD consulting', product_type: 'service', item_type: 'sales' },
  { name: 'QA & Testing', unit: 'hrs', rate: 2200, description: 'Quality assurance and automated testing', product_type: 'service', item_type: 'sales' },
  { name: 'Data Migration', unit: 'nos', rate: 75000, description: 'Database migration and ETL pipeline setup', product_type: 'service', item_type: 'sales' },
  { name: 'Training Workshop', unit: 'nos', rate: 45000, description: 'On-site technical training (per session)', product_type: 'service', item_type: 'sales' },
  { name: 'SaaS Platform License', unit: 'nos', rate: 25000, description: 'Monthly SaaS platform subscription per seat', product_type: 'service', item_type: 'sales' },
  { name: 'API Integration', unit: 'nos', rate: 120000, description: 'Third-party API integration project', product_type: 'service', item_type: 'sales' },
  { name: 'Cloud Hosting (Monthly)', unit: 'nos', rate: 18000, description: 'Managed cloud hosting — monthly', product_type: 'service', item_type: 'sales' },
  { name: 'Security Audit', unit: 'nos', rate: 95000, description: 'Comprehensive application security audit', product_type: 'service', item_type: 'sales' },
  { name: 'Technical Support', unit: 'hrs', rate: 1800, description: 'L2/L3 technical support', product_type: 'service', item_type: 'sales' },
  { name: 'Performance Optimization', unit: 'nos', rate: 85000, description: 'Application performance tuning and optimization', product_type: 'service', item_type: 'sales' },
];

// ─── Step 3: Create Contacts ─────────────────────────────────────────────────
const CUSTOMERS = [
  { name: 'Tata Consultancy Services', email: 'procurement@tcs.com', phone: '022-67789900', payment_terms: 30, city: 'Mumbai', state: 'Maharashtra' },
  { name: 'Flipkart Internet Pvt Ltd', email: 'vendor.payments@flipkart.com', phone: '080-46606600', payment_terms: 15, city: 'Bengaluru', state: 'Karnataka' },
  { name: 'Razorpay Software Pvt Ltd', email: 'finance@razorpay.com', phone: '080-46666999', payment_terms: 15, city: 'Bengaluru', state: 'Karnataka' },
  { name: 'Swiggy Pvt Ltd', email: 'accounts@swiggy.in', phone: '080-45004500', payment_terms: 30, city: 'Bengaluru', state: 'Karnataka' },
  { name: 'Paytm (One97 Communications)', email: 'vendorpay@paytm.com', phone: '0120-4770770', payment_terms: 45, city: 'Noida', state: 'Uttar Pradesh' },
  { name: 'Zerodha Broking Ltd', email: 'tech.procurement@zerodha.com', phone: '080-47181888', payment_terms: 15, city: 'Bengaluru', state: 'Karnataka' },
  { name: 'CRED (Dreamplug Technologies)', email: 'ap@cred.club', phone: '080-68aborr', payment_terms: 30, city: 'Bengaluru', state: 'Karnataka' },
  { name: 'PhonePe Pvt Ltd', email: 'vendor.finance@phonepe.com', phone: '080-68727374', payment_terms: 30, city: 'Bengaluru', state: 'Karnataka' },
  { name: 'Zomato Ltd', email: 'procurement@zomato.com', phone: '0124-4947100', payment_terms: 45, city: 'Gurugram', state: 'Haryana' },
  { name: 'Freshworks Inc (India)', email: 'ap.india@freshworks.com', phone: '044-69656965', payment_terms: 30, city: 'Chennai', state: 'Tamil Nadu' },
  { name: 'Urban Company', email: 'tech.bills@urbancompany.com', phone: '0124-6791000', payment_terms: 15, city: 'Gurugram', state: 'Haryana' },
  { name: 'Delhivery Pvt Ltd', email: 'finance@delhivery.com', phone: '0124-6225600', payment_terms: 30, city: 'Gurugram', state: 'Haryana' },
  { name: 'Meesho Inc', email: 'accounts.payable@meesho.com', phone: '080-47104710', payment_terms: 30, city: 'Bengaluru', state: 'Karnataka' },
  { name: 'Lenskart Solutions Pvt Ltd', email: 'vendor.pay@lenskart.com', phone: '0120-4029049', payment_terms: 45, city: 'Faridabad', state: 'Haryana' },
  { name: 'Ola Electric Mobility', email: 'procurement@olaelectric.com', phone: '080-48493200', payment_terms: 30, city: 'Bengaluru', state: 'Karnataka' },
];

const VENDORS = [
  { name: 'Amazon Web Services India', email: 'aws-billing@amazon.com', phone: '1800-123-4567', city: 'Mumbai', state: 'Maharashtra' },
  { name: 'Google Cloud India', email: 'cloud-billing@google.com', phone: '1800-419-0337', city: 'Hyderabad', state: 'Telangana' },
  { name: 'WeWork India Management', email: 'invoices@wework.co.in', phone: '022-71177117', city: 'Gurugram', state: 'Haryana' },
  { name: 'Figma Inc', email: 'billing@figma.com', phone: '', city: 'San Francisco', state: '' },
  { name: 'GitHub Inc', email: 'billing@github.com', phone: '', city: 'San Francisco', state: '' },
  { name: 'Slack Technologies (Salesforce)', email: 'billing@slack.com', phone: '', city: 'San Francisco', state: '' },
  { name: 'DigitalOcean LLC', email: 'billing@digitalocean.com', phone: '', city: 'New York', state: '' },
  { name: 'Priya Sharma (Freelance Designer)', email: 'priya.sharma.design@gmail.com', phone: '9876543210', city: 'Jaipur', state: 'Rajasthan' },
  { name: 'Arjun Mehta (Contract Dev)', email: 'arjun.mehta.dev@gmail.com', phone: '9123456789', city: 'Pune', state: 'Maharashtra' },
  { name: 'Staples India Office Supplies', email: 'orders@staples.in', phone: '1800-209-1515', city: 'Mumbai', state: 'Maharashtra' },
];

// ─── Step 4: Create Invoices ─────────────────────────────────────────────────
function makeInvoiceLineItems(itemMap) {
  const combos = [
    // Small project invoices
    [{ item: 'Software Development', qty: 40 }, { item: 'QA & Testing', qty: 15 }],
    [{ item: 'UI/UX Design', qty: 30 }, { item: 'Software Development', qty: 20 }],
    [{ item: 'DevOps Consulting', qty: 25 }],
    [{ item: 'Technical Support', qty: 60 }],
    [{ item: 'API Integration', qty: 1 }, { item: 'Software Development', qty: 30 }],
    // Medium project invoices
    [{ item: 'Software Development', qty: 80 }, { item: 'QA & Testing', qty: 30 }, { item: 'DevOps Consulting', qty: 15 }],
    [{ item: 'Data Migration', qty: 1 }, { item: 'Software Development', qty: 50 }],
    [{ item: 'Security Audit', qty: 1 }, { item: 'Performance Optimization', qty: 1 }],
    [{ item: 'SaaS Platform License', qty: 10 }, { item: 'Technical Support', qty: 20 }],
    [{ item: 'Training Workshop', qty: 2 }, { item: 'Software Development', qty: 15 }],
    // Large project invoices
    [{ item: 'Software Development', qty: 160 }, { item: 'UI/UX Design', qty: 60 }, { item: 'QA & Testing', qty: 50 }, { item: 'DevOps Consulting', qty: 30 }],
    [{ item: 'Cloud Hosting (Monthly)', qty: 6 }, { item: 'DevOps Consulting', qty: 40 }, { item: 'Software Development', qty: 100 }],
    [{ item: 'API Integration', qty: 2 }, { item: 'Software Development', qty: 120 }, { item: 'Security Audit', qty: 1 }],
  ];
  const chosen = combos[Math.floor(Math.random() * combos.length)];
  return chosen.map(c => ({
    item_id: itemMap[c.item],
    quantity: c.qty,
  }));
}

const INVOICE_DATES = [
  // Jan 2026
  '2026-01-05', '2026-01-12', '2026-01-22',
  // Feb 2026
  '2026-02-03', '2026-02-14', '2026-02-25',
  // Mar 2026
  '2026-03-01', '2026-03-10', '2026-03-18', '2026-03-28',
  // Apr 2026
  '2026-04-02', '2026-04-11', '2026-04-19', '2026-04-28',
  // May 2026
  '2026-05-01', '2026-05-08', '2026-05-14', '2026-05-20', '2026-05-24',
];

// ─── Step 5: Create Bills ────────────────────────────────────────────────────
const BILL_TEMPLATES = [
  { vendor: 'Amazon Web Services India', desc: 'AWS Monthly — EC2, RDS, S3, CloudFront', amounts: [42500, 48200, 51800, 45600, 53200] },
  { vendor: 'Google Cloud India', desc: 'GCP Monthly — GKE, BigQuery, Cloud Run', amounts: [28000, 31500, 29800] },
  { vendor: 'WeWork India Management', desc: 'Office space rent — Gurugram Cyber Hub (8 desks)', amounts: [185000, 185000, 185000, 185000, 185000] },
  { vendor: 'Figma Inc', desc: 'Figma Organization Plan — 6 editors', amounts: [12600] },
  { vendor: 'GitHub Inc', desc: 'GitHub Team — 12 seats', amounts: [9500] },
  { vendor: 'Slack Technologies (Salesforce)', desc: 'Slack Pro Plan — 15 users', amounts: [11200] },
  { vendor: 'DigitalOcean LLC', desc: 'DigitalOcean — staging droplets + managed DB', amounts: [8500, 9200] },
  { vendor: 'Priya Sharma (Freelance Designer)', desc: 'UI design contract — mobile app redesign', amounts: [65000, 72000] },
  { vendor: 'Arjun Mehta (Contract Dev)', desc: 'Contract development — payment gateway integration', amounts: [95000, 88000] },
  { vendor: 'Staples India Office Supplies', desc: 'Office supplies — Q1 bulk order', amounts: [15800, 12400] },
];

const BILL_DATES = [
  '2026-01-01', '2026-01-15', '2026-02-01', '2026-02-15', '2026-03-01',
  '2026-03-15', '2026-04-01', '2026-04-15', '2026-05-01', '2026-05-15',
];

// ─── Step 6: Create Expenses ─────────────────────────────────────────────────
const EXPENSES_DATA = [
  { date: '2026-01-08', amount: 12500, category: 'Travel & Conveyance', desc: 'Flight BLR→DEL — Flipkart onsite kickoff' },
  { date: '2026-01-09', amount: 8500, category: 'Travel & Conveyance', desc: 'Hotel — 2 nights Bengaluru (Flipkart meetings)' },
  { date: '2026-01-15', amount: 4200, category: 'Meals & Entertainment', desc: 'Team lunch — sprint completion celebration' },
  { date: '2026-02-05', amount: 15800, category: 'Travel & Conveyance', desc: 'Flight DEL→BOM + hotel — TCS quarterly review' },
  { date: '2026-02-14', amount: 3500, category: 'Meals & Entertainment', desc: 'Client dinner — Razorpay team at Cyber Hub' },
  { date: '2026-02-20', amount: 22000, category: 'Subscriptions', desc: 'Annual Notion workspace subscription' },
  { date: '2026-03-01', amount: 8900, category: 'Subscriptions', desc: 'Linear Pro — annual (project management)' },
  { date: '2026-03-05', amount: 5600, category: 'Office Supplies', desc: 'Ergonomic keyboards x4 — developer workstations' },
  { date: '2026-03-12', amount: 18500, category: 'Travel & Conveyance', desc: 'Flight + hotel — Chennai (Freshworks integration sprint)' },
  { date: '2026-03-15', amount: 2800, category: 'Meals & Entertainment', desc: 'Team snacks + coffee — late-night deployment' },
  { date: '2026-03-25', amount: 35000, category: 'Subscriptions', desc: 'Vercel Pro Team — annual hosting plan' },
  { date: '2026-04-02', amount: 9200, category: 'Travel & Conveyance', desc: 'Cab expenses — April client visits (Gurugram)' },
  { date: '2026-04-10', amount: 14500, category: 'Subscriptions', desc: 'Datadog monitoring — quarterly' },
  { date: '2026-04-18', amount: 6800, category: 'Office Supplies', desc: 'Monitor arms + cables — new joiner setup' },
  { date: '2026-04-25', amount: 3200, category: 'Meals & Entertainment', desc: 'Team outing — bowling + dinner' },
  { date: '2026-05-01', amount: 28000, category: 'Subscriptions', desc: '1Password Business — annual renewal (15 seats)' },
  { date: '2026-05-05', amount: 11500, category: 'Travel & Conveyance', desc: 'Flight GGN→BLR — Zerodha integration handoff' },
  { date: '2026-05-12', amount: 4500, category: 'Meals & Entertainment', desc: 'Client lunch — Zomato team at 32nd Milestone' },
  { date: '2026-05-18', amount: 7200, category: 'Office Supplies', desc: 'Whiteboard + markers — brainstorming room setup' },
  { date: '2026-05-22', amount: 19500, category: 'Subscriptions', desc: 'Sentry error tracking — 6-month plan' },
];

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Clean
  await cleanExisting();

  // 2. Create items
  console.log('=== CREATING ITEMS ===');
  const itemMap = {};
  for (const item of ITEMS) {
    const res = await api('POST', '/items', item);
    if (res?.item) {
      itemMap[item.name] = res.item.item_id;
      console.log(`  ✓ ${item.name} → ${res.item.item_id}`);
    }
    await sleep(400);
  }

  // 3. Create customers
  console.log('\n=== CREATING CUSTOMERS ===');
  const customerIds = {};
  for (const c of CUSTOMERS) {
    const res = await api('POST', '/contacts', {
      contact_name: c.name,
      contact_type: 'customer',
      email: c.email,
      phone: c.phone,
      payment_terms: c.payment_terms,
      billing_address: { city: c.city, state: c.state, country: 'India' },
    });
    if (res?.contact) {
      customerIds[c.name] = res.contact.contact_id;
      console.log(`  ✓ ${c.name}`);
    }
    await sleep(400);
  }

  // 4. Create vendors
  console.log('\n=== CREATING VENDORS ===');
  const vendorIds = {};
  for (const v of VENDORS) {
    const payload = {
      contact_name: v.name,
      contact_type: 'vendor',
      email: v.email,
      billing_address: { city: v.city, ...(v.state ? { state: v.state } : {}), country: v.state ? 'India' : 'United States' },
    };
    if (v.phone) payload.phone = v.phone;
    const res = await api('POST', '/contacts', payload);
    if (res?.contact) {
      vendorIds[v.name] = res.contact.contact_id;
      console.log(`  ✓ ${v.name}`);
    }
    await sleep(400);
  }

  // 5. Create invoices
  console.log('\n=== CREATING INVOICES ===');
  const customerNames = Object.keys(customerIds);
  const invoiceIds = [];
  for (let i = 0; i < INVOICE_DATES.length; i++) {
    const custName = customerNames[i % customerNames.length];
    const lineItems = makeInvoiceLineItems(itemMap);
    const res = await api('POST', '/invoices', {
      customer_id: customerIds[custName],
      date: INVOICE_DATES[i],
      line_items: lineItems,
    });
    if (res?.invoice) {
      invoiceIds.push({ id: res.invoice.invoice_id, date: INVOICE_DATES[i], total: res.invoice.total, custName });
      console.log(`  ✓ ${res.invoice.invoice_number} | ${custName} | ₹${res.invoice.total} | ${INVOICE_DATES[i]}`);
    }
    await sleep(500);
  }

  // 6. Mark some invoices as sent, then record payments for older ones
  console.log('\n=== UPDATING INVOICE STATUSES ===');
  for (let i = 0; i < invoiceIds.length; i++) {
    const inv = invoiceIds[i];
    // Mark as sent first
    await api('POST', `/invoices/${inv.id}/status/sent`);
    await sleep(300);

    if (i < 8) {
      // First 8: fully paid
      const payDate = inv.date.replace(/\d{2}$/, String(Math.min(28, parseInt(inv.date.slice(-2)) + 15)).padStart(2, '0'));
      await api('POST', `/customerpayments`, {
        customer_id: customerIds[inv.custName],
        date: payDate,
        amount: inv.total,
        invoices: [{ invoice_id: inv.id, amount_applied: inv.total }],
      });
      console.log(`  ✓ Paid: ${inv.custName} ₹${inv.total}`);
      await sleep(400);
    } else if (i < 12) {
      // 4 partially paid (50-70%)
      const partial = Math.round(inv.total * (0.5 + Math.random() * 0.2));
      const payDate = inv.date.replace(/\d{2}$/, String(Math.min(28, parseInt(inv.date.slice(-2)) + 10)).padStart(2, '0'));
      await api('POST', `/customerpayments`, {
        customer_id: customerIds[inv.custName],
        date: payDate,
        amount: partial,
        invoices: [{ invoice_id: inv.id, amount_applied: partial }],
      });
      console.log(`  ✓ Partial pay: ${inv.custName} ₹${partial}/${inv.total}`);
      await sleep(400);
    }
    // Rest stay as sent (overdue) or recent (open)
  }

  // 7. Create bills
  console.log('\n=== CREATING BILLS ===');
  const billIds = [];
  let billDateIdx = 0;
  for (const tmpl of BILL_TEMPLATES) {
    for (const amt of tmpl.amounts) {
      if (billDateIdx >= BILL_DATES.length) break;
      const vendorId = vendorIds[tmpl.vendor];
      if (!vendorId) { console.log(`  SKIP: vendor ${tmpl.vendor} not found`); continue; }
      const res = await api('POST', '/bills', {
        vendor_id: vendorId,
        bill_number: `BILL-${String(billDateIdx + 1).padStart(4, '0')}`,
        date: BILL_DATES[billDateIdx],
        due_date: BILL_DATES[billDateIdx].replace(/\d{2}$/, '28'),
        line_items: [{ description: tmpl.desc, rate: amt, quantity: 1 }],
      });
      if (res?.bill) {
        billIds.push({ id: res.bill.bill_id, total: res.bill.total, vendor: tmpl.vendor, date: BILL_DATES[billDateIdx] });
        console.log(`  ✓ ${tmpl.vendor} | ₹${amt} | ${BILL_DATES[billDateIdx]}`);
      }
      billDateIdx++;
      await sleep(500);
    }
  }

  // 8. Pay some bills
  console.log('\n=== PAYING BILLS ===');
  for (let i = 0; i < Math.min(6, billIds.length); i++) {
    const bill = billIds[i];
    // Find a bank account to pay from
    const acctRes = await api('GET', '/bankaccounts');
    const bankAcct = acctRes?.bankaccounts?.[0];
    if (!bankAcct) { console.log('  No bank account found, skipping bill payments'); break; }

    await api('POST', '/vendorpayments', {
      vendor_id: vendorIds[bill.vendor],
      date: bill.date.replace(/\d{2}$/, '25'),
      amount: bill.total,
      paid_through_account_id: bankAcct.account_id,
      bills: [{ bill_id: bill.id, amount_applied: bill.total }],
    });
    console.log(`  ✓ Paid: ${bill.vendor} ₹${bill.total}`);
    await sleep(400);
  }

  // 9. Create expenses
  console.log('\n=== CREATING EXPENSES ===');
  // Get chart of accounts for expense categories
  const coaRes = await api('GET', '/chartofaccounts');
  const expenseAccounts = {};
  for (const acct of coaRes?.chartofaccounts || []) {
    if (acct.account_type === 'expense') {
      expenseAccounts[acct.account_name] = acct.account_id;
    }
  }
  // Map our categories to Zoho account names
  const categoryMap = {
    'Travel & Conveyance': expenseAccounts['Travel & Conveyance'] || expenseAccounts['Travel Expenses'] || Object.values(expenseAccounts)[0],
    'Meals & Entertainment': expenseAccounts['Meals & Entertainment'] || expenseAccounts['Meals and Entertainment'] || Object.values(expenseAccounts)[1],
    'Subscriptions': expenseAccounts['IT and Internet Expenses'] || expenseAccounts['Software Subscriptions'] || Object.values(expenseAccounts)[2],
    'Office Supplies': expenseAccounts['Office Supplies'] || expenseAccounts['Office Expenses'] || Object.values(expenseAccounts)[3],
  };

  for (const exp of EXPENSES_DATA) {
    const accountId = categoryMap[exp.category];
    if (!accountId) { console.log(`  SKIP: no account for ${exp.category}`); continue; }
    const res = await api('POST', '/expenses', {
      date: exp.date,
      amount: exp.amount,
      account_id: accountId,
      description: exp.desc,
      is_billable: false,
    });
    if (res?.expense) {
      console.log(`  ✓ ${exp.date} | ₹${exp.amount} | ${exp.desc.substring(0, 50)}`);
    }
    await sleep(400);
  }

  console.log('\n=== SEEDING COMPLETE ===');
  console.log(`Items: ${Object.keys(itemMap).length}`);
  console.log(`Customers: ${Object.keys(customerIds).length}`);
  console.log(`Vendors: ${Object.keys(vendorIds).length}`);
  console.log(`Invoices: ${invoiceIds.length}`);
  console.log(`Bills: ${billIds.length}`);
  console.log(`Expenses: ${EXPENSES_DATA.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
