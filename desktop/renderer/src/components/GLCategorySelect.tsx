import { Select } from "@/components/ui/primitives";
import {
  GL_CATEGORY_GROUPS,
  REQUIRES_MANUAL_REVIEW,
  glAccountNumber,
} from "@/lib/constants";

/**
 * Dropdown of the 47 allowed GL categories, grouped by section (Brief §05/§08).
 * When `entity` is provided, each option label is prefixed with that entity's
 * derived GL account number (when one exists for the category).
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
      {includeReview && (
        <option value={REQUIRES_MANUAL_REVIEW}>⚠ Requires manual review</option>
      )}
      {isReview && !includeReview && (
        <option value={REQUIRES_MANUAL_REVIEW}>⚠ Requires manual review</option>
      )}
      {GL_CATEGORY_GROUPS.map((group) => (
        <optgroup key={group.group} label={group.group}>
          {group.categories.map((c) => {
            const raw = entity ? glAccountNumber(entity, c) : "";
            // "Varies"/"None" are sentinel COA values, not real account
            // numbers — don't prefix them onto the option label (matches the
            // worker's export formatting).
            const num = raw === "Varies" || raw === "None" ? "" : raw;
            return (
              <option key={c} value={c}>
                {num ? `${num} · ${c}` : c}
              </option>
            );
          })}
        </optgroup>
      ))}
    </Select>
  );
}
