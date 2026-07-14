/**
 * CCRMS line-by-line receipt coding — core logic (NEW; backend agent B).
 *
 * Owns:
 *   - `persistReceiptLines` — best-effort write of `cc_receipt_lines` on receipt
 *     upload (re-OCR safe; carries forward prior coding when lines match — §2.2/§2.3).
 *   - `validateLineCoding` — exact-to-cent reconcile validation mirroring
 *     `validateSplits` (entity ∈ CC_ENTITIES, location ∈ locationsFor(entity),
 *     gl_category in the allowed set, per-line + whole-tx sums exact — §3.5).
 *   - `splitEven` — floor + remainder-cents even split (cents-exact — §3.2).
 *   - `allocateTax` — by-spend-weight (or even) tax allocation with last-cent
 *     residual fix (§3.4).
 *   - `deriveEntitySplits` — entity rollup of allocations → `cc_entity_splits`
 *     (replace-all; passes the existing `validateSplits` — §1.1/§4 step 4).
 *   - `locationsFor` — BUSINESS_CLASSES[entity] else [entity] (§3.1).
 *   - DB read/write helpers (`readLines`, `replaceLines`) used by the route.
 *
 * Imports `BUSINESS_CLASSES` from `lib/constants.ts` READ-ONLY. Money math runs
 * through `roundCents` (the same idiom as `validateSplits`).
 */
import type { Env } from "../lib/types";
import { BUSINESS_CLASSES } from "../lib/constants";
import { uuid, nowIso } from "../lib/util";
import { isCcEntity } from "./ccConstants";
import { roundCents, fmtMoney, validateSplits } from "./ccRules";
import type {
  NormalizedReceipt,
  ReceiptLine,
  LineAllocation,
  ReceiptLineRow,
  LineAllocationRow,
  EntitySplitInput,
} from "./ccTypes";

/** The three GL-category labels a line allocation may carry (§3.5). */
export const SERVICE_COSTS = "Service Costs";
export const RETAIL_COSTS = "Retail / Product Costs";
export const SALES_USE_TAX = "Sales/Use Tax";
const ALLOWED_GL_CATEGORIES: ReadonlySet<string> = new Set([
  SERVICE_COSTS,
  RETAIL_COSTS,
  SALES_USE_TAX,
]);

/** A synthetic line_index for the (single) TAX line so it sorts last. */
export const TAX_LINE_INDEX = 99;

// ---------------------------------------------------------------------------
// Location set per entity (§3.1)
// ---------------------------------------------------------------------------

/**
 * The campuses/locations for a CC entity:
 *   - `BUSINESS_CLASSES[entity]` when present (Neroli/SKNBar/IBW have many;
 *     Chicago/Admin/Nala are single);
 *   - `[entity]` otherwise (UrbanAyurveda — single implicit campus = entity name).
 */
export function locationsFor(entity: string): string[] {
  const classes = BUSINESS_CLASSES[entity];
  return classes && classes.length ? classes : [entity];
}

/** O(1) check that `location` is a valid campus for `entity`. */
function isLocationFor(entity: string, location: string): boolean {
  return locationsFor(entity).includes(location);
}

// ---------------------------------------------------------------------------
// Even split (§3.2) and tax allocation (§3.4) — pure, cents-exact helpers
// ---------------------------------------------------------------------------

/**
 * Splits `amountCents` (integer cents) into `n` cents-exact parts: floor each,
 * then hand the first `rem` parts one extra cent. `Σ result === amountCents`.
 * `$10.00` across 3 → 334/333/333. A non-positive `n` returns `[]`.
 */
export function splitEvenCents(amountCents: number, n: number): number[] {
  if (n <= 0) return [];
  const total = Math.round(amountCents);
  const per = Math.floor(total / n);
  const rem = total - per * n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(per + (i < rem ? 1 : 0));
  return out;
}

/**
 * Dollar-space convenience: splits `amount` evenly across `n`, cents-exact.
 * `$30.00 / 3 → [10, 10, 10]`; `$10.00 / 3 → [3.34, 3.33, 3.33]`.
 */
export function splitEven(amount: number, n: number): number[] {
  return splitEvenCents(roundCents(amount) * 100, n).map((c) => roundCents(c / 100));
}

