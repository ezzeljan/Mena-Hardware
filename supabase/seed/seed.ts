import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'
import { formatSeedReport, parseHardwareWorkbook } from './parser.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const SEED_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

function deterministicUuid(key: string): string {
  const hash = crypto.createHash('sha1').update(`${SEED_NAMESPACE}:${key}`).digest('hex')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '5' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-')
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes('--dry-run')
  const xlsxPath = path.resolve(__dirname, '../../DOOR_HARDWARE_SET_1.xlsx')

  const parsed = parseHardwareWorkbook(xlsxPath)
  console.log(formatSeedReport(parsed))

  if (isDryRun) {
    console.log('\nDry run completed (--dry-run). No database rows were modified.')
    return
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('\nError: DATABASE_URL is not set in supabase/.env or environment.')
    console.error('To preview the seed report without a database connection, run: npm run seed:dry-run')
    process.exit(1)
  }

  const client = new pg.Client({ connectionString: databaseUrl })
  try {
    await client.connect()
    await client.query('BEGIN')

    // 1. Upsert Manufacturers idempotently
    const mfgIdByName = new Map<string, string>()
    for (const mfg of parsed.manufacturers) {
      const res = await client.query<{ id: string }>(
        `insert into public.manufacturers (name, is_owner_supplied)
         values ($1, $2)
         on conflict (name) do update
           set is_owner_supplied = excluded.is_owner_supplied
         where public.manufacturers.is_owner_supplied is distinct from excluded.is_owner_supplied
         returning id`,
        [mfg.name, mfg.is_owner_supplied],
      )

      if (res.rows[0]) {
        mfgIdByName.set(mfg.name, res.rows[0].id)
      } else {
        const existing = await client.query<{ id: string }>(
          `select id from public.manufacturers where name = $1`,
          [mfg.name],
        )
        if (existing.rows[0]) {
          mfgIdByName.set(mfg.name, existing.rows[0].id)
        }
      }
    }

    // 2. Upsert Parts idempotently (only updates if values actually changed, preventing spurious price history rows)
    let insertedOrUpdatedParts = 0
    for (const part of parsed.parts) {
      const mfgId = mfgIdByName.get(part.manufacturer)
      if (!mfgId) {
        throw new Error(`Missing manufacturer ID for ${part.manufacturer}`)
      }

      const res = await client.query(
        `insert into public.parts (sku, manufacturer_id, description, unit_cost, active)
         values ($1, $2, $3, $4, true)
         on conflict (sku) do update
           set manufacturer_id = excluded.manufacturer_id,
               description = excluded.description,
               unit_cost = excluded.unit_cost
         where public.parts.manufacturer_id is distinct from excluded.manufacturer_id
            or public.parts.description is distinct from excluded.description
            or public.parts.unit_cost is distinct from excluded.unit_cost`,
        [part.sku, mfgId, part.description, part.unit_cost],
      )
      insertedOrUpdatedParts += res.rowCount ?? 0
    }

    // 3. Upsert all 65 Standard Sets and their Lines idempotently using deterministic UUIDs
    let insertedOrUpdatedSets = 0
    let insertedOrUpdatedLines = 0

    for (const set of parsed.sets) {
      const setId = deterministicUuid(`standard_set:${set.setIndex}`)

      const setRes = await client.query(
        `insert into public.standard_sets (id, room_name, classification, leaf, door_size, active)
         values ($1, $2, $3, $4, $5, true)
         on conflict (id) do update
           set room_name = excluded.room_name,
               classification = excluded.classification,
               leaf = excluded.leaf,
               door_size = excluded.door_size
         where public.standard_sets.room_name is distinct from excluded.room_name
            or public.standard_sets.classification is distinct from excluded.classification
            or public.standard_sets.leaf is distinct from excluded.leaf
            or public.standard_sets.door_size is distinct from excluded.door_size`,
        [setId, set.room_name, set.classification, set.leaf, set.door_size],
      )
      insertedOrUpdatedSets += setRes.rowCount ?? 0

      for (const line of set.lines) {
        const lineId = deterministicUuid(`standard_set_line:${set.setIndex}:${line.position}`)
        const lineRes = await client.query(
          `insert into public.standard_set_lines (id, set_id, position, sku, description, qty, unit_price)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (id) do update
             set position = excluded.position,
                 sku = excluded.sku,
                 description = excluded.description,
                 qty = excluded.qty,
                 unit_price = excluded.unit_price
           where public.standard_set_lines.position is distinct from excluded.position
              or public.standard_set_lines.sku is distinct from excluded.sku
              or public.standard_set_lines.description is distinct from excluded.description
              or public.standard_set_lines.qty is distinct from excluded.qty
              or public.standard_set_lines.unit_price is distinct from excluded.unit_price`,
          [lineId, setId, line.position, line.sku, line.description, line.qty, line.unit_price],
        )
        insertedOrUpdatedLines += lineRes.rowCount ?? 0
      }
    }

    await client.query('COMMIT')
    console.log(
      `\nSeed completed successfully: ${insertedOrUpdatedParts} parts, ${insertedOrUpdatedSets} standard sets, ${insertedOrUpdatedLines} set lines inserted/updated.`,
    )
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Seed failed:', err)
    process.exit(1)
  } finally {
    await client.end()
  }
}

void main()
