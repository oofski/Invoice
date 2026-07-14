/**
 * Shared TypeScript types for the InvoiceIQ renderer. Mirrors the Cloudflare
 * Worker API response shapes (the frontend contract).
 */

import type {
  Approver,
  BusinessEntity,
  ClassName,
  ConfidenceLevel,
  InvoiceStatus,
  ApprovalStatus,
  SubmissionType,
  Role,
  AuditAction,
} from "./constants";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  entity_access: string[] | null;
  is_active: boolean;
  created_at?: string;
}

export interface InvoiceRow {
  id: string;
  vendor: string;
  invoice_number: string;
  subtotal: number | null;
  sales_tax: number | null;
  total_amount: number;
  inv_date: string | null;
  due_date: string | null;
  business: string | null;
  class: string | null;
  split_type: string | null;
  approved_by: string | null;
  status: InvoiceStatus;
  pdf_url: string | null;
  submitted_by: string | null;
  submission_type: SubmissionType;
  ai_processed_at: string | null;
  exported_at: string | null;
  export_id: string | null;
  created_at: string;
  archived_at?: string | null;
  review_count?: number;
  has_pdf?: boolean;
  // v1.6.0 review/ambiguity/reconciliation/shipping signals (§C4).
  shipping?: number | null; // header shipping/freight, null/0 when absent
  location_ambiguous?: boolean; // routing decided on shared-only evidence
  reconciliation_delta?: number | null; // signed gap total−(lines+tax); null = reconciled
  blocking_count?: number; // lines with the REQUIRES_MANUAL_REVIEW sentinel
}

export interface LineItemRow {
  id: string;
  invoice_id?: string;
  description: string | null;
  amount: number | null;
  gl_category: string | null;
  /**
   * Server-derived 4-digit GL account number for (entity, gl_category). Already
   * role-gated server-side (executives receive null alongside gl_category).
   */
  gl_account_number?: string | null;
  confidence_level: ConfidenceLevel | null;
  logic_path: string | null;
  requires_review: boolean;
  manually_overridden: boolean;
  split_parent_id: string | null;
  split_percentage: number | null;
  sort_order: number | null;
  business: string | null;
  class: string | null;
  item_type?: string | null;
}

/**
 * An invoice-level split allocation row (one per business/class slice) returned
 * by `POST /api/invoices/:id/split-even`.
 */
export interface InvoiceAllocation {
  id: string;
  invoice_id: string;
  business: string;
  class: string;
  percentage: number | null;
  amount: number;
  gl_account: string | null;
  source: string;
  created_at: string;
}

export interface ApprovalRow {
  status: ApprovalStatus;
  decision_note: string | null;
  decided_at: string | null;
}

export interface VendorMappingRow {
  id: string;
  vendor_name: string;
  business_entity: string | null;
  class: string | null;
  default_approver: string | null;
  is_inventory: boolean;
  gl_override: string | null;
  updated_at?: string;
}

/**
 * A vendor alias maps a misspelled/variant vendor name (`alias_text`) to a
 * canonical `vendor_mappings` row (`canonical_id`), so the variant inherits the
 * canonical vendor's GL coding + routing. Redeclared locally to mirror the
 * Worker contract (`GET/POST/DELETE /api/vendors/aliases`).
 */
export interface VendorAlias {
  id: string;
  alias_text: string;
  alias_norm: string;
  canonical_id: string;
  /**
   * The canonical vendor's display name from the LEFT JOIN, as returned by the
   * Worker route `GET /api/vendors/aliases` (`v.vendor_name AS canonical_name`)
   * and the `POST` response. Single field name on both sides (reconciled to the
   * Worker's `canonical_name`). Optional because the UI already has the canonical
   * name from the loaded vendor row and groups aliases by `canonical_id`.
   */
  canonical_name?: string;
}

/**
 * One advisory fuzzy-match suggestion from `GET /api/vendors/suggest?vendor=`.
 * Non-binding — surfaced only to offer a one-click "create alias" affordance.
 */
export interface VendorSuggestion {
  canonical_id: string;
  vendor_name: string;
  score: number;
}

export interface AuditLogRow {
  id: string;
  invoice_id?: string | null;
  user_id?: string | null;
  action: AuditAction | string;
  prev_value: unknown | null;
  new_value: unknown | null;
  note: string | null;
  created_at: string;
}

export interface ExportRow {
  id: string;
  exported_at: string;
  invoice_ids: string[];
  file_name: string;
  row_count: number;
  exported_by_name?: string;
}

/**
 * One entity's worth of QBO bill-import rows, destined for its own .xlsx tab.
 * Each row is keyed by the exact column names in `FactorResponse.header`.
 */
export interface EntitySheet {
  entity: string;
  sheetName: string;
  rows: Record<string, string>[];
}

/** Response from `POST /api/export/factor` — a multi-tab QBO bill workbook. */
export interface FactorResponse {
  entities: EntitySheet[];
  header: string[];
  fileName: string;
  totalRowCount: number;
  invoiceCount: number;
  exportId: string;
}

// ---------------------------------------------------------------------------
// API response shapes (frontend contract)
// ---------------------------------------------------------------------------

export interface InvoiceWithRelations extends InvoiceRow {
  line_items: LineItemRow[];
  approval: ApprovalRow | null;
  /** Invoice-level split slices (QUICK_EVEN / CUSTOM); [] when unsplit or per-line. */
  allocations?: InvoiceAllocation[];
  audit_log?: AuditLogRow[];
  submitter?: Pick<UserRow, "id" | "name" | "email" | "role"> | null;
}

export interface DashboardStats {
  totalPending: number;
  awaitingApproval: number;
  needsReview: number;
  needsRouting: number;
  exportReady: number;
  rejected: number;
  exportedThisMonth: number;
  overdueCount: number;
  byEntity: { entity: string; count: number; total: number }[];
  byStatus: { status: string; count: number }[];
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  must_change_password?: boolean;
  entity_access?: string[] | null;
}

export interface DuplicateWarning {
  duplicate: true;
  existingInvoiceId?: string;
  vendor: string;
  invoice_number: string;
  total_amount: number;
}

export interface SplitAllocation {
  amount: number;
  gl_category: string;
}

/**
 * One target row in a flexible cross-entity split request body for
 * `POST /api/invoices/:id/split-allocations`. Any entity is allowed (e.g. a
 * Chicago row on an IBW invoice). Percentages must total 100 (±0.05).
 */
export interface SplitAllocationInput {
  business: string;
  class: string;
  percentage: number;
}

export interface SplitAllocationsRequest {
  allocations: SplitAllocationInput[];
}

export interface SplitAllocationsResponse {
  allocations: InvoiceAllocation[];
}

/**
 * One approver's pending-approval workload, from
 * `GET /api/invoices/approvers/pending-counts`. `reachable` is false when the
 * approver has no app user / email and therefore cannot be sent a reminder.
 */
export interface ApproverPendingCount {
  name: string;
  userId: string | null;
  email: string | null;
  pendingCount: number;
  reachable: boolean;
}

/**
 * One line in a per-line split request body for
 * `POST /api/invoices/:id/split-lines`. `type` ∈ ITEM_TYPES; for "Other" the
 * typed text is sent as `customType`. Both are omitted when not chosen.
 */
export interface SplitLineInput {
  lineItemId: string;
  business: string;
  class: string;
  type?: string;
  customType?: string;
}

// Re-export commonly-used domain unions for convenience.
export type {
  Approver,
  BusinessEntity,
  ClassName,
  ConfidenceLevel,
  InvoiceStatus,
  ApprovalStatus,
  SubmissionType,
  Role,
  AuditAction,
};
