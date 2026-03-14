// ── Module-level discovery state shared across discovery + auth handlers ─────
import type { DiscoveryState, DiscoveryProgress } from '../../services/github-discovery';

export let activeDiscovery: DiscoveryState | null = null;
export let lastDiscoveryProgress: DiscoveryProgress | null = null;

export function setActiveDiscovery(state: DiscoveryState | null): void {
  activeDiscovery = state;
}

export function setLastDiscoveryProgress(progress: DiscoveryProgress | null): void {
  lastDiscoveryProgress = progress;
}
