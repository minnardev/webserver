# WebServer — Live Server Extension for Zed

A live-reload dev server extension for Zed, inspired by VS Code's Live Server. Automatically starts when you open HTML files, with WebSocket-based hot reload, file type notifications, and built-in browser launching.

**Developed by: minnardev**

---

## Table of Contents

- [Theory of Operation](#theory-of-operation)
- [Installation](#installation)
- [Usage](#usage)
- [Slash Commands](#slash-commands)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Supported File Types](#supported-file-types)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Theory of Operation

WebServer bridges three domains:

1. **Language Server Protocol (LSP)** — The extension runs a language server that manages the HTTP/WebSocket server lifecycle. Communication with Zed happens via LSP over stdio (stdin/stdout), using the standard `Content-Length` header framing.

2. **HTTP Server + WebSocket** — A Node.js HTTP server serves static files from your project root on port 5500. When a file changes, the server broadcasts a WebSocket message to all connected browser clients, triggering a page reload.

3. **File System Surveillance** — The server recursively watches the project directory (excluding `node_modules`, `.git`) for `.html`, `.js`, `.css`, and `.ts` file changes. Changes are debounced (50ms) and broadcast to connected clients.

### Key Design Decisions

- **Startup**: The server starts 5 seconds after the language server process begins, giving Zed time to initialize the LSP connection. In standalone (TTY) mode, it starts immediately.
- **No auto-browser**: The browser is NOT opened automatically. You trigger it via slash command or the `showMessageRequest` dialog (on Zed versions that support it).
- **Extension-based**: The extension is compiled to WebAssembly (wasm32-wasip2) and runs inside Zed's extension host.

---

## Installation

### From Zed Extensions Marketplace

1. Open Zed
2. Press `Cmd/Ctrl + Shift + X` to open Extensions
3. Search for "WebServer"
4. Click **Install**

### Manual Installation

```bash
cd ~/.local/share/zed/extensions/user/webserver
# Place extension files here, then reload Zed
```

---

## Usage

WebServer starts automatically when you open an HTML file in a project that has the extension installed. The live server runs at `http://localhost:5500`.

### Quick Start

```bash
# Open the live server in your browser
/webserver-start

# Or use the keyboard shortcut:
# macOS: Cmd + .
# Windows/Linux: Ctrl + .
```

---

## Slash Commands

All commands are available by typing `/` in Zed's command palette:

| Command | Description |
|---|---|
| `/webserver-start` | Open the live server in your browser |
| `/webserver-open` | Same as start — opens browser at `localhost:5500` |
| `/webserver-reopen` | Restart the server (kill port 5500, restart, open browser) |
| `/webserver-status` | Check server status and root path |
| `/webserver-stop` | Stop the server |

---

## Keyboard Shortcuts

| Shortcut | Platform | Action |
|---|---|---|
| `Cmd + .` | macOS | Restart server and open browser |
| `Ctrl + .` | Windows/Linux | Restart server and open browser |

> **Note**: To enable the keyboard shortcut, add this to `~/.config/zed/keymap.json`:

```json
[
  {
    "key": "cmd-.",
    "mac": "cmd-.",
    "when": "panel_breadcrumbs > editor",
    "action": "assistant::Toggle"
  }
]
```

Then use `/webserver-reopen` or bind a custom key to the slash command.

**Alternative approach**: Bind the keybinding to trigger the slash command directly:

```json
[
  {
    "keys": { "cmd-.": "cmd-;" },  // Use your preferred binding
    "when": { "selector": "#workspace" },
    "action": "command_palette::RunSlashCommand",
    "args": { "command": "webserver-reopen" }
  }
]
```

---

## How It Works

### Server Lifecycle

```
Zed Extension (WASM)
    │
    ├── spawns → Node.js Language Server (server.js)
    │
    └── LSP handshake
        ├── client sends → initialize
        ├── server responds → initialize result
        └── client sends → initialized
            │
            └── server starts HTTP + WS server on port 5500
                ├── File watcher activated (recursive)
                └── WebSocket server ready for browser connections

Browser
    │
    └── connects → ws://localhost:5500/webserver/ws
        │
        └── receives file change notifications → reloads page
```

### WebSocket Client Injection

When serving HTML files, the server injects a WebSocket client script into `<head>`:

```html
<script src="/webserver/client.js"></script>
```

This client:
1. Connects to the WebSocket server
2. Listens for file change events
3. Displays a 5-second toast notification ("JS Updated — Developed by: minnardev")
4. Reloads the page within 800ms

### Message Flow for File Changes

```
File modified
    │
    ├── fs.watch → handleFileChange()
    │   ├── debounce 50ms
    │   ├── broadcastWs({ type: "js", message: "JS Updated" })
    │   ├── showMessage("JS Updated — Developed by: minnardev")
    │   └── logMsg("js changes detected, reloading clients")
    │
    └── WebSocket → browser receives { type: "js", message: "JS Updated" }
        ├── shows toast notification (5s duration)
        └── reloads page (800ms delay)
```

---

## Architecture

### Files

| File | Purpose |
|---|---|
| `src/lib.rs` | Zed extension entry point (Rust, compiled to WASM) |
| `server.js` | Node.js language server with HTTP/WebSocket server |
| `extension.toml` | Extension manifest for Zed |
| `extension.json` | Marketplace listing metadata |
| `Cargo.toml` | Rust build configuration |
| `.cargo/config.toml` | Sets default WASM target |

### Communication Protocols

1. **Zed ↔ Extension** — Zed loads `extension.wasm`, calls Rust functions
2. **Zed ↔ Language Server** — LSP over stdio (Content-Length framing)
3. **Server ↔ Browser** — HTTP for file serving, WebSocket for live reload

### Security

- Serves files only within the project root (`ROOT`)
- Path traversal prevention via `path.normalize` and filtering `../`
- No external dependencies beyond Node.js built-ins and `ws` (for WebSocket)

---

## Supported File Types

| Extension | File Type | Reload Trigger |
|---|---|---|
| `.html` | HTML | HTML changes |
| `.css` | Stylesheet | CSS changes |
| `.js` | JavaScript | JS changes |
| `.ts` | TypeScript | JS changes |

---

## Troubleshooting

### Server doesn't start
- Ensure port 5500 is free: `lsof -ti:5500`
- Kill existing processes: `/webserver-stop`
- Restart: `/webserver-reopen`

### Browser doesn't auto-open
- Zed 1.26.2 doesn't support `showMessageRequest` dialogs yet
- Use `/webserver-start` or `Cmd+.` / `Ctrl+.` instead

### 404 Not Found
- Ensure there's an `index.html` in your project root
- The extension creates one automatically if missing

### WebSocket connection fails
- Check browser console for `ws://` connection errors
- Ensure browser isn't blocking WebSocket connections

### File watcher not detecting changes
- The watcher skips `node_modules` and `.git` directories
- Large projects may have performance impact

---

## License

MIT License — see [LICENSE](LICENSE) file.

Developed by [minnardev](https://github.com/minnardev)
