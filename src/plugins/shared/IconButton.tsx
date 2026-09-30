import type { ComponentChildren } from 'preact';

interface IconButtonProps {
  /** Glyph, emoji or entity shown as the button's only visible content. */
  icon: ComponentChildren;
  /** Accessible name (required). Also used as the hover tooltip unless `title` is given. */
  label: string;
  onClick?: (e: MouseEvent) => void;
  title?: string;
  class?: string;
  disabled?: boolean;
}

/**
 * Icon-only button with a mandatory accessible name. `title` alone is not reliably
 * exposed to screen readers, so this always sets aria-label. Defaults to the
 * `repo-panel-close` style used by panel headers (close / back / configure).
 */
export function IconButton({ icon, label, onClick, title, class: cls = 'repo-panel-close', disabled }: IconButtonProps) {
  return (
    <button class={cls} title={title ?? label} aria-label={label} onClick={onClick} disabled={disabled}>
      {icon}
    </button>
  );
}
