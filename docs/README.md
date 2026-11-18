# Mena Hardware — Door Hardware Pricing & Schedule Platform

Web application for the Mena Contractors door hardware team. Replaces manual Excel library and door schedule workflows with a role-secured Postgres database, Parts Library, Manufacturers registry, Standard Hardware Sets editor, Quotation `.xlsx` parser, automated Door-to-Set matching engine, Excel-style Project Hardware Grid, versioned PM approval workflow, and Excel export.

---

## Architecture & Stack

- **Frontend (`/web`):** React 18, TypeScript (`strict: true`, no `any`), Vite, Tailwind CSS v4 (strictly monochrome B&W design, Geist Sans & Mono), shadcn/ui primitives, `lucide-react`, TanStack Query, TanStack Table, React Hook Form, Zod, React Router, ExcelJS.
- **Backend (`/supabase`):** Supabase (PostgreSQL, Auth, Storage, Row Level Security).
  - The browser app uses **only** the public `VITE_SUPABASE_ANON_KEY`.
  - No `service_role` key is ever referenced or bundled in `/web`.
- **Quality & CI:** ESLint, Prettier, Vitest, SQL RLS & trigger test suite, Playwright E2E tests (`smoke.spec.ts` and `phase2-workflow.spec.ts`), and GitHub Actions CI (`.github/workflows/ci.yml`).

---

## Repository Layout

```text
.
├── .github/workflows/ci.yml                        # Runs typecheck, lint, unit tests, build, and bundle audit
├── DOOR_HARDWARE_SET_1.xlsx                        # Source workbook (65 standard sets + OSM MM parts)
├── docs/
│   └── README.md                                   # Setup, env vars, roles/RBAC, workflows & testing guide
├── supabase/
│   ├── .env.example                                # Direct Postgres connection string template (DATABASE_URL)
│   ├── config.toml                                 # Supabase CLI configuration
│   ├── migrations/
│   │   ├── 20261116000001_initial_schema.sql                  # Phase 1 schema, triggers, indexes, and RLS policies
│   │   ├── 20261117000002_harden_rls_and_history.sql          # RLS & price history hardening, profiles.email, seed_key
│   │   ├── 20261117000003_phase2_projects_and_approvals.sql   # Phase 2 tables, storage bucket, version-locking triggers & RLS
│   │   ├── 20261117000004_fix_project_cascade_delete.sql      # Let ON DELETE CASCADE pass the draft-lock triggers
│   │   ├── 20261117000005_markup_and_pm_remarks.sql           # project_versions.markup_pct, door_groups.pm_remarks
│   │   ├── 20261117000006_pm_remarks_rpc.sql                  # update_door_group_pm_remark() RPC
│   │   ├── 20261117000007_tighten_phase2_rbac.sql             # Admin-only project edits, PM-only remarks, lock markup on non-drafts
│   │   ├── 20261117000008_add_door_tag.sql                    # door_groups.door_tag
│   │   ├── 20261118000009_fix_pm_remarks_and_profile_directory.sql # PM remarks fix + profile_directory view
│   │   ├── 20261118000010_project_team_roles.sql              # PM-created projects, project_estimators, per-project RLS
│   │   ├── 20261118000011_atomic_version_functions.sql        # transition_version, create_revision, import_quotation, save_project_lines
│   │   ├── 20261118000012_reimport_quotation.sql              # reimport_quotation (updated quotation into draft / next revision)
│   │   └── 20261118000013_project_reference_no.sql            # projects.reference_no (split from "SV002 — Name")
│   ├── seed/
│   │   ├── parser.ts                               # Workbook parser, manufacturer classifier & data issues report
│   │   └── seed.ts                                 # Idempotent direct-Postgres seed script (--dry-run, --prune)
│   └── tests/
│       ├── rls_policies.test.sql                   # Phase 1 SQL tests (roles, RLS, price history)
│       ├── phase2_rls.test.sql                     # Phase 2 SQL tests (projects, version locking, approvals, PM remarks)
│       └── run-sql-tests.ts                        # Runner for the SQL test suite
└── web/
    ├── .env.example                                # Public VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
    ├── e2e/
    │   ├── smoke.spec.ts                           # Playwright smoke test (log in -> open parts library)
    │   └── phase2-workflow.spec.ts                 # Playwright E2E flow (upload -> match -> submit -> approve -> export)
    └── src/                                        # React application source
```