/**
 * Allocates a tax amount `T` across `locations` (in order) per the user's rule
 * (§3.4):
 *   - `mode='by-spend'` (default): proportional to each location's item-spend
 *     `weights[i]`; the last-cent residual lands on the largest-weight location
 *     so `Σ === roundCents(T)`. Falls back to even when all weights are 0.
 *   - `mode='even'`: a strict cents-exact even split regardless of weight.
 * Returns one amount per input location (same order), each `roundCents`-clean.
 */
export function allocateTax(
  amount: number,
  weights: number[],
  mode: "by-spend" | "even" = "by-spend",
): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const totalCents = Math.round(roundCents(amount) * 100);
  if (totalCents <= 0) return weights.map(() => 0);

  const weightCents = weights.map((w) => Math.max(0, Math.round(roundCents(w) * 100)));
  const sumWeight = weightCents.reduce((a, b) => a + b, 0);

  if (mode === "even" || sumWeight === 0) {
    return splitEvenCents(totalCents, n).map((c) => roundCents(c / 100));
  }

  // By-spend: floor each proportional share, then push the residual cents onto
  // the largest-weight location(s) (descending weight, ties by original order).
  const shares = weightCents.map((w) => Math.floor((totalCents * w) / sumWeight));
  let used = shares.reduce((a, b) => a + b, 0);
  let residual = totalCents - used;
  const order = weightCents
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w - a.w || a.i - b.i);
  for (let k = 0; residual > 0 && k < order.length; k = (k + 1) % order.length) {
    shares[order[k % order.length].i] += 1;
    residual -= 1;
    used += 1;
  }
  return shares.map((c) => roundCents(c / 100));
}

// ---------------------------------------------------------------------------
// Validation (§3.5) — exact-to-cent, mirrors validateSplits
// ---------------------------------------------------------------------------

export interface LineCodingValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validates the full line set against a transaction `txAmount` (§3.5), exact-to-cent
 * like `validateSplits`:
 *   - every allocation's `entity_name` ∈ `CC_ENTITIES`; `location` ∈
 *     `locationsFor(entity)`; `gl_category` ∈ the allowed set; amount finite & ≥ 0;
 *   - per line: `roundCents(Σ alloc.amount) === roundCents(line.amount)`;
 *   - whole tx: `roundCents(Σ all alloc.amount) === roundCents(txAmount)`.
 * Returns `{ ok, error }` in the `validateSplits` style. Never throws.
 */
export function validateLineCoding(
  txAmount: number,
  lines: ReceiptLine[],
): LineCodingValidation {
  if (!Array.isArray(lines)) {
    return { ok: false, error: "Lines must be an array." };
  }

  let txSum = 0;
  for (const line of lines) {
    if (!line || typeof line !== "object") {
      return { ok: false, error: "Invalid line entry." };
    }
    const lineAmt = toNum(line.amount);
    if (!Number.isFinite(lineAmt)) {
      return { ok: false, error: `Invalid amount for line "${line.description ?? ""}"` };
    }
    const allocs = Array.isArray(line.allocations) ? line.allocations : [];
    let lineSum = 0;
    for (const a of allocs) {
      if (!a || typeof a.entity_name !== "string" || !isCcEntity(a.entity_name)) {
        return { ok: false, error: `Unknown entity: ${a?.entity_name ?? "(missing)"}` };
      }
      if (typeof a.location !== "string" || !isLocationFor(a.entity_name, a.location)) {
        return {
          ok: false,
          error: `Invalid location "${a?.location ?? "(missing)"}" for ${a.entity_name}`,
        };
      }
      if (typeof a.gl_category !== "string" || !ALLOWED_GL_CATEGORIES.has(a.gl_category)) {
        return { ok: false, error: `Invalid category: ${a?.gl_category ?? "(missing)"}` };
      }
      const amt = toNum(a.amount);
      if (!Number.isFinite(amt)) {
        return { ok: false, error: `Invalid amount for ${a.entity_name} / ${a.location}` };
      }
      if (roundCents(amt) < 0) {
        return { ok: false, error: `Amounts cannot be negative (${a.entity_name})` };
      }
      lineSum += amt;
    }
    // Per-line reconcile: allocations must sum to the line amount, exact-to-cent.
    if (roundCents(lineSum) !== roundCents(lineAmt)) {
      const label = line.description ? `"${line.description}"` : `(${fmtMoney(lineAmt)})`;
      return {
        ok: false,
        error: `Line ${label} allocations must sum to ${fmtMoney(lineAmt)} (got ${fmtMoney(lineSum)})`,
      };
    }
    txSum += lineAmt;
  }

  // Whole-tx reconcile: every line amount must sum to the transaction amount.
  if (roundCents(txSum) !== roundCents(txAmount)) {
    const diff = roundCents(Math.abs(roundCents(txAmount) - roundCents(txSum)));
    return {
      ok: false,
      error: `Lines must sum to the transaction amount (${fmtMoney(txAmount)}); difference is ${fmtMoney(diff)}`,
    };
  }
  return { ok: true };
}

