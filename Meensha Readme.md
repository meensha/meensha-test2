# Meensha — Open Source E-Commerce Stack

**A complete, free, single-file e-commerce platform for small businesses.**
Built with static HTML + Supabase. No server, no build step, no monthly fees.

[![License: MIT](https://img.shields.io/badge/License-MIT-gold.svg)](LICENSE)
[![Hosted on: GitHub Pages](https://img.shields.io/badge/Hosted-GitHub%20Pages-blue.svg)](https://pages.github.com/)
[![Backend: Supabase](https://img.shields.io/badge/Backend-Supabase-green.svg)](https://supabase.com/)

---

## What is this?

A **two-file e-commerce platform** (`index.html` + `admin.html`) that gives you:

- **Storefront** with product catalogue, dual currency, cart, and WhatsApp ordering
- **Admin panel** with inventory management, batch tracking, sales, P&L, expenses
- **AI-powered** invoice scanning, receipt parsing, and product description generation
- **Role-based access** — super admin, owners, sales staff
- **Zero running costs** — all services used are free tier

Originally built for [Meensha](https://meensha.in), a heritage Indian handloom saree brand. Designed to be forked and adapted for any small product business.

---

## The Stack (all free)

| Service | Purpose | Free Tier |
|---------|---------|-----------|
| **GitHub Pages** | Hosting | Unlimited for public repos |
| **Supabase** | Database + Auth + Storage + Edge Functions | 500MB DB, 1GB storage, 50K monthly requests |
| **Anthropic API** | AI invoice/receipt scanner, product descriptions | Pay-per-use (~$0.003 per scan) |
| **ipapi.co** | Geo-detection for currency | 1,000 requests/day free |
| **Razorpay** | Payments (India) | No monthly fee, 2% per transaction |
| **ShipRocket** | Shipping (India) | Free plan available |

**Monthly cost for a single-user small business: ₹0** (until you exceed Supabase free tier — which handles ~50K page views/month comfortably).

---

## Quick Start (5 minutes)

### 1. Fork this repo
Click the **Fork** button above. This gives you your own copy.

### 2. Create a Supabase project
1. Go to [supabase.com](https://supabase.com) → New Project
2. Choose a region close to your customers
3. Copy your **Project URL** and **Anon Key** from Settings → API

### 3. Set up the database
Run the SQL from `setup/schema.sql` in your Supabase SQL Editor. This creates all required tables and default settings.

### 4. Add your Supabase credentials
Open `index.html` and `admin.html`. Find the constants at the top of the `<script>` block:
```javascript
const SB = 'https://YOUR-PROJECT.supabase.co';
const SK = 'your-anon-key-here';
```
Replace with your Project URL and Anon Key. **This is safe** — the anon key is designed to be public. Row Level Security (RLS) on your tables controls what it can access.

### 5. Add sensitive API keys (optional)
After your first admin login, go to Settings and enter:
- **Anthropic API key** — for AI invoice/receipt scanning (optional)
- **Razorpay key** — for online payments (optional, when KYC is done)
- **ShipRocket token** — for auto-shipping (optional)

These are stored in your Supabase `settings` table, never in the repo code.

### 6. Enable GitHub Pages
Repo Settings → Pages → Source: Branch `main` → Save.

Your site is live at `yourusername.github.io/your-repo`.

### 7. First login
Go to `yourusername.github.io/your-repo/admin.html`
Default login: `admin` / `admin@123`
**Change this immediately** in the admin Users tab.

---

## File Structure

```
├── index.html          # Storefront — customer-facing shop
├── admin.html          # Admin panel — inventory, sales, P&L
├── setup/
│   └── schema.sql      # Supabase database schema (run once)
├── assets/
│   ├── logo.svg        # Your brand logo (Hindi/primary)
│   ├── logo_eng.svg    # Secondary logo (English, for rotation)
│   └── ...             # Product/slideshow images
├── .gitignore          # Standard exclusions
├── LICENSE             # MIT License
├── MEENSHA_PROJECT_BRIEF.md  # Build guide for AI-assisted development
└── README.md           # This file
```

No `config.js` needed — Supabase URL + anon key are in the HTML (safe by design), and sensitive API keys live in your Supabase `settings` table.

---

## Features

### Storefront (index.html)
- **Product catalogue** — reads from Supabase, filterable by category
- **Dual currency** — auto-detects visitor location (INR for India, AUD for everywhere else), manual toggle
- **Smart stock display** — shows individual piece photos when ≤2 remain ("Last piece!")
- **Shopping cart** — drawer UI, persists in localStorage across sessions
- **WhatsApp ordering** — pre-filled message with cart items, prices, customer info
- **Razorpay checkout** — toggle-gated, falls back to WhatsApp when OFF
- **Promotional ticker** — infinite scroll banner, managed from admin
- **Events carousel** — upcoming + past events in infinite loop
- **Responsive** — works on mobile, tablet, desktop

### Admin Panel (admin.html)
- **Role-based access** — super admin, owner, sales (configurable per module)
- **Inventory with batch tracking** — each physical piece tracked: `ITEM-MAT-B01-03`
- **Photo per unit** — upload one photo per piece during stock entry
- **AI invoice scanner** — photograph supplier invoice → auto-fills stock entry form
- **AI receipt scanner** — photograph expense receipt → auto-fills expense form
- **AI product describer** — analyses saree photos → generates storefront descriptions
- **Overheads management** — expenses with multi-tags, editable partner splits
- **P&L statement** — proportional + 50/50 partner split, GST toggle (internal only)
- **Sales with unit selection** — pick exact piece, photo on invoice
- **Export everything** — Excel + PDF for sales, purchases, expenses, P&L
- **Shipping integration** — ShipRocket auto-create (toggle-gated)
- **Payment integration** — Razorpay (toggle-gated)
- **Site content management** — ticker messages, pop-up events, Instagram feed
- **Backup & restore** — export all data + settings + regeneration prompt

---

## Customising for Your Business

### Minimal setup (30 minutes)
1. Fork → set up Supabase → add your `config.js`
2. Replace logo files with your brand logos
3. Replace product images with your catalogue photos
4. Update `index.html`: brand name, tagline, slideshow text, craft categories
5. Login to admin → add your inventory

### What to change in index.html
| Section | What to customise |
|---------|------------------|
| `<title>` | Your brand name |
| Nav logo | Your logo files |
| Hero slideshow | Your brand story (5 slides) |
| Mission section | Your mission, passion, vision |
| Craft cards | Your product categories (images + names) |
| Events | Your pop-up events |
| Footer | Your brand info, social links, copyright |

### What to change in admin.html
| Setting | Where |
|---------|-------|
| User credentials | `LOCAL_USERS` array in `<script>` block — change usernames + passwords |
| Role names | Same array — set display names for your team |
| Expense categories | `OV-CAT` select options |
| MRP multipliers | `MRP_M` object — cost-to-MRP ratios by material |
| Courier list | `COUR` object — add/remove shipping providers |
| Seed inventory | `SEED_INV` array — replace with your initial catalogue (or delete to start empty) |

### Adding product categories
The craft cards in `index.html` are hardcoded for Indian handloom. To adapt:
1. Replace the 5 craft card images (`saree_*.png`) with your product category images
2. Update the card names, origins, and descriptions
3. Update the `matchF()` function in the shop JS to filter by your categories

---

## Security

### Three-tier key architecture

| Key Type | Where it lives | Who can see it | Why it's safe |
|----------|---------------|----------------|---------------|
| **Supabase URL + Anon Key** | Hardcoded in HTML | Everyone (public repo) | Anon key is designed to be public. RLS policies control all data access. This is Supabase's official architecture. |
| **API Keys** (Anthropic, Razorpay, ShipRocket) | Supabase `settings` table | Only authenticated admin users | Fetched after login. RLS policy: `SELECT` only when `role IN ('owner','super_admin')`. Never in repo code. |
| **Supabase Service Role Key** | Supabase Edge Functions only | Nobody (server-side only) | Never in client code. Used only for webhook processing (payment confirmations, shipping callbacks). |

### What this means
- **Your repo can be 100% public** — no secrets are exposed
- **Fork-safe** — anyone who forks gets the code structure but no access to your data
- **The anon key is not a secret** — it's like a public API endpoint URL. Supabase designed it this way. Their docs say: "This key is safe to use in a browser if you have enabled Row Level Security."

### Supabase Row-Level Security (RLS)

The `setup/schema.sql` includes RLS policies that:
- Allow public READ on `inventory_skus`, `inventory_units`, `popups`, `instagram_posts`, and selected `settings` keys (storefront needs these)
- Restrict WRITE operations on all tables to authenticated users
- Restrict `users`, sensitive `settings` keys, `purchases`, `overheads` to authenticated admin users
- Block service-role-only operations from client-side entirely

### Admin authentication

Admin login uses local credential checking for simplicity. For hardened production:
1. Move user management to Supabase Auth
2. Hash passwords (bcrypt via Edge Function)
3. Enable RLS policies that check `auth.uid()`

---

## Database Schema

### Core Tables

```sql
-- Product types (one row per SKU)
inventory_skus (
  id uuid PRIMARY KEY,
  sku_code text UNIQUE,        -- e.g., PAITH-COT
  name text,                    -- work/print type
  material text,                -- fabric
  tags jsonb DEFAULT '[]',      -- region, occasion tags
  cost numeric, mrp numeric, disc numeric,
  sale_price numeric,           -- INR
  sale_price_aud numeric,       -- AUD (auto: INR × multiplier)
  sale_price_usd numeric,       -- USD (auto: INR × multiplier)
  batch_counter integer DEFAULT 0,
  hero_photo text,
  description text              -- AI-generated storefront description
)

-- Individual pieces (one row per physical item)
inventory_units (
  id uuid PRIMARY KEY,
  unit_code text UNIQUE,        -- e.g., PAITH-COT-B01-03
  sku_id uuid REFERENCES inventory_skus,
  purchase_id uuid REFERENCES purchases,
  batch text,                   -- B01, B02, etc.
  unit_num integer,             -- 1, 2, 3...
  photo_url text,
  status text DEFAULT 'available', -- available / sold / reserved
  sold_in_sale_id uuid
)

-- Purchase transactions
purchases (
  id uuid PRIMARY KEY,
  supplier_inv text,            -- supplier's invoice number
  date date, seller text, wa text, place text,
  items jsonb,                  -- [{sku_code, name, material, qty, cost, ...}]
  total numeric,
  payment jsonb                 -- {date, amount, mode, shalini, meenakshi}
)

-- Expenses with multi-tags
overheads (
  id uuid PRIMARY KEY,
  date date, cat text, description text,
  unit_price numeric, qty numeric, total numeric,
  paid_by text,                 -- Shalini / Meenakshi / Shared
  shalini numeric, meenakshi numeric,
  tags jsonb DEFAULT '[]',      -- [logistics, one-time, infra, ...]
  note text
)

-- Key-value settings
settings (
  id bigint PRIMARY KEY,
  key text UNIQUE,
  value text,
  updated_at timestamptz
)
```

See `setup/schema.sql` for the complete schema including sales, customers, reviews, and all other tables.

---

## AI Features

The AI features use the Anthropic API (Claude) for image understanding. They are **optional** — the platform works fully without them, just with manual data entry instead.

### Cost
- Each invoice/receipt scan: ~$0.003 (3/10th of a cent)
- Each product photo description: ~$0.003
- At 50 scans/month: ~$0.15/month (~₹12)

### Setup
1. Get an API key from [console.anthropic.com](https://console.anthropic.com)
2. Login to your admin panel → Settings → paste the key into "Anthropic API Key" field
3. The key is saved to your Supabase `settings` table (encrypted at rest by Supabase)
4. The AI features automatically appear in the admin panel

### Without AI
If you don't set an Anthropic API key in Settings:
- "Scan Invoice" and "Scan Receipt" buttons are hidden
- Product photos don't generate descriptions
- Everything else works normally — you just type manually

---

## Adapting for Different Businesses

This stack works for any small product business. Examples:

| Business Type | What to Change |
|---------------|---------------|
| **Jewellery** | Categories → Rings/Necklaces/Earrings. Batch = production lot. |
| **Pottery** | Categories → Mugs/Bowls/Vases. Each piece unique, photos essential. |
| **Clothing boutique** | Categories by style. Add size field to SKUs. |
| **Art prints** | Categories by artist/style. Editions as batches. |
| **Specialty food** | Categories by type. Batch = production date. Add expiry field. |
| **Handmade crafts** | Direct fit — same one-of-a-kind tracking model. |

### What makes this different from Shopify/WooCommerce

| Feature | This Stack | Shopify |
|---------|-----------|---------|
| Monthly cost | ₹0 | ₹2,000+/month |
| Hosting | GitHub Pages (free) | Included but locked-in |
| Database | Supabase (free tier) | Proprietary |
| Customisation | Full source code, edit anything | Theme + plugin system |
| AI features | Built-in (Claude API) | Paid apps |
| Partner P&L | Built-in (50/50 + proportional) | Not available |
| Batch tracking | Built-in per-piece | Requires paid app |
| WhatsApp ordering | Built-in | Requires paid app |
| Lock-in | None — it is your code | Platform dependent |

---

## Contributing

PRs welcome! Areas that need work:
- Multi-language support (i18n)
- More payment gateways (Stripe, PayPal)
- More shipping providers
- Mobile app wrapper (PWA)
- Automated testing

---

## License

MIT License — use it, fork it, sell with it, modify it. No restrictions.

See [LICENSE](LICENSE) for full text.

---

## Credits

Built with care for [Meensha — Heritage Weaves of India](https://meensha.in).

Designed to prove that a complete e-commerce platform doesn't need to cost ₹50,000/year or require a computer science degree to run.

*If a weaver's hands can create a Patola saree that takes six months, surely we can build them a website that costs nothing.*