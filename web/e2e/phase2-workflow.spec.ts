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
const SUPPLIER_ID = '44444444-cccc-cccc-cccc-444444444444'
const SUPPLIER2_ID = '44444444-dddd-dddd-dddd-444444444444'
const QUOTE_ID = 'ffffffff-1111-1111-1111-ffffffffffff'
const QUOTE2_ID = 'ffffffff-2222-2222-2222-ffffffffffff'
const BUILDER = 'Mena Builders'
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

const supplier = { id: SUPPLIER_ID, name: 'MM', is_owner_supplied: true }
const supplier2 = { id: SUPPLIER2_ID, name: 'NOVAS', is_owner_supplied: false }
const partsList = [
  {
    id: '55555555-5555-5555-5555-555555555553', sku: 'NV-HINGE', supplier_id: SUPPLIER2_ID,
    description: 'NOVAS HINGE SSS', unit_cost: 6, active: true,
    created_at: TS, updated_at: TS, suppliers: supplier2,
  },
  {
    id: '55555555-5555-5555-5555-555555555551', sku: 'MMHINGE', supplier_id: SUPPLIER_ID,
    description: 'HINGES 100X100 4BB BLACK', unit_cost: 4, active: true,
    created_at: TS, updated_at: TS, suppliers: supplier,
  },
  {
    id: '55555555-5555-5555-5555-555555555552', sku: '505BC+SLC', supplier_id: SUPPLIER_ID,
    description: 'SLIDING ARM DOOR CLOSER', unit_cost: null, active: true,
    created_at: TS, updated_at: TS, suppliers: supplier,
  },
]

interface MockState {
  project: Row | null
  quotes: Row[]
  sheets: Row[]
  versions: Row[]
  estimators: Row[]
  doorGroups: Row[]
  lines: Row[]
  events: Row[]
  notifications: Row[]
  activity: Row[]
  comments: Row[]
  lastProfileUpdate?: Row
  lastProjectUpdate?: Row
  lastReimport?: { p_quote_id: string; p_groups: Array<Row & { lines: Row[] }> }
  lastImport?: Row
}

/** The sheet of a version for its first supplier (seeded versions get one). */
const sheetIdFor = (versionId: unknown) => `sheet-${String(versionId)}`

/**
 * Seeds written in the old shape (versions without a quote, lines without a
 * sheet) get the default quote for BUILDER and one MM sheet per version.
 */
function normalizeSeed(state: MockState) {
  for (const v of state.versions) {
    v.quote_id ??= QUOTE_ID
    if (!state.sheets.some((s) => s.version_id === v.id)) {
      state.sheets.push({
        id: sheetIdFor(v.id), version_id: v.id, supplier_id: SUPPLIER_ID, name: 'MM', position: 0,
        created_at: TS, updated_at: TS,
      })
    }
  }
  for (const quoteId of new Set(state.versions.map((v) => String(v.quote_id)))) {
    if (!state.quotes.some((q) => q.id === quoteId)) {
      state.quotes.push({
        id: quoteId, project_id: PROJECT_ID, builder_name: BUILDER, created_by: PM_ID,
        created_at: TS, updated_at: TS,
      })
    }
  }
  for (const l of state.lines) {
    if (l.sheet_id) continue
    const g = state.doorGroups.find((x) => x.id === l.group_id)
    l.sheet_id = sheetIdFor(g?.version_id ?? VERSION_ID)
  }
}

