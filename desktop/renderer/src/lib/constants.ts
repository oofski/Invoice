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
  NEEDS_REVIEW: "NEEDS_REVIEW",
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
 * lines validates that each line's class belongs to its business). Mirrors the
 * Worker constant.
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

/**
 * Per-line item types (mirror of the Worker constant). Drives the per-line
 * split Type column; the server derives the GL account from the type, so no
 * GL mapping lives client-side. "Other" lets the user type a free-form type
 * that is sent as `customType`.
 */
export const ITEM_TYPES = ["Backbar", "Retail", "Equipment", "Other"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

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
    keywords: [
      "327 E St Paul 5th Floor",
      "IBW-Milwaukee",
      "IBW Milwaukee",
      "Institute of Beauty & Wellness",
      "Institute of Beauty and Wellness",
      "Institute of Beauty",
      "IBW",
    ],
    business: "IBW",
    class: "Milwaukee",
    default_approver: "Kari",
  },
  {
    address: "7021 Tree Ln",
    keywords: [
      "7021 Tree Ln",
      "IBW-Madison",
      "IBW Madison",
      "Madison",
      "Institute of Beauty & Wellness",
      "Institute of Beauty and Wellness",
      "Institute of Beauty",
      "IBW",
    ],
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

/**
 * Group B (v1.1.4) NEW canonical category names introduced by the entity-
 * specific COA expansion (IBW account splits, salon/spa payroll splits, and the
 * full Nala §7 discrete admin accounts). These are appended to the universal
 * allow-list (`GL_CATEGORIES_FLAT`) so the flat list / dropdown validation keeps
 * accepting them. Legacy / replaced names are intentionally NOT here (they live
 * in ENTITY_COA_LEGACY) but they still appear in GL_CATEGORIES, so the union
 * below keeps them in the flat list too. MIRROR of the worker constant.
 */
export const GL_EXTRA_CATEGORIES: string[] = [
  // IBW account splits + rename
  "Bank Fees",
  "Credit Card Processing",
  "Professional Services",
  "Outside Services",
  "Guest Amenities",
  // Salon/spa payroll splits (SKNBar & Neroli)
  "Service Payroll",
  "Retail Payroll",
  // Nala (Corporate/Administrative) §7 discrete accounts
  "Bank Service Charges",
  "Credit Card Fees",
  "Employee Education",
  "Computer and Internet Expenses",
  "Insurance Expense - Health",
  "Lodging",
  "Transportation",
  "Meals and Entertainment",
  "Automobile Expense",
  "Advertising and Promotion",
  "Marketing Web/Internet",
  "Printing/Collateral",
  "Direct Client Marketing",
  "Depreciation Expense",
  "Meeting & Events",
  "Parking/Mileage",
  "Fees & Penalties",
  "Telephone Expense",
  "Insurance Expense",
  "Office Supplies",
  "Payroll-Wages/Salary/Commission",
  "Payroll-Employer Taxes",
];

/**
 * Flat universal allow-list of every accepted GL category NAME. It is the
 * unique union of: the curated `GL_CATEGORIES` groups (the historical 47, which
 * also covers the legacy/replaced names), the Group B `GL_EXTRA_CATEGORIES`,
 * and every key across all `ENTITY_COA` maps. Populated by `buildGlFlat()`
 * AFTER the entity COA maps are declared (see end of COA section) so it can
 * include their keys without a temporal-dead-zone reference. MIRROR of the
 * worker constant.
 */
export const GL_CATEGORIES_FLAT: string[] = [];

/** Internal: assembles the unique union into GL_CATEGORIES_FLAT (idempotent). */
function buildGlFlat(entityCoa: Record<string, Record<string, string>>): void {
  const seen = new Set<string>();
  const push = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      GL_CATEGORIES_FLAT.push(name);
    }
  };
  Object.values(GL_CATEGORIES).flat().forEach(push);
  GL_EXTRA_CATEGORIES.forEach(push);
  for (const coa of Object.values(entityCoa)) {
    Object.keys(coa).forEach(push);
  }
}

/** Grouped list for rendering optgroup dropdowns in the UI. */
export const GL_CATEGORY_GROUPS = Object.entries(GL_CATEGORIES).map(
  ([group, categories]) => ({ group, categories: [...categories] }),
);

