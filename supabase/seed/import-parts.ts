/**
 * Parts library import from a review workbook (e.g. parts-folders-draft.xlsx).
 *
 *   npm run import:parts                      dry run with supabase/seed/parts-folders-draft.xlsx
 *   npm run import:parts -- <file.xlsx>       dry run with another file
 *   npm run import:parts -- <file> --apply    write everything in one transaction
 *
 * Sheets read:
 *   Folders  column A = folder names, in display order.
 *   Parts    Folder | Supplier | Part number | Legend | Description | Unit cost | Status | Active | ... | Notes
 *            One row per part, matched to the library by part number (SKU).
 *            Notes containing SKIP: the row is ignored.
 *            Unit cost: blank keeps an existing part's cost (a new part gets no price, never 0).
 *   Removed  Part number | ... | Replace with (part number)
 *            Standard set lines using the part are pointed at the replacement
 *            (SKU and description; their quantity and price stay), then the
 *            part is deleted. Quote lines keep their text.
 *
 * Suppliers and folders that don't exist yet are created. Parts in the
 * library that the workbook doesn't mention are left as they are (listed).
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type ExcelJS from 'exceljs'
import dotenv from 'dotenv'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../.env') })
const requireFromWeb = createRequire(path.resolve(__dirname, '../../web/package.json'))
const ExcelJSRuntime = requireFromWeb('exceljs') as typeof ExcelJS

interface PartRow {
  row: number
  folder: string
  supplier: string
  sku: string
  legend: string
  description: string
  cost: number | null
  active: boolean
}

interface RemovedRow {
  row: number
  sku: string
  replaceWith: string
}

const key = (s: string) => s.trim().toUpperCase()

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('')
    if ('result' in v) return v.result === null || v.result === undefined ? '' : String(v.result)
    if ('text' in v) return String(v.text)
    if (v instanceof Date) return v.toISOString()
    return ''
  }
  return String(v)
}

/** Header name -> column number, from row 1. */
function headerMap(ws: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>()
  ws.getRow(1).eachCell((cell, col) => map.set(key(cellText(cell.value)), col))
  return map
}

function col(map: Map<string, number>, sheet: string, ...names: string[]): number {
  for (const n of names) {
    const c = map.get(key(n))
    if (c) return c
  }
  throw new Error(`Sheet "${sheet}" has no "${names[0]}" column`)
}

