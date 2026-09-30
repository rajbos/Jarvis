/**
 * ErrorBoundary (issue #365): a panel that throws during render must show the
 * fallback instead of blanking the window, leave surrounding chrome usable,
 * and recover through "Try again".
 */
import { describe, it, expect } from 'vitest';
import { useViewHarness } from './harness/view-harness';

const harness = useViewHarness();

describe('ErrorBoundary', () => {
  it('contains a throwing panel, keeps chrome interactive and recovers on retry', async () => {
    const { page, errors } = await harness.open('error-boundary');

    const alert = page.getByRole('alert');
    await expect.poll(() => alert.innerText()).toContain('Something went wrong in the fixture panel.');
    expect(await alert.innerText()).toContain('fixture panel exploded');
    expect(await page.getByText('Panel content is healthy').count()).toBe(0);

    // Surrounding chrome is still rendered and clickable.
    const chrome = page.getByRole('button', { name: 'Chrome button' });
    await chrome.click();
    expect(await chrome.isVisible()).toBe(true);

    // The error was logged with its label and message.
    expect(errors.some((e) => e.includes('[ErrorBoundary:the fixture panel]') && e.includes('fixture panel exploded'))).toBe(true);

    // "Try again" while the fault persists keeps the fallback.
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => alert.count()).toBe(1);

    // Fix the fault, retry: the panel renders again and the fallback is gone.
    await page.evaluate(() => {
      (window as unknown as { __bombArmed: boolean }).__bombArmed = false;
    });
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => page.getByText('Panel content is healthy').count()).toBe(1);
    expect(await alert.count()).toBe(0);
    expect(await chrome.isVisible()).toBe(true);
  });
});
