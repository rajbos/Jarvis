/**
 * Jarvis Browser Companion — Content Script
 *
 * Injected into every page. Listens for messages forwarded from the
 * background service worker and executes DOM operations in the page context.
 *
 * Note: Most commands are handled directly in background.js via
 * chrome.scripting.executeScript — this content script is a lightweight
 * complement that handles long-lived page observation.
 */

(function () {
  'use strict';

  const MAX_TEXT_LENGTH = 50000;

  // Avoid double-injection
  if (window.__jarvisCompanionInjected) return;
  window.__jarvisCompanionInjected = true;

  // Listen for messages from the background service worker
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.source !== 'jarvis-background') return;

    try {
      const result = handleMessage(msg);
      sendResponse({ ok: true, data: result });
    } catch (err) {
      sendResponse({ ok: false, error: err.message ?? String(err) });
    }

    return true; // keep channel open for async
  });

  function handleMessage(msg) {
    switch (msg.type) {
      case 'extract':
        return extractBySelector(msg.selector);
      case 'click':
        return clickElement(msg.selector);
      case 'fill':
        return fillElement(msg.selector, msg.value);
      case 'get-content':
        return getPageContent();
      default:
        throw new Error(`Unknown content script message type: ${msg.type}`);
    }
  }

  function extractBySelector(selector) {
    const elements = Array.from(document.querySelectorAll(selector));
    return elements.map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').trim(),
      value: el.value != null ? el.value : null,
      href: el.href != null ? el.href : null,
    }));
  }

  function clickElement(selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    el.click();
    return { ok: true };
  }

  function fillElement(selector, value) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  function getPageContent() {
    return {
      title: document.title,
      url: window.location.href,
      text: (document.body && document.body.innerText) ? document.body.innerText.slice(0, MAX_TEXT_LENGTH) : '',
    };
  }
})();
