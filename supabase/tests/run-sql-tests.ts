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

  const sqlPath = path.resolve(__dirname, './rls_policies.test.sql')
  const sql = fs.readFileSync(sqlPath, 'utf-8')

  const client = new pg.Client({ connectionString: databaseUrl })
  try {
    await client.connect()
    client.on('notice', (msg) => {
      if (msg.message) {
        console.log(`NOTICE: ${msg.message}`)
      }
    })
    await client.query(sql)
    console.log('SQL Role & RLS test suite completed successfully.')
  } catch (err) {
    console.error('SQL Test Suite Failed:', err)
    process.exit(1)
  } finally {
    await client.end()
  }
}

void runTests()
