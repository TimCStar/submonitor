import { useEffect, useId, useRef, useState } from "react";
import { Check, Eye, EyeOff, LoaderCircle, Minus, Plus, X } from "lucide-react";

export function Spinner({ size = 14 }) {
  return <LoaderCircle className="spin" size={size} aria-hidden="true" />;
}

export function Dot({ tone = "ok", pulse = false }) {
  return <i className={`dot dot-${tone}${pulse ? " pulse" : ""}`} aria-hidden="true" />;
}

export function Sheet({ open, onClose, title, subtitle, children, footer, size = "md" }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const previous = document.activeElement;
    document.body.classList.add("no-scroll");
    requestAnimationFrame(() => ref.current?.focus());
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <section ref={ref} tabIndex={-1} className={`sheet sheet-${size}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header className="sheet-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
      </header>
      <div className="sheet-body">{children}</div>
      {footer && <footer className="sheet-foot">{footer}</footer>}
    </section>
  </div>;
}

export function Toast({ toast, onClose }) {
  if (!toast) return null;
  return <div className={`toast toast-${toast.kind}`} role="status" onClick={onClose}>
    {toast.kind === "error" ? <Dot tone="bad" /> : <Check size={15} />}
    <span>{toast.message}</span>
  </div>;
}

export function Toggle({ checked, onChange, label, hint, disabled }) {
  const id = useId();
  return <div className={`row toggle-row${disabled ? " is-disabled" : ""}`}>
    <label htmlFor={id} className="row-text">
      <span className="row-label">{label}</span>
      {hint && <span className="row-hint">{hint}</span>}
    </label>
    <button id={id} type="button" role="switch" aria-checked={Boolean(checked)} disabled={disabled}
      className={`switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)}><span /></button>
  </div>;
}

export function Segmented({ options, value, onChange, label, multiple = false, size }) {
  const isActive = (option) => (multiple ? value.includes(option.value) : value === option.value);
  function choose(option) {
    if (!multiple) return onChange(option.value);
    if (value.includes(option.value)) { if (value.length > 1) onChange(value.filter((item) => item !== option.value)); }
    else onChange([...value, option.value]);
  }
  return <div className={`segmented${size ? ` segmented-${size}` : ""}`} role={multiple ? "group" : "radiogroup"} aria-label={label}>
    {options.map((option) => <button type="button" key={String(option.value)} role={multiple ? undefined : "radio"}
      aria-checked={multiple ? undefined : isActive(option)} aria-pressed={multiple ? isActive(option) : undefined}
      className={isActive(option) ? "active" : ""} onClick={() => choose(option)}>{option.label}</button>)}
  </div>;
}

export function Stepper({ value, onChange, min = 1, max = 10, suffix, label }) {
  const number = Number(value) || min;
  return <div className="stepper" role="group" aria-label={label}>
    <button type="button" onClick={() => onChange(Math.max(min, number - 1))} disabled={number <= min} aria-label="减少"><Minus size={16} /></button>
    <output aria-live="polite"><strong>{number}</strong>{suffix && <span>{suffix}</span>}</output>
    <button type="button" onClick={() => onChange(Math.min(max, number + 1))} disabled={number >= max} aria-label="增加"><Plus size={16} /></button>
  </div>;
}

/** label on the left, control on the right (stacks on small screens) */
export function Row({ label, hint, children, stack = false, htmlFor }) {
  return <div className={`row${stack ? " row-stack" : ""}`}>
    <label className="row-text" htmlFor={htmlFor}>
      <span className="row-label">{label}</span>
      {hint && <span className="row-hint">{hint}</span>}
    </label>
    <div className="row-control">{children}</div>
  </div>;
}

export function TextInput({ id, ...props }) {
  return <input id={id} className="input" {...props} />;
}

export function SecretInput({ id, configured, invalid, onClear, value, onChange, placeholder, cleared }) {
  const [visible, setVisible] = useState(false);
  return <div className="secret">
    {configured && !cleared && <div className="secret-state">
      {invalid ? <span className="text-bad">已保存的值无法解密，请重新输入</span> : <span><Check size={13} /> 已保存</span>}
      {onClear && !invalid && <button type="button" className="link" onClick={onClear}>清除</button>}
    </div>}
    {cleared && <div className="secret-state"><span className="text-muted">保存后将清除</span></div>}
    <div className="secret-field">
      <input id={id} className="input" type={visible ? "text" : "password"} value={value || ""} onChange={onChange}
        placeholder={placeholder || (configured && !cleared ? "留空则保持不变" : "")} autoComplete="new-password" spellCheck="false" />
      <button type="button" className="icon-btn" onClick={() => setVisible((current) => !current)} aria-label={visible ? "隐藏" : "显示输入内容"}>
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  </div>;
}

export function Button({ children, busy, variant = "quiet", className = "", ...props }) {
  return <button type="button" {...props} className={`btn btn-${variant} ${className}`} disabled={Boolean(busy || props.disabled)}>
    {busy && <Spinner />}{children}
  </button>;
}

export function Skeleton({ lines = 3 }) {
  return <div className="skeleton" aria-busy="true" aria-label="加载中">
    {Array.from({ length: lines }, (_, index) => <span key={index} style={{ width: `${90 - index * 18}%` }} />)}
  </div>;
}

export function Empty({ title, hint, children }) {
  return <div className="empty"><p className="empty-title">{title}</p>{hint && <p className="empty-hint">{hint}</p>}{children}</div>;
}
