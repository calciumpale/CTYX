'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import './prospecting-inbox.css';

type InboxRow = { id: string; username: string; text: string; intent: ReactNode; status: ReactNode };

export function ProspectingFilters({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`prospect-inbox-filters${className ? ` ${className}` : ''}`} role="group" aria-label="获客筛选">{children}</div>;
}

export function ProspectingList({ rows, selectedId, onSelect, label = '线索列表', columns = ['用户名', '原文', '意向', '状态'] }: {
  rows: InboxRow[]; selectedId?: string | null; onSelect: (id: string) => void; label?: string; columns?: readonly [string, string, string, string];
}) {
  return <div className="prospect-inbox-table-wrap"><table className="prospect-inbox-table" aria-label={label}>
    <colgroup><col className="prospect-inbox-name-col" /><col /><col className="prospect-inbox-intent-col" /><col className="prospect-inbox-status-col" /></colgroup>
    <thead><tr><th scope="col">{columns[0]}</th><th scope="col">{columns[1]}</th><th scope="col">{columns[2]}</th><th scope="col">{columns[3]}</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id} data-selected={row.id === selectedId} onClick={event => {
      event.currentTarget.querySelector('button')?.focus({ preventScroll: true });
      onSelect(row.id);
    }}>
      <th scope="row"><button type="button" className="prospect-inbox-row-button" aria-label={`查看${row.username}详情`} aria-expanded={row.id === selectedId} onClick={event => { event.stopPropagation(); onSelect(row.id); }}>{row.username}</button></th>
      <td><span className="prospect-inbox-excerpt">{row.text || '—'}</span></td><td>{row.intent}</td><td>{row.status}</td>
    </tr>)}</tbody>
  </table></div>;
}

export function ProspectingPanel({ title, onClose, children, className, header, pointerOpened, closeLabel = '关闭详情' }: {
  title: string; onClose: () => void; children: ReactNode; className?: string; closeLabel?: string; pointerOpened?: boolean;
  header?: { avatar?: ReactNode; metadata?: ReactNode; actions?: ReactNode };
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const focusKey = header ? null : title;
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [focusKey]);
  const titleElement = <h2 ref={heading} tabIndex={-1} data-pointer-open={pointerOpened || undefined}>{title}</h2>;
  return <aside className={`prospect-inbox-panel${className ? ` ${className}` : ''}`} aria-label={title} onKeyDown={event => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); onClose(); }
  }}>
    <header className="prospect-inbox-panel-header">
      {header ? <div className="prospect-inbox-panel-identity">
        {header.avatar}<div className="prospect-conversation-heading">{titleElement}{header.metadata}</div>
      </div> : titleElement}
      {header?.actions}
      <button type="button" className="icon-button" aria-label={closeLabel} title={closeLabel} onClick={onClose}><X size={19} aria-hidden="true" /></button>
    </header>
    <div className="prospect-inbox-panel-body">{children}</div>
  </aside>;
}
