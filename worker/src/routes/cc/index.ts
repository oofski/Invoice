/**
 * CCRMS route mounter (owned by Agent A2).
 *
 * Mounts all eight CC sub-apps so the final paths equal the §6 contract under the
 * `/api/cc` prefix (the parent `index.ts` does `app.route("/api/cc", cc)`).
 *
 * Mount-path strategy: the transactions / splits / receipts sub-apps all live
 * under `/transactions/...` and `/receipts/...`, so each declares its FULL
 * sub-paths internally and is mounted at `"/"` — this keeps Hono from shadowing
 * (e.g. `/transactions/:id` vs `/transactions/:id/splits`) and lets the three
 * route files be authored independently. `uploads`, `cardholders`,
 * `notifications`, `dashboard` mount under their own prefixes.
 *
 *   final path                                  sub-app   mount
 *   ------------------------------------------  --------  ----------------------
 *   /api/cc/uploads/preview|:id/confirm         uploads   cc.route("/uploads")
 *   /api/cc/uploads (history)                   uploads   cc.route("/uploads")
 *   /api/cc/transactions[...]                   transactions  cc.route("/transactions")  (A3)
 *   /api/cc/transactions/:id/splits             splits    cc.route("/")
 *   /api/cc/transactions/:id/receipts           receipts  cc.route("/")
 *   /api/cc/receipts/:id/file|:id               receipts  cc.route("/")
 *   /api/cc/cardholders[...]                     cardholders   cc.route("/cardholders")
 *   /api/cc/notifications[...]                   notifications cc.route("/notifications") (A3)
 *   /api/cc/dashboard/summary                    dashboard cc.route("/dashboard") (A3)
 *
 * A3 authored `./transactions`, `./notifications`, `./dashboard` with RELATIVE
 * sub-paths (e.g. `transactions.get("/:id")`, `notifications.post("/send")`,
 * `dashboard.get("/summary")`), so each mounts under its own prefix
 * (`/transactions`, `/notifications`, `/dashboard`). The A2 splits/receipts
 * sub-apps instead declare their FULL `/transactions/:id/...` and `/receipts/:id`
 * paths internally and mount at `/`; because `/transactions/:id` (one segment)
 * never matches `/transactions/:id/splits` (two segments), the transactions
 * sub-app and the splits/receipts sub-apps coexist without shadowing.
 */
import { Hono } from "hono";
import type { AppEnv } from "../helpers";

// A2-owned sub-apps.
import { uploads } from "./uploads";
import { splits } from "./splits";
import { receipts } from "./receipts";
import { inbox } from "./inbox";
import { lines } from "./lines";
import { cardholders } from "./cardholders";

// A3-owned sub-apps (authored in parallel — may not exist yet at A2 finish).
import { transactions } from "./transactions";
import { notifications } from "./notifications";
import { dashboard } from "./dashboard";
import { ledger } from "./ledger";

export const cc = new Hono<AppEnv>();

// Uploads (manager): /api/cc/uploads/preview, /api/cc/uploads/:id/confirm, /api/cc/uploads
cc.route("/uploads", uploads);

// Cardholders (manager): /api/cc/cardholders[...]
cc.route("/cardholders", cardholders);

// Transactions (A3): /api/cc/transactions[...] — A3 uses relative sub-paths.
cc.route("/transactions", transactions);

// Splits (A2): /api/cc/transactions/:id/splits — declares full sub-paths internally.
cc.route("/", splits);

// Receipt inbox (Feature A): /api/cc/receipts/inbox[...] — RELATIVE sub-paths.
// Mounted BEFORE `receipts` so /receipts/inbox is matched by this more-specific
// sub-app and never collides with the receipts sub-app's /receipts/:id.
cc.route("/receipts/inbox", inbox);

// Receipts (A2): /api/cc/transactions/:id/receipts + /api/cc/receipts/:id[...] —
// declares full sub-paths internally.
cc.route("/", receipts);

// Lines (B): /api/cc/transactions/:id/lines — declares full sub-paths internally.
// The 3-segment path never shadows /transactions/:id or /transactions/:id/splits.
cc.route("/", lines);

// Notifications (A3): /api/cc/notifications[...]
cc.route("/notifications", notifications);

// Dashboard (A3): /api/cc/dashboard/summary
cc.route("/dashboard", dashboard);

// Ledger: /api/cc/ledger — per-cardholder split-matrix ledger for one cycle.
cc.route("/ledger", ledger);
