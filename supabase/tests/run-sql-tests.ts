import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../.env') })

async function runTests(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL is not set in supabase/.env or environment.')
    process.exit(1)
  }

  const testFiles = [
    path.resolve(__dirname, './rls_policies.test.sql'),
    path.resolve(__dirname, './phase2_rls.test.sql'),
    path.resolve(__dirname, './notifications.test.sql'),
    path.resolve(__dirname, './profile_avatars.test.sql'),
    path.resolve(__dirname, './activity.test.sql'),
    path.resolve(__dirname, './project_stage.test.sql'),
    path.resolve(__dirname, './version_comments.test.sql'),
    path.resolve(__dirname, './line_remarks.test.sql'),
    path.resolve(__dirname, './quotes_sheets.test.sql'),
    path.resolve(__dirname, './part_folders.test.sql'),
    path.resolve(__dirname, './delete_quote.test.sql'),
  ]

  const isLocalDb = databaseUrl.includes('127.0.0.1') || databaseUrl.includes('localhost')
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: isLocalDb ? false : { rejectUnauthorized: false },
  })
  try {
    await client.connect()
    client.on('notice', (msg) => {
      if (msg.message) {
        console.log(`NOTICE: ${msg.message}`)
      }
    })
    for (const file of testFiles) {
      if (fs.existsSync(file)) {
        const sql = fs.readFileSync(file, 'utf-8')
        await client.query(sql)
      }
    }
    console.log('SQL Role & RLS test suite completed successfully.')
  } catch (err) {
    console.error('SQL Test Suite Failed:', err)
    process.exit(1)
  } finally {
    await client.end()
  }
}

void runTests()
