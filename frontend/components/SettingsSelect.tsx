"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Compact settings use the same keyboard-accessible menu as deployment forms. */
export function SettingsSelect<T extends string>({
  label, value, options, onValueChange, disabled,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onValueChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} items={options} disabled={disabled} onValueChange={(next) => {
      if (next !== null) onValueChange(next);
    }}>
      <SelectTrigger size="sm" aria-label={label} className="text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
