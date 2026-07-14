/**
 * CCRMS cardholder registry routes (NEW; owned by A2). §6.6. Manager-only CRUD
 * with soft-delete.
 *
 *   GET    /cardholders     — all (incl. inactive; the UI filters).
 *   POST   /cardholders     — create (validates first_name / card_source /
 *                             last-4 = 4 digits / last-5 = 5 digits) → 201.
 *   PATCH  /cardholders/:id  — partial update (+ is_active, user_id) → 200.
 *   DELETE /cardholders/:id  — soft delete (is_active = 0) → 204.
 *
 * Implements the §2 preamble (404→503→403→400→success).
 */
import { Hono } from "hono";
import type { AppEnv } from "../helpers";
import { user, hasRole } from "../helpers";
import { ROLES } from "../../lib/constants";
import { isCcEnabled, ccReady } from "../../cc/flag";
import { uuid, nowIso } from "../../lib/util";
import { CC_CARD_SOURCES } from "../../cc/ccConstants";
import type { Cardholder, CardholderRow, CcCardSource } from "../../cc/ccTypes";

export const cardholders = new Hono<AppEnv>();

function isManager(c: import("hono").Context<AppEnv>): boolean {
  return hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT);
}

function hydrate(r: CardholderRow): Cardholder {
  return {
    id: r.id,
    first_name: r.first_name,
    last_name: r.last_name,
    email: r.email,
    card_source: r.card_source as CcCardSource,
    cap_one_last4: r.cap_one_last4,
    amex_last5: r.amex_last5,
    amex_sheet_name: r.amex_sheet_name,
    user_id: r.user_id,
    is_active: !!r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Normalizes an optional digit string field; returns `undefined` when absent. */
function digitsOrNull(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return String(v).replace(/\D/g, "");
}

// ----- GET /cardholders -----------------------------------------------------
cardholders.get("/", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );
  if (!isManager(c)) return c.json({ error: "Forbidden" }, 403);

  const rows = await c.env.DB.prepare(
    "SELECT * FROM cc_cardholders ORDER BY first_name ASC, last_name ASC",
  ).all<CardholderRow>();
  return c.json({ cardholders: (rows.results ?? []).map(hydrate) });
});

// ----- POST /cardholders ----------------------------------------------------
cardholders.post("/", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );
  if (!isManager(c)) return c.json({ error: "Forbidden" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as {
    first_name?: string;
    last_name?: string;
    email?: string;
    card_source?: string;
    cap_one_last4?: string;
    amex_last5?: string;
    amex_sheet_name?: string;
    user_id?: string;
  };

  const firstName = (body.first_name ?? "").trim();
  if (!firstName) return c.json({ error: "first_name is required" }, 400);

  const cardSource = (body.card_source ?? "").trim() as CcCardSource;
  if (!(CC_CARD_SOURCES as readonly string[]).includes(cardSource))
    return c.json({ error: "card_source must be CAPITAL_ONE, AMEX, or BOTH" }, 400);

  const capLast4 = digitsOrNull(body.cap_one_last4);
  if (capLast4 != null && capLast4 !== "" && capLast4.length !== 4)
    return c.json({ error: "cap_one_last4 must be 4 digits" }, 400);

  const amexLast5 = digitsOrNull(body.amex_last5);
  if (amexLast5 != null && amexLast5 !== "" && amexLast5.length !== 5)
    return c.json({ error: "amex_last5 must be 5 digits" }, 400);

  const id = uuid();
  const at = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO cc_cardholders
       (id, first_name, last_name, email, card_source, cap_one_last4, amex_last5,
        amex_sheet_name, user_id, is_active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      firstName,
      (body.last_name ?? "").trim() || null,
      (body.email ?? "").trim() || null,
      cardSource,
      capLast4 || null,
      amexLast5 || null,
      (body.amex_sheet_name ?? "").trim() || null,
      (body.user_id ?? "").trim() || null,
      1,
      at,
      at,
    )
    .run();

  const row = await c.env.DB.prepare("SELECT * FROM cc_cardholders WHERE id = ?")
    .bind(id)
    .first<CardholderRow>();
  return c.json({ cardholder: row ? hydrate(row) : null }, 201);
});

// ----- PATCH /cardholders/:id -----------------------------------------------
cardholders.patch("/:id", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );
  if (!isManager(c)) return c.json({ error: "Forbidden" }, 403);

  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM cc_cardholders WHERE id = ?")
    .bind(id)
    .first<CardholderRow>();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];

  if ("first_name" in body) {
    const v = String(body.first_name ?? "").trim();
    if (!v) return c.json({ error: "first_name cannot be empty" }, 400);
    sets.push("first_name = ?");
    params.push(v);
  }
  if ("last_name" in body) {
    sets.push("last_name = ?");
    params.push(String(body.last_name ?? "").trim() || null);
  }
  if ("email" in body) {
    sets.push("email = ?");
    params.push(String(body.email ?? "").trim() || null);
  }
  if ("card_source" in body) {
    const v = String(body.card_source ?? "").trim();
    if (!(CC_CARD_SOURCES as readonly string[]).includes(v))
      return c.json({ error: "card_source must be CAPITAL_ONE, AMEX, or BOTH" }, 400);
    sets.push("card_source = ?");
    params.push(v);
  }
  if ("cap_one_last4" in body) {
    const v = digitsOrNull(body.cap_one_last4);
    if (v != null && v !== "" && v.length !== 4)
      return c.json({ error: "cap_one_last4 must be 4 digits" }, 400);
    sets.push("cap_one_last4 = ?");
    params.push(v || null);
  }
  if ("amex_last5" in body) {
    const v = digitsOrNull(body.amex_last5);
    if (v != null && v !== "" && v.length !== 5)
      return c.json({ error: "amex_last5 must be 5 digits" }, 400);
    sets.push("amex_last5 = ?");
    params.push(v || null);
  }
  if ("amex_sheet_name" in body) {
    sets.push("amex_sheet_name = ?");
    params.push(String(body.amex_sheet_name ?? "").trim() || null);
  }
  if ("user_id" in body) {
    sets.push("user_id = ?");
    params.push(String(body.user_id ?? "").trim() || null);
  }
  if ("is_active" in body) {
    sets.push("is_active = ?");
    params.push(body.is_active ? 1 : 0);
  }

  if (!sets.length) return c.json({ error: "No updatable fields" }, 400);

  sets.push("updated_at = ?");
  params.push(nowIso());
  params.push(id);
  await c.env.DB.prepare(`UPDATE cc_cardholders SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...params)
    .run();

  const row = await c.env.DB.prepare("SELECT * FROM cc_cardholders WHERE id = ?")
    .bind(id)
    .first<CardholderRow>();
  return c.json({ cardholder: row ? hydrate(row) : null });
});

// ----- DELETE /cardholders/:id (soft delete) --------------------------------
cardholders.delete("/:id", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );
  if (!isManager(c)) return c.json({ error: "Forbidden" }, 403);

  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT id FROM cc_cardholders WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await c.env.DB.prepare(
    "UPDATE cc_cardholders SET is_active = 0, updated_at = ? WHERE id = ?",
  )
    .bind(nowIso(), id)
    .run();
  return c.body(null, 204);
});
