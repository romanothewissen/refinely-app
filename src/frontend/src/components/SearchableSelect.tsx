import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';

export interface SearchableSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
  clearLabel?: string;
  className?: string;
  buttonClassName?: string;
  menuClassName?: string;
  emptyStateLabel?: string;
  align?: 'left' | 'right';
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  disabled = false,
  allowClear = false,
  clearLabel = 'Clear selection',
  className = '',
  buttonClassName = '',
  menuClassName = '',
  emptyStateLabel = 'No matches found.',
  align = 'left',
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => options.find((option) => option.value === value),
    [options, value],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => (
      option.label.toLowerCase().includes(q)
      || option.value.toLowerCase().includes(q)
      || (option.description ?? '').toLowerCase().includes(q)
    ));
  }, [options, search]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
  }, [isOpen]);

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((next) => !next)}
        className={`w-full flex items-center justify-between gap-3 rounded-xl border bg-white/90 px-3 py-2 text-left shadow-sm transition ${disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-[var(--rf-brand-subtle)] hover:bg-white'} ${buttonClassName}`}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-[var(--rf-text)]">
            {selected?.label ?? placeholder}
          </div>
          {selected?.description && (
            <div className="truncate text-[11px] font-medium text-[var(--rf-text-tertiary)]">
              {selected.description}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {allowClear && value && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChange('');
                setSearch('');
              }}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--rf-text-tertiary)] transition hover:text-[var(--rf-text)]"
              title={clearLabel}
            >
              <X className="h-3 w-3" />
              Clear
            </span>
          )}
          <ChevronDown className={`h-4 w-4 text-[var(--rf-text-tertiary)] transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {isOpen && !disabled && (
        <div
          className={`absolute z-[60] top-full mt-2 w-full rounded-2xl border border-[var(--rf-border)] bg-white shadow-[0_24px_80px_-48px_rgba(15,23,42,0.35)] overflow-hidden ${align === 'right' ? 'right-0' : 'left-0'} ${menuClassName}`}
        >
          <div className="border-b border-[var(--rf-border-subtle)] bg-[var(--rf-surface-soft)] p-2.5">
            <input
              ref={inputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              className="w-full rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2 text-sm font-medium text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/20"
            />
          </div>
          <div className="max-h-72 overflow-y-auto custom-scrollbar p-1.5">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-sm font-medium text-[var(--rf-text-tertiary)]">
                {emptyStateLabel}
              </div>
            ) : (
              filtered.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={option.disabled}
                  onClick={() => {
                    if (option.disabled) return;
                    onChange(option.value);
                    setIsOpen(false);
                    setSearch('');
                  }}
                  className={`flex w-full items-start justify-between gap-3 rounded-xl px-3 py-2 text-left transition ${
                    option.disabled
                      ? 'cursor-not-allowed opacity-45'
                      : option.value === value
                        ? 'bg-[var(--rf-brand-muted)]'
                        : 'hover:bg-[var(--rf-surface-soft)]'
                  }`}
                >
                  <div className="min-w-0">
                    <div className={`truncate text-[13px] font-semibold ${option.value === value ? 'text-[var(--rf-brand-hover)]' : 'text-[var(--rf-text)]'}`}>
                      {option.label}
                    </div>
                    {option.description && (
                      <div className="truncate text-[11px] font-medium text-[var(--rf-text-tertiary)]">
                        {option.description}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-[11px] font-mono text-[var(--rf-text-tertiary)]">
                    {option.value}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
