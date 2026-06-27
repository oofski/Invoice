/**
 * CCRMS entity constants (NEW; additive — mutates nothing in the invoice module).
 *
 * The credit-card module recognizes SEVEN canonical entities: the six invoice
 * `BUSINESS_ENTITIES` plus `UrbanAyurveda`. UrbanAyurveda is INTENTIONALLY NOT
 * added to `BUSINESS_ENTITIES` (it has no COA / GL export in v1.2.9 — it is a
 * split label/amount only). It exists here, and only here.
 *
 * Imports invoice constants READ-ONLY. Never edits `lib/constants.ts` beyond the
 * one approved roles line.
 */
import { BUSINESS_ENTITIES, ENTITY_LABEL } from "../lib/constants";

/**
 * The 7 canonical CC entities = invoice 6 + UrbanAyurveda. Stored as the
 * `cc_entity_splits.entity_name` value. UrbanAyurveda is appended here and is
 * NOT part of `BUSINESS_ENTITIES`.
 */
export const CC_ENTITIES = [...BUSINESS_ENTITIES, "UrbanAyurveda"] as const;
export type CcEntity = (typeof CC_ENTITIES)[number];

/** O(1) membership check for split validation. */
const CC_ENTITY_SET: ReadonlySet<string> = new Set(CC_ENTITIES);

/** True when `name` is one of the 7 canonical CC entity names. */
export function isCcEntity(name: string | null | undefined): name is CcEntity {
  return !!name && CC_ENTITY_SET.has(name);
}

/**
 * CC display labels. These differ from the invoice/QBO labels (the Amex template
 * uses its own wording). Spread the invoice `ENTITY_LABEL` defaults first, then
 * override per the §4 contract table.
 */
export const CC_ENTITY_LABEL: Record<string, string> = {
  ...ENTITY_LABEL, // Neroli, SKNBarRx, IBW, Chicago, Admin, Nala (invoice defaults)
  Nala: "Nala Beauty Brands",
  SKNBar: "Skn Bar Rx",
  IBW: "Institute",
  Chicago: "Institute Chicago",
  Neroli: "Neroli",
  Admin: "Admin",
  UrbanAyurveda: "Urban Ayurveda",
};

/** Returns the display label for a canonical CC entity (falls back to the name). */
export function ccEntityLabel(entity: string): string {
  return CC_ENTITY_LABEL[entity] ?? entity;
}

/**
 * Canonical entity name keyed by its display / Amex-template label. Used by Amex
 * XLSX ingestion to map a template column header → canonical `entity_name` before
 * persisting. Keys are lower-cased+trimmed for tolerant matching.
 */
export const AMEX_LABEL_TO_CANONICAL: Record<string, CcEntity> = {
  "nala beauty brands": "Nala",
  "urban ayurveda": "UrbanAyurveda",
  "skn bar rx": "SKNBar",
  admin: "Admin",
  institute: "IBW",
  "institute chicago": "Chicago",
  neroli: "Neroli",
};

/**
 * Maps an Amex template column header (any case/spacing) to a canonical CC entity
 * name, or null if it is not an entity column. Tolerant of leading/trailing
 * whitespace and case.
 */
export function amexLabelToCanonical(label: string | null | undefined): CcEntity | null {
  if (!label) return null;
  return AMEX_LABEL_TO_CANONICAL[label.trim().toLowerCase()] ?? null;
}

/**
 * Canonical CC entities in TEMPLATE / display order (Amex template cols G–M).
 * The split modal and ingestion iterate in this order.
 */
export const CC_ENTITY_ORDER: readonly CcEntity[] = [
  "Nala",
  "UrbanAyurveda",
  "SKNBar",
  "Admin",
  "IBW",
  "Chicago",
  "Neroli",
];

/** Card-source enum values for `cc_cardholders.card_source`. */
export const CC_CARD_SOURCES = ["CAPITAL_ONE", "AMEX", "BOTH"] as const;
export type CcCardSource = (typeof CC_CARD_SOURCES)[number];

/** Transaction source enum values for `cc_transactions.source`. */
export const CC_SOURCES = ["CAPITAL_ONE", "AMEX"] as const;
export type CcSource = (typeof CC_SOURCES)[number];

/** Receipt-status enum values for `cc_transactions.receipt_status`. */
export const CC_RECEIPT_STATUSES = [
  "PENDING",
  "UPLOADED",
  "RECEIVED",
  "NOT_REQUIRED",
  "WAIVED",
] as const;
export type CcReceiptStatus = (typeof CC_RECEIPT_STATUSES)[number];

/** Receipt upload-method enum values for `cc_receipts.upload_method`. */
export const CC_UPLOAD_METHODS = [
  "CAPITAL_ONE_APP",
  "INVOICE_IQ_APP",
  "MANUAL_UPLOAD",
  "MANAGER_UPLOAD",
] as const;
export type CcUploadMethod = (typeof CC_UPLOAD_METHODS)[number];

/** Upload-batch status enum values for `cc_upload_batches.status`. */
export const CC_BATCH_STATUSES = [
  "PREVIEW",
  "PROCESSING",
  "COMPLETE",
  "ERROR",
  "BLANK_TEMPLATE",
] as const;
export type CcBatchStatus = (typeof CC_BATCH_STATUSES)[number];

/** Notification delivery enum values for `cc_notifications.delivery`. */
export const CC_DELIVERY_STATUSES = ["SENT", "FAILED", "NOT_CONFIGURED", "MAILTO"] as const;
export type CcDelivery = (typeof CC_DELIVERY_STATUSES)[number];
