# Mena Hardware — Door Hardware Pricing & Schedule Platform

Web application for the Mena Contractors door hardware team. Replaces manual Excel library and door schedule workflows with a role-secured Postgres database, Parts Library, Suppliers registry, Standard Hardware Sets editor, Quotation `.xlsx` parser, automated Door-to-Set matching engine, Excel-style Project Hardware Grid, versioned PM approval workflow, and Excel export.

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
│   │   ├── 20261118000013_project_reference_no.sql            # projects.reference_no (split from "SV002 — Name")
│   │   ├── 20261118000014_notifications.sql                   # in-app notifications (assignment, submit, approve, changes requested)
│   │   ├── 20261118000015_profile_avatars.sql                 # profiles.avatar_url, avatars bucket, update_my_profile()
│   │   ├── 20261118000016_project_activity.sql                # project activity log (triggers + backfill of past history)
│   │   ├── 20261119000017_project_stage.sql                   # projects.stage: Tender (default) / Awarded
│   │   ├── 20261119000018_version_comments.sql                # PM comments on a version (replaces the PM REMARKS column)
│   │   ├── 20261119000019_line_mhqt_remarks.sql               # project_lines.mhqt_remarks (MHQT REMARKS column)
│   │   ├── 20261120000020_rename_manufacturers_to_suppliers.sql # manufacturers -> suppliers, parts.supplier_id
│   │   ├── 20261120000021_hardware_quotes_and_sheets.sql      # builder quotes, supplier sheets, sheet comments, award
│   │   └── 20261120000022_part_folders_and_legend.sql         # part folders, part legend, automatic part swap per sheet
│   ├── seed/
│   │   ├── parser.ts                               # Workbook parser, supplier classifier & data issues report
│   │   ├── seed.ts                                 # Idempotent direct-Postgres seed script (--dry-run, --prune)
│   │   └── import-parts.ts                         # Parts library import from a review workbook (dry run / --apply)
│   └── tests/
│       ├── rls_policies.test.sql                   # Phase 1 SQL tests (roles, RLS, price history)
│       ├── phase2_rls.test.sql                     # Phase 2 SQL tests (projects, version locking, approvals, PM remarks)
│       ├── activity.test.sql                       # Project activity log SQL tests
│       ├── project_stage.test.sql                  # Project stage SQL tests
│       ├── version_comments.test.sql               # PM comment SQL tests
│       ├── line_remarks.test.sql                   # MHQT remarks SQL tests
│       ├── quotes_sheets.test.sql                  # builder quotes, supplier sheets & award SQL tests
│       ├── part_folders.test.sql                   # part folders, legends & automatic part swap SQL tests
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

Enforced both in the UI and in PostgreSQL via Row Level Security (RLS) policies, `BEFORE UPDATE/DELETE` triggers, and the version functions in migrations 011–012 and 021 (`transition_version`, `create_revision`, `import_quotation`, `reimport_quotation`, `save_project_lines`, `add_quote_sheet`). Each function runs as one transaction with the caller's RLS, and a version's status can only change through them (every status change has its `approval_events` row):

Project access is per project: the **project's PM** is `projects.assigned_pm` (set automatically when a PM creates the project) and **assigned estimators** are rows in `project_estimators`.

| Capability | `admin` | `estimator` | `pm` | `viewer` |
| :--- | :---: | :---: | :---: | :---: |
| View Parts, Suppliers, Standard Sets | ✓ | ✓ | ✓ | ✓ |
| Create / edit Parts, Suppliers, Standard Sets | ✓ | | | |
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
| Post PM comments on a version (any status); delete own | ✓ | | own projects | |
| Read PM comments | ✓ | assigned | ✓ | ✓ |
| Export project version to Excel (`.xlsx`) | ✓ | assigned | ✓ | ✓ |

---

## Phase 2 Workflow: Quotation to Approved Hardware Quote