async function readWorkbook(file: string) {
  const wb = new ExcelJSRuntime.Workbook()
  await wb.xlsx.readFile(file)
  const errors: string[] = []

  const partsWs = wb.getWorksheet('Parts')
  if (!partsWs) throw new Error('The workbook has no "Parts" sheet')
  const ph = headerMap(partsWs)
  const c = {
    folder: col(ph, 'Parts', 'Folder'),
    supplier: col(ph, 'Parts', 'Supplier'),
    sku: col(ph, 'Parts', 'Part number', 'SKU'),
    legend: col(ph, 'Parts', 'Legend'),
    description: col(ph, 'Parts', 'Description'),
    cost: col(ph, 'Parts', 'Unit cost'),
    active: col(ph, 'Parts', 'Active'),
    notes: col(ph, 'Parts', 'Notes'),
  }
  const parts: PartRow[] = []
  const skipped: string[] = []
  partsWs.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return
    const get = (i: number) => cellText(row.getCell(i).value).replace(/\s+/g, ' ').trim()
    const sku = get(c.sku)
    if (!sku) return
    if (/\bSKIP\b/i.test(get(c.notes))) {
      skipped.push(sku)
      return
    }
    const costText = get(c.cost).replace(/[$,]/g, '')
    const cost = costText === '' ? null : Number(costText)
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) errors.push(`Parts row ${n} (${sku}): unit cost "${costText}" is not a number`)
    const row_: PartRow = {
      row: n,
      folder: get(c.folder),
      supplier: get(c.supplier).toUpperCase(),
      sku,
      legend: get(c.legend),
      description: get(c.description),
      cost: cost !== null && Number.isFinite(cost) ? cost : null,
      active: !/^(no|n|false|0)$/i.test(get(c.active)),
    }
    if (!row_.supplier) errors.push(`Parts row ${n} (${sku}): no supplier`)
    if (!row_.description) errors.push(`Parts row ${n} (${sku}): no description`)
    if (row_.legend.length > 20) errors.push(`Parts row ${n} (${sku}): legend longer than 20 characters`)
    parts.push(row_)
  })

  const seen = new Map<string, number>()
  for (const p of parts) {
    const prev = seen.get(key(p.sku))
    if (prev) errors.push(`Part number ${p.sku} is on Parts rows ${prev} and ${p.row} (part numbers must be unique)`)
    seen.set(key(p.sku), p.row)
  }

  const folders: string[] = []
  const foldersWs = wb.getWorksheet('Folders')
  if (foldersWs) {
    foldersWs.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return
      const name = cellText(row.getCell(1).value).replace(/\s+/g, ' ').trim()
      if (name && !folders.some((f) => key(f) === key(name))) folders.push(name)
    })
  }
  for (const p of parts) {
    if (p.folder && !folders.some((f) => key(f) === key(p.folder))) folders.push(p.folder)
  }

  const removed: RemovedRow[] = []
  const removedWs = wb.getWorksheet('Removed')
  if (removedWs) {
    const rh = headerMap(removedWs)
    const rs = col(rh, 'Removed', 'Part number')
    const rr = col(rh, 'Removed', 'Replace with (part number)', 'Replace with')
    removedWs.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return
      const sku = cellText(row.getCell(rs).value).trim()
      if (!sku) return
      removed.push({ row: n, sku, replaceWith: cellText(row.getCell(rr).value).trim() })
    })
  }
  for (const r of removed) {
    if (seen.has(key(r.sku))) errors.push(`${r.sku} is both on the Parts sheet and the Removed sheet`)
  }

  return { parts, folders, removed, skipped, errors }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const fileArg = args.find((a) => !a.startsWith('--'))
  const file = path.resolve(process.cwd(), fileArg ?? path.resolve(__dirname, 'parts-folders-draft.xlsx'))

  console.log(`Parts import ${apply ? '(APPLY)' : '(dry run - nothing is written)'}`)
  console.log(`File: ${file}\n`)
  const wbData = await readWorkbook(file)

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is not set in supabase/.env')
  const isLocal = databaseUrl.includes('127.0.0.1') || databaseUrl.includes('localhost')
  const client = new pg.Client({ connectionString: databaseUrl, ssl: isLocal ? false : { rejectUnauthorized: false } })
  await client.connect()

  try {
    // Before migration 022 there are no folders or legends yet (dry run only).
    const hasFolders = (await client.query<{ t: string | null }>(
      "select to_regclass('public.part_folders')::text as t",
    )).rows[0].t !== null
    if (!hasFolders) {
      console.log('Note: migration 022 (folders, legend) is not applied to this database yet.')
      console.log('      The dry run treats every part as unfiled with no legend; --apply needs the migration.\n')
      if (apply) throw new Error('Apply migration 20261120000022_part_folders_and_legend.sql first.')
    }
    const suppliers = (await client.query<{ id: string; name: string }>('select id, name from public.suppliers')).rows
    const folders = hasFolders
      ? (await client.query<{ id: string; name: string; position: number }>(
          'select id, name, position from public.part_folders',
        )).rows
      : []
    const libParts = (await client.query<{
      id: string; sku: string; description: string; unit_cost: string | null; active: boolean
      legend: string; supplier_id: string; folder_id: string | null
    }>(
      hasFolders
        ? 'select id, sku, description, unit_cost, active, legend, supplier_id, folder_id from public.parts'
        : "select id, sku, description, unit_cost, active, '' as legend, supplier_id, null::uuid as folder_id from public.parts",
    )).rows
    const setUse = new Map(
      (await client.query<{ k: string; n: number }>(
        'select upper(btrim(sku)) k, count(*)::int n from public.standard_set_lines group by 1',
      )).rows.map((r) => [r.k, r.n]),
    )

    const supplierByName = new Map(suppliers.map((s) => [key(s.name), s]))
    const folderByName = new Map(folders.map((f) => [key(f.name), f]))
    const partBySku = new Map(libParts.map((p) => [key(p.sku), p]))
    const errors = [...wbData.errors]

    const newSuppliers = [...new Set(wbData.parts.map((p) => p.supplier))].filter((s) => s && !supplierByName.has(key(s)))
    const newFolders = wbData.folders.filter((f) => !folderByName.has(key(f)))
    const folderPositions = wbData.folders.map((name, i) => ({ name, position: i + 1 }))

    const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.name ?? '?'
    const folderName = (id: string | null) => (id ? folders.find((f) => f.id === id)?.name ?? '?' : '(unfiled)')

    const inserts: PartRow[] = []
    const updates: Array<{ row: PartRow; id: string; changes: string[] }> = []
    for (const p of wbData.parts) {
      const lib = partBySku.get(key(p.sku))
      if (!lib) {
        inserts.push(p)
        continue
      }
      const changes: string[] = []
      if (key(supplierName(lib.supplier_id)) !== key(p.supplier)) changes.push(`supplier ${supplierName(lib.supplier_id)} -> ${p.supplier}`)
      if (key(folderName(lib.folder_id)) !== key(p.folder || '(unfiled)')) changes.push(`folder ${folderName(lib.folder_id)} -> ${p.folder || '(unfiled)'}`)
      if ((lib.legend ?? '') !== p.legend) changes.push(`legend "${lib.legend}" -> "${p.legend}"`)
      if (lib.description !== p.description) changes.push(`description -> "${p.description}"`)
      if (p.cost !== null && Number(lib.unit_cost) !== p.cost) changes.push(`unit cost ${lib.unit_cost ?? 'none'} -> ${p.cost}`)
      if (lib.active !== p.active) changes.push(p.active ? 'reactivate' : 'deactivate')
      if (changes.length) updates.push({ row: p, id: lib.id, changes })
    }

    const workbookSkus = new Set(wbData.parts.map((p) => key(p.sku)))
    const removals: Array<{ id: string; sku: string; replace: string; replaceDescription: string; setLines: number }> = []
    const reactivateTargets = new Set<string>()
    for (const r of wbData.removed) {
      const lib = partBySku.get(key(r.sku))
      if (!lib) {
        errors.push(`Removed row ${r.row}: ${r.sku} is not in the library`)
        continue
      }
      let replaceDescription = ''
      if (r.replaceWith) {
        const inBook = wbData.parts.find((p) => key(p.sku) === key(r.replaceWith))
        const inLib = partBySku.get(key(r.replaceWith))
        if (!inBook && !inLib) errors.push(`Removed row ${r.row}: replacement ${r.replaceWith} is not on the Parts sheet or in the library`)
        if (wbData.removed.some((x) => key(x.sku) === key(r.replaceWith))) errors.push(`Removed row ${r.row}: replacement ${r.replaceWith} is itself removed`)
        replaceDescription = inBook?.description ?? inLib?.description ?? ''
        if (inBook && !inBook.active) reactivateTargets.add(inBook.sku)
        else if (!inBook && inLib && !inLib.active) reactivateTargets.add(inLib.sku)
      }
      removals.push({ id: lib.id, sku: lib.sku, replace: r.replaceWith, replaceDescription, setLines: setUse.get(key(lib.sku)) ?? 0 })
    }
    const removedSkus = new Set(removals.map((r) => key(r.sku)))
    const untouched = libParts.filter((p) => !workbookSkus.has(key(p.sku)) && !removedSkus.has(key(p.sku)))

    // ------------------------------------------------------------------ report
    const line = (s = '') => console.log(s)
    line(`Workbook: ${wbData.parts.length} parts, ${wbData.folders.length} folders, ${wbData.removed.length} removed, ${wbData.skipped.length} skipped (SKIP)`)
    line(`Library now: ${libParts.length} parts, ${suppliers.length} suppliers, ${folders.length} folders\n`)
    line(`New suppliers (${newSuppliers.length}): ${newSuppliers.join(', ') || '-'}`)
    line(`New folders (${newFolders.length}): ${newFolders.join(', ') || '-'}`)
    line(`\nNew parts (${inserts.length}):`)
    for (const p of inserts) line(`  + ${p.supplier.padEnd(10)} ${p.sku.padEnd(18)} ${(p.legend || '-').padEnd(5)} ${p.folder.padEnd(36)} ${p.cost === null ? 'no price' : '$' + p.cost}`)
    line(`\nUpdated parts (${updates.length}):`)
    for (const u of updates) line(`  ~ ${u.row.sku.padEnd(18)} ${u.changes.join('; ')}`)
    const reactivateExtra = [...reactivateTargets].filter((s) => !updates.some((u) => key(u.row.sku) === key(s) && u.changes.includes('reactivate')))
    if (reactivateExtra.length) line(`\nReactivated because a removed part is replaced by them: ${reactivateExtra.join(', ')}`)
    line(`\nRemoved parts (${removals.length}) - deleted; their standard set lines are pointed at the replacement:`)
    for (const r of removals) line(`  - ${r.sku.padEnd(18)} ${String(r.setLines).padStart(3)} set lines -> ${r.replace || '(no replacement: set lines keep their text)'}`)
    line(`  Standard set lines repointed: ${removals.filter((r) => r.replace).reduce((s, r) => s + r.setLines, 0)}; left as text: ${removals.filter((r) => !r.replace).reduce((s, r) => s + r.setLines, 0)}`)
    if (wbData.skipped.length) line(`\nSkipped rows (SKIP): ${wbData.skipped.join(', ')}`)
    line(`\nLibrary parts not in the workbook, left unchanged (${untouched.length}): ${untouched.map((p) => p.sku).join(', ') || '-'}`)
    if (errors.length) {
      line(`\nPROBLEMS (${errors.length}) - fix these in the workbook before applying:`)
      for (const e of errors) line(`  ! ${e}`)
    }

    if (!apply) {
      line('\nDry run finished. Nothing was written. Run with --apply to write it.')
      return
    }
    if (errors.length) throw new Error('Not applied: fix the problems above first.')

    // ------------------------------------------------------------------- apply
    await client.query('begin')
    try {
      for (const name of newSuppliers) {
        const r = await client.query<{ id: string; name: string }>(
          'insert into public.suppliers (name) values ($1) returning id, name', [name])
        supplierByName.set(key(name), r.rows[0])
      }
      for (const f of folderPositions) {
        const existing = folderByName.get(key(f.name))
        if (existing) {
          await client.query('update public.part_folders set name = $2, position = $3 where id = $1', [existing.id, f.name, f.position])
        } else {
          const r = await client.query<{ id: string; name: string; position: number }>(
            'insert into public.part_folders (name, position) values ($1, $2) returning id, name, position', [f.name, f.position])
          folderByName.set(key(f.name), r.rows[0])
        }
      }
      const folderId = (name: string) => (name ? folderByName.get(key(name))?.id ?? null : null)
      const supplierId = (name: string) => {
        const s = supplierByName.get(key(name))
        if (!s) throw new Error(`Supplier ${name} missing`)
        return s.id
      }
      for (const p of inserts) {
        await client.query(
          `insert into public.parts (sku, supplier_id, description, unit_cost, active, folder_id, legend)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [p.sku, supplierId(p.supplier), p.description, p.cost, p.active, folderId(p.folder), p.legend])
      }
      for (const u of updates) {
        const p = u.row
        await client.query(
          `update public.parts
           set supplier_id = $2, description = $3, unit_cost = coalesce($4, unit_cost), active = $5,
               folder_id = $6, legend = $7
           where id = $1`,
          [u.id, supplierId(p.supplier), p.description, p.cost, p.active, folderId(p.folder), p.legend])
      }
      for (const sku of reactivateTargets) {
        await client.query('update public.parts set active = true where upper(btrim(sku)) = $1', [key(sku)])
      }
      for (const r of removals) {
        if (r.replace) {
          await client.query(
            `update public.standard_set_lines set sku = $2, description = $3
             where upper(btrim(sku)) = $1`,
            [key(r.sku), r.replace, r.replaceDescription])
        }
        await client.query('delete from public.parts where id = $1', [r.id])
      }
      await client.query('commit')
      line('\nApplied and committed.')
    } catch (err) {
      await client.query('rollback')
      throw err
    }
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
