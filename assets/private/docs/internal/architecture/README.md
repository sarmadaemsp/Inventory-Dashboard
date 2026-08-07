# Patman Inventory Dashboard v2.0

Enterprise inventory management system built on Google Apps Script + BigQuery.

## Architecture

```
Frontend (HtmlService SPA)
        ↓ google.script.run
Apps Script API Layer
        ↓ BigQuery Advanced Service
BigQuery Database (patman-inventory)
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vanilla HTML / CSS / JS (served via HtmlService) |
| Backend | Google Apps Script (V8 runtime) |
| Database | BigQuery (`patman-inventory.patman_inventory`) |
| Deployment | clasp CLI + GitHub Actions |

## Project IDs

| Setting | Value |
|---------|-------|
| GCP Project | `patman-inventory` |
| BigQuery Dataset | `patman_inventory` |
| Script ID | `1g2tY8l4W7koarT4CLPVBj9J7elw5FlPj2AUOk04u5QSY5hVhgtwYofxv` |
| Web App URL | `https://script.google.com/macros/s/AKfycbxxLfROgpoO-4JC_TZmEfJnD62NBqJGDlmbFgU_CKULeGv46k7K0oo4RocNWMUFTfdU/exec` |

## BigQuery Tables

| Table | Purpose |
|-------|---------|
| `inventory` | Master inventory records |
| `orders` | Uploaded order records |
| `users` | Dashboard user accounts |
| `access_requests` | Pending access requests |
| `sku_corrections` | SKU mapping corrections |
| `validation_errors` | Upload validation errors |
| `inventory_uploads` | Inventory upload history |
| `order_uploads` | Order upload history |
| `debug_logs` | System debug logs |

## Inventory Math

```
Phantom Units  = MAX(0, Units Sold − Initial Stock)   [per SKU]
Remaining Stock = MAX(0, Initial Stock − Units Sold)  [per SKU]
```

All calculations run server-side in BigQuery. The frontend never computes inventory math.

## Setup

### Prerequisites

- Node.js ≥ 18
- `@google/clasp` CLI
- Google account with BigQuery and Apps Script access

### Install

```bash
npm install
npx clasp login
```

### Deploy

```bash
npm run push      # push code to Apps Script
npm run deploy    # create new deployment
npm run open      # open in Apps Script editor
```

### Environment

1. Enable BigQuery Advanced Service in Apps Script editor:
   `Services → BigQuery API v2`

2. Ensure Web App is deployed with:
   - Execute as: **Me (your account)**
   - Who has access: **Anyone**

3. Create the first admin user by running `bootstrapAdminUser()` once
   in the Apps Script editor (see `backend/Users.gs`).

## Upload Templates

Download templates from the **Uploads** page in the dashboard, or via:

- Inventory template: `WEB_APP_URL?action=downloadTemplate&type=inventory`
- Orders template: `WEB_APP_URL?action=downloadTemplate&type=orders`

### Inventory Template Columns

| Column | Required | Notes |
|--------|----------|-------|
| `sku` | ✓ | Unique. Format: `ARAxx-PARTNUM-UPC` |
| `box_number` | ✓ | Numeric box identifier |
| `part_number` | ✓ | May contain dashes |
| `upc` | ✓ | 12–13 digit numeric |
| `quantity` | ✓ | Non-negative integer |
| `date_added` | ✓ | ISO date (YYYY-MM-DD) |
| `notes` | | Optional free text |

### Orders Template Columns

| Column | Required | Notes |
|--------|----------|-------|
| `order_id` | ✓ | Must be globally unique |
| `order_date` | ✓ | ISO date |
| `sku` | ✓ | Must match inventory SKU |
| `upc` | ✓ | 12–13 digit numeric |
| `quantity_sold` | ✓ | Positive integer |
| `source_file` | | Origin filename |
| `processed_at` | | Processing timestamp |
| `shipped_from_box` | | Box reference |
| `platform` | | Sales channel |

## User Roles

| Role | Permissions |
|------|-------------|
| `admin` | Full access, user management, debug logs |
| `manager` | All operational actions, uploads, no user management |
| `viewer` | Read-only access to all pages |

## Development

Source files are organized as:

```
backend/    ← Google Apps Script (.gs) server files
frontend/
  index.html     ← Self-contained SPA (served by HtmlService)
  css/           ← CSS source files (assembled into index.html)
  js/            ← JS source files (assembled into index.html)
  assets/        ← Static assets
.github/workflows/deploy.yml  ← CI/CD pipeline
```

## License

Proprietary — Patman Operations
