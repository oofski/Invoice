import { useCallback, useEffect, useRef, useState } from "react";
import {
  UploadCloud,
  FileSpreadsheet,
  FileText,
  AlertTriangle,
  History,
  CheckCircle2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { CcSubNav } from "@/components/cc/CcSubNav";
import { Card, Button, EmptyState } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { cn, formatDate } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import {
  ccApi,
  type CapOneRow,
  type AmexRow,
  type PreviewResponse,
  type UploadBatch,
} from "@/cc/ccApi";
import { parseAmexWorkbook } from "@/cc/amexWorkbook";

// ---------------------------------------------------------------------------
// Capital One CSV hand-roll parser
// ---------------------------------------------------------------------------

/** Minimal RFC-4180-ish CSV line splitter (handles quoted commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function toIso(value: string): string {
  const s = value.trim();
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const yyyy = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${yyyy}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : "";
}

function numOrNull(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

interface CapOneParseResult {
  rows: CapOneRow[];
  error?: string;
}

/**
 * Parse a Capital One transaction-export CSV. Capital One's standard export has
 * the header: Transaction Date, Posted Date, Card No., Description, Category,
 * Debit, Credit. We match columns BY NAME so column re-ordering survives.
 */
function parseCapOneCsv(text: string): CapOneParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], error: "CSV has no data rows." };

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => {
    for (const n of names) {
      const idx = header.findIndex((h) => h === n || h.includes(n));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const cDate = col("transaction date", "trans date", "date");
  const cPosted = col("posted date", "post date");
  const cCard = col("card no.", "card no", "card number", "last 4", "card");
  const cDesc = col("description", "merchant", "payee");
  const cCat = col("category");
  const cDebit = col("debit", "amount");
  const cCredit = col("credit");

  if (cDate < 0 || cCard < 0 || cDesc < 0) {
    return {
      rows: [],
      error:
        "Missing required Capital One columns (Transaction Date / Card No. / Description).",
    };
  }

  const rows: CapOneRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const vendor = (cells[cDesc] ?? "").trim();
    const isoDate = toIso(cells[cDate] ?? "");
    if (!vendor && !isoDate) continue;
    const cardRaw = (cells[cCard] ?? "").replace(/\D/g, "");
    const debit = numOrNull(cells[cDebit]);
    const credit = cCredit >= 0 ? numOrNull(cells[cCredit]) : null;
    rows.push({
      transaction_date: isoDate,
      posted_date: cPosted >= 0 ? toIso(cells[cPosted] ?? "") || null : null,
      card_last4: cardRaw ? cardRaw.slice(-4) : null,
      vendor,
      category: cCat >= 0 ? (cells[cCat] ?? "").trim() || null : null,
      debit,
      credit,
      amount: debit ?? (credit != null ? -credit : null),
    });
  }
  return { rows };
}

// ---------------------------------------------------------------------------
// Drop-zone
// ---------------------------------------------------------------------------

type Source = "CAPITAL_ONE" | "AMEX";

interface StagedFile {
  source: Source;
  file: File;
  rows: CapOneRow[] | AmexRow[];
  rowCount: number;
  extra?: string;
}

