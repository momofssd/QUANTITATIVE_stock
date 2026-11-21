/** "Search or get a quote" box with debounced autocomplete and keyboard navigation. */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, isAbort } from "../../services/api";
import type { Asset } from "../../types/api";

export function SearchBox({ onPick }: { onPick: (symbol: string) => void }) {
  const [text, setText] = useState("");
  const [items, setItems] = useState<Asset[]>([]);
  const [sel, setSel] = useState(-1);
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced lookup; each keystroke cancels the previous request.
  useEffect(() => {
    const q = text.trim();
    if (!q) {
      setItems([]);
      return;
    }
    const ctrl = new AbortController();
    const id = window.setTimeout(async () => {
      try {
        setItems(await api.search(q, ctrl.signal));
        setSel(-1);
        setOpen(true);
      } catch (e) {
        if (!isAbort(e)) setItems([]);
      }
    }, 160);
    return () => {
      window.clearTimeout(id);
      ctrl.abort();
    };
  }, [text]);

  // Close the list when clicking elsewhere.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!formRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  const go = (sym: string) => {
    setText("");
    setItems([]);
    setOpen(false);
    inputRef.current?.blur();
    onPick(sym.toUpperCase());
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const pick = sel >= 0 && items[sel] ? items[sel].symbol : text.trim();
    if (pick) go(pick);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open || !items.length) return;
    if (e.key === "ArrowDown") {
      setSel((s) => Math.min(s + 1, items.length - 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setSel((s) => Math.max(s - 1, -1));
      e.preventDefault();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <form className="search" ref={formRef} onSubmit={onSubmit} autoComplete="off" role="search">
      <input
        ref={inputRef} type="text" placeholder="Search or get a quote" aria-label="Symbol" spellCheck={false}
        value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
      />
      <button type="submit" aria-label="Get quote">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M10 2a8 8 0 0 1 6.32 12.9l5.39 5.39-1.42 1.42-5.39-5.39A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z" />
        </svg>
      </button>
      {open && items.length > 0 && (
        <ul className="suggest" role="listbox">
          {items.map((a, i) => (
            <li
              key={a.symbol} role="option" aria-selected={i === sel} className={i === sel ? "sel" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                go(a.symbol);
              }}
            >
              <b>{a.symbol}</b><span>{a.name}</span><em>{a.exchange}</em>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
