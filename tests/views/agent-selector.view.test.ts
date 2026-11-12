/** AgentSelector modal (issue #540): dialog semantics and the three ways to dismiss it. */
import { describe, it, expect } from 'vitest';
import { useViewHarness } from './harness/view-harness';

declare global {
  interface Window {
    __closed: number;
  }
}

const harness = useViewHarness();
const closed = (page: import('playwright').Page) => page.evaluate(() => window.__closed);

describe('AgentSelector modal', () => {
  it('exposes dialog semantics', async () => {
    const { page } = await harness.open('agent-selector');
    const dialog = page.getByRole('dialog', { name: 'Run Agent Analysis' });
    await dialog.waitFor();
    expect(await dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('closes on Escape', async () => {
    const { page } = await harness.open('agent-selector');
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await expect.poll(() => closed(page)).toBe(1);
  });

  it('ignores other keys', async () => {
    const { page } = await harness.open('agent-selector');
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    expect(await closed(page)).toBe(0);
  });

  it('closes on backdrop click but not on a click inside the modal', async () => {
    const { page } = await harness.open('agent-selector');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.locator('.agent-selector-title').click();
    expect(await closed(page)).toBe(0);
    await page.locator('.agent-selector-overlay').click({ position: { x: 5, y: 5 } });
    await expect.poll(() => closed(page)).toBe(1);
  });

  it('does not close on Escape while the analysis is starting', async () => {
    const { page } = await harness.open('agent-selector');
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Start Analysis' }).click();
    await page.getByRole('button', { name: 'Starting…' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    expect(await closed(page)).toBe(0);
  });
});
