import type { ComponentChildren } from 'preact';

type BadgeStatus = 'pending' | 'completed' | 'in-progress';

interface StatusBadgeProps {
  status: BadgeStatus;
  label: string;
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  return <span class={`status-badge status-${status}`}>{label}</span>;
}

interface NotifBadgeProps {
  count: number;
  title?: string;
  large?: boolean;
  active?: boolean;
  clickable?: boolean;
  onClick?: (e: MouseEvent) => void;
  children?: ComponentChildren;
}

/** Reusable notification count bubble. */
export function NotifBadge({ count, title, large, active, clickable, onClick, children }: NotifBadgeProps) {
  const cls = [
    'notif-badge',
    large ? 'notif-badge-large' : '',
    clickable ? 'notif-badge-clickable' : '',
    active ? 'notif-badge-active' : '',
  ].filter(Boolean).join(' ');

  return (
    <span class={cls} title={title} onClick={onClick}>
      {children ?? count}
    </span>
  );
}