/** "version_id=eq.X" / "version_id=in.(X,Y)" from a PostgREST URL. */
function idsFilter(url: string, column: string): string[] | null {
  const eq = url.match(new RegExp(`${column}=eq\\.([^&]+)`))
  if (eq) return [eq[1]]
  const inList = url.match(new RegExp(`${column}=in\\.\\(([^)]*)\\)`))
  return inList ? inList[1].split(',').map((s) => s.replace(/"/g, '')) : null
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
  const me = { ...USERS[role] }
  const state: MockState = {
    project: null,
    quotes: [],
    sheets: [],
    versions: [],
    estimators: [],
    doorGroups: [],
    lines: [],
    events: [],
    notifications: [],
    activity: [],
    comments: [],
    ...seed,
  }
  normalizeSeed(state)

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
  await page.route('**/rest/v1/notifications**', async (route) => {
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON() as Row
      const url = decodeURIComponent(route.request().url())
      for (const n of state.notifications) {
        if (url.includes('read_at=is.null') ? !n.read_at : url.includes(String(n.id))) {
          Object.assign(n, patch)
        }
      }
      return json(route, [])
    }
    return json(route, state.notifications)
  })
  await page.route('**/rest/v1/project_activity**', (route) => {
    const url = decodeURIComponent(route.request().url())
    const inList = url.match(/category=in\.\(([^)]*)\)/)
    const categories = inList ? inList[1].split(',') : null
    const rows = state.activity
      .filter((a) => !categories || categories.includes(String(a.category)))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    return json(route, rows)
  })
  await page.route('**/rest/v1/version_comments**', (route) => {
    const method = route.request().method()
    if (method === 'POST') {
      const payload = route.request().postDataJSON() as Row
      state.comments.push({ id: `comment-${state.comments.length + 1}`, created_at: new Date().toISOString(), ...payload })
      return json(route, {}, 201)
    }
    if (method === 'DELETE') {
      const id = decodeURIComponent(route.request().url()).match(/id=eq\.([^&]+)/)?.[1]
      state.comments = state.comments.filter((c) => c.id !== id)
      return json(route, {})
    }
    return json(route, state.comments)
  })
  await page.route('**/rest/v1/suppliers**', (route) =>
    json(route, [supplier, supplier2].map((s) => ({ ...s, created_at: TS, updated_at: TS }))),
  )

  await page.route('**/rest/v1/hardware_quotes**', async (route) => {
    const method = route.request().method()
    const url = decodeURIComponent(route.request().url())
    if (method === 'PATCH') {
      const id = idsFilter(url, 'id')?.[0]
      const q = state.quotes.find((x) => x.id === id)
      if (q) Object.assign(q, route.request().postDataJSON() as Row)
      return json(route, q ? [{ id: q.id }] : [])
    }
    return json(route, state.quotes)
  })

  await page.route('**/rest/v1/quote_sheets**', async (route) => {
    const method = route.request().method()
    const url = decodeURIComponent(route.request().url())
    if (method === 'PATCH') {
      const id = idsFilter(url, 'id')?.[0]
      const s = state.sheets.find((x) => x.id === id)
      if (s) Object.assign(s, route.request().postDataJSON() as Row)
      return json(route, s ? [{ id: s.id }] : [])
    }
    if (method === 'DELETE') {
      const id = idsFilter(url, 'id')?.[0]
      state.sheets = state.sheets.filter((s) => s.id !== id)
      state.lines = state.lines.filter((l) => l.sheet_id !== id)
      return json(route, [{ id }])
    }
    const versionIds = idsFilter(url, 'version_id')
    const rows = state.sheets
      .filter((s) => !versionIds || versionIds.includes(String(s.version_id)))
      .sort((a, b) => Number(a.position) - Number(b.position))
    return json(route, rows)
  })
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
        stage: payload.stage ?? 'tender',
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
        awarded_quote_id: null,
        awarded_supplier_id: null,
        ...state.project,
        hardware_quotes: state.quotes,
        project_versions: state.versions,
        project_estimators: state.estimators,
      }
      return json(route, wantsSingle(route) ? full : [full])
    }
    if (method === 'PATCH' && state.project) {
      const payload = route.request().postDataJSON() as Row
      state.project = { ...state.project, ...payload }
      state.lastProjectUpdate = payload
      return json(route, wantsSingle(route) ? state.project : [state.project])
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
    // With their sheets embedded (the award dialog asks for quote_sheets(...)).
    return json(
      route,
      state.versions.map((v) => ({
        ...v,
        quote_sheets: state.sheets.filter((s) => s.version_id === v.id),
      })),
    )
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
    const body = route.request().postDataJSON() as Row & { p_groups: Array<Row & { lines: Row[] }> }
    state.lastImport = body
    // Mirrors import_quotation (migration 021): new quote + v1 + its first sheet.
    state.quotes = [
      {
        id: QUOTE_ID, project_id: PROJECT_ID, builder_name: body.p_builder_name, created_by: me.id,
        created_at: TS, updated_at: TS,
      },
    ]
    const sup = [supplier, supplier2].find((s) => s.id === body.p_supplier_id)!
    state.sheets = [
      {
        id: sheetIdFor(VERSION_ID), version_id: VERSION_ID, supplier_id: sup.id, name: sup.name,
        position: 0, created_at: TS, updated_at: TS,
      },
    ]
    state.versions = [
      {
        id: VERSION_ID,
        project_id: PROJECT_ID,
        quote_id: QUOTE_ID,
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
          sheet_id: sheetIdFor(VERSION_ID),
          ...l,
          created_at: TS,
          updated_at: TS,
        }),
      )
    })
    return json(route, VERSION_ID)
  })

  await page.route('**/rest/v1/rpc/update_my_profile', async (route) => {
    const body = route.request().postDataJSON() as Row
    state.lastProfileUpdate = body
    me.full_name = String(body.p_full_name)
    return json(route, null)
  })

  await page.route('**/rest/v1/rpc/reimport_quotation', async (route) => {
    const body = route.request().postDataJSON() as {
      p_quote_id: string
      p_groups: Array<Row & { lines: Row[] }>
    }
    state.lastReimport = body
    // Mirrors reimport_quotation (migration 021): the new version gets the same
    // sheets; kept groups keep every sheet's lines, new groups get theirs on every sheet.
    const oldLines = state.lines
    const oldSheets = state.sheets.filter((s) => s.version_id !== VERSION2_ID)
    for (const v of state.versions) if (v.status !== 'draft') v.status = 'superseded'
    const newSheets = oldSheets.map((s) => ({ ...s, id: `${s.id}-v2`, version_id: VERSION2_ID }))
    state.sheets = [...oldSheets, ...newSheets]
    state.versions.push({
      id: VERSION2_ID,
      project_id: PROJECT_ID,
      quote_id: body.p_quote_id,
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
      for (const sheet of newSheets) {
        const oldSheetId = String(sheet.id).replace(/-v2$/, '')
        const source = g.carried_from_group_id
          ? oldLines.filter((l) => l.group_id === g.carried_from_group_id && l.sheet_id === oldSheetId)
          : lines
        source.forEach((l, li) =>
          state.lines.push({
            ...l,
            id: `pline-v2-${gi + 1}-${sheet.id}-${li + 1}`,
            group_id: groupId,
            sheet_id: sheet.id,
            created_at: TS,
            updated_at: TS,
          }),
        )
      }
    })
    return json(route, VERSION2_ID)
  })

  await page.route('**/rest/v1/rpc/add_quote_sheet', async (route) => {
    const body = route.request().postDataJSON() as Row
    const versionSheets = state.sheets.filter((s) => s.version_id === body.p_version_id)
    const sup = [supplier, supplier2].find((s) => s.id === body.p_supplier_id)!
    const id = `sheet-added-${state.sheets.length + 1}`
    state.sheets.push({
      id, version_id: body.p_version_id, supplier_id: sup.id, name: body.p_name || sup.name,
      position: versionSheets.length, created_at: TS, updated_at: TS,
    })
    const sourceId = body.p_source_sheet_id ?? versionSheets[0]?.id
    const copies = state.lines
      .filter((l) => l.sheet_id === sourceId)
      .map((l, i) => ({ ...l, id: `${id}-line-${i + 1}`, sheet_id: id }))
    state.lines.push(...copies)
    return json(route, id)
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
  // The Dashboard greets the user by first name.
  await expect(
    page.getByRole('heading', { name: `Hi ${USERS[role].full_name.split(' ')[0]}!` }),
  ).toBeVisible()
}

async function createProjectViaForm(page: Page) {
  await page.getByRole('link', { name: 'Projects', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
  await page.getByRole('button', { name: 'New Project' }).click()

  await page.getByLabel('Reference No.').fill('SV999')
  await page.getByLabel('Project Name *').fill('E2E Test Tower')
  await page.getByLabel('Client').fill('Mena Builders')
  await page.getByLabel('Site').fill('Sydney CBD')
  // Details only: the form must not ask for a quotation file.
  await expect(page.locator('input[type="file"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Create Project' }).click()

  await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible()
  await expect(page.getByText('No builder quotes yet.')).toBeVisible()
}

/** New Quote: builder and first supplier sheet, then the import wizard. */
async function importQuotation(page: Page) {
  await page.getByRole('button', { name: 'New Quote' }).click()
  const dialog = page.getByRole('dialog', { name: 'New Hardware Quote' })
  // Both are required before the upload.
  await dialog.getByRole('button', { name: 'Continue to upload' }).click()
  await expect(dialog.getByText('Enter the builder this quote is for.')).toBeVisible()
  await dialog.getByLabel('Builder').fill(BUILDER)
  await dialog.getByLabel('First supplier sheet').selectOption({ label: 'MM' })
  await dialog.getByRole('button', { name: 'Continue to upload' }).click()
  await expect(page.getByText(`Upload ${BUILDER}'s quotation`)).toBeVisible()

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

  // Creating version 1 opens the quote, on its first supplier sheet.
  await expect(page).toHaveURL(new RegExp(`/projects/[^/]+/hardware\\?quote=${QUOTE_ID}$`))
  await expect(page.getByText(`Quote for ${BUILDER}`)).toBeVisible()
  await expect(page.getByText('505BC+SLC')).toBeVisible()
  await expect(page.getByTestId('sheet-tab')).toHaveText(['MM'])
}

async function submitForApproval(page: Page) {
  await page.getByRole('button', { name: 'Submit for Approval' }).click()
  await page.getByLabel('Comment (Optional)').fill('Ready for PM review')
  await page.getByRole('button', { name: 'Confirm Submit' }).click()
  await expect(page.getByText(/Awaiting PM review/)).toBeVisible()
}

const existingProject = (assignedPm: string | null): Row => ({
  id: PROJECT_ID,
  reference_no: 'SV999',
  name: 'E2E Test Tower',
  client: 'Mena Builders',
  site: 'Sydney CBD',
  status: 'active',
  stage: 'tender',
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
  await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible()
  await expect(page.getByText('Pat PM').first()).toBeVisible()

  // The PM can't add a builder quote; the page says it's waiting on an estimator.
  await expect(page.getByRole('button', { name: 'New Quote' })).toHaveCount(0)
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
  await expect(page.getByText('Waiting for the PM to assign an estimator.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New Quote' })).toHaveCount(0)
})

test('Estimator cannot create projects; assigned estimator imports and submits', async ({
  page,
}) => {
  await mockSupabase(page, 'estimator', {
    project: existingProject(PM_ID),
    estimators: [assignedEstimator(PM_ID)],
  })
  await signIn(page, 'estimator')

  await page.getByRole('link', { name: 'Projects', exact: true }).click()
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

  // Quote page: can view, cannot approve.
  await expect(page.getByTestId('hardware-quote-row')).toContainText(BUILDER)
  await page.getByRole('link', { name: 'Open Quote' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/hardware\\?quote=${QUOTE_ID}$`))
  await expect(page.getByText(/Awaiting PM review/)).toBeVisible()
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

  // Export asks for the Schedule # first (required), picked on the calendar.
  await page.getByRole('button', { name: 'Export Excel' }).click()
  await page.getByRole('button', { name: 'Download' }).click()
  await expect(page.getByText('Pick the schedule date to export.')).toBeVisible()
  const now = new Date()
  // The calendar opens on the current month; pick the 15th (day buttons carry data-day="M/D/YYYY").
  const scheduleNo = `${now.getMonth() + 1}/15/${now.getFullYear()}`
  await page.locator(`[data-day="${scheduleNo}"]`).first().click()
  await expect(page.getByTestId('export-schedule-value')).toHaveText(scheduleNo)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('SV999_E2E_Test_Tower_Mena_Builders-v1.xlsx')

  const filePath = await download.path()
  expect(filePath).toBeTruthy()
  const exportedWb = new ExcelJS.Workbook()
  await exportedWb.xlsx.readFile(filePath!)
  // One worksheet per supplier sheet, named after it.
  expect(exportedWb.worksheets.map((w) => w.name)).toEqual(['MM'])
  const hwSheet = exportedWb.getWorksheet('MM')
  expect(hwSheet).toBeDefined()
  // Header rows 1-4 (NOVAS Template layout)
  expect(hwSheet!.getCell('A1').value).toBe('NOVAS HARDWARE - SATIN STAINLESS STEEL')
  expect(hwSheet!.getCell('A2').value).toBe('Project:')
  expect(hwSheet!.getCell('B2').value).toBe('E2E TEST TOWER')
  expect(hwSheet!.getCell('A3').value).toBe('Client:')
  expect(hwSheet!.getCell('B3').value).toBe('MENA BUILDERS')
  expect(hwSheet!.getCell('A4').value).toBe('Schedule #:')
  // The schedule date is a real Excel date.
  expect(hwSheet!.getCell('B4').value).toEqual(new Date(Date.UTC(now.getFullYear(), now.getMonth(), 15)))
  expect((hwSheet!.getCell('E4').value as { result: number }).result).toBe(5) // OVERALL DOOR QTY: 2 + 3
  expect(hwSheet!.getCell('M5').value).toBe('MHQT  REMARKS')
  expect(hwSheet!.getCell('A6').value).toBe('FIRE EGRESS - BASEMENT')
  expect(hwSheet!.getCell('D6').value).toBe('DOOR QTY:')
  // Line 1 of group 1 is the owner-supplied MM hinge
  expect(hwSheet!.getCell('A7').value).toBe('MM')
  expect(hwSheet!.getCell('B7').value).toBe('MM')
  expect(hwSheet!.getCell('C7').value).toBe('MMHINGE')
  // Line 2 of group 1 is 505BC+SLC; its missing unit price stays empty
  expect(hwSheet!.getCell('C8').value).toBe('505BC+SLC')
  expect(hwSheet!.getCell('F8').value).toBeNull()
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

  expect(state.lastReimport!.p_quote_id).toBe(QUOTE_ID)
  const groups = state.lastReimport!.p_groups
  expect(groups).toHaveLength(2)
  // The kept group is copied by the database on every sheet (lines are not sent).
  const fire = groups.find((g) => g.group_key === fireKey)!
  expect(fire.door_qty).toBe(4)
  expect(fire.pm_remarks).toBe('Check closer finish')
  expect(fire.carried_from_group_id).toBe('group-v1-1')
  expect(fire.lines).toEqual([])
  const bath = groups.find((g) => g.group_key !== fireKey)!
  expect(bath.carried_from_group_id).toBeUndefined()
  expect(bath.lines).toEqual([expect.objectContaining({ sku: 'MMHINGE', origin: 'set' })])

  // v2 keeps the edited closer price.
  const closerRow = page.getByRole('row').filter({ hasText: '505BC+SLC' })
  await expect(closerRow).toContainText('99.00')
})

test('PM home: Dashboard lists the version to review; the bell opens it and marks it read', async ({
  page,
}) => {
  const state = await mockSupabase(page, 'pm', {
    project: existingProject(PM_ID),
    estimators: [assignedEstimator(PM_ID)],
    versions: [
      {
        id: VERSION_ID, project_id: PROJECT_ID, version_no: 1, status: 'submitted',
        upload_id: UPLOAD_ID, markup_pct: 12, created_by: ESTIMATOR_ID,
        submitted_at: '2026-11-18T01:00:00Z', created_at: TS, updated_at: TS,
      },
    ],
    notifications: [
      {
        id: 'notif-1', user_id: PM_ID, project_id: PROJECT_ID, version_id: VERSION_ID,
        kind: 'submitted', title: `v1 of ${PROJECT_NAME} is waiting for your review`,
        body: 'Erin Estimator submitted it.', actor_id: ESTIMATOR_ID, read_at: null,
        created_at: new Date().toISOString(),
      },
    ],
  })
  await signIn(page, 'pm')

  // Dashboard: the submitted version is in the review queue.
  const review = page.locator('section', { has: page.getByRole('heading', { name: 'Waiting for your review' }) })
  await expect(review.getByRole('link', { name: new RegExp(PROJECT_NAME) })).toBeVisible()
  await expect(review.getByText(`${BUILDER} v1 · SUBMITTED`)).toBeVisible()

  // Bell: one unread; opening it goes to the version's quote and marks it read.
  await expect(page.getByTestId('notification-count')).toHaveText('1')
  await page.getByRole('button', { name: /Notifications/ }).click()
  await page.getByRole('button', { name: new RegExp('waiting for your review') }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/hardware\\?quote=${QUOTE_ID}$`))
  await expect.poll(() => state.notifications[0].read_at).not.toBeNull()
  await expect(page.getByTestId('notification-count')).toHaveCount(0)
})

test('Account page: user renames themselves; the header menu shows the new name', async ({
  page,
}) => {
  const state = await mockSupabase(page, 'estimator')
  await signIn(page, 'estimator')

  await page.getByRole('button', { name: 'Account menu' }).click()
  await expect(page.getByTestId('header-user-name')).toHaveText('Erin Estimator')
  await page.getByRole('menuitem', { name: 'My Account' }).click()
  await expect(page.getByRole('heading', { name: 'My Account' })).toBeVisible()

  // No photo yet: initials, and an Upload Photo button.
  await expect(page.getByRole('button', { name: 'Upload Photo' })).toBeVisible()

  await page.getByLabel('Full Name').fill('Erin Tan')
  await page.getByRole('button', { name: 'Save Name' }).click()
  await expect(page.getByText('Name saved.')).toBeVisible()
  expect(state.lastProfileUpdate).toEqual({ p_full_name: 'Erin Tan', p_avatar_url: null })

  await page.getByRole('button', { name: 'Account menu' }).click()
  await expect(page.getByTestId('header-user-name')).toHaveText('Erin Tan')
})

test('Project overview: Activities lists who did what and when, with filters', async ({ page }) => {
  const now = Date.now()
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
  const entry = (id: string, minutesAgo: number, row: Row) => ({
    id, project_id: PROJECT_ID, version_id: null, details: {},
    created_at: at(minutesAgo), updated_at: at(minutesAgo), ...row,
  })
  await mockSupabase(page, 'pm', {
    project: existingProject(PM_ID),
    estimators: [assignedEstimator(PM_ID)],
    versions: [
      {
        id: VERSION_ID, project_id: PROJECT_ID, version_no: 1, status: 'changes_requested',
        upload_id: UPLOAD_ID, markup_pct: 12, created_by: ESTIMATOR_ID,
        submitted_at: at(30), created_at: TS, updated_at: at(5),
      },
    ],
    activity: [
      entry('act-1', 120, {
        actor_id: ADMIN_ID, category: 'project', action: 'project_created', summary: 'created the project',
      }),
      entry('act-2', 110, {
        actor_id: PM_ID, category: 'team', action: 'estimator_added',
        summary: 'added Erin Estimator as an estimator',
      }),
      entry('act-3', 60, {
        actor_id: ESTIMATOR_ID, category: 'quotation', action: 'quotation_imported',
        summary: 'imported the quotation (v1)', version_id: VERSION_ID,
        details: { file: 'quotation.xlsx', door_groups: 2, version_no: 1 },
      }),
      entry('act-4', 40, {
        actor_id: ESTIMATOR_ID, category: 'hardware', action: 'lines_edited',
        summary: 'updated hardware lines in v1', version_id: VERSION_ID,
        details: { version_no: 1, edited: 3, added: 0, removed: 0 },
      }),
      entry('act-5', 5, {
        actor_id: PM_ID, category: 'version', action: 'version_changes_requested',
        summary: 'requested changes on v1', version_id: VERSION_ID,
        details: { version_no: 1, comment: 'Check the closers', from: 'submitted', to: 'changes_requested' },
      }),
    ],
  })
  await signIn(page, 'pm')
  await page.goto(`/projects/${PROJECT_ID}`)

  const panel = page.getByTestId('project-activity')
  await expect(panel.getByRole('heading', { name: 'Activities' })).toBeVisible()
  await expect(panel.getByTestId('activity-entry')).toHaveCount(5)
  await expect(panel.getByText('Today')).toBeVisible()

  // Newest first, with the actor, the change, status chips and the comment.
  const newest = panel.getByTestId('activity-entry').first()
  await expect(newest).toContainText('Pat PM')
  await expect(newest).toContainText('requested changes on v1')
  await expect(newest).toContainText('Changes requested')
  await expect(newest).toContainText('“Check the closers”')
  await newest.getByRole('button', { name: 'Hide' }).click()
  await expect(newest).not.toContainText('Check the closers')

  // Filters.
  await panel.getByRole('tab', { name: 'Hardware edits' }).click()
  await expect(panel.getByTestId('activity-entry')).toHaveCount(1)
  await expect(panel.getByTestId('activity-entry').first()).toContainText('3 changes')

  await panel.getByRole('tab', { name: 'Project & Team' }).click()
  await expect(panel.getByTestId('activity-entry')).toHaveCount(2)
  await expect(panel).toContainText('Admin User')
  await expect(panel).toContainText('added Erin Estimator as an estimator')
})

test('Projects list: the assigned PM awards the project to a quote and sheet', async ({ page }) => {
  const state = await mockSupabase(page, 'pm', {
    project: existingProject(PM_ID),
    estimators: [assignedEstimator(PM_ID)],
    quotes: [
      { id: QUOTE_ID, project_id: PROJECT_ID, builder_name: BUILDER, created_by: PM_ID, created_at: TS, updated_at: TS },
      { id: QUOTE2_ID, project_id: PROJECT_ID, builder_name: 'Bolt Construct', created_by: PM_ID, created_at: '2026-11-18T01:00:00Z', updated_at: TS },
    ],
    versions: [
      {
        id: VERSION_ID, project_id: PROJECT_ID, quote_id: QUOTE_ID, version_no: 1, status: 'approved',
        upload_id: UPLOAD_ID, markup_pct: 12, created_by: ESTIMATOR_ID,
        submitted_at: TS, created_at: TS, updated_at: TS,
      },
      {
        id: VERSION2_ID, project_id: PROJECT_ID, quote_id: QUOTE2_ID, version_no: 1, status: 'draft',
        upload_id: UPLOAD_ID, markup_pct: 12, created_by: ESTIMATOR_ID,
        submitted_at: null, created_at: TS, updated_at: TS,
      },
    ],
    sheets: [
      { id: 'sheet-a-mm', version_id: VERSION_ID, supplier_id: SUPPLIER_ID, name: 'MM', position: 0, created_at: TS, updated_at: TS },
      { id: 'sheet-a-nv', version_id: VERSION_ID, supplier_id: SUPPLIER2_ID, name: 'Novas option', position: 1, created_at: TS, updated_at: TS },
    ],
  })
  await signIn(page, 'pm')
  await page.goto('/projects')

  await expect(page.getByRole('columnheader', { name: 'Stage' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Quotes' })).toBeVisible()
  await expect(page.getByRole('cell', { name: /Mena Builders.*v1.*approved/i })).toBeVisible()
  const stage = page.getByRole('button', { name: 'Stage of SV999 — E2E Test Tower' })
  await expect(stage).toHaveText('Tender')
  await stage.click()
  await page.getByRole('listbox').getByRole('option', { name: 'Awarded' }).click()

  // Awarding asks for the winner: only the approved quote can win.
  const dialog = page.getByRole('dialog', { name: 'Award Project' })
  await expect(dialog.getByRole('radio', { name: /Bolt Construct/ })).toBeDisabled()
  await expect(dialog.getByRole('radio', { name: /Mena Builders/ })).toBeChecked()
  await expect(dialog.getByRole('button', { name: 'Award Project' })).toBeDisabled()
  await dialog.getByRole('radio', { name: 'Novas option' }).check()
  await dialog.getByRole('button', { name: 'Award Project' }).click()

  await expect.poll(() => state.lastProjectUpdate).toEqual({
    stage: 'awarded',
    awarded_quote_id: QUOTE_ID,
    awarded_supplier_id: SUPPLIER2_ID,
  })
  await expect(dialog).toHaveCount(0)
  await expect(stage).toHaveText('Awarded')
  await expect(page.getByRole('listbox')).toHaveCount(0)

  // Stage filter.
  await page.getByLabel('Filter by project stage').selectOption('tender')
  await expect(page.getByText('No projects found.')).toBeVisible()
  await page.getByLabel('Filter by project stage').selectOption('awarded')
  await expect(page.getByRole('link', { name: 'E2E Test Tower' })).toBeVisible()
})

test('Projects list: an estimator sees the stage but cannot change it', async ({ page }) => {
  await mockSupabase(page, 'estimator', {
    project: { ...existingProject(PM_ID), stage: 'awarded' },
    estimators: [assignedEstimator(PM_ID)],
  })
  await signIn(page, 'estimator')
  await page.goto('/projects')

  await expect(page.getByTestId('project-stage')).toHaveText('Awarded')
  await expect(page.getByTestId('project-stage-select')).toHaveCount(0)
})

const COMMENT_SEED = (status: string) => ({
  project: existingProject(PM_ID),
  estimators: [assignedEstimator(PM_ID)],
  versions: [
    {
      id: VERSION_ID, project_id: PROJECT_ID, version_no: 1, status,
      upload_id: UPLOAD_ID, markup_pct: 15, created_by: ESTIMATOR_ID,
      submitted_at: TS, created_at: TS, updated_at: TS,
    },
  ],
  doorGroups: [
    {
      id: 'group-c-1', version_id: VERSION_ID, position: 1, group_key: 'C1',
      door_tag: 'DR-001', room_name: 'LOBBY', classification: 'NON RATED',
      leaf: 'SINGLE', door_size: '2040x920', door_qty: 2,
      matched_set_id: null, match_status: 'manual', match_score: 0, match_reason: '',
      pm_remarks: '', created_at: TS, updated_at: TS,
    },
  ],
  lines: [
    {
      id: 'pline-c-1', group_id: 'group-c-1', position: 1, sku: 'MMHINGE',
      description: 'HINGES 100X100 4BB BLACK', qty_per_door: 3, unit_price: 4, origin: 'set',
      part_id: null, created_at: TS, updated_at: TS,
    },
  ],
})

test('Hardware: the PM comments in the drawer (no PM REMARKS column)', async ({ page }) => {
  const state = await mockSupabase(page, 'pm', COMMENT_SEED('submitted'))
  await signIn(page, 'pm')
  await page.goto(`/projects/${PROJECT_ID}/hardware`)

  await expect(page.getByText('LOBBY')).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'PM REMARKS' })).toHaveCount(0)

  await page.getByRole('button', { name: 'PM Comments (0)' }).click()
  const drawer = page.getByTestId('comments-drawer')
  await expect(drawer.getByText('No comments yet. Add the first one below.')).toBeVisible()

  // Comment on the LOBBY door group.
  await drawer.getByLabel('Show comments for').selectOption({ label: 'LOBBY · DR-001' })
  await expect(drawer.getByText('Comment on')).toContainText('LOBBY · DR-001')
  await drawer.getByPlaceholder('Write a comment for the estimators...').fill('Use satin hinges here')
  await drawer.getByRole('button', { name: 'Post comment' }).click()

  await expect.poll(() => state.comments.length).toBe(1)
  expect(state.comments[0]).toMatchObject({
    version_id: VERSION_ID, door_group_id: 'group-c-1', author_id: PM_ID, body: 'Use satin hinges here',
  })
  await expect(drawer.getByTestId('comment')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'PM Comments (1)' })).toBeVisible()
  // The door group row shows the count.
  await expect(page.getByRole('button', { name: '1 PM comment on LOBBY' })).toBeVisible()
})

