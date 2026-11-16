export type UserRole = 'admin' | 'estimator' | 'pm' | 'viewer'

export type LeafType = 'SINGLE' | 'DOUBLE' | 'CAVITY SINGLE' | ''

export interface Profile {
  id: string
  full_name: string
  role: UserRole
  created_at: string
}

export interface Manufacturer {
  id: string
  name: string
  is_owner_supplied: boolean
  created_at: string
  updated_at: string
}

export interface Part {
  id: string
  sku: string
  manufacturer_id: string
  description: string
  unit_cost: number | null
  active: boolean
  created_at: string
  updated_at: string
  manufacturers?: Pick<Manufacturer, 'id' | 'name' | 'is_owner_supplied'> | null
}

export interface PartPriceHistory {
  id: string
  part_id: string
  unit_cost: number | null
  effective_from: string
  changed_by: string | null
}

export interface StandardSet {
  id: string
  room_name: string
  classification: string
  leaf: LeafType
  door_size: string
  active: boolean
  created_at: string
  updated_at: string
  standard_set_lines?: StandardSetLine[]
}

export interface StandardSetLine {
  id: string
  set_id: string
  position: number
  sku: string
  description: string
  qty: number
  unit_price: number | null
  created_at: string
  updated_at: string
}