function DropZone({
  source,
  accept,
  icon,
  title,
  hint,
  staged,
  onPick,
  onClear,
}: {
  source: Source;
  accept: string;
  icon: React.ReactNode;
  title: string;
  hint: string;
  staged: StagedFile | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-surface p-8 text-center transition-colors",
        dragging ? "border-accent bg-selected-bg" : "border-line",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onPick(f);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      <div className="text-ink-subtle">{icon}</div>
      <p className="font-medium text-ink">{title}</p>
      <p className="max-w-xs text-xs text-ink-muted">{hint}</p>
      {staged ? (
        <div className="mt-2 w-full rounded-lg bg-surface-2 px-3 py-2 text-left text-xs">
          <div className="flex items-center justify-between">
            <span className="truncate font-medium text-ink">
              {staged.file.name}
            </span>
            <button
              onClick={onClear}
              className="ml-2 shrink-0 text-ink-muted hover:text-danger"
            >
              Remove
            </button>
          </div>
          <p className="mt-0.5 text-ink-muted">
            {staged.rowCount} row{staged.rowCount === 1 ? "" : "s"} parsed
            {staged.extra ? ` · ${staged.extra}` : ""}
          </p>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => inputRef.current?.click()}
        >
          Choose {source === "AMEX" ? "XLSX" : "CSV"} file
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CcUploadPage() {
  const [staged, setStaged] = useState<StagedFile | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [batches, setBatches] = useState<UploadBatch[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await ccApi.listUploads();
      setBatches(res.batches ?? []);
    } catch {
      // non-fatal; history is secondary
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function pickCapOne(file: File) {
    setPreview(null);
    try {
      const text = await file.text();
      const { rows, error } = parseCapOneCsv(text);
      if (error) {
        toast.error(error);
        return;
      }
      if (rows.length === 0) {
        toast.error("No transactions found in the CSV.");
        return;
      }
      setStaged({
        source: "CAPITAL_ONE",
        file,
        rows,
        rowCount: rows.length,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to read CSV");
    }
  }

  async function pickAmex(file: File) {
    setPreview(null);
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseAmexWorkbook(buf);
      setStaged({
        source: "AMEX",
        file,
        rows: parsed.rows,
        rowCount: parsed.rows.length,
        extra:
          parsed.sheetNames.length > 0
            ? `${parsed.sheetNames.length} cardholder sheet${parsed.sheetNames.length === 1 ? "" : "s"}`
            : "no cardholder sheets",
      });
      if (parsed.isBlankTemplate) {
        toast.info(
          "This looks like a blank template — 0 transactions found. You can still preview it.",
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to read XLSX");
    }
  }

  async function runPreview() {
    if (!staged) return;
    setPreviewing(true);
    setPreview(null);
    try {
      const form = new FormData();
      form.set("source", staged.source);
      form.set("rows", JSON.stringify(staged.rows));
      form.set("file", staged.file, staged.file.name);
      const res = await ccApi.uploadsPreview(form);
      setPreview(res);
      if (res.status === "BLANK_TEMPLATE") {
        toast.info(res.message ?? "Blank template — nothing to commit.");
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  async function confirm(forceOverwrite: boolean) {
    if (!preview?.batch_id) return;
    setConfirming(true);
    try {
      const res = await ccApi.uploadsConfirm(preview.batch_id, {
        force_overwrite: forceOverwrite,
      });
      toast.success(
        `Imported ${res.transaction_count} transaction${res.transaction_count === 1 ? "" : "s"}` +
          (res.duplicate_count ? ` · ${res.duplicate_count} duplicate(s)` : ""),
      );
      setStaged(null);
      setPreview(null);
      await loadHistory();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Confirm failed");
    } finally {
      setConfirming(false);
    }
  }

  const p = preview?.preview;
  const isBlank = preview?.status === "BLANK_TEMPLATE";

  return (
    <div>
      <PageHeader
        title="Upload Statements"
        subtitle="Import Capital One (CSV) and Amex (XLSX) transactions"
      />
      <CcSubNav />

      <div className="space-y-6 p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DropZone
            source="CAPITAL_ONE"
            accept=".csv,text/csv"
            icon={<FileText className="h-8 w-8" />}
            title="Capital One CSV"
            hint="Export your Capital One transactions as CSV and drop it here."
            staged={staged?.source === "CAPITAL_ONE" ? staged : null}
            onPick={pickCapOne}
            onClear={() => {
              setStaged(null);
              setPreview(null);
            }}
          />
          <DropZone
            source="AMEX"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            icon={<FileSpreadsheet className="h-8 w-8" />}
            title="Amex XLSX"
            hint="Drop the monthly Amex workbook (one sheet per cardholder)."
            staged={staged?.source === "AMEX" ? staged : null}
            onPick={pickAmex}
            onClear={() => {
              setStaged(null);
              setPreview(null);
            }}
          />
        </div>

        {staged && (
          <div className="flex items-center justify-between rounded-lg bg-selected-bg px-4 py-3">
            <span className="text-sm text-accent">
              {staged.source === "AMEX" ? "Amex" : "Capital One"} ·{" "}
              {staged.file.name} · {staged.rowCount} row
              {staged.rowCount === 1 ? "" : "s"}
            </span>
            <Button onClick={runPreview} loading={previewing}>
              <UploadCloud className="h-4 w-4" />
              Preview
            </Button>
          </div>
        )}

        {preview && (
          <Card>
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <CheckCircle2 className="h-4 w-4 text-ink-subtle" />
              <h2 className="font-display text-sm font-semibold text-ink">
                Preview
              </h2>
            </div>

            {isBlank ? (
              <div className="p-6">
                <div className="flex items-start gap-3 rounded-lg bg-warning-soft-bg px-4 py-3 text-sm text-warning-soft-fg">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>
                    {preview.message ??
                      "This appears to be a blank template — 0 transactions found. Upload the completed version when available."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4 p-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    ["Rows", p?.row_count ?? 0],
                    ["New", p?.new_count ?? 0],
                    ["Duplicates", p?.duplicate_count ?? 0],
                    ["Skipped", p?.skipped_count ?? 0],
                  ].map(([label, val]) => (
                    <div
                      key={label}
                      className="rounded-lg bg-surface-2 px-3 py-2"
                    >
                      <p className="text-xs text-ink-muted">{label}</p>
                      <p className="font-display text-lg font-semibold tabular-nums text-ink">
                        {val}
                      </p>
                    </div>
                  ))}
                </div>

                {p?.period_start && (
                  <p className="text-sm text-ink-muted">
                    Period: {formatDate(p.period_start)} –{" "}
                    {formatDate(p.period_end)}
                  </p>
                )}

                {!!p?.unmatched_cards?.length && (
                  <div className="flex items-start gap-3 rounded-lg bg-danger-soft-bg px-4 py-3 text-sm text-danger-soft-fg">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>
                      {p.unmatched_cards.length} unmatched card
                      {p.unmatched_cards.length === 1 ? "" : "s"}:{" "}
                      {p.unmatched_cards.map((c) => `••${c}`).join(", ")}. These
                      rows import as UNMATCHED — assign a cardholder afterward.
                    </p>
                  </div>
                )}

                {!!p?.cardholder_breakdown?.length && (
                  <div className="rounded-lg border border-line">
                    <p className="border-b border-line px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
                      Cardholder breakdown
                    </p>
                    <ul className="divide-y divide-line text-sm">
                      {p.cardholder_breakdown.map((c) => (
                        <li
                          key={`${c.cardholder_id ?? "none"}-${c.name}`}
                          className="flex items-center justify-between px-3 py-2"
                        >
                          <span
                            className={cn(
                              c.cardholder_id ? "text-ink" : "text-danger",
                            )}
                          >
                            {c.name}
                          </span>
                          <span className="tabular-nums text-ink-muted">
                            {c.count}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex items-center justify-end gap-2">
                  {!!p?.duplicate_count && (
                    <Button
                      variant="secondary"
                      onClick={() => confirm(true)}
                      loading={confirming}
                    >
                      Overwrite duplicates &amp; import
                    </Button>
                  )}
                  <Button onClick={() => confirm(false)} loading={confirming}>
                    Confirm import
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}

        {/* History */}
        <Card>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <History className="h-4 w-4 text-ink-subtle" />
            <h2 className="font-display text-sm font-semibold text-ink">
              Upload history
            </h2>
          </div>
          {batches.length === 0 ? (
            <EmptyState title="No uploads yet" />
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
                    <th className="px-4 py-2.5 font-medium">Date</th>
                    <th className="px-4 py-2.5 font-medium">Source</th>
                    <th className="px-4 py-2.5 font-medium">File</th>
                    <th className="px-4 py-2.5 font-medium">Tx</th>
                    <th className="px-4 py-2.5 font-medium">Dupes</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} className="border-b border-line">
                      <td className="px-4 py-3 text-ink-muted">
                        {formatDate(b.created_at)}
                      </td>
                      <td className="px-4 py-3 text-ink-muted">{b.source}</td>
                      <td className="px-4 py-3 font-mono text-xs text-ink-muted">
                        {b.original_filename}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-ink-muted">
                        {b.transaction_count}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-ink-muted">
                        {b.duplicate_count}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                            b.status === "COMPLETE"
                              ? "bg-success-soft-bg text-success-soft-fg"
                              : b.status === "ERROR"
                                ? "bg-danger-soft-bg text-danger-soft-fg"
                                : "bg-surface-2 text-ink-muted",
                          )}
                        >
                          {b.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