test('Hardware: the estimator reads PM comments but cannot post', async ({ page }) => {
  await mockSupabase(page, 'estimator', {
    ...COMMENT_SEED('changes_requested'),
    comments: [
      {
        id: 'comment-1', version_id: VERSION_ID, door_group_id: 'group-c-1', author_id: PM_ID,
        body: 'Closer missing on this door', created_at: TS,
      },
    ],
  })
  await signIn(page, 'estimator')
  await page.goto(`/projects/${PROJECT_ID}/hardware`)

  await page.getByRole('button', { name: '1 PM comment on LOBBY' }).click()
  const drawer = page.getByTestId('comments-drawer')
  await expect(drawer.getByTestId('comment')).toHaveCount(1)
  await expect(drawer).toContainText('Closer missing on this door')
  await expect(drawer).toContainText('Pat PM')
  await expect(drawer.getByRole('button', { name: 'Post comment' })).toHaveCount(0)
  await expect(drawer.getByRole('button', { name: 'Delete comment' })).toHaveCount(0)
})

test('Hardware grid: NOVAS Template columns and editable MHQT remarks', async ({ page }) => {
  const state = await mockSupabase(page, 'estimator', COMMENT_SEED('draft'))
  await signIn(page, 'estimator')
  await page.goto(`/projects/${PROJECT_ID}/hardware`)

  for (const header of [
    'LEGEND', 'SUPPLIER', 'COST DOOR', 'PRICE DOOR', 'HW PRICE PER DOOR TYPE',
    'OVERALL HW PRICE PER TYPICAL DOOR', 'TOTAL ITEMS PER TYPICAL DOOR', 'MHQT REMARKS',
  ]) {
    await expect(page.getByRole('columnheader', { name: header, exact: true })).toBeVisible()
  }
  await expect(page.getByRole('columnheader', { name: 'COST + MARKUP' })).toHaveCount(0)

  // MMHINGE is an owner-supplied MM part: 3 per door × $4, 2 doors, 15% markup.
  const hingeRow = page.getByRole('row').filter({ hasText: 'MMHINGE' })
  await expect(hingeRow).toContainText('MM')
  await expect(hingeRow).toContainText('12.00') // cost door
  await expect(hingeRow).toContainText('4.60') // price
  await expect(hingeRow).toContainText('13.80') // price door
  // 2 doors × $13.80 + $3.00 deliveries
  await expect(page.getByTestId('grid-total-ex-gst')).toContainText('30.60')

  // Edit the remarks cell (last editable column) and save.
  await hingeRow.locator('td').nth(17).locator('div[tabindex]').dblclick()
  await page.keyboard.type('Supply only')
  await page.keyboard.press('Enter')
  await expect.poll(() => state.lines.find((l) => l.id === 'pline-c-1')?.mhqt_remarks).toBe('Supply only')
  await expect(hingeRow).toContainText('Supply only')
})

