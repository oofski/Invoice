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
import type { BusinessEntity, ClassName } from "./constants";

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

  const { approver } = routeApprover({
    business,
    vendor: x.vendor,
    vendorMapping,
    total,
    descriptions,
  });

  const prompt3: Prompt3LineItem[] = x.line_items.map((li) => {
    const c = codeLineItem({
      description: li.description,
      vendorMapping,
      business,
      suggestedCategory: li.suggested_category,
    });
    return {
      BusinessEntity: business,
      LineItemDescription: li.description,
      Amount: li.amount ?? 0,
      Category: c.category,
      ConfidenceLevel: c.confidence,
      LogicPathUsed: c.logic,
    };
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