// ---------------------------------------------------------------------------
// Entity-specific Chart of Accounts (COA) — Group A + Group B (v1.1.4)
// MIRROR of worker/src/lib/constants.ts ENTITY_COA / ENTITY_COA_LEGACY — keep
// in sync. Includes the IBW splits (Bank Fees / Credit Card Processing /
// Professional Services / Outside Services / Guest Amenities), the SKNBar +
// Neroli Service Payroll 5010 / Retail Payroll 5500 splits, and Nala's full
// discrete §7 admin account set.
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
    // Group B (v1.1.4): the spec splits the combined account into two discrete
    // accounts. New coding uses these; the legacy combined name resolves via
    // ENTITY_COA_LEGACY.
    "Bank Fees": "6040",
    "Credit Card Processing": "6100",
    "Bad Debt": "6045",
    "Guest Amenities": "6053", // spec "Guest Amenities" (was "Guest Relations")
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
    // Group B (v1.1.4): split into two discrete accounts. New coding uses
    // these; the legacy combined name resolves via ENTITY_COA_LEGACY.
    "Professional Services": "6224",
    "Outside Services": "6240",
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
    "Service Payroll": "5010",
    "Retail / Product Costs": "5100",
    "Sales/Use Tax": "5400",
    "Retail Payroll": "5500",
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
    "Service Payroll": "5010",
    "Retail / Product Costs": "5100",
    "Sales/Use Tax": "5400",
    "Retail Payroll": "5500",
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
  // ENTITY_COA_ALIAS. Group B (v1.1.4): the canonical set is now the spec §7
  // discrete admin accounts (the dropdown offer set). The Group-A generic names
  // that were replaced live in ENTITY_COA_LEGACY so historical rows still
  // resolve / validate.
  Nala: {
    "Bank Service Charges": "6040",
    "Credit Card Fees": "6042",
    "Dues & Subscriptions": "6090",
    "Employee Education": "6114",
    Freight: "6150",
    "Computer and Internet Expenses": "6170",
    "Insurance Expense - Health": "6180",
    Lodging: "6229-1",
    Transportation: "6229-3",
    "Meals and Entertainment": "6229-4",
    "Automobile Expense": "6229-5",
    "Advertising and Promotion": "6230",
    "Marketing Web/Internet": "6235",
    "Printing/Collateral": "6237",
    "Direct Client Marketing": "6238",
    "Depreciation Expense": "6240",
    "Meeting & Events": "6245",
    "Parking/Mileage": "6250",
    "Fees & Penalties": "6255",
    Supplies: "6300",
    "Telephone Expense": "6310",
    "Insurance Expense": "6330",
    "Office Supplies": "6490",
    "Payroll-Wages/Salary/Commission": "6600",
    "Payroll-Employer Taxes": "6605",
    "Corp Management Fee": "7000",
    "Reconciliation Discrepancies": "None",
  },
};

/**
 * Per-entity fallback map of REPLACED legacy category names → account number.
 * These names are NOT offered in the dropdown and are NOT part of the canonical
 * ENTITY_COA, but they remain RESOLVABLE and VALID so that historical rows
 * stored under an old combined / generic name still export with the correct
 * number and pass entity-aware validation. `glAccountNumber` consults this map
 * only after ENTITY_COA misses (Group B v1.1.4).
 */
