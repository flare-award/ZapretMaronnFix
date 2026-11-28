import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface SeamlessSelectOption {
  value: string;
  label: string;
}

interface SeamlessSelectProps {
  value: string;
  options: SeamlessSelectOption[];
  placeholder?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  mono?: boolean;
  fullWidth?: boolean;
  className?: string;
  onChange: (nextValue: string) => void;
}

export const SeamlessSelect: React.FC<SeamlessSelectProps> = ({
  value,
  options,
  placeholder = 'Выберите вариант',
  icon,
  disabled = false,
  mono = false,
  fullWidth = false,
  className = '',
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleToggle = () => {
    if (disabled) return;
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setDropUp(spaceBelow < 235 && spaceAbove > spaceBelow);
    }
    setOpen((prev) => !prev);
  };

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption ? selectedOption.label : placeholder;

  const rootClasses = [
    'm3-seamless-dropdown',
    open ? 'open' : '',
    open && dropUp ? 'drop-up' : '',
    fullWidth ? 'full-width' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={rootRef} className={rootClasses}>
      <button
        type="button"
        className="m3-seamless-trigger"
        disabled={disabled}
        onClick={handleToggle}
      >
        {icon && <span className="m3-seamless-icon">{icon}</span>}
        <span
          className={`m3-seamless-label ${mono ? 'mono' : ''} ${!selectedOption ? 'placeholder' : ''}`}
        >
          {displayLabel}
        </span>
        <ChevronDown size={15} className={`m3-seamless-chevron ${open ? 'rotated' : ''}`} />
      </button>

      {open && (
        <div className="m3-seamless-menu">
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                className={`m3-seamless-option ${mono ? 'mono' : ''} ${active ? 'active' : ''}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span title={opt.label}>{opt.label}</span>
                {active && <Check size={13} style={{ flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
