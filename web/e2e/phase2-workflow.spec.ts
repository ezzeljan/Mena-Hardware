import { expect, test, type Page, type Route } from '@playwright/test'
import ExcelJS from 'exceljs'
import { parseQuotationWorkbook } from '../src/features/projects/quotationParser'

/**
 * Phase 2 workflow E2E tests (project-team permission model, migration 010).
 *
 *   PM/admin creates project (details only) -> PM assigns estimators ->
 *   assigned estimator imports quotation + matches -> submits -> project PM approves.
 *
 * Supabase is mocked with an in-memory backend. These tests check what each
 * role sees and can do in the UI; the database rules themselves are covered by
 * supabase/tests/phase2_rls.test.sql.
 */

const ADMIN_ID = '11111111-1111-1111-1111-111111111111'
const PM_ID = '22222222-aaaa-aaaa-aaaa-222222222222'
const OTHER_PM_ID = '99999999-9999-9999-9999-999999999999'
const ESTIMATOR_ID = '33333333-bbbb-bbbb-bbbb-333333333333'
const PROJECT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const VERSION_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const VERSION2_ID = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb'
const UPLOAD_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const SET_FIRE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const SET_BATH_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
const MFR_ID = '44444444-cccc-cccc-cccc-444444444444'
const TS = '2026-11-18T00:00:00Z'
const PROJECT_NAME = 'SV999 — E2E Test Tower'

type Role = 'admin' | 'pm' | 'estimator'
type Row = Record<string, unknown>

const USERS: Record<Role, { id: string; full_name: string; email: string }> = {
  admin: { id: ADMIN_ID, full_name: 'Admin User', email: 'admin@menacontractors.com' },
  pm: { id: PM_ID, full_name: 'Pat PM', email: 'pm@menacontractors.com' },
  estimator: { id: ESTIMATOR_ID, full_name: 'Erin Estimator', email: 'erin@menacontractors.com' },
}

const DIRECTORY = [
  ...(Object.keys(USERS) as Role[]).map((r) => ({
    id: USERS[r].id,
    full_name: USERS[r].full_name,
    role: r,
  })),
  { id: OTHER_PM_ID, full_name: 'Olive Other PM', role: 'pm' },
]

const FIRE_ROW = (qty: number) => [
  'Basement 01', 'DR-001', 'FS', 'Fire Egress - Basement', 'F (Metal Sng Reb)',
  '-/120/30', 'FR2', 2340, 870, '-', 1, '', '', qty,
]
const BATH_ROW = (qty: number) => [
  'Level 01', 'DR-002', 'A01', 'Bathroom', 'ST', '-/-/-', 'SC1', 2040, 820, '-', 1, '', '', qty,
]

async function buildSampleQuotationBuffer(
  rows: Array<Array<string | number>> = [FIRE_ROW(2), BATH_ROW(3)],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Quotation STL 7sept')
  ws.addRow(['MENA CONTRACTORS PTY LTD'])
  ws.addRow(['DOOR SCHEDULE'])
  ws.addRow(['LOCATION'])
  ws.addRow([
    'Door Level',
    'Door Type',
    'Door Apt #',
    'Room Name',
    'Frame Type',
    'FRL',
    'Leaf Type',
    'Leaf Height',
    'Leaf 1 Width',
    'Leaf 2 Width',
    'Leafs',
    'Door Schedule Comments',
    'Mena Contractors Comments',
    'QTY',
  ])
  ws.addRow([]) // subtotal row
  for (const r of rows) ws.addRow(r)
  const arrayBuffer = await wb.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}

