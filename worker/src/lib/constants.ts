/**
 * InvoiceIQ domain constants — the canonical source of truth that mirrors the
 * Developer Brief (Sections 02, 03, 05, 13).
 *
 * NOTE: The location dictionary and vendor routing lists below are ALSO seeded
 * into the `location_mappings` and `vendor_mappings` database tables so that an
 * admin can update routing without a code change (Brief §02). These constants
 * are the build-time defaults / seed source and are used by the AI prompts as
 * the embedded routing reference.
 */

// ---------------------------------------------------------------------------
// Roles & statuses
// ---------------------------------------------------------------------------

export const ROLES = {
  ACCOUNTANT: "accountant",
  EXECUTIVE: "executive",
  STAFF: "staff",
  ADMIN: "admin",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: Role[] = [
  ROLES.ACCOUNTANT,
  ROLES.EXECUTIVE,
  ROLES.STAFF,
  ROLES.ADMIN,
];

/** Invoice lifecycle statuses. */
export const INVOICE_STATUS = {
  PROCESSING: "PROCESSING",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EXPORTED: "EXPORTED",
} as const;

export type InvoiceStatus =
  (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];

export const APPROVAL_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
} as const;

export type ApprovalStatus =
  (typeof APPROVAL_STATUS)[keyof typeof APPROVAL_STATUS];

export const SUBMISSION_TYPE = {
  ACCOUNTANT: "ACCOUNTANT",
  STAFF: "STAFF",
} as const;

export type SubmissionType =
  (typeof SUBMISSION_TYPE)[keyof typeof SUBMISSION_TYPE];

export const CONFIDENCE_LEVEL = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
  MANUAL_REVIEW: "MANUAL_REVIEW",
} as const;

export type ConfidenceLevel =
  (typeof CONFIDENCE_LEVEL)[keyof typeof CONFIDENCE_LEVEL];

/** Sentinel GL category that blocks export until resolved (Brief §13). */
export const REQUIRES_MANUAL_REVIEW = "REQUIRES_MANUAL_REVIEW";

/** Hours after which a PENDING_APPROVAL invoice is considered overdue (§07/§08). */
export const OVERDUE_HOURS = 72;

/** Dollar threshold that routes an invoice to Susan (Prompt 2, Rule 1). */
export const SUSAN_THRESHOLD = 10000;

// ---------------------------------------------------------------------------
// Business entities & approvers
// ---------------------------------------------------------------------------

export const BUSINESS_ENTITIES = [
  "Neroli",
  "SKNBar",
  "IBW",
  "Chicago",
  "Admin",
  "Nala",
] as const;
export type BusinessEntity = (typeof BUSINESS_ENTITIES)[number];

export const CLASSES = [
  "Mequon",
  "Downtown",
  "Eastside",
  "North Shore",
  "Brookfield",
  "Shorewood",
  "Pewaukee",
  "Milwaukee",
  "Madison",
  "Chicago",
  "Nala",
  "Admin",
  "None",
] as const;
export type ClassName = (typeof CLASSES)[number];

/**
 * The set of classes that belong to each business entity. Used to drive
 * invoice-splitting (split-even fans an invoice across these classes; split-
 * lines validates that each line's class belongs to its business).
 */
export const BUSINESS_CLASSES: Record<string, string[]> = {
  Neroli: ["Mequon", "Downtown", "Eastside", "North Shore", "Brookfield"],
  SKNBar: ["Shorewood", "Pewaukee"],
  IBW: ["Milwaukee", "Madison"],
  Chicago: ["Chicago"],
  Admin: ["Admin"],
  Nala: ["Nala"],
};

export const APPROVERS = ["Lori", "Lisa", "Kari", "Bonnie", "Susan"] as const;
export type Approver = (typeof APPROVERS)[number];

// ---------------------------------------------------------------------------
// Location dictionary (Brief §02) — seeds the `location_mappings` table.
// ---------------------------------------------------------------------------

export interface LocationMapping {
  /** Address fragment + human keyword(s) used to match Textract addresses. */
  address: string;
  keywords: string[];
  business: BusinessEntity;
  class: ClassName;
  default_approver: Approver | "None";
}

export const LOCATION_DICTIONARY: LocationMapping[] = [
  {
    address: "10902 N Port Washington",
    keywords: ["10902 N Port Washington", "Mequon"],
    business: "Neroli",
    class: "Mequon",
    default_approver: "Lori",
  },
  {
    address: "327 E St Paul",
    keywords: ["327 E St Paul", "Downtown"],
    business: "Neroli",
    class: "Downtown",
    default_approver: "Lori",
  },
  {
    address: "1919 E Kenilworth",
    keywords: ["1919 E Kenilworth", "Eastside"],
    business: "Neroli",
    class: "Eastside",
    default_approver: "Lori",
  },
  {
    address: "200 W Silver Spring",
    keywords: ["200 W Silver Spring", "North Shore"],
    business: "Neroli",
    class: "North Shore",
    default_approver: "Lori",
  },
  {
    address: "3885 N Brookfield",
    keywords: ["3885 N Brookfield", "Brookfield"],
    business: "Neroli",
    class: "Brookfield",
    default_approver: "Lori",
  },
  {
    address: "4005 N Downer",
    keywords: ["4005 N Downer", "Shorewood"],
    business: "SKNBar",
    class: "Shorewood",
    default_approver: "Lisa",
  },
  {
    address: "145 W Wisconsin",
    keywords: ["145 W Wisconsin", "Pewaukee"],
    business: "SKNBar",
    class: "Pewaukee",
    default_approver: "Lisa",
  },
  {
    address: "327 E St Paul 5th Floor",
    keywords: ["327 E St Paul 5th Floor", "IBW-Milwaukee", "IBW Milwaukee"],
    business: "IBW",
    class: "Milwaukee",
    default_approver: "Kari",
  },
  {
    address: "7021 Tree Ln",
    keywords: ["7021 Tree Ln", "IBW-Madison", "IBW Madison", "Madison"],
    business: "IBW",
    class: "Madison",
    default_approver: "Kari",
  },
  {
    address: "2828 N Clark St",
    keywords: ["2828 N Clark St", "Chicago"],
    business: "Chicago",
    class: "Chicago",
    default_approver: "Bonnie",
  },
  {
    // Catch-all / corporate (Brief §02 final row).
    address: "Admin / Corporate",
    keywords: ["Admin", "Corporate", "Nala"],
    business: "Admin",
    class: "None",
    default_approver: "None",
  },
];