1. **Create Project (PM or admin, `CreateProjectForm`):**
   - Enter Reference No. (`projects.reference_no`), name, builder, and site. A PM who creates a project becomes its PM automatically.
   - The project overview (`/projects/:id`, `ProjectDetailPage`) shows the details, the team and the **Hardware Quotes** panel (`HardwareQuotesPanel`): one row per builder with the latest version, its supplier sheets and an **Open Quote** button. Each quote's grid, versions, re-import, approvals and export are on `/projects/:id/hardware?quote=<id>` (`ProjectHardwarePage`; `?version=<id>` opens that version's quote, as notification links do).
   - **Builder quotes** (`hardware_quotes`, migration 021): at Tender a project can have one quote per builder (builder name typed per quote, unique within the project, renamable). **New Quote** asks the builder and the supplier of the first sheet (`NewQuoteDialog`), then opens the import wizard; `import_quotation` creates the quote, its v1 and the first sheet together. Every quote has its own versions (v1, v2…), one draft at a time, one quotation upload and its own submit / approve flow. Existing projects were migrated to one quote each (builder = the project's client) with one sheet per version.
   - On the overview, the PM assigns one or more estimators (`ProjectTeamPanel`). Estimators only see projects they are assigned to.
   - **Stage:** every project is at **Tender** (the default) or **Awarded** (`projects.stage`, migration 017). The Projects list has a Stage column and a stage filter; the overview shows the stage in the details row. The project's assigned PM and admins change it from the stage pill (Projects list or overview); everyone else sees a read-only badge. New projects start at Tender. Choosing **Awarded** opens **Award Project** (`AwardProjectDialog`): pick the winning quote (its latest version must be approved) and its winning supplier sheet (`projects.awarded_quote_id` / `awarded_supplier_id`, checked by a trigger). While awarded, the other quotes are read-only (database-enforced: no edits, sheets, submits, revisions or re-imports) and no new quotes can be added; the winner stays editable and is marked on the overview, the Projects list and the quote switcher. Back to Tender clears the winner. Changes appear in the project's Activities ("awarded the project to Builder (Supplier)").
1b. **Upload Quotation (assigned estimator or admin, `QuotationImportWizard`):**
   - Drop a Mena quotation `.xlsx` workbook; `quotationParser.ts` detects the Door Schedule sheet, filters excluded rows (`Ex.`, `EXCLUDED`, `BY OTHERS`), extracts `door_tag` (`Door Type`), normalizes fire rating (`FIRE RATED` / `NON RATED`), leaf configuration (`SINGLE`, `DOUBLE`, `CAVITY SINGLE`, etc.), and dimensions, and groups matching doors. Parsing runs in a Web Worker (`quotationParser.worker.ts`, falls back to the main thread). Finishing the import creates version 1 in one call (`import_quotation`).
   - **Re-import Quotation** (quote page) loads an updated file into that quote: door groups whose key (door tag, room, classification, leaf, size) is unchanged keep their set, every supplier sheet keeps its edited lines and prices, and the PM remarks stay (door quantity comes from the new file); new groups are matched and get the set's lines on every sheet; removed groups are dropped. It replaces the draft's quotation, or creates `vN+1` after approval / changes requested; refused while a version is submitted.
2. **Door-to-Set Matching Review (`doorMatcher.ts`):**
   - Rules-based matching engine scores each door group against the 65 Standard Hardware Sets using classification/leaf filters, room-name token overlap + synonym expansion, and door size similarity.
   - Estimators can bulk-confirm auto-matches scoring ≥ 72%; lower-confidence matches must be confirmed one by one (or changed). They can also pick an alternate Standard Set or define a custom door group.
3. **Excel-Style Project Grid (`ProjectGridPanel`) and Supplier Sheets (`SheetTabs`, migration 021):**
   - Each quote version has one or more **supplier sheets** (`quote_sheets`, one per supplier). The door groups are shared; each sheet has its own hardware lines (`project_lines.sheet_id`). Tabs under the grid switch sheets; the strip, totals and line edits are per sheet. In a draft the team **adds a sheet** for another supplier (`add_quote_sheet` copies the door groups' lines from a chosen sheet), **renames** it (unique names) or **removes** it (a quote keeps at least one). New revisions copy every sheet.
   - **Automatic part swap (migration 022):** a line switches to the sheet supplier's part when that supplier has exactly **one** active part in the same Parts library folder (`supplier_equivalent_part`). This happens when a sheet is added (`add_quote_sheet`) and for new door groups on import / re-import (on every sheet). The line takes that part's SKU, description and unit cost (blank stays blank); a standard-set line becomes "edited". Owner-supplied (MM) parts are never swapped; otherwise the line is copied as it is and flagged.
   - LEGEND shows the part's legend code (`parts.legend`), else "MM" for owner-supplied parts; the export does the same.
   - Part suggestions in the SKU cell come from the sheet's supplier, the line's own folder first; tick **Parts from other suppliers** to pick another supplier's part (e.g. out of stock). Lines whose library part belongs to another supplier (except owner-supplied MM parts, which belong on every sheet) show an **Other supplier** badge in the SUPPLIER column — that's what to swap after adding a sheet. (Automatic swapping to the equivalent part will follow once the per-supplier part lists are loaded.)
   - Single connected table with the door details (`ROOM NAME`, `DOOR TAG`, `DOOR SIZE`, `DOOR CLASSIFICATION`, `LEAFS`) followed by the NOVAS Template columns (`LEGEND`, `SUPPLIER`, `PART NUMBER`, `DESCRIPTION`, `QTY`, `COST`, `COST DOOR`, `PRICE`, `PRICE DOOR`, `HW PRICE PER DOOR TYPE`, `OVERALL HW PRICE PER TYPICAL DOOR`, `TOTAL ITEMS PER TYPICAL DOOR`, `MHQT REMARKS`), computed with the same formulas as the export. SKU, description, qty, cost and MHQT remarks are editable (remarks: `project_lines.mhqt_remarks`, migration 019, up to 500 characters, copied into revisions and kept on re-import). The strip above shows markup, overall door qty, total cost, total + markup, deliveries ($1.5 per door) and TOTAL EX. GST, with keyboard navigation (`Arrow` keys, `Enter`/`F2` to edit, `Tab`, `Esc`), SKU autocomplete from the Parts Library, autosave status indicator, and preserved `NULL` unit prices (`No unit price` marker — never defaulted to `0`).
4. **Versions, Diff & Approval (`ApprovalBar`, `VersionsDiffDialog`):**
   - Submitting a draft first saves any pending grid edits, then locks `door_groups` and `project_lines` via database triggers.
   - PMs review `submitted` versions, leave **PM Comments**, and either **Approve** or **Request Changes** (comment required).
   - **PM Comments** (`VersionCommentsDrawer`, migration 018) replace the old PM REMARKS column: a right-hand drawer on the hardware page (**PM Comments (n)** button), non-modal so the grid stays usable. The assigned PM or an admin posts comments on the selected version, either on the whole quote or on one door group, and optionally for one supplier sheet (`version_comments.sheet_id`; defaults to the sheet open in the grid, shown as a chip and as a count on the sheet tab); everyone on the project reads them. Door groups with comments show a count badge in the grid that opens the drawer on that group, and a group chip in a comment scrolls the grid to it. Authors (and admins) can delete comments; comments are not editable. Each comment is logged in the Activities and notifies the project's estimators (the notification opens the drawer). Existing PM remarks were copied in as comments.
   - Creating a new draft revision (`vN+1`) clones all groups and lines from `vN` and marks older versions `superseded`. Any two versions can be compared in the Diff modal (added, removed, and changed lines).
5. **Dashboard & Notifications (`DashboardPage`, `NotificationBell`):**
   - After sign-in users land on the **Dashboard** (`/dashboard`), which groups their active projects by what needs doing: estimators see changes requested, quotations to upload, drafts and versions waiting for review; PMs see versions waiting for their review, projects needing estimators and work in progress; admins see submitted versions, projects without a PM and projects without estimators.
   - The header bell shows in-app notifications (refreshed every 30 s), created by database triggers when someone is assigned to a project, a PM is set, a version is submitted (to the project's PM, or the admins if there is none), or a version is approved / sent back (to the estimators). Nobody is notified about their own action.
6. **Account & Avatars (`AccountPage`, `UserAvatar`):**
   - The header avatar opens a menu with **My Account** and **Sign out**. On `/account` users change their photo (cropped to a centred square and resized to 256×256 in the browser, stored in the public `avatars` bucket under `<user id>/`), their full name (`update_my_profile()`), and their password. Email and role stay admin-managed.
   - Avatars (photo, or initials) appear in the header, `/users` (where admins can also rename users; only the user can change their own photo), the project team panel, the projects list and the Dashboard (team column), notifications and the approval bar.
7. **Project Activity (`ProjectActivityPanel`):**
   - The **Activities** panel (right of the hardware quotes on the project overview; the team is on the left): a timeline of project creation, detail edits (old → new), PM and estimator changes, quotation imports and re-imports, new revisions, submit / approve / request changes (with the comment), markup and PM remark changes, and hardware line edits (grouped per person per version within 30 minutes, with counts). Each entry shows who did it, the date and the time. Filters: All · Project & Team · Quotation & Versions · Hardware edits; 30 at a time with **Show more**; refreshed every 30 s.
   - Entries are written only by database triggers (`project_activity`, migration 016), so clients cannot add, change or delete them; anyone who can view the project can read them. Migration 016 rebuilds past history from existing data (creation, estimator assignments, uploads, revisions and approval events); older detail edits and line edits were never recorded, so they cannot be shown.
8. **Excel Export (`projectExcelExport.ts`):**
   - One worksheet per supplier sheet (named after the sheet, cleaned for Excel), each with that sheet's lines and totals; the file name includes the builder. The Client row is the quote's builder.
   - Follows Mena's final **NOVAS Template**. Before exporting, the user picks the **Schedule #** date on a calendar with month/year dropdowns (`components/shadcn-space/calendar/calendar-05.tsx`) and can adjust the sheet title (default "NOVAS HARDWARE - SATIN STAINLESS STEEL"). The hardware grid shows the same Project / Client / Schedule # rows (schedule left blank).
   - Rows 1–4: title (A1, merged to L1), `Project:` / `Client:` / `Schedule #:` with values in B2–B4 (the schedule as a real Excel date, `mm-dd-yy`), **MARKUP** (F3, from the version's markup), total before markup and margin (G3 `=K3/(1+F3)`, G4 `=K3-G3`), **OVERALL DOOR QTY** (E4, `SUMIF` over the "DOOR QTY:" rows), **DELIVERIES** (K4 `=E4*1.5`) and **TOTAL EX. GST** (K3 `=SUM(K4:K…)`, incl. deliveries).
   - Row 5 columns: LEGEND, SUPPLIER, PART NUMBER, DESCRIPTION, QTY, Cost, Cost Door, Price, Price Door, Hardware Price per Door Type, Overall HW Price per Typical Door, Total Items per Typical Door, MHQT REMARKS (each line's remarks from the grid; PM comments are not exported). Each door group is a grey row (room, door tag, leaf + classification, `DOOR QTY:`, door qty, `SUM` totals, `J=I`, `K=E*I`) followed by its lines (`G=IFERROR(E*F,"")`, `H=F*(1+$F$3)`, `I=E*H`, `L=E*door qty`). Supplier comes from the line's library part; LEGEND shows "MM" for owner-supplied parts (other legend codes are not stored).
   - Lines with no unit price keep their price cells blank (highlighted, with a note; the total notes how many were excluded). Lines added to the standard set are green.

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
  Run all SQL files in [`supabase/migrations/`](../supabase/migrations/) in chronological order (`20261116000001` through `20261120000022`).

### Step 4: Seed the 65 Standard Sets & Parts Library

From `/web`:

```bash
# Preview the Supplier Mapping Summary & Data Issues Report without touching the DB:
npm run seed:dry-run

# Run the idempotent seed against DATABASE_URL (inserts new rows without overwriting admin UI edits):
npm run seed

# Deactivate stale seeded parts/sets removed from the workbook (preserves UI-created rows):
npm run seed -- --prune
```
- Loads all **7 suppliers** (`MM` marked `is_owner_supplied = true`, `NOVAS`, `LOCKWOOD`, `SCOPE`, `GEZE`, `FSH`, `OTHER`), **59 library parts**, and all **65 standard sets** with their part lines.
- Preserves intentional `NULL` prices (`505BC+SLC` and `L505 BC` have `unit_cost = NULL`, never `0`).
- Re-running `npm run seed` is completely idempotent (`0` rows duplicated or spuriously updated).

### Parts Library folders & importing supplier part lists

The Parts Library (`/parts`) is organised in **folders** (`part_folders`, migration 022): families of hardware such as "Lever furniture - round rose" or "Seals", each holding parts from every supplier. A folder pane lists All parts, each folder with its count, and Unfiled; admins add, rename and delete folders (deleting a folder leaves its parts unfiled) and set each part's folder and **legend** code in the part form.

Bulk changes come from a review workbook (sheets **Parts**, **Folders**, **Removed**; see `supabase/seed/import-parts.ts` for the columns):

```bash
cd web
# Dry run: prints new suppliers / folders / parts, updates, removals and any problems. Writes nothing.
npm run import:parts -- ../supabase/seed/parts-folders-draft.xlsx
# Write it, in one transaction (needs migration 022):
npm run import:parts -- ../supabase/seed/parts-folders-draft.xlsx --apply
```
- Parts are matched by part number (SKU). A blank unit cost keeps an existing part's cost; new parts without a cost get no price (never `0`). Notes containing `SKIP` ignore the row.
- **Removed** parts: the standard set lines using them are pointed at the "Replace with" part (SKU and description; quantity and price stay). The part is then deleted, or deactivated and unfiled when quote lines still link to it (submitted / approved versions are locked). Quote lines keep their text.

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
