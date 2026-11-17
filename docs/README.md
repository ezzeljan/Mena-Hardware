# Mena Hardware — Door Hardware Pricing Foundation

Foundation web application for the Mena Contractors door hardware team. Replaces manual Excel library and standard set lookups with a role-secured Postgres database, Parts Library, Manufacturers registry, and Standard Hardware Sets editor.

---

## Architecture & Stack

- **Frontend (`/web`):** React 18, TypeScript (`strict: true`, no `any`), Vite, Tailwind CSS v4 (strictly monochrome B&W design, Google Sans font), shadcn/ui primitives, `lucide-react`, TanStack Query, TanStack Table, React Hook Form, Zod, React Router.
- **Backend (`/supabase`):** Supabase (PostgreSQL, Auth, Row Level Security).
  - The browser app uses **only** the public `VITE_SUPABASE_ANON_KEY`.
  - No `service_role` key is ever referenced or bundled in `/web`.
- **Quality & CI:** ESLint, Prettier, Vitest, Playwright smoke test, and GitHub Actions CI (`.github/workflows/ci.yml`).

---

## Repository Layout

```text
.
├── .github/workflows/ci.yml                        # Runs typecheck, lint, unit tests, build, and bundle audit
├── DOOR_HARDWARE_SET_1.xlsx                        # Source workbook (65 standard sets + OSM MM parts)
├── docs/
│   └── README.md                                   # Setup, env vars, admin promotion, DB reset & testing guide
├── supabase/
│   ├── .env.example                                # Direct Postgres connection string template (DATABASE_URL)
│   ├── config.toml                                 # Supabase CLI configuration
│   ├── migrations/
│   │   └── 20261116000001_initial_schema.sql       # Schema, triggers, indexes, and RLS policies
│   ├── seed/
│   │   ├── parser.ts                               # Workbook parser, manufacturer classifier & data issues report
│   │   └── seed.ts                                 # Idempotent direct-Postgres seed script
│   └── tests/
│       ├── rls_policies.test.sql                   # SQL tests verifying admin, estimator, pm, viewer permissions
│       └── run-sql-tests.ts                        # Runner for the SQL test suite
└── web/
    ├── .env.example                                # PublicVITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
    ├── e2e/smoke.spec.ts                           # Playwright smoke test (log in -> open parts library)
    └── src/                                        # React application source
```

---

## 15-Minute Quickstart (Free Supabase Project or Local CLI)

### Prerequisites
- **Node.js 20+** and `npm`
- A free [Supabase](https://supabase.com) cloud project **or** local [Supabase CLI](https://supabase.com/docs/guides/cli)

### Step 1: Install Dependencies
```bash
cd web
npm install
```

### Step 2: Configure Environment Variables

1. **Frontend (`web/.env`)** — Copy `web/.env.example` to `web/.env`:
   ```bash
   cp .env.example .env
   ```
   Fill in your Supabase project URL and **public anon key** (from **Supabase Dashboard -> Project Settings -> API**):
   ```ini
   VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<your-public-anon-key>
   ```
   > **Security Rule:** Never place your `service_role` key or `DATABASE_URL` in `web/.env`.

2. **Database / Seed (`supabase/.env`)** — Copy `supabase/.env.example` to `supabase/.env`:
   ```bash
   cp ../supabase/.env.example ../supabase/.env
   ```
   Set `DATABASE_URL` to your direct Postgres connection string (from **Supabase Dashboard -> Connect -> Direct connection / Session pooler**, or `postgresql://postgres:postgres@127.0.0.1:54322/postgres` if running `supabase start` locally):
   ```ini
   DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.<your-project-ref>.supabase.co:5432/postgres
   ```

### Step 3: Apply the Database Migration

- **Option A — Using Supabase CLI:**
  ```bash
  npx supabase link --project-ref <your-project-ref>
  npx supabase db push
  ```
- **Option B — Using Direct Postgres / SQL Editor:**
  Run [`supabase/migrations/20261116000001_initial_schema.sql`](../supabase/migrations/20261116000001_initial_schema.sql) followed by [`supabase/migrations/20261117000002_harden_rls_and_history.sql`](../supabase/migrations/20261117000002_harden_rls_and_history.sql) in the Supabase SQL Editor or via `psql "$DATABASE_URL"`.

### Step 4: Seed the 65 Standard Sets & Parts Library

From `/web`:

```bash
# Preview the Manufacturer Mapping Summary & Data Issues Report without touching the DB:
npm run seed:dry-run

# Run the idempotent seed against DATABASE_URL (inserts new rows without overwriting admin UI edits):
npm run seed

# Deactivate stale seeded parts/sets removed from the workbook (preserves UI-created rows):
npm run seed -- --prune
```
- Loads all **7 manufacturers** (`MM` marked `is_owner_supplied = true`, `NOVAS`, `LOCKWOOD`, `SCOPE`, `GEZE`, `FSH`, `OTHER`), **59 library parts**, and all **65 standard sets** with their part lines.
- Preserves intentional `NULL` prices (`505BC+SLC` and `L505 BC` have `unit_cost = NULL`, never `0`).
- Flags any genuine SKU-to-description mismatches or blank quantities in the **Data Issues Report**.
- Re-running `npm run seed` is completely idempotent (`0` rows duplicated or spuriously updated).

### Step 5: Run the Web App

```bash
cd web
npm run dev
```
Open `http://localhost:5173`. You will see the **Sign In / Create Account** page.

---

## Promoting the First Admin User

All new sign-ups automatically receive a `profiles` row with `role = 'viewer'` via the `on_auth_user_created` database trigger.

To promote your first user to `admin`, sign up in the UI first, then run this SQL query in the **Supabase SQL Editor** (or via `psql "$DATABASE_URL"`):

```sql
update public.profiles
set role = 'admin'
from auth.users
where public.profiles.id = auth.users.id
  and auth.users.email = 'your-email@menacontractors.com';
```

Once promoted to `admin`, refresh the web app. You will see the `ADMIN` badge in the header, the **Users & Roles** link in the sidebar, and full create/edit/reorder controls on **Parts Library**, **Manufacturers**, and **Standard Sets**.

---

## How to Reset the Database

### Local Supabase CLI
```bash
npx supabase db reset
cd web && npm run seed
```

### Hosted Supabase Project
Run the following in the Supabase SQL Editor to wipe application tables cleanly, then re-run ` supabase/migrations/20261116000001_initial_schema.sql` and `npm run seed`:

```sql
drop table if exists public.standard_set_lines cascade;
drop table if exists public.standard_sets cascade;
drop table if exists public.part_price_history cascade;
drop table if exists public.parts cascade;
drop table if exists public.manufacturers cascade;
drop table if exists public.profiles cascade;
drop type if exists public.user_role cascade;
```

---

## Running Tests & Verification

From `/web`:

```bash
# TypeScript strict typecheck
npm run typecheck

# ESLint check
npm run lint

# Unit tests (Vitest: Excel seed parser, manufacturer inference, data issue detection, Zod schemas)
npm run test:run

# SQL RLS & Trigger tests (requires DATABASE_URL in supabase/.env)
npm run db:test

# Playwright E2E smoke test (logs in and opens Parts Library)
npm run test:e2e
```
