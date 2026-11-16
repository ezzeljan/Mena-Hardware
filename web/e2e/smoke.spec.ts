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

  await page.route('**/rest/v1/manufacturers**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
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
      ]),
    })
  })

  await page.route('**/rest/v1/parts**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: '44444444-4444-4444-4444-444444444444',
          sku: '6125SSS',
          manufacturer_id: '33333333-3333-3333-3333-333333333333',
          description: 'NOVAS 6000 SERIES VESTIBULE LOCK 60MM BACKSET SSS',
          unit_cost: 54,
          active: true,
          created_at: '2026-11-16T00:00:00Z',
          updated_at: '2026-11-16T00:00:00Z',
          manufacturers: {
            id: '33333333-3333-3333-3333-333333333333',
            name: 'NOVAS',
            is_owner_supplied: false,
          },
        },
        {
          id: '55555555-5555-5555-5555-555555555555',
          sku: '505BC+SLC',
          manufacturer_id: '22222222-2222-2222-2222-222222222222',
          description: 'SLIDING ARM DOOR CLOSER',
          unit_cost: null,
          active: true,
          created_at: '2026-11-16T00:00:00Z',
          updated_at: '2026-11-16T00:00:00Z',
          manufacturers: {
            id: '22222222-2222-2222-2222-222222222222',
            name: 'MM',
            is_owner_supplied: true,
          },
        },
      ]),
    })
  })

  // 1. Navigate to root -> redirects to /login
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'MENA HARDWARE' })).toBeVisible()

  // 2. Fill credentials and sign in
  await page.getByLabel('Email').fill('admin@menacontractors.com')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign In' }).click()

  // 3. Verify Parts Library opens with parts and the "No unit price" marker
  await expect(page.getByRole('heading', { name: 'Parts Library' })).toBeVisible()
  await expect(page.getByText('6125SSS')).toBeVisible()
  await expect(page.getByText('505BC+SLC')).toBeVisible()
  await expect(page.getByTestId('no-unit-price-marker')).toHaveText('No unit price')
})
