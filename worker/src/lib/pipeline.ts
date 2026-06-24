import type { Env, PipelineResult, Prompt3LineItem } from "./types";
import type { ExtractedInvoice } from "./extract";
import {
  loadVendorMappings,
  findVendorMapping,
  loadLocations,
  matchLocation,
  routeApprover,
  codeLineItem,
  resolveGlAccount,
} from "./rules";
import {
  CONFIDENCE_LEVEL,
  REQUIRES_MANUAL_REVIEW,
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
  const className = (loc?.class ?? vendorMapping?.class ?? "None") as ClassName;

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

  // Post-pass — non-school discount netting (v1.1.8 G). For each negative-amount
  // line NOT already coded to "Discounts" (i.e. the entity has no Discounts
  // account, so L0 fell through), net the discount into the invoice's dominant
  // positive line's GL category — the line with the largest positive amount — so
  // the credit reduces that same account (e.g. +$100 and -$25 both on GL X => net
  // $75). Fall back to the vendor-mapping default category, else REQUIRES_MANUAL_REVIEW.
  // (School lines already got "Discounts" in codeLineItem L0 and are skipped here.)
  const dominantIdx = prompt3.reduce(
    (best, l, i) =>
      l.Amount > 0 && (best < 0 || l.Amount > prompt3[best].Amount) ? i : best,
    -1,
  );
  const fallbackCategory =
    resolveGlAccount(vendorMapping) /* gl_override / inventory / else MANUAL_REVIEW */;
  for (const l of prompt3) {
    if (l.Amount < 0 && l.Category !== "Discounts") {
      const netCategory =
        dominantIdx >= 0 ? prompt3[dominantIdx].Category : fallbackCategory;
      l.Category = netCategory;
      l.LogicPathUsed = "DISCOUNT NET";
      // Confidence follows resolution: a real GL nets cleanly; only a stray
      // unresolved fallback should still flag for review.
      l.ConfidenceLevel =
        netCategory === REQUIRES_MANUAL_REVIEW
          ? CONFIDENCE_LEVEL.MANUAL_REVIEW
          : CONFIDENCE_LEVEL.LOW;
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
