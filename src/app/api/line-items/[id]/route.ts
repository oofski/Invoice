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
  REQUIRES_MANUAL_REVIEW,
} from "@/lib/constants";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/**
 * PATCH /api/line-items/[id] — override the GL category on a single line item
 * (Brief §07, Sessions 4 & 5). Flags manually_overridden, clears the
 * REQUIRES_MANUAL_REVIEW flag when a valid category is chosen, writes audit.
 *
 * Body: { "gl_category": "Supplies" }
 */
export const PATCH = withErrorHandling(
  async (request: NextRequest, { params }: Ctx) => {
    const profile = await requireProfile();
    const loaded = await loadEditableLineItem(params.id, profile);
    if (!loaded.ok) return fail(loaded.error, loaded.status);
    const { lineItem } = loaded;

    const body = await request.json().catch(() => ({}));
    const category = body?.gl_category as string | undefined;
    if (!category) return fail("gl_category is required", 400);
    if (
      category !== REQUIRES_MANUAL_REVIEW &&
      !GL_CATEGORIES_FLAT.includes(category)
    ) {
      return fail("Invalid GL category", 400);
    }

    const wasReview = lineItem.requires_review;
    const stillReview = category === REQUIRES_MANUAL_REVIEW;

    const admin = createAdminClient();
    const { data: updated, error } = await admin
      .from("line_items")
      .update({
        gl_category: category,
        manually_overridden: true,
        overridden_by: profile.id,
        requires_review: stillReview,
        confidence_level: stillReview
          ? CONFIDENCE_LEVEL.MANUAL_REVIEW
          : CONFIDENCE_LEVEL.HIGH,
        logic_path: "MANUAL OVERRIDE",
      })
      .eq("id", params.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    await writeAudit({
      invoiceId: lineItem.invoice_id,
      userId: profile.id,
      action:
        wasReview && !stillReview
          ? AUDIT_ACTION.MANUAL_REVIEW_RESOLVED
          : AUDIT_ACTION.GL_OVERRIDE,
      prevValue: {
        gl_category: lineItem.gl_category,
        confidence_level: lineItem.confidence_level,
      },
      newValue: { gl_category: category },
      note: `${profile.name} set "${lineItem.description}" to ${category}`,
    });

    return ok({ lineItem: updated });
  },
);
