import { useEffect, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: number;
  /** Called with the parsed number when the user finishes editing (blur or Enter). */
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
};

/**
 * Number input you can freely type into (including clearing it). The value is only
 * parsed, clamped and committed on blur / Enter; an empty or invalid entry reverts.
 */
export function NumberField({ value, onCommit, min, max, onBlur, onKeyDown, ...rest }: Props) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);

  function commit() {
    setEditing(false);
    const n = Math.trunc(Number(text));
    if (text.trim() === '' || Number.isNaN(n)) { setText(String(value)); return; }
    const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  }

  return (
    <input
      {...rest}
      type="text"
      inputMode="numeric"
      value={text}
      onFocus={(e) => { setEditing(true); e.target.select(); }}
      onChange={(e) => { setEditing(true); setText(e.target.value.replace(/[^\d-]/g, '')); }}
      onBlur={(e) => { commit(); onBlur?.(e); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); onKeyDown?.(e); }}
    />
  );
}
