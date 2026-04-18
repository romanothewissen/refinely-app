import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, ChevronDown } from 'lucide-react';

export interface MultiSearchSelectOption {
  value: string;
  label: string;
  description?: string;
  score?: number;
}

interface MultiSearchSelectProps {
  selectedValues: string[];
  onToggle: (value: string) => void;
  onRemove: (value: string) => void;
  options: MultiSearchSelectOption[];
  onSearchChange?: (query: string) => void;
  searchValue?: string;
  isSearching?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
  emptyStateLabel?: string;
  maxDisplayOptions?: number;
}

export function MultiSearchSelect({
  selectedValues,
  onToggle,
  onRemove,
  options,
  onSearchChange,
  searchValue = '',
  isSearching = false,
  placeholder = 'Search to add…',
  searchPlaceholder = 'Search by key or summary…',
  disabled = false,
  className = '',
  emptyStateLabel = 'No matches found.',
  maxDisplayOptions = 12,
}: MultiSearchSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [internalSearch, setInternalSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Use external search value if provided, otherwise use internal
  const effectiveSearch = onSearchChange ? searchValue : internalSearch;

  const filtered = useMemo(() => {
    const q = effectiveSearch.trim().toLowerCase();
    if (!q) return options.slice(0, maxDisplayOptions);
    return options
      .filter((option) =>
        option.label.toLowerCase().includes(q)
        || option.value.toLowerCase().includes(q)
        || (option.description ?? '').toLowerCase().includes(q),
      )
      .slice(0, maxDisplayOptions);
  }, [options, effectiveSearch, maxDisplayOptions]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const handleSearchChange = (value: string) => {
    if (onSearchChange) {
      onSearchChange(value);
    } else {
      setInternalSearch(value);
    }
  };

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      {/* Selected chips */}
      {selectedValues.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selectedValues.map((key) => {
            return (
              <span
                key={key}
                className="inline-flex items-center gap-1 rounded-full border border-[rgba(43,89,74,0.2)] bg-[var(--rf-brand-muted)] px-2.5 py-1 text-[12px] font-bold text-[var(--rf-brand)] transition hover:border-[var(--rf-brand)]"
              >
                {key}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(key);
                  }}
                  className="ml-0.5 rounded-full p-0.5 transition hover:bg-[var(--rf-brand)] hover:text-white"
                  aria-label={`Remove ${key}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--rf-text-tertiary)]" />
        <input
          ref={inputRef}
          type="text"
          value={effectiveSearch}
          onChange={(e) => handleSearchChange(e.target.value)}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full rounded-xl border border-[var(--rf-border)] bg-white pl-10 pr-4 py-2.5 text-sm font-medium text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 disabled:opacity-50"
        />
        {isSearching && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--rf-brand)] border-t-transparent" />
          </div>
        )}
      </div>

      {/* Dropdown results */}
      {isOpen && !disabled && (
        <div className="absolute z-[60] top-full mt-2 w-full rounded-2xl border border-[var(--rf-border)] bg-white shadow-[0_24px_80px_-48px_rgba(15,23,42,0.35)] overflow-hidden">
          <div className="max-h-72 overflow-y-auto custom-scrollbar p-1.5">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-sm font-medium text-[var(--rf-text-tertiary)]">
                {isSearching ? 'Searching…' : emptyStateLabel}
              </div>
            ) : (
              filtered.map((option) => {
                const isSelected = selectedValues.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      onToggle(option.value);
                    }}
                    className={`w-full flex items-center gap-3 rounded-xl px-3 py-2 text-left transition ${
                      isSelected
                        ? 'bg-[var(--rf-brand-muted)] border border-[var(--rf-brand)]'
                        : 'border border-transparent hover:bg-[var(--rf-surface-soft)] hover:border-[var(--rf-border)]'
                    }`}
                  >
                    {option.score !== undefined && (
                      <span className={`text-[11px] font-black tabular-nums rounded px-1.5 py-0.5 min-w-[36px] text-center ${
                        isSelected ? 'bg-white text-[var(--rf-brand)]' : 'bg-[var(--rf-brand-muted)] text-[var(--rf-brand)]'
                      }`}>
                        {option.score}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-[var(--rf-text)]">{option.value}</div>
                      {option.description && (
                        <div className="truncate text-[12px] text-[var(--rf-text-secondary)]">{option.description}</div>
                      )}
                    </div>
                    <span className={`rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-widest ${
                      isSelected ? 'bg-white text-[var(--rf-brand)]' : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)]'
                    }`}>
                      {isSelected ? 'Selected' : 'Add'}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {options.length > maxDisplayOptions && (
            <div className="border-t border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2 text-[11px] font-medium text-[var(--rf-text-tertiary)]">
              Showing {Math.min(filtered.length, maxDisplayOptions)} of {options.length} results
            </div>
          )}
        </div>
      )}
    </div>
  );
}