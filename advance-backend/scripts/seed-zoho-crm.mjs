#!/usr/bin/env node
/**
 * Seed realistic Zoho CRM data for Relicwave Technologies.
 * Creates Accounts (matching Books customers), Contacts, Deals, Leads, Tasks, Notes, Events.
 * Usage: node scripts/seed-zoho-crm.mjs <access_token>
 */

const TOKEN = process.argv[2];
if (!TOKEN) { console.error('Usage: node seed-zoho-crm.mjs <access_token>'); process.exit(1); }

const BASE = 'https://www.zohoapis.in/crm/v2';
const HEADERS = { 'Authorization': `Zoho-oauthtoken ${TOKEN}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: HEADERS, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json();
  if (data.data?.[0]?.code === 'DUPLICATE_DATA' || data.data?.[0]?.status === 'error') {
    console.error(`  FAIL ${path}: ${data.data[0].message}`);
    return null;
  }
  return data;
}

// ─── Step 1: Clean sample data ───────────────────────────────────────────────
async function cleanSampleData() {
  console.log('\n=== CLEANING SAMPLE DATA ===');
  for (const mod of ['Deals', 'Contacts', 'Accounts', 'Leads']) {
    const res = await api('GET', `/${mod}?per_page=200`);
    const ids = (res?.data || []).map(r => r.id);
    if (ids.length) {
      await api('DELETE', `/${mod}?ids=${ids.join(',')}`);
      console.log(`  Deleted ${ids.length} ${mod}`);
    }
    await sleep(300);
  }
  console.log('  Done.\n');
}

// ─── Accounts (matching Books customers + vendors) ───────────────────────────
const ACCOUNTS = [
  // Customers (active clients — match Zoho Books)
  { Account_Name: 'Tata Consultancy Services', Industry: 'Technology', Account_Type: 'Customer', Phone: '022-67789900', Website: 'https://www.tcs.com', Billing_City: 'Mumbai', Billing_State: 'Maharashtra', Billing_Country: 'India', Annual_Revenue: 220000000000, Employees: 600000, Description: 'India\'s largest IT services company. Long-term dev partnership since 2024.' },
  { Account_Name: 'Flipkart Internet Pvt Ltd', Industry: 'Retail', Account_Type: 'Customer', Phone: '080-46606600', Website: 'https://www.flipkart.com', Billing_City: 'Bengaluru', Billing_State: 'Karnataka', Billing_Country: 'India', Annual_Revenue: 50000000000, Employees: 30000, Description: 'E-commerce giant. We handle their internal tools and checkout microservices.' },
  { Account_Name: 'Razorpay Software Pvt Ltd', Industry: 'Finance', Account_Type: 'Customer', Phone: '080-46666999', Website: 'https://razorpay.com', Billing_City: 'Bengaluru', Billing_State: 'Karnataka', Billing_Country: 'India', Annual_Revenue: 2000000000, Employees: 3000, Description: 'Payment gateway leader. API integration + security audit contract.' },
  { Account_Name: 'Swiggy Pvt Ltd', Industry: 'Food & Beverage', Account_Type: 'Customer', Phone: '080-45004500', Website: 'https://www.swiggy.com', Billing_City: 'Bengaluru', Billing_State: 'Karnataka', Billing_Country: 'India', Annual_Revenue: 8000000000, Employees: 5000, Description: 'Food delivery platform. Backend optimization + DevOps consulting.' },
  { Account_Name: 'Paytm (One97 Communications)', Industry: 'Finance', Account_Type: 'Customer', Phone: '0120-4770770', Website: 'https://paytm.com', Billing_City: 'Noida', Billing_State: 'Uttar Pradesh', Billing_Country: 'India', Annual_Revenue: 7800000000, Employees: 9000, Description: 'Digital payments & financial services. Long payment cycles (Net 45).' },
  { Account_Name: 'Zerodha Broking Ltd', Industry: 'Finance', Account_Type: 'Customer', Phone: '080-47181888', Website: 'https://zerodha.com', Billing_City: 'Bengaluru', Billing_State: 'Karnataka', Billing_Country: 'India', Annual_Revenue: 4000000000, Employees: 1500, Description: 'India\'s largest retail stockbroker. Trading platform engineering.' },
  { Account_Name: 'CRED (Dreamplug Technologies)', Industry: 'Finance', Account_Type: 'Customer', Phone: '080-68000000', Website: 'https://cred.club', Billing_City: 'Bengaluru', Billing_State: 'Karnataka', Billing_Country: 'India', Annual_Revenue: 1500000000, Employees: 800, Description: 'Credit card rewards platform. Mobile app backend development.' },
  { Account_Name: 'PhonePe Pvt Ltd', Industry: 'Finance', Account_Type: 'Customer', Phone: '080-68727374', Website: 'https://phonepe.com', Billing_City: 'Bengaluru', Billing_State: 'Karnataka', Billing_Country: 'India', Annual_Revenue: 3200000000, Employees: 6000, Description: 'UPI payments leader. Performance optimization project.' },
  { Account_Name: 'Zomato Ltd', Industry: 'Food & Beverage', Account_Type: 'Customer', Phone: '0124-4947100', Website: 'https://zomato.com', Billing_City: 'Gurugram', Billing_State: 'Haryana', Billing_Country: 'India', Annual_Revenue: 12000000000, Employees: 4000, Description: 'Food delivery + Blinkit. Data migration + SaaS licensing deal.' },
  { Account_Name: 'Freshworks Inc (India)', Industry: 'Technology', Account_Type: 'Customer', Phone: '044-69656965', Website: 'https://freshworks.com', Billing_City: 'Chennai', Billing_State: 'Tamil Nadu', Billing_Country: 'India', Annual_Revenue: 5600000000, Employees: 5500, Description: 'SaaS CRM/ITSM provider. Integration consulting engagement.' },
  { Account_Name: 'Urban Company', Industry: 'Services', Account_Type: 'Customer', Phone: '0124-6791000', Website: 'https://urbancompany.com', Billing_City: 'Gurugram', Billing_State: 'Haryana', Billing_Country: 'India', Annual_Revenue: 1800000000, Employees: 2500, Description: 'Home services marketplace. Cloud hosting + DevOps.' },
  { Account_Name: 'Delhivery Pvt Ltd', Industry: 'Logistics', Account_Type: 'Customer', Phone: '0124-6225600', Website: 'https://delhivery.com', Billing_City: 'Gurugram', Billing_State: 'Haryana', Billing_Country: 'India', Annual_Revenue: 7500000000, Employees: 25000, Description: 'Logistics & supply chain. Route optimization + API work.' },
  { Account_Name: 'Meesho Inc', Industry: 'Retail', Account_Type: 'Customer', Phone: '080-47104710', Website: 'https://meesho.com', Billing_City: 'Bengaluru', Billing_State: 'Karnataka', Billing_Country: 'India', Annual_Revenue: 3000000000, Employees: 2000, Description: 'Social commerce platform. QA automation + training workshops.' },
  { Account_Name: 'Lenskart Solutions Pvt Ltd', Industry: 'Retail', Account_Type: 'Customer', Phone: '0120-4029049', Website: 'https://lenskart.com', Billing_City: 'Faridabad', Billing_State: 'Haryana', Billing_Country: 'India', Annual_Revenue: 4500000000, Employees: 10000, Description: 'Eyewear D2C brand. Full-stack dev for AR try-on feature.' },
  { Account_Name: 'Ola Electric Mobility', Industry: 'Automotive', Account_Type: 'Customer', Phone: '080-48493200', Website: 'https://olaelectric.com', Billing_City: 'Bengaluru', Billing_State: 'Karnataka', Billing_Country: 'India', Annual_Revenue: 5200000000, Employees: 3500, Description: 'EV manufacturer. IoT dashboard + cloud infrastructure.' },
  // Vendors
  { Account_Name: 'Amazon Web Services India', Industry: 'Technology', Account_Type: 'Vendor', Phone: '1800-123-4567', Website: 'https://aws.amazon.com', Billing_City: 'Mumbai', Billing_State: 'Maharashtra', Billing_Country: 'India', Description: 'Primary cloud provider — EC2, RDS, S3, CloudFront.' },
  { Account_Name: 'Google Cloud India', Industry: 'Technology', Account_Type: 'Vendor', Phone: '1800-419-0337', Website: 'https://cloud.google.com', Billing_City: 'Hyderabad', Billing_State: 'Telangana', Billing_Country: 'India', Description: 'Secondary cloud — GKE, BigQuery, Cloud Run for ML workloads.' },
  { Account_Name: 'WeWork India Management', Industry: 'Real Estate', Account_Type: 'Vendor', Phone: '022-71177117', Website: 'https://wework.co.in', Billing_City: 'Gurugram', Billing_State: 'Haryana', Billing_Country: 'India', Description: 'Office space — Cyber Hub, 8 desks, monthly lease.' },
];

// ─── Contacts (1-2 per account — real Indian names + titles) ─────────────────
const CONTACTS_MAP = {
  'Tata Consultancy Services': [
    { First_Name: 'Rajesh', Last_Name: 'Krishnamurthy', Title: 'VP — Technology Partnerships', Email: 'rajesh.k@tcs.com', Phone: '9820012345', Department: 'Technology' },
    { First_Name: 'Sneha', Last_Name: 'Iyer', Title: 'Senior Manager — Vendor Management', Email: 'sneha.iyer@tcs.com', Phone: '9820012346', Department: 'Procurement' },
  ],
  'Flipkart Internet Pvt Ltd': [
    { First_Name: 'Arun', Last_Name: 'Sundaram', Title: 'Director of Engineering', Email: 'arun.s@flipkart.com', Phone: '9845012345', Department: 'Engineering' },
    { First_Name: 'Kavita', Last_Name: 'Reddy', Title: 'Engineering Manager — Checkout', Email: 'kavita.r@flipkart.com', Phone: '9845012346', Department: 'Engineering' },
  ],
  'Razorpay Software Pvt Ltd': [
    { First_Name: 'Harshil', Last_Name: 'Mathur', Title: 'Head of Platform', Email: 'harshil@razorpay.com', Phone: '9886012345', Department: 'Platform' },
  ],
  'Swiggy Pvt Ltd': [
    { First_Name: 'Vikram', Last_Name: 'Tangri', Title: 'VP Engineering', Email: 'vikram.t@swiggy.in', Phone: '9900012345', Department: 'Engineering' },
    { First_Name: 'Pooja', Last_Name: 'Sharma', Title: 'Lead — DevOps', Email: 'pooja.s@swiggy.in', Phone: '9900012346', Department: 'DevOps' },
  ],
  'Paytm (One97 Communications)': [
    { First_Name: 'Amit', Last_Name: 'Khare', Title: 'AVP — Technology', Email: 'amit.khare@paytm.com', Phone: '9971012345', Department: 'Technology' },
  ],
  'Zerodha Broking Ltd': [
    { First_Name: 'Kailash', Last_Name: 'Nadh', Title: 'CTO', Email: 'kailash@zerodha.com', Phone: '9880012345', Department: 'Technology' },
  ],
  'CRED (Dreamplug Technologies)': [
    { First_Name: 'Gaurav', Last_Name: 'Gupta', Title: 'Senior Engineering Manager', Email: 'gaurav.g@cred.club', Phone: '9845112345', Department: 'Engineering' },
  ],
  'PhonePe Pvt Ltd': [
    { First_Name: 'Rahul', Last_Name: 'Chari', Title: 'CTO', Email: 'rahul.c@phonepe.com', Phone: '9845212345', Department: 'Technology' },
    { First_Name: 'Nisha', Last_Name: 'Banerjee', Title: 'Lead — Performance Engineering', Email: 'nisha.b@phonepe.com', Phone: '9845212346', Department: 'Engineering' },
  ],
  'Zomato Ltd': [
    { First_Name: 'Gunjan', Last_Name: 'Patidar', Title: 'CTO', Email: 'gunjan.p@zomato.com', Phone: '9812012345', Department: 'Technology' },
  ],
  'Freshworks Inc (India)': [
    { First_Name: 'Muthu', Last_Name: 'Ramalingam', Title: 'VP Engineering', Email: 'muthu.r@freshworks.com', Phone: '9444012345', Department: 'Engineering' },
  ],
  'Urban Company': [
    { First_Name: 'Siddharth', Last_Name: 'Jain', Title: 'Head of Infrastructure', Email: 'sid.j@urbancompany.com', Phone: '9811012345', Department: 'Infrastructure' },
  ],
  'Delhivery Pvt Ltd': [
    { First_Name: 'Kapil', Last_Name: 'Bharati', Title: 'VP — Technology', Email: 'kapil.b@delhivery.com', Phone: '9810012345', Department: 'Technology' },
  ],
  'Meesho Inc': [
    { First_Name: 'Sanjeev', Last_Name: 'Barnwal', Title: 'CTO', Email: 'sanjeev.b@meesho.com', Phone: '9845312345', Department: 'Technology' },
  ],
  'Lenskart Solutions Pvt Ltd': [
    { First_Name: 'Ramneek', Last_Name: 'Khurana', Title: 'VP — Digital', Email: 'ramneek.k@lenskart.com', Phone: '9811112345', Department: 'Digital' },
  ],
  'Ola Electric Mobility': [
    { First_Name: 'Ankit', Last_Name: 'Jain', Title: 'Head of Connected Vehicles', Email: 'ankit.j@olaelectric.com', Phone: '9845412345', Department: 'IoT' },
  ],
};

// ─── Deals (various stages — connected to accounts) ──────────────────────────
const DEALS = [
  // Closed Won (match Books invoices)
  { Deal_Name: 'TCS — Enterprise Platform Buildout FY26', Stage: 'Closed Won', Amount: 4060000, Closing_Date: '2026-01-20', account: 'Tata Consultancy Services', Description: 'Full-stack platform development — 160 hrs dev + 60 hrs design + 50 hrs QA + 30 hrs DevOps. Invoiced and paid.' },
  { Deal_Name: 'Flipkart — Checkout Microservices Overhaul', Stage: 'Closed Won', Amount: 9580000, Closing_Date: '2026-01-27', account: 'Flipkart Internet Pvt Ltd', Description: 'Complete rewrite of checkout backend. Largest single contract in FY26.' },
  { Deal_Name: 'Razorpay — Security Audit + API Integration', Stage: 'Closed Won', Amount: 1080000, Closing_Date: '2026-02-06', account: 'Razorpay Software Pvt Ltd', Description: 'Comprehensive security audit and API integration package.' },
  { Deal_Name: 'Swiggy — Backend Performance Optimization', Stage: 'Closed Won', Amount: 6180000, Closing_Date: '2026-02-18', account: 'Swiggy Pvt Ltd', Description: 'DevOps consulting + software dev for backend optimization.' },
  { Deal_Name: 'Zerodha — Trading Platform Engineering', Stage: 'Closed Won', Amount: 2860000, Closing_Date: '2026-03-12', account: 'Zerodha Broking Ltd', Description: 'High-frequency trading module development and optimization.' },
  { Deal_Name: 'CRED — Mobile Backend Sprint', Stage: 'Closed Won', Amount: 2250000, Closing_Date: '2026-03-16', account: 'CRED (Dreamplug Technologies)', Description: 'Mobile app backend API development — 3 month sprint.' },
  { Deal_Name: 'PhonePe — Performance Tuning Project', Stage: 'Closed Won', Amount: 2500000, Closing_Date: '2026-03-25', account: 'PhonePe Pvt Ltd', Description: 'Application performance tuning + SaaS license deployment.' },
  { Deal_Name: 'Paytm — Cloud Migration Phase 1', Stage: 'Closed Won', Amount: 2860000, Closing_Date: '2026-03-01', account: 'Paytm (One97 Communications)', Description: 'Cloud hosting migration + DevOps consulting. Net 45 payment.' },

  // In progress (various pipeline stages)
  { Deal_Name: 'Zomato — Data Migration + SaaS Licensing', Stage: 'Negotiation/Review', Amount: 3500000, Closing_Date: '2026-06-30', account: 'Zomato Ltd', Description: 'Database migration + 10-seat SaaS platform license. Partially paid, negotiating expansion.' },
  { Deal_Name: 'Urban Company — Cloud Infrastructure Revamp', Stage: 'Proposal/Price Quote', Amount: 1800000, Closing_Date: '2026-07-15', account: 'Urban Company', Description: 'Cloud hosting migration + DevOps consulting. Proposal sent.' },
  { Deal_Name: 'Freshworks — Integration Consulting Q3', Stage: 'Proposal/Price Quote', Amount: 2200000, Closing_Date: '2026-07-30', account: 'Freshworks Inc (India)', Description: 'API integration + custom connector development for Freshworks platform.' },
  { Deal_Name: 'Delhivery — Route Optimization AI', Stage: 'Id. Decision Makers', Amount: 4500000, Closing_Date: '2026-08-15', account: 'Delhivery Pvt Ltd', Description: 'ML-based route optimization + API integration with existing logistics stack.' },
  { Deal_Name: 'Meesho — QA Automation Framework', Stage: 'Value Proposition', Amount: 1540000, Closing_Date: '2026-08-30', account: 'Meesho Inc', Description: 'Automated testing framework + training workshops for internal team.' },
  { Deal_Name: 'Lenskart — AR Try-On Feature Dev', Stage: 'Needs Analysis', Amount: 6000000, Closing_Date: '2026-09-30', account: 'Lenskart Solutions Pvt Ltd', Description: 'Full-stack development for AR virtual try-on feature. Requirements being gathered.' },
  { Deal_Name: 'Ola Electric — IoT Dashboard v2', Stage: 'Qualification', Amount: 3200000, Closing_Date: '2026-10-15', account: 'Ola Electric Mobility', Description: 'Next-gen connected vehicle dashboard. Early stage — qualifying budget and timeline.' },

  // Renewals / Expansions
  { Deal_Name: 'TCS — Platform Maintenance FY26-Q3', Stage: 'Negotiation/Review', Amount: 1800000, Closing_Date: '2026-06-15', account: 'Tata Consultancy Services', Description: 'Renewal of ongoing maintenance + support hours for FY26 Q3.' },
  { Deal_Name: 'Flipkart — Phase 2 Expansion', Stage: 'Proposal/Price Quote', Amount: 4200000, Closing_Date: '2026-07-01', account: 'Flipkart Internet Pvt Ltd', Description: 'Expanding checkout microservices to handle international payments.' },

  // Closed Lost
  { Deal_Name: 'Swiggy — Mobile App Redesign', Stage: 'Closed Lost', Amount: 3800000, Closing_Date: '2026-04-10', account: 'Swiggy Pvt Ltd', Description: 'Lost to in-house team decision. They chose to build internally.' },
  { Deal_Name: 'PhonePe — Fraud Detection Module', Stage: 'Closed Lost to Competition', Amount: 5500000, Closing_Date: '2026-03-28', account: 'PhonePe Pvt Ltd', Description: 'Lost to Fractal Analytics. Price was competitive but they preferred domain expertise.' },
];

// ─── Leads (unconverted prospects) ───────────────────────────────────────────
const LEADS = [
  { First_Name: 'Priya', Last_Name: 'Chandrasekaran', Company: 'Groww', Title: 'Head of Engineering', Email: 'priya.c@groww.in', Phone: '9845512345', Lead_Source: 'Web Research', City: 'Bengaluru', State: 'Karnataka', Country: 'India', Industry: 'Finance', Description: 'Investment platform — interested in trading engine development. Inbound via website.' },
  { First_Name: 'Nikhil', Last_Name: 'Agarwal', Company: 'Jupiter Money', Title: 'CTO', Email: 'nikhil.a@jupiter.money', Phone: '9820112345', Lead_Source: 'Cold Call', City: 'Mumbai', State: 'Maharashtra', Country: 'India', Industry: 'Finance', Description: 'Neobanking app. Cold call follow-up, interested in API integration services.' },
  { First_Name: 'Deepa', Last_Name: 'Menon', Company: 'Byju\'s (Think & Learn)', Title: 'VP Engineering', Email: 'deepa.m@byjus.com', Phone: '9845612345', Lead_Source: 'Employee Referral', City: 'Bengaluru', State: 'Karnataka', Country: 'India', Industry: 'Education', Description: 'EdTech giant. Referral from Arun at Flipkart. Looking for performance optimization.' },
  { First_Name: 'Arjun', Last_Name: 'Menon', Company: 'Nykaa', Title: 'Director of Technology', Email: 'arjun.m@nykaa.com', Phone: '9821112345', Lead_Source: 'Partner', City: 'Mumbai', State: 'Maharashtra', Country: 'India', Industry: 'Retail', Description: 'Beauty e-commerce. Partner referral from AWS. Interested in cloud migration.' },
  { First_Name: 'Ritu', Last_Name: 'Kapur', Company: 'PolicyBazaar', Title: 'Head of Data Engineering', Email: 'ritu.k@policybazaar.com', Phone: '9811212345', Lead_Source: 'Web Research', City: 'Gurugram', State: 'Haryana', Country: 'India', Industry: 'Insurance', Description: 'Insurance marketplace. Needs data pipeline + ETL setup for analytics modernization.' },
  { First_Name: 'Sameer', Last_Name: 'Gupta', Company: 'Cars24', Title: 'CTO', Email: 'sameer.g@cars24.com', Phone: '9810112345', Lead_Source: 'Trade Show', City: 'Gurugram', State: 'Haryana', Country: 'India', Industry: 'Automotive', Description: 'Used car marketplace. Met at TechSparks 2026. Interested in ML-based pricing engine.' },
  { First_Name: 'Ananya', Last_Name: 'Birla', Company: 'Vedantu', Title: 'VP Product Engineering', Email: 'ananya.b@vedantu.com', Phone: '9845712345', Lead_Source: 'Seminar Partner', City: 'Bengaluru', State: 'Karnataka', Country: 'India', Industry: 'Education', Description: 'Live tutoring platform. Met at GDG DevFest. Video infrastructure consulting.' },
  { First_Name: 'Mohit', Last_Name: 'Jain', Company: 'Spinny', Title: 'Engineering Manager', Email: 'mohit.j@spinny.com', Phone: '9811312345', Lead_Source: 'External Referral', City: 'Gurugram', State: 'Haryana', Country: 'India', Industry: 'Automotive', Description: 'Full-stack used car marketplace. Referred by Delhivery. Mobile app development.' },
  { First_Name: 'Shruti', Last_Name: 'Rajan', Company: 'Simplilearn', Title: 'Head of Platform', Email: 'shruti.r@simplilearn.com', Phone: '9845812345', Lead_Source: 'Web Download', City: 'Bengaluru', State: 'Karnataka', Country: 'India', Industry: 'Education', Description: 'Online certification platform. Downloaded our case study. LMS integration consulting.' },
  { First_Name: 'Varun', Last_Name: 'Khaitan', Company: 'Urban Ladder (Reliance Retail)', Title: 'Tech Lead', Email: 'varun.k@urbanladder.com', Phone: '9845912345', Lead_Source: 'Facebook', City: 'Bengaluru', State: 'Karnataka', Country: 'India', Industry: 'Retail', Description: 'Furniture e-commerce. Responded to LinkedIn campaign. AR visualization interest.' },
  { First_Name: 'Kabir', Last_Name: 'Suri', Company: 'GoMechanic', Title: 'CTO', Email: 'kabir.s@gomechanic.com', Phone: '9811412345', Lead_Source: 'Cold Call', City: 'Gurugram', State: 'Haryana', Country: 'India', Industry: 'Automotive', Description: 'Auto service marketplace. Cold outreach — interested in booking engine rewrite.' },
  { First_Name: 'Tanvi', Last_Name: 'Shah', Company: 'HealthifyMe', Title: 'Director of Engineering', Email: 'tanvi.s@healthifyme.com', Phone: '9845013456', Lead_Source: 'Employee Referral', City: 'Bengaluru', State: 'Karnataka', Country: 'India', Industry: 'Healthcare', Description: 'Health & fitness app. Internal referral. AI meal tracking feature development.' },
];

// ─── Tasks (linked to deals/contacts) ────────────────────────────────────────
const TASKS_DATA = [
  { Subject: 'Send revised SOW to TCS', Status: 'Completed', Priority: 'High', Due_Date: '2026-05-20', Description: 'Send updated scope of work for Q3 maintenance renewal. Include new rate card.', deal: 'TCS — Platform Maintenance FY26-Q3' },
  { Subject: 'Schedule demo for Delhivery route optimization', Status: 'Not Started', Priority: 'High', Due_Date: '2026-06-02', Description: 'Book 1-hour demo slot with Kapil and logistics team to showcase ML prototype.', deal: 'Delhivery — Route Optimization AI' },
  { Subject: 'Follow up on Flipkart Phase 2 pricing', Status: 'In Progress', Priority: 'High', Due_Date: '2026-05-28', Description: 'Arun requested itemized pricing breakdown for international payments module.', deal: 'Flipkart — Phase 2 Expansion' },
  { Subject: 'Prepare case study for Lenskart pitch', Status: 'Not Started', Priority: 'Normal', Due_Date: '2026-06-05', Description: 'Create AR/VR case study based on our Flipkart work to share during needs analysis.', deal: 'Lenskart — AR Try-On Feature Dev' },
  { Subject: 'Send cold email sequence to Groww', Status: 'In Progress', Priority: 'Normal', Due_Date: '2026-05-30', Description: 'Priya showed interest — send 3-email nurture sequence with fintech portfolio.', lead: 'Groww' },
  { Subject: 'Review Meesho QA automation proposal', Status: 'Completed', Priority: 'Normal', Due_Date: '2026-05-22', Description: 'Final review of testing framework proposal before sending to Sanjeev.', deal: 'Meesho — QA Automation Framework' },
  { Subject: 'Internal sync — Ola Electric IoT scope', Status: 'Not Started', Priority: 'Normal', Due_Date: '2026-06-01', Description: 'Align with backend team on IoT dashboard architecture before qualification call.', deal: 'Ola Electric — IoT Dashboard v2' },
  { Subject: 'Collect testimonial from Zerodha', Status: 'Not Started', Priority: 'Low', Due_Date: '2026-06-10', Description: 'Request written testimonial from Kailash for website. Project completed successfully.', deal: 'Zerodha — Trading Platform Engineering' },
  { Subject: 'Renew NDA with PhonePe', Status: 'In Progress', Priority: 'Normal', Due_Date: '2026-06-15', Description: 'Current NDA expires July 1. Legal team drafting renewal — need Rahul\'s sign-off.', account: 'PhonePe Pvt Ltd' },
  { Subject: 'Post-mortem: Swiggy lost deal', Status: 'Completed', Priority: 'Low', Due_Date: '2026-04-15', Description: 'Document lessons from lost Swiggy mobile redesign deal. Share with sales team.', deal: 'Swiggy — Mobile App Redesign' },
  { Subject: 'Schedule intro call with PolicyBazaar', Status: 'Not Started', Priority: 'High', Due_Date: '2026-05-29', Description: 'Ritu responded to outreach email. Schedule 30-min discovery call.', lead: 'PolicyBazaar' },
  { Subject: 'Prepare Zomato expansion pitch', Status: 'In Progress', Priority: 'High', Due_Date: '2026-06-03', Description: 'Build pitch deck for expanding data migration scope + additional SaaS seats.', deal: 'Zomato — Data Migration + SaaS Licensing' },
];

// ─── Notes (deal/account context) ────────────────────────────────────────────
const NOTES_DATA = [
  { Note_Title: 'TCS Q3 Renewal — Pricing Discussion', Note_Content: 'Rajesh mentioned TCS is tightening vendor budgets for H2. We may need to offer 10% discount on maintenance hours to retain. Sneha (procurement) is the decision gate — make sure proposal goes through her.\n\nAction: Prepare tiered pricing (standard vs. premium support).', account: 'Tata Consultancy Services' },
  { Note_Title: 'Flipkart Phase 2 — Technical Requirements', Note_Content: 'Arun shared that international payments module needs:\n- Multi-currency support (USD, EUR, GBP, AED)\n- PCI DSS Level 1 compliance\n- Sub-200ms latency on payment gateway calls\n- Integration with Adyen and Stripe\n\nEstimate: 120 hrs dev + 40 hrs QA + 20 hrs DevOps.', account: 'Flipkart Internet Pvt Ltd' },
  { Note_Title: 'Razorpay Security Audit — Post-Delivery Feedback', Note_Content: 'Harshil was very happy with the security audit deliverables. Found 3 critical vulnerabilities that their internal team missed. This positions us well for future security consulting.\n\nFollow-up: Propose quarterly security review retainer.', account: 'Razorpay Software Pvt Ltd' },
  { Note_Title: 'PhonePe Lost Deal Analysis', Note_Content: 'Lost the fraud detection module to Fractal Analytics. Key factors:\n1. Fractal had specific banking fraud domain expertise\n2. Their team had ex-RBI analysts\n3. Our price was actually lower but domain expertise mattered more\n\nLesson: For fraud/compliance deals, consider partnering with a domain specialist.', account: 'PhonePe Pvt Ltd' },
  { Note_Title: 'Zomato — Gunjan Meeting Notes (May 15)', Note_Content: 'Met Gunjan at Cyber Hub office. Key takeaways:\n- They want to migrate 4 legacy MySQL databases to Postgres\n- Blinkit team also interested in our SaaS platform for ops tooling\n- Budget approved for Q2, but they need a formal SOW by June end\n- Gunjan will introduce us to Blinkit CTO next week\n\nNext step: Prepare SOW with phased migration timeline.', account: 'Zomato Ltd' },
  { Note_Title: 'Delhivery — Competitive Intelligence', Note_Content: 'Kapil mentioned they evaluated Fractal and Mu Sigma for the route optimization project. Both quoted 2x our price but had more ML team depth. Our edge: full-stack capability (ML + API + deployment) in one team.\n\nImportant: They want a PoC with 2 cities before committing to full project.', account: 'Delhivery Pvt Ltd' },
];

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  await cleanSampleData();

  // 1. Create Accounts
  console.log('=== CREATING ACCOUNTS ===');
  const accountIds = {};
  for (const acct of ACCOUNTS) {
    const res = await api('POST', '/Accounts', { data: [acct] });
    if (res?.data?.[0]?.details?.id) {
      accountIds[acct.Account_Name] = res.data[0].details.id;
      console.log(`  ✓ ${acct.Account_Name} (${acct.Account_Type})`);
    }
    await sleep(300);
  }

  // 2. Create Contacts (linked to accounts)
  console.log('\n=== CREATING CONTACTS ===');
  const contactIds = {};
  for (const [acctName, contacts] of Object.entries(CONTACTS_MAP)) {
    for (const c of contacts) {
      const payload = { ...c, Account_Name: { id: accountIds[acctName] } };
      const res = await api('POST', '/Contacts', { data: [payload] });
      if (res?.data?.[0]?.details?.id) {
        contactIds[`${c.First_Name} ${c.Last_Name}`] = res.data[0].details.id;
        console.log(`  ✓ ${c.First_Name} ${c.Last_Name} @ ${acctName}`);
      }
      await sleep(300);
    }
  }

  // 3. Create Deals (linked to accounts)
  console.log('\n=== CREATING DEALS ===');
  const dealIds = {};
  for (const d of DEALS) {
    const payload = {
      Deal_Name: d.Deal_Name,
      Stage: d.Stage,
      Amount: d.Amount,
      Closing_Date: d.Closing_Date,
      Description: d.Description,
      ...(accountIds[d.account] ? { Account_Name: { id: accountIds[d.account] } } : {}),
    };
    const res = await api('POST', '/Deals', { data: [payload] });
    if (res?.data?.[0]?.details?.id) {
      dealIds[d.Deal_Name] = res.data[0].details.id;
      console.log(`  ✓ ${d.Stage.padEnd(28)} | ₹${(d.Amount/100000).toFixed(1)}L | ${d.Deal_Name.slice(0, 50)}`);
    }
    await sleep(300);
  }

  // 4. Create Leads
  console.log('\n=== CREATING LEADS ===');
  for (const lead of LEADS) {
    const res = await api('POST', '/Leads', { data: [lead] });
    if (res?.data?.[0]?.details?.id) {
      console.log(`  ✓ ${lead.First_Name} ${lead.Last_Name} @ ${lead.Company} (${lead.Lead_Source})`);
    }
    await sleep(300);
  }

  // 5. Create Tasks (linked to deals)
  console.log('\n=== CREATING TASKS ===');
  for (const t of TASKS_DATA) {
    const payload = { ...t };
    delete payload.deal;
    delete payload.lead;
    delete payload.account;
    if (t.deal && dealIds[t.deal]) payload.What_Id = { id: dealIds[t.deal] };
    else if (t.account && accountIds[t.account]) payload.What_Id = { id: accountIds[t.account] };
    const res = await api('POST', '/Tasks', { data: [payload] });
    if (res?.data?.[0]?.details?.id) {
      console.log(`  ✓ [${t.Status.padEnd(12)}] ${t.Subject.slice(0, 55)}`);
    }
    await sleep(300);
  }

  // 6. Create Notes (linked to accounts)
  console.log('\n=== CREATING NOTES ===');
  for (const n of NOTES_DATA) {
    const acctId = accountIds[n.account];
    if (!acctId) { console.log(`  SKIP: ${n.account} not found`); continue; }
    const res = await api('POST', `/Accounts/${acctId}/Notes`, {
      data: [{ Note_Title: n.Note_Title, Note_Content: n.Note_Content }],
    });
    if (res?.data?.[0]?.details?.id) {
      console.log(`  ✓ ${n.Note_Title.slice(0, 55)}`);
    }
    await sleep(300);
  }

  console.log('\n=== CRM SEEDING COMPLETE ===');
  console.log(`Accounts: ${Object.keys(accountIds).length}`);
  console.log(`Contacts: ${Object.keys(contactIds).length}`);
  console.log(`Deals:    ${Object.keys(dealIds).length}`);
  console.log(`Leads:    ${LEADS.length}`);
  console.log(`Tasks:    ${TASKS_DATA.length}`);
  console.log(`Notes:    ${NOTES_DATA.length}`);
}

main().catch(e => { console.error('CRASH:', e); process.exit(1); });
