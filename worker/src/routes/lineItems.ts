import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "./helpers";
import { user, canViewInvoice } from "./helpers";
import { audit, getInvoice } from "../lib/db";
import { uuid } from "../lib/util";
import {
  AUDIT_ACTION,
  CONFIDENCE_LEVEL,
  REQUIRES_MANUAL_REVIEW,
  INVOICE_STATUS,
  isCategoryValidForEntity,
} from "../lib/constants";
import type { LineItemRow, InvoiceRow } from "../lib/types";

export const lineItems = new Hono<AppEnv>();

async function loadEditable(c: Context<AppEnv>, lineId: string) {
  const li = await c.env.DB.prepare("SELECT * FROM line_items WHERE id = ?")
    .bind(lineId)
    .first<LineItemRow>();
  if (!li) return { error: "Line item not found", status: 404 as const };
  const inv = await getInvoice(c.env, li.invoice_id);
  if (!inv) return { error: "Invoice not found", status: 404 as const };
  if (!canViewInvoice(c, inv)) return { error: "Forbidden", status: 403 as const };
  if (inv.status === INVOICE_STATUS.EXPORTED)
    return { error: "Invoice exported; line items locked", status: 409 as const };
  return { li, inv: inv as InvoiceRow };
}

// PATCH /:id — GL override
lineItems.patch("/:id", async (c) => {
  const loaded = await loadEditable(c, c.req.param("id"));
  if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);
  const { li, inv } = loaded;

  const body = await c.req.json().catch(() => ({}));
  const category = (body as { gl_category?: string }).gl_category;
  if (!category) return c.json({ error: "gl_category required" }, 400);
  const entity = li.business ?? inv.business;
  if (!isCategoryValidForEntity(entity, category, li.gl_category))
    return c.json({ error: "Invalid GL category" }, 400);

  const stillReview = category === REQUIRES_MANUAL_REVIEW;
  await c.env.DB.prepare(
    `UPDATE line_items SET gl_category=?, manually_overridden=1, overridden_by=?,
       requires_review=?, confidence_level=?, logic_path='MANUAL OVERRIDE' WHERE id=?`,
  )
    .bind(
      category,
      user(c).id,
      stillReview ? 1 : 0,
      stillReview ? CONFIDENCE_LEVEL.MANUAL_REVIEW : CONFIDENCE_LEVEL.HIGH,
      li.id,
    )
    .run();

  await audit(c.env, {
    invoiceId: li.invoice_id,
    userId: user(c).id,
    action: li.requires_review && !stillReview ? AUDIT_ACTION.MANUAL_REVIEW_RESOLVED : AUDIT_ACTION.GL_OVERRIDE,
    prevValue: { gl_category: li.gl_category, confidence_level: li.confidence_level },
    newValue: { gl_category: category },
    note: `${user(c).name} set "${li.description}" to ${category}`,
  });
  return c.json({ ok: true });
});

// POST /:id/split
lineItems.post("/:id/split", async (c) => {
  const loaded = await loadEditable(c, c.req.param("id"));
  if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);
  const { li, inv } = loaded;
  const entity = li.business ?? inv.business;

  const parentAmount = Number(li.amount ?? 0);
  if (parentAmount <= 0) return c.json({ error: "Cannot split a zero-amount line" }, 400);

  const body = await c.req.json().catch(() => ({}));
  const allocations = (body as { allocations?: { amount?: number; percentage?: number; gl_category: string }[] }).allocations;
  if (!Array.isArray(allocations) || allocations.length < 2)
    return c.json({ error: "Provide at least two split allocations" }, 400);

  const resolved = allocations.map((a) => ({
    amount:
      typeof a.amount === "number"
        ? a.amount
        : typeof a.percentage === "number"
          ? Math.round((parentAmount * a.percentage) / 100 * 100) / 100
          : NaN,
    gl_category: a.gl_category,
    percentage: a.percentage,
  }));
  for (const r of resolved) {
    if (!Number.isFinite(r.amount) || r.amount <= 0)
      return c.json({ error: "Each split must have a positive amount" }, 400);
    if (!r.gl_category || !isCategoryValidForEntity(entity, r.gl_category))
      return c.json({ error: `Invalid GL category: ${r.gl_category}` }, 400);
  }
  const sum = resolved.reduce((acc, r) => acc + r.amount, 0);
  if (Math.abs(sum - parentAmount) > 0.01)
    return c.json(
      { error: `Split amounts (${sum.toFixed(2)}) must equal the line total (${parentAmount.toFixed(2)})` },
      400,
    );

  await c.env.DB.prepare("DELETE FROM line_items WHERE split_parent_id = ?")
    .bind(li.id)
    .run();
  const base = li.sort_order ?? 0;
  const stmts = resolved.map((r, idx) =>
    c.env.DB.prepare(
      `INSERT INTO line_items (id, invoice_id, description, amount, gl_category,
         confidence_level, logic_path, requires_review, manually_overridden,
         overridden_by, split_parent_id, split_percentage, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      uuid(), li.invoice_id,
      `${li.description ?? "Line item"} (split ${idx + 1}/${resolved.length})`,
      r.amount, r.gl_category, CONFIDENCE_LEVEL.HIGH, "SPLIT", 0, 1,
      user(c).id, li.id,
      typeof r.percentage === "number" ? r.percentage : Math.round((r.amount / parentAmount) * 10000) / 100,
      base + (idx + 1) / 100,
    ),
  );
  await c.env.DB.batch(stmts);
  await c.env.DB.prepare(
    "UPDATE line_items SET requires_review = 0, manually_overridden = 1 WHERE id = ?",
  ).bind(li.id).run();

  await audit(c.env, {
    invoiceId: li.invoice_id,
    userId: user(c).id,
    action: AUDIT_ACTION.LINE_ITEM_SPLIT,
    prevValue: { description: li.description, amount: parentAmount, gl_category: li.gl_category },
    newValue: { allocations: resolved },
    note: `${user(c).name} split "${li.description}" into ${resolved.length} allocations`,
  });
  return c.json({ ok: true, parentId: li.id }, 201);
});
