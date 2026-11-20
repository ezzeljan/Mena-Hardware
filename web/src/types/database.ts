export type UserRole = 'admin' | 'estimator' | 'pm' | 'viewer'

export type LeafType = 'SINGLE' | 'DOUBLE' | 'CAVITY SINGLE' | 'CAVITY DOUBLE' | 'TRIPLE' | ''

export interface Profile {
  id: string
  full_name: string
  email: string
  role: UserRole
  /** Public URL of the profile photo (migration 015); null shows initials. */
  avatar_url: string | null
  created_at: string
}

export interface Supplier {
  id: string
  name: string
  is_owner_supplied: boolean
  created_at: string
  updated_at: string
}

/** A family of hardware in the Parts library, holding parts from every supplier (migration 022). */
export interface PartFolder {
  id: string
  name: string
  position: number
  created_at: string
  updated_at: string
}

export interface Part {
  id: string
  sku: string
  supplier_id: string
  description: string
  unit_cost: number | null
  active: boolean
  /** Folder (migration 022); null = unfiled. */
  folder_id?: string | null
  /** Legend code from the quotes, e.g. "F7" (migration 022); '' when none. */
  legend?: string
  created_at: string
  updated_at: string
  suppliers?: Pick<Supplier, 'id' | 'name' | 'is_owner_supplied'> | null
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

/** Row of the profile_directory view: non-sensitive profile columns readable by any signed-in user. */
export type DirectoryProfile = Pick<Profile, 'id' | 'full_name' | 'role' | 'avatar_url'>

/** An estimator assigned to a project by its PM (or an admin). */
export interface ProjectEstimator {
  project_id: string
  estimator_id: string
  assigned_by: string | null
  created_at: string
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

/** Project stage (migration 017). */
export type ProjectStage = 'tender' | 'awarded'

export interface Project {
  id: string
  /** Reference No. (e.g. "SV002"); '' when none. */
  reference_no: string
  name: string
  client: string
  site: string
  status: ProjectStatus
  /** Tender (default) or Awarded; changed by the assigned PM or an admin. */
  stage: ProjectStage
  /** Winning quote and supplier once Awarded (migration 021); null at Tender. */
  awarded_quote_id: string | null
  awarded_supplier_id: string | null
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

/** A builder's hardware quote in a project (migration 021). */
export interface HardwareQuote {
  id: string
  project_id: string
  builder_name: string
  created_by: string | null
  created_at: string
  updated_at: string
}

/** A supplier sheet of a quote version; each has its own hardware lines (migration 021). */
export interface QuoteSheet {
  id: string
  version_id: string
  supplier_id: string
  name: string
  position: number
  created_at: string
  updated_at: string
}

export interface ProjectVersion {
  id: string
  project_id: string
  /** The builder quote this version belongs to; version_no counts per quote. */
  quote_id: string
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
  door_tag: string
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
  /** The supplier sheet the line is on (migration 021). */
  sheet_id: string
  position: number
  sku: string
  description: string
  qty_per_door: number
  unit_price: number | null
  origin: LineOrigin
  part_id: string | null
  /** "MHQT REMARKS" column (migration 019); '' when empty. */
  mhqt_remarks?: string
  created_at: string
  updated_at: string
}

export type NotificationKind =
  | 'assigned_estimator'
  | 'assigned_pm'
  | 'submitted'
  | 'approved'
  | 'changes_requested'
  | 'comment'

/** In-app notification (created by database triggers, migration 014). */
export interface AppNotification {
  id: string
  user_id: string
  project_id: string | null
  version_id: string | null
  kind: NotificationKind
  title: string
  body: string
  actor_id: string | null
  read_at: string | null
  created_at: string
}

/** PM comment on a hardware quote version (migration 018). */
export interface VersionComment {
  id: string
  version_id: string
  /** The door group it is about, or null for the whole quote. */
  door_group_id: string | null
  /** The supplier sheet it is about, or null (migration 021). */
  sheet_id: string | null
  author_id: string | null
  body: string
  created_at: string
}

export type ActivityCategory = 'project' | 'team' | 'quotation' | 'version' | 'hardware'

/** Project activity log entry (written by database triggers, migration 016). */
export interface ProjectActivity {
  id: string
  project_id: string
  version_id: string | null
  actor_id: string | null
  category: ActivityCategory
  action: string
  /** Verb phrase without the actor, e.g. "approved v2". */
  summary: string
  details: Record<string, unknown>
  created_at: string
  /** Moves forward when more edits are grouped into the entry. */
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