// ---------------------------------------------------------------------------
// Prompt 2 — Approver routing vendor lists (Brief §05)
// ---------------------------------------------------------------------------

/** Rule 2: IBW/Chicago + these vendors -> Lisa. */
export const RULE2_LISA_VENDORS = [
  "Pivot Point",
  "FROMM",
  "Ultraceuticals",
  "Cohere",
  "CTC Supplies",
  "Marlo",
  "Concordance",
  "Cintas",
];

/** Rule 3: IBW/Chicago + these vendors (or unknown) -> Kari. */
export const RULE3_KARI_VENDORS = [
  "Avellas",
  "Culligan",
  "Imaginal Group",
  "Salescomm",
  "West Place LLC",
];

/** Rule 4: Neroli/SKNBar + these vendors -> Lori. */
export const RULE4_LORI_VENDORS = [
  "CTC Supplies",
  "Marlo",
  "Concordance",
  "Cintas",
  "Colectivo",
];

/** Rule 5: these vendors (or Admin/Corporate entity) -> Bonnie. */
export const RULE5_BONNIE_VENDORS = [
  "Beautiful Clean",
  "STAMM",
  "WASH",
  "CSC LLC",
  "UKG",
  "Brixmor",
  "Delta Dental",
  "FISH",
  "Gordon Flesch",
  "TOGO",
  "Guthrie & Frey",
  "Global Sight",
  "Adelman",
];

// ---------------------------------------------------------------------------
// 47 allowed GL categories (Brief §05)
// ---------------------------------------------------------------------------

export const GL_CATEGORIES = {
  Revenue: [
    "Service Revenue",
    "Retail Revenue",
    "Tuition Revenue",
    "Tuition Revenue - Other",
    "Kit Revenue",
    "Student Education Fund",
    "Cash Short/Over",
  ],
  "Cost of Sales": [
    "Service Costs",
    "Retail / Product Costs",
    "Kit Costs",
    "Sales/Use Tax",
  ],
  "Operating Expenses": [
    "Accounting Services",
    "Bad Debt",
    "Bank Fees & CC Processing",
    "Computer & IT",
    "Corp Management Fee",
    "Depreciation",
    "Discounts",
    "Dues & Subscriptions",
    "Employee Expenses",
    "Equipment & Fixtures",
    "Equipment Lease",
    "Freight",
    "Guest Relations",
    "Insurance - Business",
    "Insurance - Health",
    "Interest",
    "Interest Income",
    "Licenses & Permits",
    "Marketing",
    "Miscellaneous",
    "Occupancy - CAM",
    "Occupancy - Insurance",
    "Occupancy - Property Tax",
    "Occupancy - Rent",
    "Other Income/Loss",
    "Payroll - Taxes",
    "Payroll - Wages",
    "Penalties & Fees",
    "Professional / Outside Services",
    "Reconciliation Discrepancies",
    "Repairs & Maintenance",
    "Supplies",
    "Telephone",
    "Training & Education",
    "Utilities",
    "Student Expenses",
  ],
} as const;

/** Flat list of all 47 allowed GL categories. */
export const GL_CATEGORIES_FLAT: string[] = Object.values(GL_CATEGORIES).flat();

/** Grouped list for rendering optgroup dropdowns in the UI. */
export const GL_CATEGORY_GROUPS = Object.entries(GL_CATEGORIES).map(
  ([group, categories]) => ({ group, categories: [...categories] }),
);

// ---------------------------------------------------------------------------
// Audit log action types (Brief §13: write to audit_log on EVERY state change)
// ---------------------------------------------------------------------------

export const AUDIT_ACTION = {
  INVOICE_UPLOADED: "INVOICE_UPLOADED",
  AI_PROCESSED: "AI_PROCESSED",
  AI_PROCESSING_FAILED: "AI_PROCESSING_FAILED",
  STATUS_CHANGED: "STATUS_CHANGED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  GL_OVERRIDE: "GL_OVERRIDE",
  LINE_ITEM_SPLIT: "LINE_ITEM_SPLIT",
  MANUAL_REVIEW_RESOLVED: "MANUAL_REVIEW_RESOLVED",
  REMINDER_SENT: "REMINDER_SENT",
  EXPORTED: "EXPORTED",
  INVOICE_UPDATED: "INVOICE_UPDATED",
  INVOICE_DELETED: "INVOICE_DELETED",
  INVOICE_SPLIT: "INVOICE_SPLIT",
  SPLIT_CLEARED: "SPLIT_CLEARED",
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];
