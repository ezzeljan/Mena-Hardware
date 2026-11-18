import { z } from 'zod'

export const userRoleSchema = z.enum(['admin', 'estimator', 'pm', 'viewer'])

export const leafTypeSchema = z.enum(['SINGLE', 'DOUBLE', 'CAVITY SINGLE', 'CAVITY DOUBLE', 'TRIPLE', ''])

export const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
})

export type LoginFormValues = z.infer<typeof loginSchema>

export const signUpSchema = z.object({
  full_name: z.string().trim().min(2, 'Full name is required'),
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
})

export type SignUpFormValues = z.infer<typeof signUpSchema>

export const manufacturerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Manufacturer name is required')
    .max(100, 'Manufacturer name is too long')
    .transform((v) => v.toUpperCase()),
  is_owner_supplied: z.boolean(),
})

export type ManufacturerFormValues = z.infer<typeof manufacturerSchema>

/**
 * Helper for nullable numeric fields (unit_cost and unit_price):
 * An empty string or null/undefined becomes `null` intentionally (never defaults to 0).
 */
export const nullablePriceSchema = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((val, ctx) => {
    if (val === null || val === undefined) return null
    if (typeof val === 'number') {
      if (Number.isNaN(val)) return null
      if (val < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Price cannot be negative',
        })
        return z.NEVER
      }
      return val
    }
    const trimmed = val.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || parsed < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a valid non-negative number or leave blank for no price',
      })
      return z.NEVER
    }
    return Math.round(parsed * 1000) / 1000
  })

export const partFormSchema = z.object({
  sku: z.string().trim().min(1, 'SKU is required').max(120, 'SKU is too long'),
  manufacturer_id: z.string().uuid('Select a manufacturer'),
  description: z.string().trim().min(1, 'Description is required'),
  unit_cost: z.string().refine(
    (val) => {
      const t = val.trim()
      if (t === '') return true
      const n = Number(t)
      return Number.isFinite(n) && n >= 0
    },
    { message: 'Enter a valid non-negative cost or leave blank for no unit price' },
  ),
  active: z.boolean(),
})

export type PartFormValues = z.infer<typeof partFormSchema>

export function parseNullablePriceInput(raw: string): number | null {
  return nullablePriceSchema.parse(raw)
}

export const standardSetSchema = z.object({
  room_name: z.string().trim().min(1, 'Room name is required'),
  classification: z.string().trim().min(1, 'Classification is required'),
  leaf: leafTypeSchema,
  door_size: z.string().trim().min(1, 'Door size is required'),
  active: z.boolean(),
})

export type StandardSetFormValues = z.infer<typeof standardSetSchema>

export const standardSetLineSchema = z.object({
  sku: z.string().trim().min(1, 'Part number (SKU) is required'),
  description: z.string().trim().min(1, 'Description is required'),
  qty: z
    .string()
    .refine(
      (val) => {
        const n = Number(val.trim())
        return Number.isFinite(n) && n > 0
      },
      { message: 'Quantity must be greater than 0' },
    ),
  unit_price: z.string().refine(
    (val) => {
      const t = val.trim()
      if (t === '') return true
      const n = Number(t)
      return Number.isFinite(n) && n >= 0
    },
    { message: 'Enter a valid non-negative price or leave blank' },
  ),
})

export type StandardSetLineFormValues = z.infer<typeof standardSetLineSchema>

export const updateUserRoleSchema = z.object({
  userId: z.string().uuid(),
  role: userRoleSchema,
})

export const projectStatusSchema = z.enum(['active', 'archived'])

export const projectFormSchema = z.object({
  reference_no: z.string().trim().max(40, 'Reference No. is too long'),
  name: z.string().trim().min(1, 'Project name is required').max(160, 'Project name is too long'),
  client: z.string().trim().max(160, 'Client name is too long'),
  site: z.string().trim().max(200, 'Site address is too long'),
  status: projectStatusSchema,
  assigned_pm: z.string().refine(
    (val) => val === '' || z.string().uuid().safeParse(val).success,
    { message: 'Invalid PM selection' },
  ),
})

export type ProjectFormValues = z.infer<typeof projectFormSchema>
