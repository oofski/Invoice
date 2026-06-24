import type { Env, PipelineResult, Prompt3LineItem } from "./types";
import type { ExtractedInvoice } from "./extract";
import {
  loadVendorMappings,
  findVendorMapping,
  loadLocations,
  matchLocation,
  routeApprover,
  codeLineItem,
} from "./rules";
import {
  CONFIDENCE_LEVEL,
  type BusinessEntity,
  type ClassName,
} from "./constants";

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
  const [vendorRows, locs] = await Promise.all([loadVendorMappings(env), loadLocations(env)]);
  const vendorMapping = findVendorMapping(x.vendor, vendorRows);

  // Business / Class — match the ship-to (and supporting text) against locations.
  const locText = [x.ship_to_address, x.vendor, ...x.line_items.map((l) => l.description)].join(" \n ");
  const loc = matchLocation(locText, locs);
  const business = (loc?.business ?? vendorMapping?.business_entity ?? "Admin") as BusinessEntity;
  let className = (loc?.class ?? vendorMapping?.class ?? "None") as ClassName;

  // Class recovery (v1.2.2): when the entity is known (often from the vendor
  // mapping) but no class resolved — e.g. a shared-building or DBA-named invoice
  // whose address didn't match a full location keyword (the 327 E St Paul building
  // is shared by IBW-Milwaukee and Neroli-Downtown, and a vendor rule sets the
  // entity but not the campus) — recover the class from the entity's OWN
  // class/location names appearing in the text. Scoped to the determined entity,
  // so it can never cross entities (an IBW invoice that says "Milwaukee" → campus
  // Milwaukee, never a Neroli campus). Only fills when the class is still unset.
  if (className === "None" || !className) {
    const hay = locText.toLowerCase();
    const recovered = locs.find(
      (l) =>
        l.business === business &&
        l.class &&
        l.class !== "None" &&
        (hay.includes(l.class.toLowerCase()) ||
          l.keywords.some((k) => k && hay.includes(k.toLowerCase()))),
    );
    if (recovered) className = recovered.class as ClassName;
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
    });
    // Light confidence gating (v1.1.8 P): a clearly-low Reducto citation
    // confidence flags the line for review and downgrades its confidence to LOW
    // (unless it's already the stronger MANUAL_REVIEW sentinel from coding).
    const lowConf = li.lowConfidence === true;
    return {
      BusinessEntity: business,
      LineItemDescription: li.description,
      Amount: li.amount ?? 0,
      Category: c.category,
      ConfidenceLevel:
        lowConf && c.confidence !== CONFIDENCE_LEVEL.MANUAL_REVIEW
          ? CONFIDENCE_LEVEL.LOW
          : c.confidence,
      LogicPathUsed: c.logic,
      ...(c.itemType ? { ItemType: c.itemType } : {}),
      ...(lowConf ? { RequiresReview: true } : {}),
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
    // Remove the non-school negative lines.
    for (let i = prompt3.length - 1; i >= 0; i--) {
      if (prompt3[i].Amount < 0 && prompt3[i].Category !== "Discounts") {
        prompt3.splice(i, 1);
      }
    }
    // If Σ(remaining positives) exceeds the subtotal by ≈ the dropped discount,
    // reduce the dominant positive line so booked == subtotal (gross-price case).
    const subtotal = x.subtotal;
    if (subtotal != null) {
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
    }
  }

  const glCategories = prompt3.map((l) => l.Category);

  const { approver } = routeApprover({
    business,
    vendor: x.vendor,
    vendorMapping,
    total,
    descriptions,
    glCategories,
    salesTaxPresent,
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

  return { prompt1, prompt2: { ApprovedBy: approver }, prompt3, finalApprover: approver };
}