test('Supplier sheets: add a sheet, flag other-supplier parts, rename, export both', async ({ page }) => {
  const state = await mockSupabase(page, 'estimator', COMMENT_SEED('draft'))
  await signIn(page, 'estimator')
  await page.goto(`/projects/${PROJECT_ID}/hardware`)

  await expect(page.getByTestId('sheet-tab')).toHaveText(['MM'])
  // MM parts on the MM sheet: no flag.
  await expect(page.getByTestId('other-supplier-badge')).toHaveCount(0)

  // Add a NOVAS sheet: same door groups and parts, copied from MM.
  await page.getByTestId('add-sheet').click()
  const dialog = page.getByRole('dialog', { name: 'Add Supplier Sheet' })
  // MM already has a sheet, so only NOVAS is offered.
  await expect(dialog.getByLabel('Supplier').locator('option')).toHaveText([
    'Select supplier...',
    'NOVAS',
  ])
  await dialog.getByLabel('Supplier').selectOption({ label: 'NOVAS' })
  await dialog.getByRole('button', { name: 'Add Sheet' }).click()

  await expect(page.getByTestId('sheet-tab')).toHaveText(['MM', 'NOVAS'])
  await expect(page.getByRole('tab', { name: 'NOVAS' })).toHaveAttribute('aria-selected', 'true')
  expect(state.sheets.filter((s) => s.version_id === VERSION_ID)).toHaveLength(2)
  // The copied MM hinge is flagged on the NOVAS sheet.
  const hingeRow = page.getByRole('row').filter({ hasText: 'MMHINGE' })
  await expect(hingeRow.getByTestId('other-supplier-badge')).toBeVisible()

  // Part suggestions: NOVAS parts only, unless other suppliers are allowed.
  await hingeRow.locator('td').nth(7).locator('div[tabindex]').dblclick()
  await page.getByPlaceholder('SKU...').fill('HINGE')
  await expect(page.getByRole('listbox', { name: 'Part suggestions' }).getByRole('option')).toHaveCount(1)
  await expect(page.getByRole('listbox', { name: 'Part suggestions' }).getByRole('option')).toContainText('NV-HINGE')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.getByTestId('other-suppliers-toggle').check()
  await hingeRow.locator('td').nth(7).locator('div[tabindex]').dblclick()
  await page.getByPlaceholder('SKU...').fill('HINGE')
  await expect(page.getByRole('listbox', { name: 'Part suggestions' }).getByRole('option')).toHaveCount(2)
  // Swap to the NOVAS hinge: the flag goes away.
  await page.getByRole('option', { name: /NV-HINGE/ }).click()
  const novasRow = page.getByRole('row').filter({ hasText: 'NV-HINGE' })
  await expect(novasRow).toBeVisible()
  await expect(novasRow.getByTestId('other-supplier-badge')).toHaveCount(0)
  await expect
    .poll(() => state.lines.find((l) => l.sheet_id !== sheetIdFor(VERSION_ID) && l.sku === 'NV-HINGE')?.unit_price)
    .toBe(6)
  // The MM sheet still has the MM hinge.
  await page.getByRole('tab', { name: 'MM' }).click()
  await expect(page.getByRole('row').filter({ hasText: 'MMHINGE' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'NV-HINGE' })).toHaveCount(0)

  // Rename the NOVAS sheet.
  await page.getByRole('tab', { name: 'NOVAS' }).click()
  await page.getByRole('button', { name: 'Rename the NOVAS sheet' }).click()
  await page.getByLabel('Sheet name').fill('Novas (option B)')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('sheet-tab')).toHaveText(['MM', 'Novas (option B)'])

  // Export: one worksheet per sheet.
  await page.getByRole('button', { name: 'Export Excel' }).click()
  const now = new Date()
  await page.locator(`[data-day="${now.getMonth() + 1}/15/${now.getFullYear()}"]`).first().click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download' }).click()
  const download = await downloadPromise
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile((await download.path())!)
  expect(wb.worksheets.map((w) => w.name)).toEqual(['MM', 'Novas (option B)'])
  expect(wb.getWorksheet('MM')!.getCell('C7').value).toBe('MMHINGE')
  expect(wb.getWorksheet('Novas (option B)')!.getCell('C7').value).toBe('NV-HINGE')
})

