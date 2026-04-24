/**
 * Unit tests for plugins/discovery/state.ts
 *
 * The module exposes simple setter functions and exported variables for shared
 * discovery state.  These tests verify the setters mutate the exported values
 * and that setting null clears the state.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  activeDiscovery,
  lastDiscoveryProgress,
  setActiveDiscovery,
  setLastDiscoveryProgress,
} from '../../src/plugins/discovery/state';
import type { DiscoveryState, DiscoveryProgress } from '../../src/services/github-discovery';

// Re-import as a namespace so we can read the latest exported values
import * as state from '../../src/plugins/discovery/state';

afterEach(() => {
  // Reset state after each test
  setActiveDiscovery(null);
  setLastDiscoveryProgress(null);
});

describe('setActiveDiscovery', () => {
  it('updates activeDiscovery to a non-null value', () => {
    const mockState = { cancel: () => {} } as unknown as DiscoveryState;
    setActiveDiscovery(mockState);
    expect(state.activeDiscovery).toBe(mockState);
  });

  it('clears activeDiscovery when set to null', () => {
    const mockState = { cancel: () => {} } as unknown as DiscoveryState;
    setActiveDiscovery(mockState);
    setActiveDiscovery(null);
    expect(state.activeDiscovery).toBeNull();
  });
});

describe('setLastDiscoveryProgress', () => {
  it('updates lastDiscoveryProgress to a progress object', () => {
    const progress: DiscoveryProgress = {
      phase: 'orgs',
      orgsFound: 3,
      reposFound: 10,
    };
    setLastDiscoveryProgress(progress);
    expect(state.lastDiscoveryProgress).toEqual(progress);
  });

  it('clears lastDiscoveryProgress when set to null', () => {
    const progress: DiscoveryProgress = { phase: 'repos', orgsFound: 0, reposFound: 5 };
    setLastDiscoveryProgress(progress);
    setLastDiscoveryProgress(null);
    expect(state.lastDiscoveryProgress).toBeNull();
  });
});
