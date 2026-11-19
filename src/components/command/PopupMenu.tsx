// İmleç yanında açılan küçük menü (sağ tık, S menüsü, ağaç sağ tık). Dışarı tıklama, Esc ya da
// pencere kaydırma kapatır; ekran kenarına taşmaz.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CIcon, type CmdIconName } from './commandIcons';
import './command.css';

export interface MenuItem {
  label: string;
  icon?: CmdIconName | ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Devre dışıysa nedeni (ipucu) */
  title?: string;
  danger?: boolean;
  primary?: boolean;
  /** Kısayol ipucu */
  hint?: string;
}

export type MenuEntry = MenuItem | 'sep' | { heading: string };

export function PopupMenu({
  x,
  y,
  entries,
  onClose,
  grid,
  className = '',
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose(): void;
  /** Simge ızgarası (S menüsü) */
  grid?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Ekran kenarından taşmasın
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    setPos({ left, top });
  }, [x, y, entries.length]);

  useEffect(() => {
    const onClose = () => closeRef.current();
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const onBlur = () => onClose();
    // Açan tıklamanın kendisi kapatmasın
    const t = window.setTimeout(() => {
      document.addEventListener('pointerdown', onDown, true);
      window.addEventListener('wheel', onBlur, { passive: true });
    }, 0);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', onBlur);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      className={`pmenu ${grid ? 'pmenu-grid' : ''} ${className}`}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((e, i) => {
        if (e === 'sep') return <div key={i} className="pmenu-sep" />;
        if ('heading' in e) {
          return (
            <div key={i} className="pmenu-heading">
              {e.heading}
            </div>
          );
        }
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`pmenu-item ${e.danger ? 'danger' : ''} ${e.primary ? 'primary' : ''}`}
            disabled={e.disabled}
            title={e.title ?? (grid ? e.label : undefined)}
            onClick={() => {
              onClose();
              e.onClick?.();
            }}
          >
            <span className="pmenu-icon">{typeof e.icon === 'string' ? <CIcon name={e.icon as CmdIconName} /> : e.icon}</span>
            <span className="pmenu-label">{e.label}</span>
            {e.hint && <kbd className="pmenu-hint">{e.hint}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