const standardSets = [
  {
    id: SET_FIRE_ID,
    set_code: 'SET-001',
    room_name: 'FIRE EGRESS - BASEMENT',
    door_Combined: 'FIRE RATED SINGLE 2340x870',
    classification: 'FIRE RATED',
    leaf: 'SINGLE',
    door_size: '2340x870',
    notes: null,
    active: true,
    created_at: TS,
    updated_at: TS,
    standard_set_lines: [
      {
        id: 'line-std-1', set_id: SET_FIRE_ID, position: 1, sku: 'MMHINGE',
        description: 'HINGES 100X100 4BB BLACK', qty: 3, unit_price: 4,
        part_id: '55555555-5555-5555-5555-555555555551',
      },
      {
        id: 'line-std-2', set_id: SET_FIRE_ID, position: 2, sku: '505BC+SLC',
        description: 'SLIDING ARM DOOR CLOSER', qty: 1, unit_price: null,
        part_id: '55555555-5555-5555-5555-555555555552',
      },
    ],
  },
  {
    id: SET_BATH_ID,
    set_code: 'SET-002',
    room_name: 'BATHROOM',
    door_Combined: 'NON RATED SINGLE 2040x820',
    classification: 'NON RATED',
    leaf: 'SINGLE',
    door_size: '2040x820',
    notes: null,
    active: true,
    created_at: TS,
    updated_at: TS,
    standard_set_lines: [
      {
        id: 'line-std-3', set_id: SET_BATH_ID, position: 1, sku: 'MMHINGE',
        description: 'HINGES 100X100 4BB BLACK', qty: 3, unit_price: 4,
        part_id: '55555555-5555-5555-5555-555555555551',
      },
    ],
  },
]

const manufacturer = { id: MFR_ID, name: 'MM', is_owner_supplied: true }
const partsList = [
  {
    id: '55555555-5555-5555-5555-555555555551', sku: 'MMHINGE', manufacturer_id: MFR_ID,
    description: 'HINGES 100X100 4BB BLACK', unit_cost: 4, active: true,
    created_at: TS, updated_at: TS, manufacturers: manufacturer,
  },
  {
    id: '55555555-5555-5555-5555-555555555552', sku: '505BC+SLC', manufacturer_id: MFR_ID,
    description: 'SLIDING ARM DOOR CLOSER', unit_cost: null, active: true,
    created_at: TS, updated_at: TS, manufacturers: manufacturer,
  },
]

