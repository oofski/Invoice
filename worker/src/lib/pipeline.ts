import type { Env, PipelineResult, Prompt3LineItem } from "./types";
import type { ExtractedInvoice } from "./extract";
import {
  loadVendorMappings,
  loadVendorAliases,
  findVendorMapping,
  loadLocations,
  matchLocationScored,
  normalizeLocationText,
  routeApprover,
  codeLineItem,
} from "./rules";
import {
  CONFIDENCE_LEVEL,
  REQUIRES_MANUAL_REVIEW,
  isCategoryValidForEntity,
  type BusinessEntity,
  type ClassName,
} from "./constants";

/** De-dupe guard for the synthesized shipping line (mirrors rules.ts FREIGHT_RE). */
const FREIGHT_RE = /\b(freight|shipping|postage|courier|parcel|fedex|ups|usps|dhl)\b/i;

/**
 * Deterministic replacement for the 3-Claude-prompt pipeline. Takes Reducto's
 * structured extraction and produces the same PipelineResult shape the rest of
 * the app expects (so process.ts persistence is unchanged):
 *   - Business/Class from location keyword match (else vendor mapping, else Admin)
 *   - Approver from the priority routing rules
 *   - One coded line item per extracted line (rules first, Reducto suggestion, manual)
 */
export async function runRulesPipeline(
  env: Env,
  x: ExtractedInvoice,
): Promise<PipelineResult> {
  const [vendorRows, locs, aliases] = await Promise.all([
    loadVendorMappings(env),
    loadLocations(env),
    loadVendorAliases(env),
  ]);
  const vendorMapping = findVendorMapping(x.vendor, vendorRows, aliases);

  // Business / Class — scored ship-to match (v1.6.0 FIX-1/FIX-2). The matcher
  // scores the ship-to address first (unique keywords beat shared brand keywords),
  // falling back to the full text blob only when ship-to yields nothing.
  const locText = [x.ship_to_address, x.vendor, ...x.line_items.map((l) => l.description)].join(" \n ");
  const m = matchLocationScored(x.ship_to_address, locText, locs);
  const business = (m.loc?.business ?? vendorMapping?.business_entity ?? "Admin") as BusinessEntity;
  let className = (m.loc?.class ?? vendorMapping?.class ?? "None") as ClassName;
  let locationAmbiguous = m.ambiguous;

  // Class recovery (v1.6.0 FIX-2): now runs whenever the class is unset OR the
  // winning match was NOT unique (a shared-brand tie that the winner didn't break
  // with a unique keyword) — so it CORRECTS a shared-tie pick, not just fills a
  // blank. Scoped to the determined entity, so it can never cross entities. It
  // looks for a class name OR a UNIQUE keyword of THIS entity in the text; only a
  // single unambiguous class corrects the pick (zero or 2+ ⇒ leave as-is).
  if (className === "None" || !className || !m.unique) {
    // Uniqueness map, computed identically to matchLocationScored: a normalized
    // keyword present in exactly one location's list is UNIQUE.
    const keywordCounts = new Map<string, number>();
    for (const l of locs) {
      const seen = new Set<string>();
      for (const k of l.keywords) {
        if (!k) continue;
        const nk = normalizeLocationText(k);
        if (!nk || seen.has(nk)) continue;
        seen.add(nk);
        keywordCounts.set(nk, (keywordCounts.get(nk) ?? 0) + 1);
      }
    }
    const hayNorm = normalizeLocationText(locText);
    const candidateClasses = new Set<string>();
    for (const l of locs) {
      if (l.business !== business) continue;
      if (!l.class || l.class === "None") continue;
      const classHit = hayNorm.includes(normalizeLocationText(l.class));
      const uniqueKwHit = l.keywords.some((k) => {
        if (!k) return false;
        const nk = normalizeLocationText(k);
        return !!nk && (keywordCounts.get(nk) ?? 0) === 1 && hayNorm.includes(nk);
      });
      if (classHit || uniqueKwHit) candidateClasses.add(l.class);
    }
    if (candidateClasses.size === 1) {
      className = [...candidateClasses][0] as ClassName;
      locationAmbiguous = false;
    }
    // zero or 2+ ⇒ keep current className; locationAmbiguous unchanged.
  }

  const total =
    x.total ?? x.line_items.reduce((s, l) => s + (l.amount ?? 0), 0);
  const descriptions = x.line_items.map((l) => l.description);
  const salesTaxPresent = (x.sales_tax ?? 0) > 0;

  // Code each line FIRST so the approver router can see the resulting GL
  // categories (e.g. any REQUIRES_MANUAL_REVIEW line routes to Bonnie).
  const prompt3: Prompt3LineItem[] = x.line_items.map((li) => {
    const c = codeLineItem({
      description: li.description,
      vendor: x.vendor,
      vendorMapping,
      business,
      suggestedCategory: li.suggested_category,
      salesTaxPresent,
      lineTax: li.tax,
      amount: li.amount,
      headerTax: x.sales_tax,
    });
    // Light confidence gating (v1.1.8 P): a clearly-low Reducto citation
    // confidence flags the line for review and downgrades its confidence to LOW
    // (unless it's already the stronger MANUAL_REVIEW sentinel from coding).
    const lowConf = li.lowConfidence === true;
    const finalConfidence =
      lowConf && c.confidence !== CONFIDENCE_LEVEL.MANUAL_REVIEW
        ? CONFIDENCE_LEVEL.LOW
        : c.confidence;
    // FIX-6 (v1.6.0): every LOW-confidence line (OCR-low OR a heuristic L2.5/L4
    // result) is flagged for review — so a guess never reaches export unnoticed.
    const flag = lowConf || finalConfidence === CONFIDENCE_LEVEL.LOW;
    return {
      BusinessEntity: business,
      LineItemDescription: li.description,
      Amount: li.amount ?? 0,
      Category: c.category,
      ConfidenceLevel: finalConfidence,
      LogicPathUsed: c.logic,
      ...(c.itemType ? { ItemType: c.itemType } : {}),
      ...(flag ? { RequiresReview: true } : {}),
    };
  });

  // Post-pass — non-school discount DROP (v1.2.0 FIX 2). For entities WITHOUT a
  // "Discounts" account (everything except IBW/Chicago, whose negatives L0 already
  // coded to "Discounts"), we DON'T track the discount at all: REMOVE every
  // negative-amount line that wasn't booked to "Discounts". Then, if the remaining
  // positives overshoot the invoice subtotal by ≈ the dropped discount total
  // (gross-price-then-discount invoices), reduce the DOMINANT positive line so the
  // booked lines sum to the subtotal. School negatives (Category === "Discounts")
  // are KEPT untouched. (v1.1.8's netting-into-dominant-GL is replaced by this drop.)
  const droppedDiscountTotal = prompt3.reduce(
    (s, l) => (l.Amount < 0 && l.Category !== "Discounts" ? s + l.Amount : s),
    0,
  ); // negative or 0
  if (droppedDiscountTotal < 0) {
    const subtotal = x.subtotal;
    if (subtotal != null) {
      // v1.5.0 drop+compensate path (byte-identical when subtotal is known).
      // Remove the non-school negative lines.
      for (let i = prompt3.length - 1; i >= 0; i--) {
        if (prompt3[i].Amount < 0 && prompt3[i].Category !== "Discounts") {
          prompt3.splice(i, 1);
        }
      }
      // If Σ(remaining positives) exceeds the subtotal by ≈ the dropped discount,
      // reduce the dominant positive line so booked == subtotal (gross-price case).
      const posSum = prompt3.reduce((s, l) => (l.Amount > 0 ? s + l.Amount : s), 0);
      const overshoot = Math.round((posSum - subtotal) * 100) / 100;
      const tol = Math.max(0.02, Math.abs(subtotal) * 0.005);
      if (overshoot > tol) {
        const dominantIdx = prompt3.reduce(
          (best, l, i) =>
            l.Amount > 0 && (best < 0 || l.Amount > prompt3[best].Amount) ? i : best,
          -1,
        );
        if (dominantIdx >= 0) {
          prompt3[dominantIdx].Amount =
            Math.round((prompt3[dominantIdx].Amount - overshoot) * 100) / 100;
        }
      }
    } else {
      // §D (v1.6.0): no subtotal to reconcile against — DON'T drop the negatives
      // (that silently loses money and trips reconciliation). Keep each negative
      // line and net it into the dominant positive line's Category (pre-v1.2.0
      // behavior), flagged for review.
      const dominantIdx = prompt3.reduce(
        (best, l, i) =>
          l.Amount > 0 && (best < 0 || l.Amount > prompt3[best].Amount) ? i : best,
        -1,
      );
      const dominantCategory = dominantIdx >= 0 ? prompt3[dominantIdx].Category : null;
      if (dominantCategory) {
        for (const l of prompt3) {
          if (l.Amount < 0 && l.Category !== "Discounts") {
            l.Category = dominantCategory;
            l.RequiresReview = true;
            l.LogicPathUsed = "DISCOUNT NET (NO SUBTOTAL)";
          }
        }
      }
    }
  }

  // FIX-9 (v1.6.0): synthesize a coded "Shipping & Handling" Freight line from the
  // header shipping charge — unless an existing line already books the same freight
  // amount (Reducto sometimes emits freight both as a header AND a line item).
  const shipping = x.shipping ?? 0;
  if (shipping > 0) {
    const alreadyBooked = prompt3.some(
      (l) => FREIGHT_RE.test(l.LineItemDescription) && Math.abs(l.Amount - shipping) <= 0.02,
    );
    if (!alreadyBooked) {
      const freightValid = isCategoryValidForEntity(business, "Freight");
      prompt3.push({
        BusinessEntity: business,
        LineItemDescription: "Shipping & Handling",
        Amount: shipping,
        Category: freightValid ? "Freight" : REQUIRES_MANUAL_REVIEW,
        ConfidenceLevel: freightValid
          ? CONFIDENCE_LEVEL.HIGH
          : CONFIDENCE_LEVEL.MANUAL_REVIEW,
        LogicPathUsed: "SHIPPING HEADER",
        ...(freightValid ? {} : { RequiresReview: true }),
      });
    }
  }

  const glCategories = prompt3.map((l) => l.Category);
  // equipmentTotal (v1.6.0 FIX-12 input): Σ of "Equipment & Fixtures" line amounts,
  // so routeApprover can escalate a capital-equipment purchase to Susan.
  const equipmentTotal = prompt3.reduce(
    (s, l) => (l.Category === "Equipment & Fixtures" ? s + l.Amount : s),
    0,
  );

  const { approver } = routeApprover({
    business,
    vendor: x.vendor,
    vendorMapping,
    total,
    descriptions,
    glCategories,
    salesTaxPresent,
    equipmentTotal,
  });

  const prompt1 = {
    Vendor: x.vendor,
    Subtotal: x.subtotal != null ? String(x.subtotal) : "",
    SalesTax: x.sales_tax != null ? String(x.sales_tax) : "0",
    TotalAmount: String(total),
    InvDate: x.invoice_date,
    DueDate: x.due_date || x.invoice_date,
    InvoiceNumber: x.invoice_number,
    Business: business,
    Class: className,
    ApprovedBy: approver,
  };

  return {
    prompt1,
    prompt2: { ApprovedBy: approver },
    prompt3,
    finalApprover: approver,
    locationAmbiguous,
  };
}
