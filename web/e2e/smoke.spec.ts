import { expect, test } from '@playwright/test'

const FAKE_USER_ID = '11111111-1111-1111-1111-111111111111'

test('log in and open parts library (smoke test)', async ({ page }) => {
  // Mock Supabase Auth & REST endpoints so the smoke test runs reliably in CI or local without external state
  await page.route('**/auth/v1/token**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'mock-access-token',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'mock-refresh-token',
        user: {
          id: FAKE_USER_ID,
          aud: 'authenticated',
          role: 'authenticated',
          email: 'admin@menacontractors.com',
          user_metadata: { full_name: 'Admin User' },
        },
      }),
    })
  })

  await page.route('**/auth/v1/user**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: FAKE_USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'admin@menacontractors.com',
      }),
    })
  })

  await page.route('**/rest/v1/profiles**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: FAKE_USER_ID,
        full_name: 'Admin User',
        role: 'admin',
        created_at: '2026-11-16T00:00:00Z',
      }),
    })
  })

  await page.route('**/rest/v1/suppliers**', async (route) => {
    const list = [
        {
          id: '22222222-2222-2222-2222-222222222222',
          name: 'MM',
          is_owner_supplied: true,
          created_at: '2026-11-16T00:00:00Z',
          updated_at: '2026-11-16T00:00:00Z',
        },
        {
          id: '33333333-3333-3333-3333-333333333333',
          name: 'NOVAS',
          is_owner_supplied: false,
          created_at: '2026-11-16T00:00:00Z',
          updated_at: '2026-11-16T00:00:00Z',
        },
    ]
    // One supplier by id (maybeSingle) for the supplier products page.
    const id = new URL(route.request().url()).searchParams.get('id')?.replace(/^eq\./, '')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(id ? (list.find((s) => s.id === id) ?? null) : list),
    })
  })

  const LOCKS_FOLDER = '66666666-6666-6666-6666-666666666666'
  const folders: Array<Record<string, unknown>> = [
    { id: LOCKS_FOLDER, name: 'Locks & latches', position: 1, created_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z' },
  ]
  const createdFolders: Array<Record<string, unknown>> = []
  await page.route('**/rest/v1/part_folders**', async (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as Record<string, unknown>
      createdFolders.push(payload)
      folders.push({ id: '77777777-7777-7777-7777-777777777777', created_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z', ...payload })
      await route.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(folders) })
  })

  await page.route('**/rest/v1/parts**', async (route) => {
    const list = [
        {
          id: '44444444-4444-4444-4444-444444444444',
          sku: '6125SSS',
          supplier_id: '33333333-3333-3333-3333-333333333333',
          description: 'NOVAS 6000 SERIES VESTIBULE LOCK 60MM BACKSET SSS',
          unit_cost: 54,
          active: true,
          folder_id: LOCKS_FOLDER,
          legend: 'L2',
          created_at: '2026-11-16T00:00:00Z',
          updated_at: '2026-11-16T00:00:00Z',
          suppliers: {
            id: '33333333-3333-3333-3333-333333333333',
            name: 'NOVAS',
            is_owner_supplied: false,
          },
        },
        {
          id: '55555555-5555-5555-5555-555555555555',
          sku: '505BC+SLC',
          supplier_id: '22222222-2222-2222-2222-222222222222',
          description: 'SLIDING ARM DOOR CLOSER',
          unit_cost: null,
          active: true,
          folder_id: null,
          legend: '',
          created_at: '2026-11-16T00:00:00Z',
          updated_at: '2026-11-16T00:00:00Z',
          suppliers: {
            id: '22222222-2222-2222-2222-222222222222',
            name: 'MM',
            is_owner_supplied: true,
          },
        },
        {
          id: '88888888-8888-8888-8888-888888888888',
          sku: '6100SSS',
          supplier_id: '33333333-3333-3333-3333-333333333333',
          description: 'NOVAS 6000 SERIES PASSAGE LATCH 60MM BACKSET SSS',
          unit_cost: 30,
          active: false,
          folder_id: null,
          legend: '',
          created_at: '2026-11-16T00:00:00Z',
          updated_at: '2026-11-16T00:00:00Z',
          suppliers: {
            id: '33333333-3333-3333-3333-333333333333',
            name: 'NOVAS',
            is_owner_supplied: false,
          },
        },
    ]
    const supplierId = new URL(route.request().url()).searchParams.get('supplier_id')?.replace(/^eq\./, '')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(supplierId ? list.filter((p) => p.supplier_id === supplierId) : list),
    })
  })

  // 1. Navigate to root -> redirects to /login
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'MENA HARDWARE' })).toBeVisible()

  // 2. Fill credentials and sign in
  await page.getByLabel('Email').fill('admin@menacontractors.com')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign In' }).click()

  // 3. Sign-in lands on the Dashboard; open the Parts Library and check the parts and the "No unit price" marker
  await expect(page.getByRole('heading', { name: 'Hi Admin!' })).toBeVisible()
  await page.getByRole('link', { name: 'Parts Library' }).click()
  await expect(page.getByRole('heading', { name: 'Parts Library' })).toBeVisible()
  await expect(page.getByText('6125SSS')).toBeVisible()
  await expect(page.getByText('505BC+SLC')).toBeVisible()
  await expect(page.getByTestId('no-unit-price-marker')).toHaveText('No unit price')

  // 4. Folders: All parts, each folder and Unfiled, with counts.
  const pane = page.getByRole('navigation', { name: 'Part folders' })
  await expect(pane.getByTestId('folder-item')).toHaveText(['All parts2', 'Locks & latches1', 'Unfiled1'])
  await pane.getByRole('button', { name: /Locks & latches/ }).click()
  await expect(page.getByRole('heading', { name: 'Locks & latches' })).toBeVisible()
  await expect(page.getByText('6125SSS')).toBeVisible()
  await expect(page.getByText('505BC+SLC')).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: '6125SSS' })).toContainText('L2')
  await pane.getByRole('button', { name: /Unfiled/ }).click()
  await expect(page.getByText('505BC+SLC')).toBeVisible()
  await expect(page.getByText('6125SSS')).toHaveCount(0)

  // 5. Admins add folders.
  await pane.getByRole('button', { name: 'New folder' }).click()
  await page.getByLabel('Folder name').fill('Hinges')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => createdFolders.length).toBe(1)
  expect(createdFolders[0]).toMatchObject({ name: 'Hinges', position: 2 })
  await expect(pane.getByRole('button', { name: /Hinges/ })).toBeVisible()

  // 6. Suppliers: clicking a supplier lists only its parts, with filters.
  await page.getByRole('link', { name: 'Suppliers' }).click()
  await page.getByRole('row').filter({ hasText: 'NOVAS' }).getByRole('cell').nth(1).click()
  await expect(page).toHaveURL(/\/suppliers\/33333333-3333-3333-3333-333333333333$/)
  await expect(page.getByRole('heading', { name: 'NOVAS' })).toBeVisible()
  await expect(page.getByText('1 active part · 1 inactive')).toBeVisible()
  await expect(page.getByText('6125SSS')).toBeVisible()
  await expect(page.getByText('505BC+SLC')).toHaveCount(0)
  await expect(page.getByText('6100SSS')).toHaveCount(0)
  await page.getByText('Show inactive parts').click()
  await expect(page.getByText('6100SSS')).toBeVisible()
  const folderSelect = page.getByLabel('Filter by folder')
  await folderSelect.selectOption({ label: 'Unfiled (1)' })
  await expect(page.getByText('6125SSS')).toHaveCount(0)
  await expect(page.getByText('6100SSS')).toBeVisible()
  await folderSelect.selectOption({ label: 'All folders (2)' })
  await page.getByLabel("Search this supplier's parts").fill('vestibule')
  await expect(page.getByText('6125SSS')).toBeVisible()
  await expect(page.getByText('6100SSS')).toHaveCount(0)
})
