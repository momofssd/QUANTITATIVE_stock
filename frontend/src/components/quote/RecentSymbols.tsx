/** "Recent:" chips; clicking one switches the symbol. */
export function RecentSymbols({ symbols, current, onPick }: { symbols: string[]; current: string; onPick: (s: string) => void }) {
  if (!symbols.length) return null;
  return (
    <div className="recent">
      <span className="lbl">Recent:</span>
      {symbols.map((s) => (
        <button key={s} className={`chip${s === current ? " on" : ""}`} onClick={() => s !== current && onPick(s)}>
          {s}
        </button>
      ))}
    </div>
  );
}
