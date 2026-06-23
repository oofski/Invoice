import { type NextRequest } from "next/server";
import { ok, fail, withErrorHandling } from "@/lib/api";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadEditableLineItem } from "@/lib/lineItems";
import { writeAudit } from "@/lib/audit";
import {
  AUDIT_ACTION,
  CONFIDENCE_LEVEL,
  GL_CATEGORIES_FLAT,
} from "@/lib/constants";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

interface AllocationInput {
  amount?: number;
  percentage?: number;
  gl_category: string;
}

/**
 * POST /api/line-items/[id]/split — split a line item into multiple GL
 * allocations (Brief §07, Session 5).
 *
 * Allocations may be given as amounts or percentages. The amounts MUST sum to
 * the parent amount (enforced here AND client-side, Brief §13) — returns 400
 * otherwise. Children are created with split_parent_id = parent; the parent is
 * retained but excluded from export (it is referenced as a split parent).
 *
 * Body: { "allocations": [{ "amount": 50.00, "gl_category": "Supplies" }, ...] }
 */
export const POST = withErrorHandling(
  async (request: NextRequest, { params }: Ctx) => {
    const profile = await requireProfile();
    const loaded = await loadEditableLineItem(params.id, profile);
    if (!loaded.ok) return fail(loaded.error, loaded.status);
    const { lineItem } = loaded;

    const parentAmount = Number(lineItem.amount ?? 0);
    if (parentAmount <= 0)
      return fail("Cannot split a line item with no amount", 400);

    const body = await request.json().catch(() => ({}));
    const allocations = body?.allocations as AllocationInput[] | undefined;
    if (!Array.isArray(allocations) || allocations.length < 2) {
      return fail("Provide at least two split allocations", 400);
    }

    // Resolve each allocation to a concrete amount.
    const resolved = allocations.map((a) => {
      const amount =
        typeof a.amount === "number"
          ? a.amount
          : typeof a.percentage === "number"
            ? Math.round(((parentAmount * a.percentage) / 100) * 100) / 100
            : NaN;
      return { amount, gl_category: a.gl_category, percentage: a.percentage };
    });

    for (const r of resolved) {
      if (!Number.isFinite(r.amount) || r.amount <= 0)
        return fail("Each split must have a positive amount", 400);
      if (!r.gl_category || !GL_CATEGORIES_FLAT.includes(r.gl_category))
        return fail(`Invalid GL category: ${r.gl_category}`, 400);
    }

    const sum = resolved.reduce((acc, r) => acc + r.amount, 0);
    if (Math.abs(sum - parentAmount) > 0.01) {
      return fail(
        `Split amounts (${sum.toFixed(2)}) must equal the line total (${parentAmount.toFixed(2)})`,
        400,
      );
    }

    const admin = createAdminClient();

    // Remove any previous children of this parent (re-split is idempotent).
    await admin.from("line_items").delete().eq("split_parent_id", params.id);

    const baseSort = lineItem.sort_order ?? 0;
    const childRows = resolved.map((r, idx) => ({
      invoice_id: lineItem.invoice_id,
      description: `${lineItem.description ?? "Line item"} (split ${idx + 1}/${resolved.length})`,
      amount: r.amount,
      gl_category: r.gl_category,
      confidence_level: CONFIDENCE_LEVEL.HIGH,
      logic_path: "SPLIT",
      requires_review: false,
      manually_overridden: true,
      overridden_by: profile.id,
      split_parent_id: params.id,
      split_percentage:
        typeof r.percentage === "number"
          ? r.percentage
          : Math.round((r.amount / parentAmount) * 10000) / 100,
      sort_order: baseSort + (idx + 1) / 100,
    }));

    const { data: children, error } = await admin
      .from("line_items")
      .insert(childRows)
      .select("*");
    if (error) throw new Error(error.message);

    // Mark the parent as split: keep it for history but clear its review flag
    // so it no longer blocks export (children carry valid categories).
    await admin
      .from("line_items")
      .update({ requires_review: false, manually_overridden: true })
      .eq("id", params.id);

    await writeAudit({
      invoiceId: lineItem.invoice_id,
      userId: profile.id,
      action: AUDIT_ACTION.LINE_ITEM_SPLIT,
      prevValue: {
        description: lineItem.description,
        amount: parentAmount,
        gl_category: lineItem.gl_category,
      },
      newValue: { allocations: resolved },
      note: `${profile.name} split "${lineItem.description}" into ${resolved.length} allocations`,
    });

    return ok({ parentId: params.id, children }, 201);
  },
);
