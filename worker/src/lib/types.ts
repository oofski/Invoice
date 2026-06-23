/**
 * Worker types. D1 rows use INTEGER for booleans (0/1) and TEXT (JSON strings)
 * for arrays/json; helpers in db.ts hydrate these into the app shapes below.
 */
import type {
  Approver,
  BusinessEntity,
  ClassName,
  ConfidenceLevel,
} from "./constants";

export interface Env {
  DB: D1Database;
  PDFS: R2Bucket;
  REDUCTO_API_KEY: string;
  REDUCTO_BASE_URL?: string;
  ANTHROPIC_API_KEY: string;
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
  SESSION_SECRET?: string;
  /** Shared secret for unattended ingestion (e.g. SharePoint via Power Automate). */
  INGEST_TOKEN?: string;
  APP_URL?: string;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  entity_access: string | null;
  is_active: number;
  must_change_password: number;
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
  status: string;
  has_pdf: number;
  submitted_by: string | null;
  submission_type: string;
  textract_raw: string | null;
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
  confidence_level: string | null;
  logic_path: string | null;
  requires_review: number;
  manually_overridden: number;
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
  status: string;
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
  is_inventory: number;
  gl_override: string | null;
  updated_at: string;
}

// --- AI prompt output schemas (Brief §05) ---
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

export interface PipelineResult {
  prompt1: Prompt1Output;
  prompt2: Prompt2Output;
  prompt3: Prompt3Output;
  finalApprover: Approver;
}

/** The authenticated user attached to the Hono context. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  entity_access: string[] | null;
}
