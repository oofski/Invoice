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
  review_count?: number;
  has_pdf?: boolean;
}

export interface LineItemRow {
  id: string;
  invoice_id?: string;
  description: string | null;
  amount: number | null;
  gl_category: string | null;
  confidence_level: ConfidenceLevel | null;
  logic_path: string | null;
  requires_review: boolean;
  manually_overridden: boolean;
  split_parent_id: string | null;
  split_percentage: number | null;
  sort_order: number | null;
  business: string | null;
  class: string | null;
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
  audit_log?: AuditLogRow[];
  submitter?: Pick<UserRow, "id" | "name" | "email" | "role"> | null;
}

export interface DashboardStats {
  totalPending: number;
  awaitingApproval: number;
  needsReview: number;
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
