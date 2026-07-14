import type { ReactNode } from "react";
import { Select } from "@/components/ui/primitives";
import {
  CATEGORY_GROUP_OF,
  ENTITY_COA,
  ENTITY_COA_ALIAS,
  ENTITY_COA_LEGACY,
  GL_CATEGORIES_FLAT,
  REQUIRES_MANUAL_REVIEW,
  glAccountNumber,
} from "@/lib/constants";

/** High-level reporting groups, in the order they should appear as optgroups. */
const GROUP_ORDER = ["Revenue", "Cost of Sales", "Operating Expenses"] as const;

/**
 * Formats an option label, prefixing the entity-derived account number when
 * one resolves. "Varies"/"None" are sentinel COA values, not real account
 * numbers — don't prefix them onto the label (matches the worker's export
 * formatting). When `entity` is null/undefined the number is omitted unless a
 * caller-supplied lookup resolves one.
 */
function optionLabel(entity: string | null | undefined, name: string): string {
  const raw = entity ? glAccountNumber(entity, name) : "";
  const num = raw === "Varies" || raw === "None" ? "" : raw;
  return num ? `${num} · ${name}` : name;
}

/**
 * Dropdown of allowed GL categories, grouped by section (Brief §05/§08).
 *
 * When `entity` is provided, the offered options are restricted to that
 * entity's own Chart of Accounts (alias-resolved), grouped into optgroups by
 * reporting group (Revenue → Cost of Sales → Operating Expenses) and labelled
 * with the entity's derived account number. Legacy / historical-only names
 * (ENTITY_COA_LEGACY) are NOT offered. If the current `value` is a real
 * selection that isn't in the entity's offered set, it is grandfathered into an
 * "Other (historical)" optgroup so a stored legacy / out-of-COA value still
 * displays and stays selected.
 *
 * When `entity` is null/undefined (e.g. VendorsPage with no business chosen),
 * it falls back to the full `GL_CATEGORY_GROUPS` list (the prior behavior).
 */
export function GLCategorySelect({
  value,
  onChange,
  disabled,
  includeReview = true,
  className,
  entity,
}: {
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  includeReview?: boolean;
  className?: string;
  entity?: string | null;
}) {
  const isReview = value === REQUIRES_MANUAL_REVIEW;

  // The manual-review sentinel option, rendered when includeReview is set or
  // when the current value already is the sentinel (so it stays selectable).
  const reviewOption =
    includeReview || (isReview && !includeReview) ? (
      <option value={REQUIRES_MANUAL_REVIEW}>⚠ Requires manual review</option>
    ) : null;

  let body: ReactNode;

  if (entity) {
    // v1.9.3: offer EVERY GL category available for this institution — its own
    // COA keys + its legacy names + the universal set — grouped by reporting
    // group. The account number is prefixed only where this institution's COA
    // resolves one (optionLabel handles that); a category with no entity-specific
    // number is still selectable (validation accepts the full flat list).
    const resolved = ENTITY_COA_ALIAS[entity] ?? entity;
    const coa = ENTITY_COA[resolved] ?? {};
    const offered = Array.from(
      new Set([
        ...Object.keys(coa),
        ...Object.keys(ENTITY_COA_LEGACY[resolved] ?? {}),
        ...GL_CATEGORIES_FLAT,
      ]),
    );
    const offeredSet = new Set(offered);

    const byGroup = new Map<string, string[]>();
    for (const name of offered) {
      const group = CATEGORY_GROUP_OF[name] ?? "Operating Expenses";
      const list = byGroup.get(group);
      if (list) list.push(name);
      else byGroup.set(group, [name]);
    }

    // Grandfather the current value: a real selection that isn't offered for
    // this entity (e.g. a stored legacy / out-of-COA name) still renders so it
    // stays selected instead of being silently dropped.
    const grandfathered =
      value &&
      value !== REQUIRES_MANUAL_REVIEW &&
      !offeredSet.has(value)
        ? value
        : null;

    body = (
      <>
        {GROUP_ORDER.map((group) => {
          const names = byGroup.get(group);
          if (!names || names.length === 0) return null;
          return (
            <optgroup key={group} label={group}>
              {names.map((name) => (
                <option key={name} value={name}>
                  {optionLabel(entity, name)}
                </option>
              ))}
            </optgroup>
          );
        })}
        {grandfathered && (
          <optgroup label="Other (historical)">
            <option value={grandfathered}>
              {optionLabel(entity, grandfathered)}
            </option>
          </optgroup>
        )}
      </>
    );
  } else {
    // No entity chosen (e.g. a not-yet-classified needs-processing invoice):
    // show the FULL universal category list, grouped, so nothing is hidden.
    const byGroup = new Map<string, string[]>();
    for (const name of GL_CATEGORIES_FLAT) {
      const group = CATEGORY_GROUP_OF[name] ?? "Operating Expenses";
      const list = byGroup.get(group);
      if (list) list.push(name);
      else byGroup.set(group, [name]);
    }
    body = GROUP_ORDER.map((group) => {
      const names = byGroup.get(group);
      if (!names || names.length === 0) return null;
      return (
        <optgroup key={group} label={group}>
          {names.map((c) => (
            <option key={c} value={c}>
              {optionLabel(entity, c)}
            </option>
          ))}
        </optgroup>
      );
    });
  }

  return (
    <Select
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    >
      <option value="" disabled>
        Select a GL category…
      </option>
      {reviewOption}
      {body}
    </Select>
  );
}