export const ENTITY_COA_LEGACY: Record<string, Record<string, string>> = {
  // IBW & Chicago: the combined accounts that were split into discrete ones.
  IBW: {
    "Bank Fees & CC Processing": "6040", // split into Bank Fees / Credit Card Processing
    "Professional / Outside Services": "6240", // split into Professional Services / Outside Services
    "Guest Relations": "6053", // renamed to "Guest Amenities"
  },

  // Nala & Admin: the Group-A generic names replaced by the spec §7 discrete set.
  Nala: {
    "Bank Fees & CC Processing": "6040", // -> Bank Service Charges
    "Computer & IT": "6170", // -> Computer and Internet Expenses
    "Insurance - Health": "6180", // -> Insurance Expense - Health
    Marketing: "6235", // -> Marketing Web/Internet
    "Penalties & Fees": "6255", // -> Fees & Penalties
    Telephone: "6310", // -> Telephone Expense
    "Payroll - Wages": "6600", // -> Payroll-Wages/Salary/Commission
    "Payroll - Taxes": "6605", // -> Payroll-Employer Taxes
    Depreciation: "6240", // -> Depreciation Expense
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

// Now that every ENTITY_COA map is declared, assemble the universal allow-list
// (curated groups ∪ Group B extras ∪ all entity-COA keys), deduplicated.
buildGlFlat(ENTITY_COA);

/**
 * Maps EVERY category NAME (existing curated + Group B new + every entity-COA
 * key) to one of the three high-level reporting groups. Cost of Sales covers
 * the direct service/retail/kit cost and payroll-cost accounts; Revenue covers
 * the curated Revenue group; everything else (and any unknown name) defaults to
 * Operating Expenses. Group B v1.1.4. MIRROR of the worker constant.
 */
export const CATEGORY_GROUP_OF: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  // Seed from the curated groups first so "Revenue" / "Cost of Sales" win.
  for (const [group, categories] of Object.entries(GL_CATEGORIES)) {
    for (const cat of categories) map[cat] = group;
  }
  // Explicit Cost-of-Sales additions (Group B payroll-cost splits).
  const costOfSales = [
    "Service Costs",
    "Retail / Product Costs",
    "Kit Costs",
    "Sales/Use Tax",
    "Service Payroll",
    "Retail Payroll",
  ];
  for (const cat of costOfSales) map[cat] = "Cost of Sales";
  // Every remaining category name (entity-COA keys + extras) defaults to
  // Operating Expenses unless already classified as Revenue / Cost of Sales.
  for (const cat of GL_CATEGORIES_FLAT) {
    if (!map[cat]) map[cat] = "Operating Expenses";
  }
  return map;
})();

/**
 * Derives the GL account number (as a string) for a given business entity +
 * GL category NAME. Resolves the entity through `ENTITY_COA_ALIAS` first, then
 * looks up the canonical `ENTITY_COA` map, falling back to the
 * `ENTITY_COA_LEGACY` map so that historical rows stored under a replaced
 * (combined / generic) name still resolve to the correct number. Returns ""
 * when the entity or category is unknown (null-safe) or when neither map has an
 * equivalent. Note: some values are non-numeric sentinels ("Varies" / "None")
 * or are suffixed (e.g. "6229-1").
 */
export function glAccountNumber(
  entity: string | null | undefined,
  category: string | null | undefined,
): string {
  if (!entity || !category) return "";
  const resolved = ENTITY_COA_ALIAS[entity] ?? entity;
  return (
    ENTITY_COA[resolved]?.[category] ??
    ENTITY_COA_LEGACY[resolved]?.[category] ??
    ""
  );
}

/**
 * True when `category` is acceptable for the given business entity. Used by the
 * line-item GL-category PATCH and split-allocation validation (Group B v1.1.4).
 *
 * Accepts when:
 *  - category is the manual-review sentinel; OR
 *  - the entity (alias-resolved) offers it in its canonical COA; OR
 *  - the entity offers it in its legacy COA (historical names); OR
 *  - it equals the value currently stored on the row (grandfathering an edit
 *    that doesn't change the category); OR
 *  - the entity is null/unknown — in which case we fall back to the universal
 *    GL_CATEGORIES_FLAT allow-list.
 */
export function isCategoryValidForEntity(
  entity: string | null | undefined,
  category: string | null | undefined,
  currentStoredValue?: string | null,
): boolean {
  if (!category) return false;
  if (category === REQUIRES_MANUAL_REVIEW) return true;
  if (currentStoredValue && category === currentStoredValue) return true;
  if (!entity) return GL_CATEGORIES_FLAT.includes(category);
  const resolved = ENTITY_COA_ALIAS[entity] ?? entity;
  const coa = ENTITY_COA[resolved];
  const legacy = ENTITY_COA_LEGACY[resolved];
  if (!coa && !legacy) return GL_CATEGORIES_FLAT.includes(category);
  return Boolean(coa?.[category]) || Boolean(legacy?.[category]);
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
  INVOICE_REROUTED: "INVOICE_REROUTED",
  MANUAL_REVIEW_REQUESTED: "MANUAL_REVIEW_REQUESTED",
  LINE_ITEM_ADDED: "LINE_ITEM_ADDED",
  INVOICE_ARCHIVED: "INVOICE_ARCHIVED",
  INVOICE_UNARCHIVED: "INVOICE_UNARCHIVED",
  AUDIT_CLEARED: "AUDIT_CLEARED",
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];
