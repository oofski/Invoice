"use client";

import { Select } from "@/components/ui/primitives";
import { GL_CATEGORY_GROUPS, REQUIRES_MANUAL_REVIEW } from "@/lib/constants";

/**
 * Dropdown of the 47 allowed GL categories, grouped by section (Brief §05/§08).
 */
export function GLCategorySelect({
  value,
  onChange,
  disabled,
  includeReview = true,
  className,
}: {
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  includeReview?: boolean;
  className?: string;
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
        <option value={REQUIRES_MANUAL_REVIEW}>
          ⚠ Requires manual review
        </option>
      )}
      {isReview && !includeReview && (
        <option value={REQUIRES_MANUAL_REVIEW}>⚠ Requires manual review</option>
      )}
      {GL_CATEGORY_GROUPS.map((group) => (
        <optgroup key={group.group} label={group.group}>
          {group.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}
