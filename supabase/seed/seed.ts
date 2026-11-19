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
  const shouldPrune = process.argv.includes('--prune')
  const forceOverwrite = process.argv.includes('--force-overwrite')
  const xlsxPath = path.resolve(__dirname, '../../DOOR_HARDWARE_SET_1.xlsx')

  const parsed = await parseHardwareWorkbook(xlsxPath)
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

  const isLocalDb = databaseUrl.includes('127.0.0.1') || databaseUrl.includes('localhost')
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: isLocalDb ? false : { rejectUnauthorized: false },
  })

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

    // 2. Insert new Parts idempotently (preserves admin UI edits unless --force-overwrite is passed)
    let insertedOrUpdatedParts = 0
    for (const part of parsed.parts) {
      const mfgId = mfgIdByName.get(part.manufacturer)
      if (!mfgId) {
        throw new Error(`Missing manufacturer ID for ${part.manufacturer}`)
      }

      const partSeedKey = `part:${part.sku}`
      const res = forceOverwrite
        ? await client.query(
            `insert into public.parts (sku, manufacturer_id, description, unit_cost, active, seed_key)
             values ($1, $2, $3, $4, true, $5)
             on conflict (sku) do update
               set manufacturer_id = excluded.manufacturer_id,
                   description = excluded.description,
                   unit_cost = excluded.unit_cost,
                   active = true,
                   seed_key = coalesce(public.parts.seed_key, excluded.seed_key)
             where public.parts.manufacturer_id is distinct from excluded.manufacturer_id
                or public.parts.description is distinct from excluded.description
                or public.parts.unit_cost is distinct from excluded.unit_cost
                or public.parts.active is distinct from true
                or public.parts.seed_key is distinct from coalesce(public.parts.seed_key, excluded.seed_key)`,
            [part.sku, mfgId, part.description, part.unit_cost, partSeedKey],
          )
        : await client.query(
            `insert into public.parts (sku, manufacturer_id, description, unit_cost, active, seed_key)
             values ($1, $2, $3, $4, true, $5)
             on conflict (sku) do update
               set seed_key = excluded.seed_key
             where public.parts.seed_key is null`,
            [part.sku, mfgId, part.description, part.unit_cost, partSeedKey],
          )
      insertedOrUpdatedParts += res.rowCount ?? 0
    }

    // Optional --prune: deactivate ONLY seed-originated parts no longer in the workbook
    let deactivatedParts = 0
    if (shouldPrune) {
      const activeSkus = parsed.parts.map((p) => p.sku)
      const pruneRes = await client.query(
        `update public.parts
         set active = false
         where seed_key is not null
           and active = true
           and not (sku = any($1::text[]))`,
        [activeSkus],
      )
      deactivatedParts = pruneRes.rowCount ?? 0
    }

    // 3. Upsert Standard Sets & Lines using stable content-based seed_key (not row index)
    let insertedOrUpdatedSets = 0
    let insertedOrUpdatedLines = 0
    let prunedLines = 0
    const activeSetSeedKeys: string[] = []

    for (const set of parsed.sets) {
      activeSetSeedKeys.push(set.seedKey)
      const setId = deterministicUuid(set.seedKey)

      const setRes = forceOverwrite
        ? await client.query(
            `insert into public.standard_sets (id, room_name, classification, leaf, door_size, active, seed_key)
             values ($1, $2, $3, $4, $5, true, $6)
             on conflict (id) do update
               set room_name = excluded.room_name,
                   classification = excluded.classification,
                   leaf = excluded.leaf,
                   door_size = excluded.door_size,
                   seed_key = coalesce(public.standard_sets.seed_key, excluded.seed_key)
             where public.standard_sets.room_name is distinct from excluded.room_name
                or public.standard_sets.classification is distinct from excluded.classification
                or public.standard_sets.leaf is distinct from excluded.leaf
                or public.standard_sets.door_size is distinct from excluded.door_size
                or public.standard_sets.seed_key is distinct from coalesce(public.standard_sets.seed_key, excluded.seed_key)`,
            [setId, set.room_name, set.classification, set.leaf, set.door_size, set.seedKey],
          )
        : await client.query(
            `insert into public.standard_sets (id, room_name, classification, leaf, door_size, active, seed_key)
             values ($1, $2, $3, $4, $5, true, $6)
             on conflict (id) do update
               set seed_key = excluded.seed_key
             where public.standard_sets.seed_key is null`,
            [setId, set.room_name, set.classification, set.leaf, set.door_size, set.seedKey],
          )
      insertedOrUpdatedSets += setRes.rowCount ?? 0

      // Clean up legacy index-based set ID if migrating from old seed format
      const legacySetId = deterministicUuid(`standard_set:${set.setIndex}`)
      const targetSetRes = await client.query<{ id: string }>(
        `select id from public.standard_sets where seed_key = $1 or id = $2 limit 1`,
        [set.seedKey, setId],
      )
      const resolvedSetId = targetSetRes.rows[0]?.id ?? setId

      for (const line of set.lines) {
        const lineSeedKey = `${set.seedKey}:line:${line.position}`
        const lineId = deterministicUuid(lineSeedKey)
        const lineRes = forceOverwrite
          ? await client.query(
              `insert into public.standard_set_lines (id, set_id, position, sku, description, qty, unit_price, seed_key)
               values ($1, $2, $3, $4, $5, $6, $7, $8)
               on conflict (id) do update
                 set position = excluded.position,
                     sku = excluded.sku,
                     description = excluded.description,
                     qty = excluded.qty,
                     unit_price = excluded.unit_price,
                     seed_key = coalesce(public.standard_set_lines.seed_key, excluded.seed_key)
               where public.standard_set_lines.position is distinct from excluded.position
                  or public.standard_set_lines.sku is distinct from excluded.sku
                  or public.standard_set_lines.description is distinct from excluded.description
                  or public.standard_set_lines.qty is distinct from excluded.qty
                  or public.standard_set_lines.unit_price is distinct from excluded.unit_price
                  or public.standard_set_lines.seed_key is distinct from coalesce(public.standard_set_lines.seed_key, excluded.seed_key)`,
              [lineId, resolvedSetId, line.position, line.sku, line.description, line.qty, line.unit_price, lineSeedKey],
            )
          : await client.query(
              `insert into public.standard_set_lines (id, set_id, position, sku, description, qty, unit_price, seed_key)
               values ($1, $2, $3, $4, $5, $6, $7, $8)
               on conflict (id) do nothing`,
              [lineId, resolvedSetId, line.position, line.sku, line.description, line.qty, line.unit_price, lineSeedKey],
            )
        insertedOrUpdatedLines += lineRes.rowCount ?? 0
      }

      if (shouldPrune) {
        const pruneLinesRes = await client.query(
          `delete from public.standard_set_lines
           where set_id = $1
             and seed_key is not null
             and position > $2`,
          [resolvedSetId, set.lines.length],
        )
        prunedLines += pruneLinesRes.rowCount ?? 0

        if (legacySetId !== resolvedSetId) {
          await client.query(
            `delete from public.standard_sets where id = $1 and seed_key is null`,
            [legacySetId],
          )
        }
      }
    }

    let deactivatedSets = 0
    if (shouldPrune) {
      const pruneSetsRes = await client.query(
        `update public.standard_sets
         set active = false
         where seed_key is not null
           and active = true
           and not (seed_key = any($1::text[]))`,
        [activeSetSeedKeys],
      )
      deactivatedSets = pruneSetsRes.rowCount ?? 0
    }

    await client.query('COMMIT')
    console.log(
      `\nSeed completed successfully: ${insertedOrUpdatedParts} parts, ${insertedOrUpdatedSets} standard sets, ${insertedOrUpdatedLines} set lines inserted/updated.` +
        (shouldPrune
          ? ` Pruned: ${deactivatedParts} stale seeded parts deactivated, ${deactivatedSets} stale seeded sets deactivated, ${prunedLines} extra seeded lines removed.`
          : ''),
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