---

## Role-Based Access Control (RBAC)

Enforced both in the UI and in PostgreSQL via Row Level Security (RLS) policies, `BEFORE UPDATE/DELETE` triggers, and the version functions in migrations 011–012 (`transition_version`, `create_revision`, `import_quotation`, `reimport_quotation`, `save_project_lines`). Each function runs as one transaction with the caller's RLS, and a version's status can only change through them (every status change has its `approval_events` row):

Project access is per project: the **project's PM** is `projects.assigned_pm` (set automatically when a PM creates the project) and **assigned estimators** are rows in `project_estimators`.

| Capability | `admin` | `estimator` | `pm` | `viewer` |
| :--- | :---: | :---: | :---: | :---: |
| View Parts, Manufacturers, Standard Sets | ✓ | ✓ | ✓ | ✓ |
| Create / edit Parts, Manufacturers, Standard Sets | ✓ | | | |
| Manage user roles (`/users`) | ✓ | | | |
| View projects | all | assigned only | all | all |
| Create project (details only; PM is auto-assigned) | ✓ | | ✓ | |
| Edit project details / status | ✓ | | own projects | |
| Change a project's PM / delete project | ✓ | | | |
| Assign / remove estimators on a project | ✓ | | own projects | |
| Upload quotation `.xlsx` & door-to-set matching (creates v1) | ✓ | assigned | | |
| Edit `draft` version lines, quantities, prices & markup | ✓ | assigned | | |
| Submit `draft` version for PM review (`draft` → `submitted`) | ✓ | assigned | | |
| Create new draft revision (`vN+1`) from locked version | ✓ | assigned | | |
| Re-import an updated quotation (into the draft, or as `vN+1`) | ✓ | assigned | | |
| Approve or request changes on `submitted` version | ✓ | | own projects | |
| Edit `pm_remarks` on a `submitted` version | | | own projects | |
| Export project version to Excel (`.xlsx`) | ✓ | assigned | ✓ | ✓ |

---

## Phase 2 Workflow: Quotation to Approved Hardware Schedule

1. **Create Project (PM or admin, `CreateProjectForm`):**
   - Enter Reference No. (`projects.reference_no`), name, builder, and site. A PM who creates a project becomes its PM automatically.
   - The project overview (`/projects/:id`, `ProjectDetailPage`) shows the details, the team and a Hardware Schedule summary with an **Open Hardware Schedule** button. The grid, versions, re-import, approvals and export are on `/projects/:id/hardware` (`ProjectHardwarePage`).
   - On the overview, the PM assigns one or more estimators (`ProjectTeamPanel`). Estimators only see projects they are assigned to.
1b. **Upload Quotation (assigned estimator or admin, `QuotationImportWizard`):**
   - Drop a Mena quotation `.xlsx` workbook; `quotationParser.ts` detects the Door Schedule sheet, filters excluded rows (`Ex.`, `EXCLUDED`, `BY OTHERS`), extracts `door_tag` (`Door Type`), normalizes fire rating (`FIRE RATED` / `NON RATED`), leaf configuration (`SINGLE`, `DOUBLE`, `CAVITY SINGLE`, etc.), and dimensions, and groups matching doors. Parsing runs in a Web Worker (`quotationParser.worker.ts`, falls back to the main thread). Finishing the import creates version 1 in one call (`import_quotation`).
   - **Re-import Quotation** (hardware page) loads an updated file: door groups whose key (door tag, room, classification, leaf, size) is unchanged keep their set, edited lines, prices and PM remarks (door quantity comes from the new file); new groups are matched; removed groups are dropped. It replaces the draft's quotation, or creates `vN+1` after approval / changes requested; refused while a version is submitted.
2. **Door-to-Set Matching Review (`doorMatcher.ts`):**
   - Rules-based matching engine scores each door group against the 65 Standard Hardware Sets using classification/leaf filters, room-name token overlap + synonym expansion, and door size similarity.
   - Estimators can bulk-confirm auto-matches scoring ≥ 72%; lower-confidence matches must be confirmed one by one (or changed). They can also pick an alternate Standard Set or define a custom door group.