function toNum(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

// ---------------------------------------------------------------------------
// Entity rollup → cc_entity_splits (§1.1 / §4 step 4)
// ---------------------------------------------------------------------------

/**
 * Rolls a tx's line allocations up into per-entity totals (the legacy
 * `cc_entity_splits` shape). One row per entity = `roundCents(Σ allocations of
 * that entity)`; $0 rows dropped. By construction `Σ rows == tx.amount`, so the
 * derived splits pass the existing `validateSplits`.
 */
export function rollupEntitySplits(lines: ReceiptLine[]): EntitySplitInput[] {
  const byEntity = new Map<string, number>();
  for (const line of lines) {
    for (const a of line.allocations ?? []) {
      const amt = roundCents(toNum(a.amount));
      if (!Number.isFinite(amt)) continue;
      byEntity.set(a.entity_name, (byEntity.get(a.entity_name) ?? 0) + amt);
    }
  }
  const out: EntitySplitInput[] = [];
  for (const [entity_name, sum] of byEntity) {
    const amount = roundCents(sum);
    if (amount === 0) continue;
    out.push({ entity_name, amount });
  }
  return out;
}

/**
 * Re-derives `cc_entity_splits` for a tx from its line allocations (replace-all:
 * DELETE then INSERT, $0 rows dropped). Keeps the legacy modal/email/GET-detail
 * correct for free. Caller supplies the same `at` timestamp it used for the lines.
 */
export function deriveEntitySplitsStmts(
  env: Env,
  transactionId: string,
  lines: ReceiptLine[],
  at: string,
): D1PreparedStatement[] {
  const rows = rollupEntitySplits(lines);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM cc_entity_splits WHERE transaction_id = ?").bind(transactionId),
  ];
  for (const r of rows) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO cc_entity_splits (id, transaction_id, entity_name, amount, created_at) VALUES (?,?,?,?,?)",
      ).bind(uuid(), transactionId, r.entity_name, r.amount, at),
    );
  }
  return stmts;
}

/**
 * v1.9.3 fix (#6): the replace-all is now atomic — all DELETE + INSERT rows go
 * through a single `env.DB.batch([...])` so a mid-loop failure can't leave
 * `cc_entity_splits` half-written (the line-item split already did this).
 */
export async function deriveEntitySplits(
  env: Env,
  transactionId: string,
  lines: ReceiptLine[],
  at: string,
): Promise<void> {
  await env.DB.batch(deriveEntitySplitsStmts(env, transactionId, lines, at));
}

// ---------------------------------------------------------------------------
// OCR line persistence on upload (§2.2 / §2.3)
// ---------------------------------------------------------------------------

/** Carry-forward match key: `(line_index | roundedCents | description)`. */
function lineMatchKey(lineIndex: number, amount: number, description: string): string {
  return `${lineIndex}|${roundCents(amount).toFixed(2)}|${(description || "").trim().toLowerCase()}`;
}

/**
 * Best-effort: persists `cc_receipt_lines` for a freshly-uploaded receipt (§2.2).
 *
 *   - Deletes any prior lines for this `receipt_id` (re-upload safety), first
 *     snapshotting them so we can carry forward coding (§2.3).
 *   - Inserts one ITEM row per `normalized.line_items[i]` (line_index = i).
 *   - If `normalized.sales_tax > 0`, inserts one TAX row (amount = sales_tax).
 *   - When a new line matches an old one by `(line_index, roundCents(amount),
 *     description)`, re-points that old line's `cc_line_allocations` to the new
 *     line id and marks it coded; otherwise the new line starts uncoded.
 *   - Leaves brand-new lines' allocations empty (the user codes them via §4).
 *
 * Never throws — the caller wraps it in try/catch, but it self-guards too so a
 * partial failure can't bubble up and block the 201 receipt insert.
 */
