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

/**
 * Display label for a business entity. The canonical entity name (used as the
 * DB value and the `entity` field in exports) maps to a human-facing display
 * name used for worksheet/tab names and QBO Class prefixes. Only SKNBar differs
 * ("SKNBarRx"); all others display as themselves.
 */
export const ENTITY_LABEL: Record<string, string> = {
  Neroli: "Neroli",
  SKNBar: "SKNBarRx",
  IBW: "IBW",
  Chicago: "Chicago",
  Admin: "Admin",
  Nala: "Nala",
};

/** Short entity code used to disambiguate per-line fan-out bill numbers. */
export const ENTITY_CODE: Record<string, string> = {
  Neroli: "NER",
  SKNBar: "SKN",
  IBW: "IBW",
  Chicago: "CHI",
  Nala: "NALA",
  Admin: "ADM",
};

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

/**
 * Per-line item "Type" the executive can set during a per-line split. Selecting a
 * type auto-codes the line's GL account (TYPE_GL) so the accountant needn't
 * re-code. "Other" carries no fixed GL — it routes to manual review.
 */
export const ITEM_TYPES = ["Backbar", "Retail", "Equipment", "Other"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Maps an item Type to its GL category. Each value must be in GL_CATEGORIES_FLAT. */
export const TYPE_GL: Record<string, string> = {
  Backbar: "Service Costs",
  Retail: "Retail / Product Costs",
  Equipment: "Equipment & Fixtures",
};

/** Grouped list for rendering optgroup dropdowns in the UI. */
export const GL_CATEGORY_GROUPS = Object.entries(GL_CATEGORIES).map(
  ([group, categories]) => ({ group, categories: [...categories] }),
);

// ---------------------------------------------------------------------------
// Entity-specific Chart of Accounts (COA) — Group A
// ---------------------------------------------------------------------------

/**
 * Per-entity Chart of Accounts. The account number for a GL category is DERIVED
 * from (entity, category NAME) at read/export time — category NAMES remain the
 * canonical stored value, there is NO schema change and NO migration.
 *
 * Keys of each inner map are the CURRENT canonical category names already in
 * `GL_CATEGORIES` / `GL_CATEGORIES_FLAT`. Values are that entity's 4-digit
 * account number as a STRING (some are suffixed e.g. "6229-1", some special
 * e.g. "Varies" / "None"). Where an entity's COA has no equivalent for a
 * current canonical category, that key is OMITTED so the lookup returns "".
 *
 * Source: "Entity-Specific Chart of Accounts (COA) Mappings" (spec §6).
 */
export const ENTITY_COA: Record<string, Record<string, string>> = {
  // IBW & Chicago (School Institutional Mapping). Chicago resolves here via
  // ENTITY_COA_ALIAS.
  IBW: {
    "Service Costs": "5000",
    "Retail / Product Costs": "5100", // spec "Retail Costs"
    "Kit Costs": "5300",
    "Sales/Use Tax": "5400",
    "Accounting Services": "6000",
    "Corp Management Fee": "6005",
    // note: spec splits Bank Fees 6040 / Credit Card Processing 6100 — the
    // split into a separate Credit Card Processing account is deferred to a
    // later phase; use the primary 6040 for the current canonical category.
    "Bank Fees & CC Processing": "6040",
    "Bad Debt": "6045",
    "Guest Relations": "6053", // spec "Guest Amenities"
    "Computer & IT": "6060",
    Depreciation: "6070",
    Discounts: "6075",
    "Dues & Subscriptions": "6090",
    "Equipment Lease": "6105",
    "Employee Expenses": "6110",
    "Training & Education": "6117", // spec "Training & Education-staff"
    "Student Expenses": "6121",
    "Student Education Fund": "6130",
    Freight: "6150",
    "Insurance - Business": "6160",
    "Insurance - Health": "6180",
    "Licenses & Permits": "6220",
    // note: spec splits Professional Services 6224 / Outside Services 6240 —
    // the split into a separate Professional Services account is deferred to a
    // later phase; use the primary 6240 for the current canonical category.
    "Professional / Outside Services": "6240",
    Marketing: "6235",
    "Penalties & Fees": "6255",
    "Occupancy - Rent": "6280",
    "Occupancy - CAM": "6285",
    "Occupancy - Property Tax": "6287",
    "Occupancy - Insurance": "6288",
    "Repairs & Maintenance": "6290",
    Supplies: "6300",
    "Equipment & Fixtures": "6302",
    Telephone: "6310",
    Utilities: "6360",
    "Payroll - Taxes": "6560",
    "Reconciliation Discrepancies": "6900",
    "Interest Income": "7700",
    "Other Income/Loss": "7720",
    "Payroll - Wages": "Varies",
  },

  // SKNBarRX (Clinical/Spa Mapping).
  SKNBar: {
    "Service Costs": "5000",
    "Retail / Product Costs": "5100",
    "Sales/Use Tax": "5400",
    "Accounting Services": "6000",
    "Corp Management Fee": "6005",
    "Bank Fees & CC Processing": "6040",
    "Guest Relations": "6052",
    "Computer & IT": "6060",
    Depreciation: "6070",
    "Dues & Subscriptions": "6090",
    "Employee Expenses": "6115",
    Freight: "6150",
    "Insurance - Business": "6160",
    "Insurance - Health": "6180",
    Marketing: "6239",
    "Professional / Outside Services": "6240",
    "Penalties & Fees": "6255",
    "Occupancy - Rent": "6280",
    "Occupancy - CAM": "6285", // spec "Occupancy - CAM & Taxes"
    "Repairs & Maintenance": "6290",
    Supplies: "6300",
    "Equipment & Fixtures": "6302",
    Telephone: "6310",
    Utilities: "6360",
    "Payroll - Wages": "6401",
    "Payroll - Taxes": "6560",
    Miscellaneous: "6600",
    "Equipment Lease": "6670",
    Interest: "7705", // spec "Interest Expense"
    "Reconciliation Discrepancies": "None",
  },

  // Neroli (Salon/Spa Mapping).
  Neroli: {
    "Service Costs": "5000",
    "Retail / Product Costs": "5100",
    "Sales/Use Tax": "5400",
    "Accounting Services": "6000",
    "Corp Management Fee": "6005",
    "Bank Fees & CC Processing": "6040",
    "Guest Relations": "6052",
    "Computer & IT": "6060",
    Depreciation: "6070",
    "Dues & Subscriptions": "6090",
    "Employee Expenses": "6115",
    "Training & Education": "6120",
    Freight: "6150",
    "Insurance - Business": "6160",
    "Insurance - Health": "6180",
    "Licenses & Permits": "6220",
    Marketing: "6239",
    "Professional / Outside Services": "6240",
    "Penalties & Fees": "6255",
    "Occupancy - Rent": "6280",
    "Occupancy - CAM": "6285", // spec "Occupancy - CAM & Taxes"
    "Repairs & Maintenance": "6290",
    Supplies: "6300",
    "Equipment & Fixtures": "6302",
    Telephone: "6310",
    Utilities: "6360",
    "Payroll - Wages": "6401",
    "Payroll - Taxes": "6560",
    "Interest Income": "7700",
    Interest: "7705", // spec "Interest Expense"
    "Other Income/Loss": "7950",
    "Reconciliation Discrepancies": "None",
  },

  // Nala (Corporate/Administrative Mapping). Admin resolves here via
  // ENTITY_COA_ALIAS. Only the current canonical names with a clear admin-COA
  // equivalent are mapped; the spec's brand-new admin accounts (Lodging,
  // Transportation, Meals & Entertainment, Office Supplies, etc.) are NEW
  // categories deferred to a later phase and are intentionally NOT added here.
  Nala: {
    "Bank Fees & CC Processing": "6040", // spec "Bank Service Charges"
    "Dues & Subscriptions": "6090",
    Freight: "6150",
    "Computer & IT": "6170", // spec "Computer and Internet Expenses"
    "Insurance - Health": "6180", // spec "Insurance Expense - Health"
    Marketing: "6235", // spec "Marketing Web/Internet"
    "Penalties & Fees": "6255", // spec "Fees & Penalties"
    Supplies: "6300",
    Telephone: "6310", // spec "Telephone Expense"
    "Payroll - Wages": "6600", // spec "Payroll-Wages/Salary/Commission"
    "Payroll - Taxes": "6605", // spec "Payroll-Employer Taxes"
    "Corp Management Fee": "7000",
    Depreciation: "6240", // spec "Depreciation Expense"
    "Reconciliation Discrepancies": "None",
  },
};

/**
 * Entities that share another entity's COA. Chicago uses IBW's school COA;
 * Admin uses Nala's admin COA. Resolved by `glAccountNumber` before lookup.
 */
export const ENTITY_COA_ALIAS: Record<string, string> = {
  Chicago: "IBW",
  Admin: "Nala",
};

/**
 * Derives the 4-digit GL account number (as a string) for a given business
 * entity + canonical GL category NAME. Resolves the entity through
 * `ENTITY_COA_ALIAS` first. Returns "" when the entity or category is unknown
 * (null-safe) or when that entity's COA has no equivalent for the category.
 * Note: some values are non-numeric sentinels ("Varies" / "None").
 */
export function glAccountNumber(
  entity: string | null | undefined,
  category: string | null | undefined,
): string {
  if (!entity || !category) return "";
  const resolved = ENTITY_COA_ALIAS[entity] ?? entity;
  const coa = ENTITY_COA[resolved];
  if (!coa) return "";
  return coa[category] ?? "";
}

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
