# Barcode Builder (cloud, multi-tenant)

Customers sign up with their business details, log in, upload a CSV of their
inventory, and print barcode labels. No POS integration — CSV in, labels out.

## How it works

- **Signup** collects business name, address, email, password, and contact
  number. All required, all stored on the `users` table.
- **Login** issues a signed session cookie (JWT, httpOnly).
- **`/builder.html` and `/dashboard.html`** are only reachable when logged
  in — the server checks the session cookie before serving either page and
  redirects to `/login.html` otherwise.
- **CSV upload happens entirely in the browser** (via PapaParse in
  `builder.html`). No inventory data is ever sent to or stored on the
  server — each customer's spreadsheet stays local to their session.

## Local development

1. **Install Postgres** (or use a free hosted one — see deploy section).
2. `npm install`
3. `cp .env.example .env` and fill in:
   - `DATABASE_URL` — your Postgres connection string.
   - `JWT_SECRET` — generate with:
     ```
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
4. `npm start` — this also runs the database migration automatically.
5. Open `http://localhost:4321`, sign up, and you'll land on your dashboard.

## Deploying to the cloud (Render — recommended to start)

Render gives you a free Postgres database and a free web service, and the
included `render.yaml` sets up both in one go.

1. Push this project to a GitHub repo.
2. In Render, choose **New → Blueprint** and point it at the repo — it reads
   `render.yaml` and provisions the web service + database automatically,
   including a generated `JWT_SECRET`.
3. Once deployed, visit your Render URL, sign up, and start uploading CSVs.

**Other hosts:** the included `Dockerfile` works as-is on Railway, Fly.io,
AWS App Runner, or any Docker-friendly host — just provide `DATABASE_URL`
and `JWT_SECRET` as env vars.

## Database schema

One `users` table (see `migrations/001_init.sql`):
`email`, `password_hash`, `business_name`, `address_line1`, `city`, `state`,
`postal_code`, `country`, `contact_number`.

No item/inventory tables exist — that data lives only in each customer's
browser tab for the duration of their session (or in a `.json` template
file they can save/reload from the builder).

## Zoho POS integration (per-user OAuth)

Each user account can connect its own Zoho organization independently —
credentials and tokens are stored per-user (encrypted at rest), so login A's
Zoho connection is completely separate from login B's.

**How a user connects (from the Builder → "Zoho POS Sync" → "Zoho POS
(OAuth)" tab):**

1. The app shows a **Homepage URL** and **Authorized Redirect URI** — the
   same two values for every user, since it's this app's own domain.
2. The user creates a **Server-based Application** at
   [api-console.zoho.com](https://api-console.zoho.com), pasting in those two
   URLs.
3. Zoho gives them a **Client ID** and **Client Secret**, which they paste
   into the app along with their Zoho **Organization ID** and **Data
   Center** (India/.in, US/.com, EU/.eu, etc.) and click **Save
   Credentials**.
4. Clicking **Connect to Zoho** sends them to Zoho's consent screen; after
   approving, Zoho redirects back to `/api/zoho/oauth/callback`, which
   exchanges the authorization code for an access + refresh token and stores
   them (encrypted) on that user's row.
5. **Sync & Import** pulls items from Zoho Inventory using the stored
   tokens, silently refreshing the access token as needed. If the refresh
   token is ever revoked, the user is prompted to reconnect.

**Required env vars for this to work in production:**
- `APP_BASE_URL` — your deployed URL (e.g. `https://your-app.onrender.com`),
  so the redirect URI is always exactly right regardless of proxy headers.
- `ENCRYPTION_KEY` — random value used to encrypt stored client secrets and
  refresh tokens (falls back to deriving one from `JWT_SECRET` if unset, but
  set a dedicated value in production). `render.yaml` auto-generates both.

Two legacy modes remain available in the same modal for users who prefer
them: **Manual Token** (paste a self-client access token) and **Custom
Plugin** (point at your own middleware endpoint). Custom Plugin URLs must be
public `http(s)` hosts — private/internal addresses are blocked server-side.

## Invoice Template Designer (`/invoice`)

Edit the Zoho POS **print profile** and **print field details** JSON files
visually, then export them for the Zoho Admin tool.

**Workflow**

1. In the POS, export `printProfileDetail…json` and `printFieldDetails…json`
   (or pick a preset in the designer).
2. Open `/invoice`, load the two files (drag-and-drop; both at once is fine).
3. Edit:
   - **Table view** — every array/section found in the files, editable
     cell-by-cell; add, duplicate, delete and reorder rows.
   - **Layout preview** — drag, resize and nudge elements on an A4/A5/Letter/
     thermal page with live sample data.
   - **POS fields tab** — searchable list of `PrintModel.*` fields; bind to the
     selected row or add as a new row.
   - **Selected row** — every property of a row, including nested JSON.
4. **Check** flags unknown `PrintModel.*` bindings, duplicate IDs and elements
   outside the page. **Export** downloads each file (or a ZIP) under the file
   names you choose; import them in the Zoho Admin tool.

**Safety properties**

- The designer never assumes a fixed schema. Unknown keys are preserved exactly
  and key order is kept, so a file you only partly edit stays Zoho-compatible.
- Numeric IDs longer than 15 digits are kept lossless (plain `JSON.parse` would
  round them and Zoho would then reject or mis-match them).
- Files are processed in the browser; nothing is uploaded. A draft is kept in
  `localStorage` so a refresh doesn't lose work ("Resume last session").

**Presets:** place preset pairs in `public/assets/aistudio/` using the file
names listed in `TEMPLATE_PRESETS` in `server.js`. Presets whose files are
missing are simply hidden from the dropdown.

**Column mapping:** the designer auto-detects which columns hold the POS field
binding, label, X/Y and width/height. If your export uses unusual key names,
open "Column mapping" above the table and pick them by hand.

When you're ready to charge, the natural next step is Stripe Checkout +
Billing Portal, with a `subscriptions` table keyed by `user_id`, and a
middleware that gates `/builder.html` on an active subscription. Happy to
build that out when you're ready — just ask.