export async function persistReceiptLines(
  env: Env,
  args: { transactionId: string; receiptId: string; normalized: NormalizedReceipt },
): Promise<void> {
  const { transactionId, receiptId, normalized } = args;
  const items = Array.isArray(normalized.line_items) ? normalized.line_items : [];
  const tax = normalized.sales_tax;
  const hasTax = typeof tax === "number" && Number.isFinite(tax) && roundCents(tax) > 0;

  // Nothing to persist — leave the tx on the legacy whole-charge path (§2.2.3).
  if (items.length === 0 && !hasTax) return;

  try {
    // Snapshot prior lines for this receipt (for carry-forward), then delete them.
    const prior = await env.DB.prepare(
      "SELECT id, line_index, kind, description, amount FROM cc_receipt_lines WHERE receipt_id = ?",
    )
      .bind(receiptId)
      .all<Pick<ReceiptLineRow, "id" | "line_index" | "kind" | "description" | "amount">>();
    const priorById = new Map<string, string>(); // matchKey -> old line id
    for (const p of prior.results ?? []) {
      priorById.set(lineMatchKey(p.line_index, p.amount, p.description ?? ""), p.id);
    }

    await env.DB.prepare("DELETE FROM cc_receipt_lines WHERE receipt_id = ?")
      .bind(receiptId)
      .run();

    const at = nowIso();

    // Insert the ITEM rows.
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const amount = roundCents(typeof it.amount === "number" ? it.amount : 0);
      const newId = uuid();
      const oldId = priorById.get(lineMatchKey(i, amount, it.description ?? ""));
      const coded = oldId ? await carryForwardAllocations(env, oldId, newId, at) : false;
      await env.DB.prepare(
        `INSERT INTO cc_receipt_lines
           (id, transaction_id, receipt_id, line_index, kind, description, quantity, unit_price, amount, is_coded, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          newId,
          transactionId,
          receiptId,
          i,
          "ITEM",
          it.description || null,
          it.quantity ?? null,
          it.unit_price ?? null,
          amount,
          coded ? 1 : 0,
          at,
          at,
        )
        .run();
    }

    // Insert the single TAX row (kind='TAX') when the receipt printed sales tax.
    if (hasTax) {
      const amount = roundCents(tax as number);
      const newId = uuid();
      const oldId = priorById.get(lineMatchKey(TAX_LINE_INDEX, amount, "Sales Tax"));
      const coded = oldId ? await carryForwardAllocations(env, oldId, newId, at) : false;
      await env.DB.prepare(
        `INSERT INTO cc_receipt_lines
           (id, transaction_id, receipt_id, line_index, kind, description, quantity, unit_price, amount, is_coded, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          newId,
          transactionId,
          receiptId,
          TAX_LINE_INDEX,
          "TAX",
          "Sales Tax",
          null,
          null,
          amount,
          coded ? 1 : 0,
          at,
          at,
        )
        .run();
    }
  } catch (e) {
    console.error("[cc] persistReceiptLines failed (skipping line persistence):", e);
  }
}

/**
 * Re-points an old line's `cc_line_allocations` to a new line id (carry-forward
 * on re-OCR, §2.3). Returns true when at least one allocation was carried so the
 * caller can set `is_coded`.
 */
async function carryForwardAllocations(
  env: Env,
  oldLineId: string,
  newLineId: string,
  _at: string,
): Promise<boolean> {
  const cnt = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM cc_line_allocations WHERE line_id = ?",
  )
    .bind(oldLineId)
    .first<{ n: number }>();
  if (!cnt || !cnt.n) return false;
  await env.DB.prepare("UPDATE cc_line_allocations SET line_id = ? WHERE line_id = ?")
    .bind(newLineId, oldLineId)
    .run();
  return true;
}

// ---------------------------------------------------------------------------
// DB read/write helpers used by routes/cc/lines.ts
// ---------------------------------------------------------------------------

/** Hydrates a `cc_receipt_lines` row + its allocations into a `ReceiptLine` DTO. */
function hydrateAllocation(r: LineAllocationRow): LineAllocation {
  return {
    id: r.id,
    entity_name: r.entity_name,
    location: r.location,
    gl_category: r.gl_category,
    amount: r.amount,
    is_tax: !!r.is_tax,
  };
}

/**
 * Reads all lines (+ allocations) for a tx, ordered by (line_index, created_at),
 * and assembles the `LinesResponse` payload (totals + reconcile flag) the GET/PUT
 * handlers return.
 */
