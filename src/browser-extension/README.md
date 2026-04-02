# Jarvis Browser Companion — Browser Extension

This browser extension connects your local **Jarvis** desktop app to Edge or Chrome, enabling Jarvis to:

- Navigate to pages in your **live, authenticated** browser sessions (no headless browser needed)
- Interact with forms: fill inputs, click buttons, select options
- Scrape data from pages using CSS selectors
- List open tabs and capture screenshots

## Architecture

```
┌──────────────────────┐  WebSocket (ws://127.0.0.1:35789)  ┌───────────────────┐
│  Jarvis Desktop App  │ ◄────────────────────────────────► │ Browser Extension │
│  (Electron / Node.js)│                                    │ (Edge / Chrome)   │
└──────────────────────┘                                    └───────────────────┘
                                                                     │
                                                          chrome.tabs / chrome.scripting
                                                                     │
                                                            ┌────────▼────────┐
                                                            │  Browser Tabs   │
                                                            │  (live sessions)│
                                                            └─────────────────┘
```

The Jarvis app runs a local WebSocket bridge server on `ws://127.0.0.1:35789`. The extension's service worker connects to this server and relays commands from Jarvis into the browser using the Chrome Extensions API.

## Installation (Developer Mode)

1. Open Edge or Chrome and navigate to:
   - **Edge**: `edge://extensions`
   - **Chrome**: `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `src/browser-extension` folder from the Jarvis source directory
5. The 🌐 extension icon will appear in your toolbar

Once the Jarvis desktop app is running, the badge on the extension icon will turn **green** to indicate an active connection.

## Permissions

| Permission | Reason |
|---|---|
| `tabs` | Read open tab URLs and titles; navigate to URLs |
| `activeTab` | Interact with the currently active tab |
| `scripting` | Inject functions into pages to click, fill, and extract data |
| `storage` | Persist extension preferences |
| `<all_urls>` | Allow scripting on any domain your skills need to visit |

## Security

- The WebSocket server only binds to `127.0.0.1` (loopback), so it is **not accessible** from other machines on your network.
- All commands originate from your local Jarvis app — no external service ever sends commands to the extension.
- The extension never sends your browsing data anywhere except back to your local Jarvis instance.

## Skill Instructions Format

When defining a Browser Skill in Jarvis, the **Navigation Instructions** field accepts simple step commands (one per line):

```
# Lines starting with # are comments
click #search-input
fill #search-input quarterly report
click button[type=submit]
wait 1000
extract .result-row
```

Supported commands:

| Command | Example | Description |
|---|---|---|
| `click <selector>` | `click #submit-btn` | Click element matching CSS selector |
| `fill <selector> <value>` | `fill #name-input John Doe` | Set value of input/textarea |
| `select <selector> <value>` | `select #year 2024` | Set selected option in a `<select>` element |
| `submit <selector>` | `submit #login-form` | Submit a form element |
| `wait <ms>` | `wait 500` | Pause for N milliseconds (max 10,000) |

## Development

The extension uses Manifest V3 with a persistent service worker. The WebSocket connection is maintained with exponential back-off reconnection logic and a keep-alive alarm so the service worker isn't unloaded between uses.
