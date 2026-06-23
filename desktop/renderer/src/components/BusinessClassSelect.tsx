import { Select } from "@/components/ui/primitives";
import { BUSINESS_ENTITIES, BUSINESS_CLASSES } from "@/lib/constants";

/**
 * Paired Business + Class dropdowns used for invoice splitting. The Class
 * options are scoped to the selected business via BUSINESS_CLASSES; changing
 * the business resets the class so an invalid pairing can't be saved.
 */
export function BusinessClassSelect({
  business,
  class: klass,
  onChange,
  disabled,
  className,
}: {
  business: string | null;
  class: string | null;
  onChange: (business: string, klass: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const classOptions = business ? (BUSINESS_CLASSES[business] ?? []) : [];

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <Select
          value={business ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const nextBusiness = e.target.value;
            // Reset the class when the business changes — default to the only
            // class if the business has exactly one.
            const nextClasses = BUSINESS_CLASSES[nextBusiness] ?? [];
            const nextClass = nextClasses.length === 1 ? nextClasses[0] : "";
            onChange(nextBusiness, nextClass);
          }}
        >
          <option value="" disabled>
            Business…
          </option>
          {BUSINESS_ENTITIES.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </Select>
        <Select
          value={klass ?? ""}
          disabled={disabled || !business}
          onChange={(e) => onChange(business ?? "", e.target.value)}
        >
          <option value="" disabled>
            Class…
          </option>
          {classOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