test('PM comments on one supplier sheet', async ({ page }) => {
  const state = await mockSupabase(page, 'pm', {
    ...COMMENT_SEED('submitted'),
    sheets: [
      { id: sheetIdFor(VERSION_ID), version_id: VERSION_ID, supplier_id: SUPPLIER_ID, name: 'MM', position: 0, created_at: TS, updated_at: TS },
      { id: 'sheet-nv', version_id: VERSION_ID, supplier_id: SUPPLIER2_ID, name: 'NOVAS', position: 1, created_at: TS, updated_at: TS },
    ],
  })
  await signIn(page, 'pm')
  await page.goto(`/projects/${PROJECT_ID}/hardware`)

  await page.getByRole('tab', { name: 'NOVAS' }).click()
  await page.getByRole('button', { name: 'PM Comments (0)' }).click()
  const drawer = page.getByTestId('comments-drawer')
  // New comments point at the sheet open in the grid.
  await expect(drawer.getByLabel('for', { exact: true })).toHaveValue('sheet-nv')
  await drawer.getByPlaceholder('Write a comment for the estimators...').fill('NOVAS is cheaper on hinges')
  await drawer.getByRole('button', { name: 'Post comment' }).click()

  await expect.poll(() => state.comments.length).toBe(1)
  expect(state.comments[0]).toMatchObject({ version_id: VERSION_ID, sheet_id: 'sheet-nv', door_group_id: null })
  await expect(drawer.getByTestId('comment-sheet')).toHaveText('Sheet: NOVAS')
  // The tab shows the count.
  await expect(page.getByRole('tab', { name: /^NOVAS\s*1$/ })).toBeVisible()
})