interface MockState {
  project: Row | null
  versions: Row[]
  estimators: Row[]
  doorGroups: Row[]
  lines: Row[]
  events: Row[]
  lastReimport?: { p_groups: Array<Row & { lines: Row[] }> }
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const wantsSingle = (route: Route) =>
  (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object+json')

/**
 * Installs an in-memory Supabase mock signed in as `role`.
 * `seed` pre-populates state (e.g. an existing project with assigned estimators).
 */
async function mockSupabase(page: Page, role: Role, seed: Partial<MockState> = {}) {
  const me = USERS[role]
  const state: MockState = {
    project: null,
    versions: [],
    estimators: [],
    doorGroups: [],
    lines: [],
    events: [],
    ...seed,
  }

  const authUser = { id: me.id, aud: 'authenticated', role: 'authenticated', email: me.email }

  await page.route('**/auth/v1/token**', (route) =>
    json(route, {
      access_token: 'mock-access-token',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: 'mock-refresh-token',
      user: { ...authUser, user_metadata: { full_name: me.full_name } },
    }),
  )
  await page.route('**/auth/v1/user**', (route) => json(route, authUser))

  await page.route('**/rest/v1/profiles**', (route) => {
    const profile = { ...me, role, created_at: TS }
    return json(route, route.request().url().includes('role=in.') ? [profile] : profile)
  })
  await page.route('**/rest/v1/profile_directory**', (route) => json(route, DIRECTORY))
  await page.route('**/rest/v1/manufacturers**', (route) =>
    json(route, [{ ...manufacturer, created_at: TS, updated_at: TS }]),
  )
  await page.route('**/rest/v1/parts**', (route) => json(route, partsList))
  await page.route('**/rest/v1/standard_sets**', (route) => json(route, standardSets))
  await page.route('**/storage/v1/object/quotations/**', (route) =>
    json(route, { Key: 'quotations/mock-file.xlsx' }),
  )

  await page.route('**/rest/v1/projects**', async (route) => {
    const method = route.request().method()
    if (method === 'POST') {
      const payload = route.request().postDataJSON() as Row
      state.project = {
        id: PROJECT_ID,
        reference_no: payload.reference_no ?? '',
        name: payload.name,
        client: payload.client ?? '',
        site: payload.site ?? '',
        status: payload.status ?? 'active',
        created_by: me.id,
        // Mirrors the assign_creating_pm trigger: a PM creator becomes the project's PM.
        assigned_pm: role === 'pm' ? me.id : (payload.assigned_pm ?? null),
        created_at: TS,
        updated_at: TS,
      }
      return json(route, wantsSingle(route) ? state.project : [state.project], 201)
    }
    if (method === 'GET') {
      if (!state.project) return json(route, [])
      const full = {
        ...state.project,
        project_versions: state.versions,
        project_estimators: state.estimators,
      }
      return json(route, wantsSingle(route) ? full : [full])
    }
    return json(route, {})
  })

  await page.route('**/rest/v1/project_estimators**', async (route) => {
    const method = route.request().method()
    if (method === 'POST') {
      const payload = route.request().postDataJSON() as Row
      state.estimators.push({ ...payload, created_at: TS })
      return json(route, [], 201)
    }
    if (method === 'DELETE') {
      const removed = state.estimators
      state.estimators = []
      return json(route, removed)
    }
    return json(route, state.estimators)
  })

  await page.route('**/rest/v1/project_versions**', async (route) => {
    const method = route.request().method()
    if (method === 'POST') {
      const payload = route.request().postDataJSON() as Row
      const v: Row = {
        id: VERSION_ID,
        upload_id: null,
        markup_pct: 12,
        submitted_at: null,
        created_at: TS,
        updated_at: TS,
        ...payload,
      }
      state.versions = [v]
      return json(route, wantsSingle(route) ? v : [v], 201)
    }
    if (method === 'PATCH') {
      const payload = route.request().postDataJSON() as Row
      const v = state.versions[0]
      Object.assign(v, payload)
      if (payload.status === 'submitted') v.submitted_at = '2026-11-18T01:00:00Z'
      return json(route, wantsSingle(route) ? v : [v])
    }
    return json(route, state.versions)
  })

  await page.route('**/rest/v1/quotation_uploads**', (route) =>
    json(route, { id: UPLOAD_ID }, 201),
  )
  await page.route('**/rest/v1/quotation_doors**', (route) => json(route, [], 201))

  await page.route('**/rest/v1/door_groups**', async (route) => {
    const method = route.request().method()
    if (method === 'POST') {
      const rows = route.request().postDataJSON() as Row[]
      state.doorGroups = rows.map((r, idx) => ({
        id: `group-${idx + 1}`,
        version_id: VERSION_ID,
        door_tag: '',
        match_reason: '',
        ...r,
        pm_remarks: '',
        created_at: TS,
        updated_at: TS,
      }))
      return json(route, state.doorGroups, 201)
    }
    if (method === 'DELETE') {
      state.doorGroups = []
      return json(route, [])
    }
    return json(route, state.doorGroups)
  })

  await page.route('**/rest/v1/project_lines**', async (route) => {
    const method = route.request().method()
    if (method === 'POST') {
      const rows = route.request().postDataJSON() as Row[]
      const start = state.lines.length
      const added = rows.map((r, idx) => ({
        id: `pline-${start + idx + 1}`,
        ...r,
        created_at: TS,
        updated_at: TS,
      }))
      state.lines.push(...added)
      return json(route, added, 201)
    }
    return json(route, state.lines)
  })

  // Database functions (migration 011)
  await page.route('**/rest/v1/rpc/import_quotation', async (route) => {
    const body = route.request().postDataJSON() as { p_groups: Array<Row & { lines: Row[] }> }
    state.versions = [
      {
        id: VERSION_ID,
        project_id: PROJECT_ID,
        version_no: 1,
        status: 'draft',
        upload_id: UPLOAD_ID,
        markup_pct: 12,
        created_by: me.id,
        submitted_at: null,
        created_at: TS,
        updated_at: TS,
      },
    ]
    state.doorGroups = []
    state.lines = []
    body.p_groups.forEach(({ lines, ...g }, gi) => {
      const groupId = `group-${gi + 1}`
      state.doorGroups.push({
        id: groupId,
        version_id: VERSION_ID,
        door_tag: '',
        ...g,
        pm_remarks: '',
        created_at: TS,
        updated_at: TS,
      })
      lines.forEach((l, li) =>
        state.lines.push({
          id: `pline-${gi + 1}-${li + 1}`,
          group_id: groupId,
          ...l,
          created_at: TS,
          updated_at: TS,
        }),
      )
    })
    return json(route, VERSION_ID)
  })

  await page.route('**/rest/v1/rpc/reimport_quotation', async (route) => {
    const body = route.request().postDataJSON() as { p_groups: Array<Row & { lines: Row[] }> }
    state.lastReimport = body
    for (const v of state.versions) if (v.status !== 'draft') v.status = 'superseded'
    state.versions.push({
      id: VERSION2_ID,
      project_id: PROJECT_ID,
      version_no: 2,
      status: 'draft',
      upload_id: UPLOAD_ID,
      markup_pct: 12,
      created_by: me.id,
      submitted_at: null,
      created_at: TS,
      updated_at: TS,
    })
    state.doorGroups = []
    state.lines = []
    body.p_groups.forEach(({ lines, ...g }, gi) => {
      const groupId = `group-v2-${gi + 1}`
      state.doorGroups.push({ id: groupId, version_id: VERSION2_ID, ...g, created_at: TS, updated_at: TS })
      lines.forEach((l, li) =>
        state.lines.push({ id: `pline-v2-${gi + 1}-${li + 1}`, group_id: groupId, ...l, created_at: TS, updated_at: TS }),
      )
    })
    return json(route, VERSION2_ID)
  })

  await page.route('**/rest/v1/rpc/transition_version', async (route) => {
    const body = route.request().postDataJSON() as {
      p_version_id: string
      p_action: 'submit' | 'approve' | 'reject'
      p_comment: string
    }
    const v = state.versions.find((x) => x.id === body.p_version_id)!
    v.status =
      body.p_action === 'submit'
        ? 'submitted'
        : body.p_action === 'approve'
          ? 'approved'
          : 'changes_requested'
    if (body.p_action === 'submit') v.submitted_at = '2026-11-18T01:00:00Z'
    state.events.unshift({
      id: `evt-${state.events.length + 1}`,
      version_id: body.p_version_id,
      action: body.p_action,
      actor: me.id,
      comment: body.p_comment ?? '',
      created_at: new Date().toISOString(),
    })
    return json(route, v)
  })

  await page.route('**/rest/v1/rpc/save_project_lines', async (route) => {
    const body = route.request().postDataJSON() as { p_lines: Row[] }
    for (const change of body.p_lines) {
      const line = state.lines.find((l) => l.id === change.id)
      if (line) Object.assign(line, change)
    }
    return json(route, body.p_lines.length)
  })

  await page.route('**/rest/v1/approval_events**', async (route) => {
    const method = route.request().method()
    if (method === 'POST') {
      const payload = route.request().postDataJSON() as Row
      const evt = {
        id: `evt-${state.events.length + 1}`,
        version_id: payload.version_id,
        action: payload.action,
        actor: payload.actor,
        comment: payload.comment ?? '',
        created_at: new Date().toISOString(),
      }
      state.events.unshift(evt)
      return json(route, evt, 201)
    }
    const latest = state.events[0] ?? null
    if (wantsSingle(route)) return json(route, latest)
    if (route.request().url().includes('limit=1')) return json(route, latest ? [latest] : [])
    return json(route, state.events)
  })

  return state
}

async function signIn(page: Page, role: Role) {
  await page.goto('/')
  await page.getByLabel('Email').fill(USERS[role].email)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page.getByRole('heading', { name: 'Parts Library' })).toBeVisible()
}

async function createProjectViaForm(page: Page) {
  await page.getByRole('link', { name: 'Projects' }).click()
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
  await page.getByRole('button', { name: 'New Project' }).click()

  await page.getByLabel('Reference No.').fill('SV999')
  await page.getByLabel('Project Name *').fill('E2E Test Tower')
  await page.getByLabel('Builder').fill('Mena Builders')
  await page.getByLabel('Site').fill('Sydney CBD')
  // Details only: the form must not ask for a quotation file.
  await expect(page.locator('input[type="file"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Create Project' }).click()

  await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible()
  await expect(page.getByText('No quotation imported yet')).toBeVisible()
}

async function importQuotation(page: Page) {
  await page.getByRole('button', { name: 'Upload Quotation' }).click()

  // Step 1: upload
  await page.locator('input[type="file"]').setInputFiles({
    name: 'SV999_Quotation.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await buildSampleQuotationBuffer(),
  })
  await expect(page.getByText('Selected: SV999_Quotation.xlsx')).toBeVisible()
  await expect(page.getByText('DR-001')).toBeVisible()
  await expect(page.getByText('DR-002')).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()

  // Step 2: matching review
  const confirmAuto = page.getByRole('button', { name: /Confirm Auto Matches \(2\)/ })
  await expect(confirmAuto).toBeVisible()
  await confirmAuto.click()
  await page.getByRole('button', { name: 'Next' }).click()

  // Step 3: summary
  await page.getByRole('button', { name: 'Create Version 1' }).click()

  // Creating version 1 opens the hardware page
  await expect(page).toHaveURL(/\/projects\/[^/]+\/hardware$/)
  await expect(page.getByText('No quotation imported yet')).toHaveCount(0)
  await expect(page.getByText('505BC+SLC')).toBeVisible()
}

async function submitForApproval(page: Page) {
  await page.getByRole('button', { name: 'Submit for Approval' }).click()
  await page.getByLabel('Comment (Optional)').fill('Ready for PM review')
  await page.getByRole('button', { name: 'Confirm Submit' }).click()
  await expect(page.getByText(/Locked and awaiting PM review/)).toBeVisible()
}

const existingProject = (assignedPm: string | null): Row => ({
  id: PROJECT_ID,
  reference_no: 'SV999',
  name: 'E2E Test Tower',
  client: 'Mena Builders',
  site: 'Sydney CBD',
  status: 'active',
  created_by: PM_ID,
  assigned_pm: assignedPm,
  created_at: TS,
  updated_at: TS,
})

const assignedEstimator = (assignedBy: string): Row => ({
  project_id: PROJECT_ID,
  estimator_id: ESTIMATOR_ID,
  assigned_by: assignedBy,
  created_at: TS,
})

test('PM creates a project (auto-assigned), cannot import, assigns an estimator', async ({
  page,
}) => {
  const state = await mockSupabase(page, 'pm')
  await signIn(page, 'pm')
  await createProjectViaForm(page)

  expect(state.project?.assigned_pm).toBe(PM_ID)
  expect(state.project?.reference_no).toBe('SV999')
  expect(state.project?.name).toBe('E2E Test Tower')
  await expect(page.getByText('SV999', { exact: true })).toBeVisible()
  await expect(page.getByText('Pat PM').first()).toBeVisible()

  // The PM can't upload the quotation; the page says it's waiting on an estimator.
  await expect(page.getByRole('button', { name: 'Upload Quotation' })).toHaveCount(0)
  await expect(page.getByText('Waiting for the PM to assign an estimator.')).toBeVisible()

  // Assign an estimator from the Project Team panel.
  await page.getByLabel('Estimator to assign').selectOption(ESTIMATOR_ID)
  await page.getByRole('button', { name: 'Assign', exact: true }).click()

  await expect(page.getByRole('button', { name: 'Remove Erin Estimator' })).toBeVisible()
  expect(state.estimators).toEqual([
    expect.objectContaining({
      project_id: PROJECT_ID,
      estimator_id: ESTIMATOR_ID,
      assigned_by: PM_ID,
    }),
  ])
  await expect(
    page.getByText('Waiting for the assigned estimator to upload the quotation'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Upload Quotation' })).toHaveCount(0)
})

test('Estimator cannot create projects; assigned estimator imports and submits', async ({
  page,
}) => {
  await mockSupabase(page, 'estimator', {
    project: existingProject(PM_ID),
    estimators: [assignedEstimator(PM_ID)],
  })
  await signIn(page, 'estimator')

  await page.getByRole('link', { name: 'Projects' }).click()
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New Project' })).toHaveCount(0)

  await page.goto(`/projects/${PROJECT_ID}`)
  await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible()
  // Estimators don't manage the team or the project details.
  await expect(page.getByLabel('Estimator to assign')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit Project Info' })).toHaveCount(0)

  await importQuotation(page)
  await submitForApproval(page)

  // An estimator can't approve their own submission.
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
})

test('Other PM can view a project but cannot approve or manage its team', async ({ page }) => {
  // The project belongs to a different PM; version 1 is already submitted.
  await mockSupabase(page, 'pm', {
    project: existingProject(OTHER_PM_ID),
    estimators: [assignedEstimator(OTHER_PM_ID)],
    versions: [
      {
        id: VERSION_ID, project_id: PROJECT_ID, version_no: 1, status: 'submitted',
        upload_id: UPLOAD_ID, markup_pct: 12, created_by: ESTIMATOR_ID,
        submitted_at: '2026-11-18T01:00:00Z', created_at: TS, updated_at: TS,
      },
    ],
  })
  await signIn(page, 'pm')
  await page.goto(`/projects/${PROJECT_ID}`)

  // Overview: details, team (read-only for this PM) and the hardware status.
  await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible()
  await expect(page.getByText('Waiting for PM review')).toBeVisible()
  await expect(page.getByLabel('Estimator to assign')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit Project Info' })).toHaveCount(0)

  // Hardware page: can view, cannot approve.
  await page.getByRole('link', { name: 'Open Hardware Schedule' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/hardware$`))
  await expect(page.getByText(/Locked and awaiting PM review/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Request Changes' })).toHaveCount(0)
})

test('Admin: create project -> import quotation -> submit -> approve -> export Excel', async ({
  page,
}) => {
  await mockSupabase(page, 'admin')
  await signIn(page, 'admin')
  await createProjectViaForm(page)

  // Admins can do every step, including the import.
  await importQuotation(page)
  await expect(page.getByText('DR-001')).toBeVisible()
  await expect(page.getByText('DR-002')).toBeVisible()

  await submitForApproval(page)

  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await page.getByLabel('Comment (Optional)').fill('Approved for procurement')
  await page.getByRole('button', { name: 'Confirm Approve' }).click()
  await expect(page.getByText('Approved — "Approved for procurement"')).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export Excel' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('SV999_E2E_Test_Tower-v1.xlsx')

  const filePath = await download.path()
  expect(filePath).toBeTruthy()
  const exportedWb = new ExcelJS.Workbook()
  await exportedWb.xlsx.readFile(filePath!)
  const hwSheet = exportedWb.getWorksheet('HARDWARE')
  expect(hwSheet).toBeDefined()
  expect(hwSheet!.getCell('H3').value).toBe(5) // OVERALL DOOR QTY: 2 + 3
  expect(hwSheet!.getCell('A5').value).toBe('FIRE EGRESS - BASEMENT')
  expect(hwSheet!.getCell('B5').value).toBe('DR-001')
  // Line 2 of group 1 is 505BC+SLC; its missing unit price stays empty
  expect(hwSheet!.getCell('F7').value).toBe('505BC+SLC')
  expect(hwSheet!.getCell('I7').value).toBeNull()
})

test('Assigned estimator re-imports an updated quotation: unchanged groups keep their edits', async ({
  page,
}) => {
  // Version 1 (approved) has the fire egress group only, with an edited closer price.
  const baseParse = await parseQuotationWorkbook(
    new Uint8Array(await buildSampleQuotationBuffer([FIRE_ROW(2)])).buffer,
  )
  const fireKey = baseParse.groups[0].group_key

  const state = await mockSupabase(page, 'estimator', {
    project: existingProject(PM_ID),
    estimators: [assignedEstimator(PM_ID)],
    versions: [
      {
        id: VERSION_ID, project_id: PROJECT_ID, version_no: 1, status: 'approved',
        upload_id: UPLOAD_ID, markup_pct: 12, created_by: ESTIMATOR_ID,
        submitted_at: '2026-11-18T01:00:00Z', created_at: TS, updated_at: TS,
      },
    ],
    doorGroups: [
      {
        id: 'group-v1-1', version_id: VERSION_ID, position: 1, group_key: fireKey,
        door_tag: 'DR-001', room_name: 'FIRE EGRESS - BASEMENT', classification: 'FIRE RATED',
        leaf: 'SINGLE', door_size: baseParse.groups[0].door_size ?? '', door_qty: 2,
        matched_set_id: SET_FIRE_ID, match_status: 'confirmed', match_score: 1, match_reason: '',
        pm_remarks: 'Check closer finish', created_at: TS, updated_at: TS,
      },
    ],
    lines: [
      {
        id: 'pline-v1-1', group_id: 'group-v1-1', position: 1, sku: 'MMHINGE',
        description: 'HINGES 100X100 4BB BLACK', qty_per_door: 3, unit_price: 4, origin: 'set',
        part_id: null, created_at: TS, updated_at: TS,
      },
      {
        id: 'pline-v1-2', group_id: 'group-v1-1', position: 2, sku: '505BC+SLC',
        description: 'SLIDING ARM DOOR CLOSER', qty_per_door: 1, unit_price: 99, origin: 'edited',
        part_id: null, created_at: TS, updated_at: TS,
      },
    ],
  })
  await signIn(page, 'estimator')
  await page.goto(`/projects/${PROJECT_ID}/hardware`)
  await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible()

  await page.getByRole('button', { name: 'Re-import Quotation' }).click()
  await expect(page.getByRole('heading', { name: 'Re-import Quotation' })).toBeVisible()

  // Updated file: fire egress qty 2 -> 4, plus a new bathroom group.
  await page.locator('input[type="file"]').setInputFiles({
    name: 'SV999_Quotation_rev2.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await buildSampleQuotationBuffer([FIRE_ROW(4), BATH_ROW(3)]),
  })
  await expect(page.getByText('Selected: SV999_Quotation_rev2.xlsx')).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByText('Changes compared with v1')).toBeVisible()
  await expect(page.getByText('New groups: 1')).toBeVisible()
  await expect(page.getByText('Door qty changed: 1')).toBeVisible()
  await expect(page.getByText('Kept from v1')).toBeVisible()

  // Only the new group needs matching.
  await page.getByRole('button', { name: /Confirm Auto Matches \(1\)/ }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Create Version 2' }).click()

  await expect(page.getByRole('heading', { name: 'Re-import Quotation' })).toHaveCount(0)

  const groups = state.lastReimport!.p_groups
  expect(groups).toHaveLength(2)
  const fire = groups.find((g) => g.group_key === fireKey)!
  expect(fire.door_qty).toBe(4)
  expect(fire.pm_remarks).toBe('Check closer finish')
  expect(fire.lines).toEqual([
    expect.objectContaining({ sku: 'MMHINGE', unit_price: 4, origin: 'set' }),
    expect.objectContaining({ sku: '505BC+SLC', unit_price: 99, origin: 'edited' }),
  ])
  const bath = groups.find((g) => g.group_key !== fireKey)!
  expect(bath.lines).toEqual([expect.objectContaining({ sku: 'MMHINGE', origin: 'set' })])
})
