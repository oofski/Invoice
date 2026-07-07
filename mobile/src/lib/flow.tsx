/**
 * Receipt-flow context — carries the in-progress receipt across the capture →
 * review → split → confirm screens (a single snap-and-submit journey).
 *
 * The photo `File` is captured once and POSTed to the drop endpoint on the
 * review screen (to get OCR + match outcome); the same File + the balanced
 * split are used at submit. `reset()` clears everything for "Snap another".
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReceiptOcr, PerFileResult } from "./api";
import type { EntitySplitInput } from "./cc";

export type DropStatus = "MATCHED" | "PENDING_MATCH" | "ERROR";

export interface FlowState {
  /** The captured photo. */
  file: File | null;
  /** Object URL for previewing the photo (revoked on reset). */
  previewUrl: string | null;
  /** OCR fields from the review drop (may be an empty receipt). */
  ocr: ReceiptOcr | null;
  /** User-confirmed/edited total that seeds the split. */
  total: number;
  /** Match outcome from the review drop. */
  status: DropStatus | null;
  inboxId: string | null;
  matchedTransactionId: string | null;
  candidateIds: string[];
  /** The balanced split rows built on the split screen. */
  splits: EntitySplitInput[];
  /** Whether the server reported it applied the split at drop time. */
  splitApplied: boolean;
}

interface FlowApi extends FlowState {
  setFile: (file: File | null) => void;
  applyDropResult: (result: PerFileResult) => void;
  setTotal: (total: number) => void;
  setSplits: (splits: EntitySplitInput[]) => void;
  setSplitApplied: (applied: boolean) => void;
  reset: () => void;
}

const emptyState: FlowState = {
  file: null,
  previewUrl: null,
  ocr: null,
  total: 0,
  status: null,
  inboxId: null,
  matchedTransactionId: null,
  candidateIds: [],
  splits: [],
  splitApplied: false,
};

const FlowContext = createContext<FlowApi | null>(null);

export function FlowProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FlowState>(emptyState);
  const urlRef = useRef<string | null>(null);

  const setFile = useCallback((file: File | null) => {
    setState((prev) => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const previewUrl = file ? URL.createObjectURL(file) : null;
      urlRef.current = previewUrl;
      // A new file starts a fresh journey (drop OCR to be re-fetched).
      return {
        ...prev,
        file,
        previewUrl,
        ocr: null,
        status: null,
        inboxId: null,
        matchedTransactionId: null,
        candidateIds: [],
        splitApplied: false,
      };
    });
  }, []);

  const applyDropResult = useCallback((result: PerFileResult) => {
    setState((prev) => ({
      ...prev,
      ocr: result.ocr ?? null,
      status: result.status,
      inboxId: result.inbox_id || null,
      matchedTransactionId: result.matched_transaction_id ?? null,
      candidateIds: result.candidate_transaction_ids ?? [],
      splitApplied: !!result.split_applied,
      // Seed the editable total from OCR when we don't already have one.
      total:
        prev.total > 0
          ? prev.total
          : typeof result.ocr?.total === "number"
            ? result.ocr.total
            : 0,
    }));
  }, []);

  const setTotal = useCallback(
    (total: number) => setState((prev) => ({ ...prev, total })),
    [],
  );
  const setSplits = useCallback(
    (splits: EntitySplitInput[]) => setState((prev) => ({ ...prev, splits })),
    [],
  );
  const setSplitApplied = useCallback(
    (applied: boolean) => setState((prev) => ({ ...prev, splitApplied: applied })),
    [],
  );

  const reset = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setState(emptyState);
  }, []);

  const value = useMemo<FlowApi>(
    () => ({
      ...state,
      setFile,
      applyDropResult,
      setTotal,
      setSplits,
      setSplitApplied,
      reset,
    }),
    [state, setFile, applyDropResult, setTotal, setSplits, setSplitApplied, reset],
  );

  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>;
}

export function useFlow(): FlowApi {
  const ctx = useContext(FlowContext);
  if (!ctx) throw new Error("useFlow must be used within <FlowProvider>");
  return ctx;
}
