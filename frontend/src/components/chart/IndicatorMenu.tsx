/**
 * "Indicators" dropdown: toggles + editable lengths for the current interval.
 * Edits are validated per field, then committed (debounced) as that interval's override.
 */
import { useEffect, useRef, useState } from "react";
import {
  getField, INDICATOR_ROWS, PRESETS, setField, validateField,
  type IndicatorKey, type IndicatorParams, type ParamField,
} from "../../config/indicators";
import { TF_LABEL, TF_UNIT } from "../../config/timeframes";
import type { Timeframe } from "../../types/api";

interface Props {
  timeframe: Timeframe;
  params: IndicatorParams;
  enabled: Set<IndicatorKey>;
  onToggle: (key: IndicatorKey, on: boolean) => void;
  onAllOff: () => void;
  onParams: (tf: Timeframe, params: IndicatorParams) => void;
  onReset: (tf: Timeframe) => void;
}

const fieldId = ([name, i]: ParamField) => `${name}.${i ?? ""}`;
const COMMIT_DELAY = 350;

export function IndicatorMenu({ timeframe, params, enabled, onToggle, onAllOff, onParams, onReset }: Props) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [bad, setBad] = useState<Record<string, string>>({});
  const pending = useRef(params);
  const timer = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const preset = PRESETS[timeframe];

  // Committed params (or interval) changed: drop drafts and start from them.
  const paramsSig = JSON.stringify(params);
  const latest = useRef(params);
  latest.current = params;
  useEffect(() => {
    pending.current = latest.current;
    setDrafts({});
    setBad({});
  }, [timeframe, paramsSig]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (open && !rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  const onInput = (field: ParamField, raw: string) => {
    const id = fieldId(field);
    setDrafts((d) => ({ ...d, [id]: raw }));
    const value = field[2] ? parseFloat(raw) : Number(raw);
    const candidate = Number.isFinite(value) ? setField(pending.current, field, value) : pending.current;
    const err = validateField(field, value, candidate);
    setBad((b) => {
      const next = { ...b };
      if (err) next[id] = err; else delete next[id];
      return next;
    });
    if (err) return;
    pending.current = candidate;
    window.clearTimeout(timer.current);
    // Capture interval + values now: if the interval changes before the commit fires, this edit still
    // belongs to the interval it was made on (pending.current is re-pointed at the new interval's params).
    const tf = timeframe;
    timer.current = window.setTimeout(() => onParams(tf, candidate), COMMIT_DELAY);
  };

  return (
    <div className="dropdown" ref={rootRef}>
      <button className="btn btn-ghost" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Indicators <span className="count">{enabled.size}</span> &#9662;
      </button>
      {open && (
        <div className="menu">
          <div className="menu-unit">Lengths are in bars · 1 bar = <b>{TF_UNIT[timeframe]}</b></div>
          {INDICATOR_ROWS.map((row) => {
            if ("section" in row) return <div className="menu-h" key={row.section}>{row.section}</div>;
            return (
              <div className="ind-row" key={row.key}>
                <label>
                  <input type="checkbox" checked={enabled.has(row.key)} onChange={(e) => onToggle(row.key, e.target.checked)} />
                  {row.color && <i className="sw" style={{ ["--c" as string]: row.color }} />} {row.label}
                  {row.hint && <small>{row.hint}</small>}
                </label>
                {row.fields && (
                  <span className="nums">
                    {row.fields.map((f) => {
                      const id = fieldId(f);
                      const committed = getField(params, f);
                      const def = getField(preset, f);
                      const cls = bad[id] ? "bad" : committed !== def ? "custom" : "";
                      return (
                        <input
                          key={id} type="number" className={cls}
                          min={f[2] ? 0.1 : 1} max={f[2] ? 5 : 500} step={f[2] ? 0.1 : 1}
                          value={drafts[id] ?? String(committed)}
                          onChange={(e) => onInput(f, e.target.value)}
                          aria-label={`${row.label} setting`}
                          title={bad[id] ?? `Default: ${def}`}
                        />
                      );
                    })}
                  </span>
                )}
              </div>
            );
          })}
          <div className="menu-f">
            <button className="link" onClick={() => onReset(timeframe)}>Reset lengths to {TF_LABEL[timeframe]} defaults</button>
            <button className="link" onClick={onAllOff}>Turn all off</button>
          </div>
        </div>
      )}
    </div>
  );
}
