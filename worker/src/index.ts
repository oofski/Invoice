import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./routes/helpers";
import { userFromToken, bearer } from "./lib/auth";
import { authPublic, authProtected } from "./routes/auth";
import { ingest } from "./routes/ingest";
import { invoices } from "./routes/invoices";
import { lineItems } from "./routes/lineItems";
import { exportRoutes } from "./routes/export";
import { vendors } from "./routes/vendors";
import { audit } from "./routes/audit";
import { dashboard } from "./routes/dashboard";
import { users } from "./routes/users";
import { cc } from "./routes/cc";
import { ensureSchema, ensureSeedData } from "./lib/migrations";
import { ensureCcSchema } from "./cc/ccMigrations";

/**
 * InvoiceIQ Cloudflare Worker — the backend + D1 database for the desktop app.
 * Bearer-token auth (no cookies), so permissive CORS is safe for the Electron
 * renderer (which has a file:// / null origin).
 */
const app = new Hono<AppEnv>();

app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization"], allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] }));

// On the first request per isolate, self-apply (a) the additive schema migration
// for the v1.2.8 archive / audit-clear features and (b) the system-managed
// mapping seeds (location keywords, inventory vendors) — so both go live
// automatically on deploy with no manual `wrangler`/`db:init`. Both are guarded,
// idempotent, and never throw (see migrations.ts).
app.use("*", async (c, next) => {
  await ensureSchema(c.env);
  await ensureSeedData(c.env);
  await ensureCcSchema(c.env);
  return next();
});

app.get("/", (c) => c.json({ name: "InvoiceIQ API", status: "ok" }));
// Additive health probe: bare `/` now serves the mobile SPA index at the edge (a
// static asset), so this worker-side probe is never shadowed by the SPA fallback.
app.get("/healthz", (c) => c.json({ name: "InvoiceIQ API", status: "ok" }));

// Public auth endpoints.
app.route("/api/auth", authPublic);

// Unattended ingestion (SharePoint / Power Automate) — token-authed, NOT a user
// session, so it lives outside the `/api/*` gate below.
app.route("/ingest", ingest);

// Auth gate for everything below.
app.use("/api/*", async (c, next) => {
  // public auth routes already handled above; re-check to allow them through.
  const path = new URL(c.req.url).pathname;
  if (path === "/api/auth/login" || path === "/api/auth/bootstrap") return next();
  const u = await userFromToken(c.env, bearer(c.req.header("authorization")));
  if (!u) return c.json({ error: "Not authenticated" }, 401);
  c.set("user", u);
  await next();
});

// Protected routes.
app.route("/api/auth", authProtected);
app.route("/api/invoices", invoices);
app.route("/api/line-items", lineItems);
app.route("/api/export", exportRoutes);
app.route("/api/vendors", vendors);
app.route("/api/audit", audit);
app.route("/api/dashboard", dashboard);
app.route("/api/users", users);
app.route("/api/cc", cc);

// Additive: serve the Executive Mobile Receipt SPA (mobile/dist via the ASSETS
// binding) for any non-API GET. Declared LAST so it can never shadow an existing
// route. The installed wrangler (3.114.17) lacks `run_worker_first`'s array form,
// so THIS catch-all — not wrangler.toml — is what keeps every API path on the
// worker: /api/* & /ingest/* are handled above and are explicitly excluded here so
// unknown paths under them keep the worker's native 404 (never the SPA index). For
// everything else, `env.ASSETS.fetch` returns the hashed asset, or — via
// `not_found_handling = "single-page-application"` — index.html for SPA deep links.
app.get("*", (c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") || path === "/ingest" || path.startsWith("/ingest/")) {
    return c.notFound();
  }
  return (c.env as unknown as { ASSETS: Fetcher }).ASSETS.fetch(c.req.raw);
});

// Surface real error messages to the client (and the Worker logs) instead of a
// bare 500, so failures like a misconfigured Reducto key or an unexpected
// Reducto API response are diagnosable from the app.
app.onError((err, c) => {
  console.error("[worker error]", err);
  const message = err instanceof Error ? err.message : "Internal server error";
  return c.json({ error: message }, 500);
});

export default app;
