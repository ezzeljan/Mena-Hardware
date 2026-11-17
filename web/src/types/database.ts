export type UserRole = 'admin' | 'estimator' | 'pm' | 'viewer'

export type LeafType = 'SINGLE' | 'DOUBLE' | 'CAVITY SINGLE' | ''

export interface Profile {
  id: string
  full_name: string
  email: string
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

export type ProjectStatus = 'active' | 'archived'
export type VersionStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'changes_requested'
  | 'superseded'
export type MatchStatus = 'auto' | 'confirmed' | 'manual' | 'unmatched'
export type LineOrigin = 'set' | 'added' | 'edited'
export type ApprovalAction = 'submit' | 'approve' | 'reject'

export interface Project {
  id: string
  name: string
  client: string
  site: string
  status: ProjectStatus
  created_by: string
  assigned_pm: string | null
  created_at: string
  updated_at: string
}

export interface QuotationUpload {
  id: string
  project_id: string
  storage_path: string
  original_filename: string
  uploaded_by: string
  parse_report: Record<string, unknown>
  created_at: string
}

export interface QuotationDoor {
  id: string
  upload_id: string
  door_ref: string
  room_name: string
  classification: string
  leaf: string
  door_size: string
  qty: number
  source_row: number
  created_at: string
}

export interface ProjectVersion {
  id: string
  project_id: string
  version_no: number
  status: VersionStatus
  upload_id: string | null
  markup_pct: number
  created_by: string
  submitted_at: string | null
  created_at: string
  updated_at: string
}

export interface DoorGroup {
  id: string
  version_id: string
  position: number
  group_key: string
  room_name: string
  classification: string
  leaf: string
  door_size: string
  door_qty: number
  matched_set_id: string | null
  match_status: MatchStatus
  match_score: number | null
  match_reason: string
  pm_remarks: string
  created_at: string
  updated_at: string
}

export interface ProjectLine {
  id: string
  group_id: string
  position: number
  sku: string
  description: string
  qty_per_door: number
  unit_price: number | null
  origin: LineOrigin
  part_id: string | null
  created_at: string
  updated_at: string
}

export interface ApprovalEvent {
  id: string
  version_id: string
  action: ApprovalAction
  actor: string
  comment: string
  created_at: string
}