3. **Excel-Style Project Grid (`ProjectGridPanel`):**
   - Single connected 12-column table (`ROOM NAME`, `DOOR TAG`, `DOOR DESCRIPTION`, `CLASSIFICATION`, `DOOR SIZE`, `HARDWARE CODE`, `HARDWARE DESCRIPTION`, `QTY`, `UNIT COST`, `TOTAL COST`, `COST + MARKUP`, `PM REMARKS`) with keyboard navigation (`Arrow` keys, `Enter`/`F2` to edit, `Tab`, `Esc`), SKU autocomplete from the Parts Library, autosave status indicator, and preserved `NULL` unit prices (`No unit price` marker — never defaulted to `0`).
4. **Versions, Diff & Approval (`ApprovalBar`, `VersionsDiffDialog`):**
   - Submitting a draft first saves any pending grid edits, then locks `door_groups` and `project_lines` via database triggers.
   - PMs review `submitted` versions, add `PM REMARKS`, and either **Approve** or **Request Changes** (comment required).
   - Creating a new draft revision (`vN+1`) clones all groups and lines from `vN` and marks older versions `superseded`. Any two versions can be compared in the Diff modal (added, removed, and changed lines).
5. **Excel Export (`projectExcelExport.ts`):**
   - Downloads a styled `.xlsx` (`HARDWARE` worksheet) with live Excel formulas (`=I*H` line totals, `=SUM(...)` group/overall totals, `=J*(1+$I$2)` markup totals) and visual indicators for added/edited lines while keeping blank (`null`) unit prices blank (highlighted, with a cell note; the grand total notes how many lines were excluded).

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

### Step 3: Apply the Database Migrations

- **Option A — Using Supabase CLI:**
  ```bash
  npx supabase link --project-ref <your-project-ref>
  npx supabase db push
  ```
- **Option B — Using Direct Postgres / SQL Editor:**
  Run all SQL files in [`supabase/migrations/`](../supabase/migrations/) in chronological order (`20261116000001` through `20261118000013`).

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
- Re-running `npm run seed` is completely idempotent (`0` rows duplicated or spuriously updated).

### Step 5: Run the Web App

```bash
cd web
npm run dev
```
Open `http://localhost:5173`. You will see the **Sign In** page. Public sign-up is disabled (see below).

---

## Creating Users & Promoting the First Admin

Public sign-up is **disabled** (`enable_signup = false` in `supabase/config.toml`), because every signed-in user can read parts, costs and projects. On a hosted project, also turn off **Authentication → Sign In / Providers → Allow new users to sign up** in the Supabase Dashboard.

Create accounts in **Supabase Dashboard / Studio → Authentication → Users → Add user** (or *Invite user*). Every new account automatically gets a `profiles` row with `role = 'viewer'` via the `on_auth_user_created` trigger.

To promote your first user to `admin`, run this in the **Supabase SQL Editor** (or via `psql "$DATABASE_URL"`):

```sql
update public.profiles
set role = 'admin'
from auth.users
where public.profiles.id = auth.users.id
  and auth.users.email = 'your-email@menacontractors.com';
```

If you ever need self sign-up (e.g. a local demo), enable it in Supabase Auth **and** set `VITE_ALLOW_SIGNUP=true` in `web/.env` to show the *Create Account* tab.

Once promoted to `admin`, refresh the web app. You can manage all other users' roles (`admin`, `estimator`, `pm`, `viewer`) directly from the **Users & Roles** page (`/users`).

---

## Running Tests & Verification

From `/web`:

```bash
# TypeScript strict typecheck
npm run typecheck

# ESLint check
npm run lint

# Unit tests (Vitest: seed parser, quotation parser, door matcher, version diff, Excel export, Zod schemas)
npm run test:run

# SQL Role, RLS & Version Locking tests (requires DATABASE_URL in supabase/.env)
npm run db:test

# Playwright E2E tests (smoke test + full Phase 2 upload -> match -> submit -> approve -> export flow)
npm run test:e2e
```
