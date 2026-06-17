/**
 * Shared TypeScript types for InvoiceIQ.
 *
 * Database row shapes mirror the schema in Brief §06. API response shapes are
 * the contract relied on by the frontend. Keep these in sync with the SQL
 * migrations in /supabase/migrations.
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
// Database row shapes
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  entity_access: string[] | null;
  is_active: boolean;
  created_at: string;
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
  approved_by: string | null;
  status: InvoiceStatus;
  pdf_url: string | null;
  submitted_by: string | null;
  submission_type: SubmissionType;
  textract_raw: unknown | null;
  ai_processed_at: string | null;
  exported_at: string | null;
  export_id: string | null;
  created_at: string;
}

export interface LineItemRow {
  id: string;
  invoice_id: string;
  description: string | null;
  amount: number | null;
  gl_category: string | null;
  confidence_level: ConfidenceLevel | null;
  logic_path: string | null;
  requires_review: boolean;
  manually_overridden: boolean;
  overridden_by: string | null;
  split_parent_id: string | null;
  split_percentage: number | null;
  sort_order: number | null;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  invoice_id: string;
  assigned_to: string | null;
  assigned_to_name: string | null;
  status: ApprovalStatus;
  decision_note: string | null;
  decided_at: string | null;
  reminder_sent_at: string | null;
  reminder_count: number;
  created_at: string;
}

export interface VendorMappingRow {
  id: string;
  vendor_name: string;
  business_entity: string | null;
  class: string | null;
  default_approver: string | null;
  is_inventory: boolean;
  gl_override: string | null;
  updated_at: string;
}

export interface AuditLogRow {
  id: string;
  invoice_id: string | null;
  user_id: string | null;
  action: AuditAction | string;
  prev_value: unknown | null;
  new_value: unknown | null;
  note: string | null;
  created_at: string;
}

export interface ExportRow {
  id: string;
  exported_by: string | null;
  exported_at: string;
  invoice_ids: string[];
  file_name: string;
  row_count: number;
  file_url: string | null;
}

export interface LocationMappingRow {
  id: string;
  address: string;
  keywords: string[];
  business: string;
  class: string;
  default_approver: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// AI prompt output schemas (Brief §05)
// ---------------------------------------------------------------------------

export interface Prompt1Output {
  Vendor: string;
  Subtotal: string;
  SalesTax: string;
  TotalAmount: string;
  InvDate: string;
  DueDate: string;
  InvoiceNumber: string;
  Business: BusinessEntity;
  Class: ClassName;
  ApprovedBy: Approver;
}

export interface Prompt2Output {
  ApprovedBy: Approver;
}

export interface Prompt3LineItem {
  BusinessEntity: BusinessEntity;
  LineItemDescription: string;
  Amount: number;
  Category: string;
  ConfidenceLevel: ConfidenceLevel;
  LogicPathUsed: string;
}

export type Prompt3Output = Prompt3LineItem[];

/** Merged pipeline result saved to the DB. */
export interface PipelineResult {
  prompt1: Prompt1Output;
  prompt2: Prompt2Output;
  prompt3: Prompt3Output;
  /** Final approver = prompt2.ApprovedBy ALWAYS (Brief §13). */
  finalApprover: Approver;
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

export interface ApiError {
  error: string;
  details?: unknown;
}

export interface DuplicateWarning {
  duplicate: true;
  existingInvoiceId: string;
  vendor: string;
  invoice_number: string;
  total_amount: number;
}

/** A single split allocation submitted to /api/line-items/[id]/split. */
export interface SplitAllocation {
  amount: number;
  gl_category: string;
}