export async function readLines(env: Env, txId: string, txAmount: number) {
  const lineRes = await env.DB.prepare(
    "SELECT * FROM cc_receipt_lines WHERE transaction_id = ? ORDER BY line_index ASC, created_at ASC",
  )
    .bind(txId)
    .all<ReceiptLineRow>();
  const allocRes = await env.DB.prepare(
    "SELECT * FROM cc_line_allocations WHERE transaction_id = ? ORDER BY created_at ASC",
  )
    .bind(txId)
    .all<LineAllocationRow>();

  const allocByLine = new Map<string, LineAllocation[]>();
  for (const a of allocRes.results ?? []) {
    const list = allocByLine.get(a.line_id) ?? [];
    list.push(hydrateAllocation(a));
    allocByLine.set(a.line_id, list);
  }

  let allocatedTotal = 0;
  const lines: ReceiptLine[] = (lineRes.results ?? []).map((r) => {
    const allocations = allocByLine.get(r.id) ?? [];
    for (const a of allocations) allocatedTotal += roundCents(a.amount);
    return {
      id: r.id,
      receipt_id: r.receipt_id,
      line_index: r.line_index,
      kind: r.kind === "TAX" ? "TAX" : "ITEM",
      description: r.description ?? "",
      quantity: r.quantity,
      unit_price: r.unit_price,
      amount: r.amount,
      is_coded: !!r.is_coded,
      allocations,
    };
  });

  const allocated = roundCents(allocatedTotal);
  const amount = roundCents(txAmount);
  return {
    lines,
    transaction_amount: amount,
    allocated_total: allocated,
    remaining: roundCents(amount - allocated),
    reconciled: lines.length > 0 && allocated === amount,
  };
}

/**
 * Replace-all writer for a tx's lines + allocations (§4 step 3). DELETEs all
 * existing lines/allocations for the tx, then re-inserts from `lines`, dropping
 * $0 allocation rows and setting `is_coded` per line. Where an incoming line
 * carries a `receipt_id` it is preserved (manual lines write NULL). Uses the
 * supplied `at` timestamp throughout for consistency with the entity rollup.
 */
export function replaceLinesStmts(
  env: Env,
  txId: string,
  lines: ReceiptLine[],
  at: string,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM cc_line_allocations WHERE transaction_id = ?").bind(txId),
    env.DB.prepare("DELETE FROM cc_receipt_lines WHERE transaction_id = ?").bind(txId),
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kind = line.kind === "TAX" ? "TAX" : "ITEM";
    const lineId = uuid();
    const lineAmount = roundCents(toNum(line.amount));
    const lineIndex =
      typeof line.line_index === "number"
        ? line.line_index
        : kind === "TAX"
          ? TAX_LINE_INDEX
          : i;

    // Build the non-zero allocation rows first so we can set is_coded correctly.
    const allocRows: { entity: string; location: string; gl: string; amount: number; isTax: boolean }[] = [];
    let codedSum = 0;
    for (const a of line.allocations ?? []) {
      const amt = roundCents(toNum(a.amount));
      if (amt === 0) continue;
      const isTax = a.is_tax === true || a.gl_category === SALES_USE_TAX || kind === "TAX";
      allocRows.push({
        entity: a.entity_name,
        location: a.location,
        gl: a.gl_category,
        amount: amt,
        isTax,
      });
      codedSum += amt;
    }
    const isCoded = allocRows.length > 0 && roundCents(codedSum) === lineAmount ? 1 : 0;

    stmts.push(
      env.DB.prepare(
        `INSERT INTO cc_receipt_lines
         (id, transaction_id, receipt_id, line_index, kind, description, quantity, unit_price, amount, is_coded, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        lineId,
        txId,
        line.receipt_id ?? null,
        lineIndex,
        kind,
        line.description || null,
        line.quantity ?? null,
        line.unit_price ?? null,
        lineAmount,
        isCoded,
        at,
        at,
      ),
    );

    for (const ar of allocRows) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO cc_line_allocations
           (id, line_id, transaction_id, entity_name, location, gl_category, amount, is_tax, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        ).bind(uuid(), lineId, txId, ar.entity, ar.location, ar.gl, ar.amount, ar.isTax ? 1 : 0, at),
      );
    }
  }
  return stmts;
}

/**
 * v1.9.3 fix (#6): DELETE + all re-inserts now run in a single `env.DB.batch`
 * so a mid-loop failure can't leave the tx's lines/allocations half-written.
 */
export async function replaceLines(
  env: Env,
  txId: string,
  lines: ReceiptLine[],
  at: string,
): Promise<void> {
  await env.DB.batch(replaceLinesStmts(env, txId, lines, at));
}

/** Re-exported for the route so it can mirror the `validateSplits` derived check. */
export { validateSplits };