test('Awarded project: the other quotes are read-only and no quote can be added', async ({ page }) => {
  await mockSupabase(page, 'estimator', {
    project: {
      ...existingProject(PM_ID),
      stage: 'awarded',
      awarded_quote_id: QUOTE2_ID,
      awarded_supplier_id: SUPPLIER_ID,
    },
    estimators: [assignedEstimator(PM_ID)],
    quotes: [
      { id: QUOTE_ID, project_id: PROJECT_ID, builder_name: BUILDER, created_by: PM_ID, created_at: TS, updated_at: TS },
      { id: QUOTE2_ID, project_id: PROJECT_ID, builder_name: 'Bolt Construct', created_by: PM_ID, created_at: '2026-11-18T01:00:00Z', updated_at: TS },
    ],
    versions: [
      {
        id: VERSION_ID, project_id: PROJECT_ID, quote_id: QUOTE_ID, version_no: 1, status: 'draft',
        upload_id: UPLOAD_ID, markup_pct: 15, created_by: ESTIMATOR_ID,
        submitted_at: null, created_at: TS, updated_at: TS,
      },
      {
        id: VERSION2_ID, project_id: PROJECT_ID, quote_id: QUOTE2_ID, version_no: 1, status: 'approved',
        upload_id: UPLOAD_ID, markup_pct: 15, created_by: ESTIMATOR_ID,
        submitted_at: TS, created_at: TS, updated_at: TS,
      },
    ],
    doorGroups: COMMENT_SEED('draft').doorGroups,
    lines: COMMENT_SEED('draft').lines,
  })
  await signIn(page, 'estimator')
  await page.goto(`/projects/${PROJECT_ID}`)

  // Overview: the winner is marked, the other quote is read-only, no New Quote.
  const rows = page.getByTestId('hardware-quote-row')
  await expect(rows.filter({ hasText: 'Bolt Construct' })).toContainText('Awarded · MM')
  await expect(rows.filter({ hasText: BUILDER })).toContainText('Not awarded (read-only)')
  await expect(page.getByRole('button', { name: 'New Quote' })).toHaveCount(0)
  await expect(page.getByText('Awarded — no new quotes.')).toBeVisible()

  // The losing quote opens read-only: no submit, no sheet changes, no editing.
  await page.goto(`/projects/${PROJECT_ID}/hardware?quote=${QUOTE_ID}`)
  await expect(page.getByText('The project was awarded to another quote; this one is read-only.')).toBeVisible()
  await expect(page.getByText('LOBBY')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Submit for Approval' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Re-import Quotation' })).toHaveCount(0)
  await expect(page.getByTestId('add-sheet')).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'ACTIONS' })).toHaveCount(0)

  // The quote switcher marks the winner.
  await expect(page.getByTestId('quote-select').locator('option')).toHaveText([
    BUILDER,
    'Bolt Construct (awarded)',
  ])
})
