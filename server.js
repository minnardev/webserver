 'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, execSync } = require('child_process');

const PORT = parseInt(process.argv[3] || '5500', 10);
const ROOT = process.argv[2] || process.cwd();
const FORCE_HTTP = process.env.WEBSERVER_HTTP_ONLY === '1';
const FORCE_STD = process.env.WEBSERVER_FORCE_STD === '1';
const LS_MODE = FORCE_STD ? false : (process.stdin.isTTY !== true);

const WS_MAGIC = '258EAACFE731D6D7382A4A4E0E89E70C9A8C4A96';

let httpServer = null;
let wsClients = [];
let WebSocket, wss;

module.paths.push(path.join(ROOT, 'node_modules'));
try {
    WebSocket = require('ws');
    wss = new WebSocket.Server({ noServer: true });
} catch (e) {
    logMsg('ws module not available; WS will not work: ' + e.message, 1);
}
if (wss) {
    wss.on('connection', function(ws, req) {
        const client = { socket: ws };
        wsClients.push(client);
        ws.on('close', function() { cleanupClient(client); });
        ws.on('error', function() { cleanupClient(client); });
    });
}
let isRunning = false;
let isHttps = false;
let debounceTimers = {};

const FILE_TYPE_MAP = {
    '.js': 'JavaScript', '.jsx': 'JavaScript', '.ts': 'TypeScript',
    '.tsx': 'TypeScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.css': 'CSS', '.scss': 'CSS', '.less': 'CSS', '.sass': 'CSS', '.styl': 'CSS',
    '.html': 'HTML', '.htm': 'HTML', '.svelte': 'HTML', '.vue': 'HTML',
    '.ejs': 'HTML', '.pug': 'HTML', '.njk': 'HTML',
};

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
    '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
};

const CLIENT_JS = [
    '(function(){',
    '  var proto = location.protocol === "https:" ? "wss:" : "ws:";',
    '  var wsUrl = proto + "//" + location.host + "/webserver/ws";',
    '  var ws = new WebSocket(wsUrl);',
    '  var attempts = 0;',
    '  ws.onopen = function(){ attempts = 0; };',
    '  ws.onmessage = function(e){',
    '    var data = {};',
    '    try { data = JSON.parse(e.data); } catch(err) { data = { message: "File Updated" }; }',
    '    var msg = data.message || "File Updated";',
    '    var existing = document.getElementById("__webserver_notification__");',
    '    if(existing && existing.parentNode) existing.parentNode.removeChild(existing);',
    '    var n = document.createElement("div");',
    '    n.id = "__webserver_notification__";',
    '    n.style.cssText = "position:fixed;top:20px;right:20px;background:#1ea532;color:#fff;padding:10px 22px;border-radius:6px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:14px;font-weight:600;line-height:1.4;z-index:2147483647;box-shadow:0 6px 16px rgba(0,0,0,0.2);cursor:pointer;";',
    '    n.textContent = msg + " — Developed by: minnardev";',
    '    n.onclick = function(){ this.remove(); };',
    '    document.body.appendChild(n);',
    '    setTimeout(function(){ if(n.parentNode) n.parentNode.removeChild(n); }, 5000);',
    '    setTimeout(function(){ location.reload(); }, 800);',
    '  };',
    '  ws.onclose = function(){',
    '    if(attempts < 50){',
    '      attempts++;',
    '      setTimeout(function(){',
    '        try { new WebSocket(wsUrl); } catch(e) {}',
    '      }, 1500);',
    '    }',
    '  };',
    '  ws.onerror = function(){};',
    '})();',
].join('\n');

let _buffer = '';
if (LS_MODE) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function(chunk) {
        _buffer += chunk;
        while (true) {
            const headerEnd = _buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) break;
            const headerBlock = _buffer.substring(0, headerEnd);
            const bodyStart = headerEnd + 4;
            const lenMatch = headerBlock.match(/Content-Length:\s*(\d+)/i);
            if (!lenMatch) {
                _buffer = _buffer.substring(bodyStart);
                continue;
            }
            const contentLength = parseInt(lenMatch[1], 10);
            if (_buffer.length < bodyStart + contentLength) break;
            const body = _buffer.substring(bodyStart, bodyStart + contentLength);
            _buffer = _buffer.substring(bodyStart + contentLength);
            try {
                handleMessage(JSON.parse(body));
            } catch (e) {}
        }
    });
}

function sendLsp(message) {
    try {
        const content = JSON.stringify(message);
        const body = Buffer.from(content, 'utf8');
        const header = 'Content-Length: ' + body.length + '\r\n\r\n';
        process.stdout.write(header + content);
    } catch (e) {}
}

let lspRequestId = 0;
let pendingRequests = {};

function sendLspRequest(method, params, callback) {
    if (!LS_MODE) return;
    const id = ++lspRequestId;
    pendingRequests[id] = callback;
    const message = { jsonrpc: '2.0', id: id, method: method };
    if (params !== undefined && params !== null) {
        message.params = params;
    }
    sendLsp(message);
}

function logMsg(message, type) {
    if (LS_MODE) {
        sendLsp({
            jsonrpc: '2.0',
            method: 'window/logMessage',
            params: { type: type || 3, message: message }
        });
    } else {
        process.stderr.write('[WebServer] ' + message + '\n');
    }
}

function showMessage(message, type) {
    if (LS_MODE) {
        sendLsp({
            jsonrpc: '2.0',
            method: 'window/showMessage',
            params: {
                type: type || 3,
                message: message + ' — Developed by: minnardev'
            }
        });
    } else {
        process.stderr.write('[WebServer] ' + message + '\n');
    }
}

function showNotification(message, type) {
    showMessage(message + ' — Developed by: minnardev', type);
    if (LS_MODE) {
        setTimeout(function() {}, 5000);
    }
}

function handleMessage(msg) {
    if (msg.jsonrpc !== '2.0') return;

    if (msg.id !== undefined && msg.method === undefined) {
        const callback = pendingRequests[msg.id];
        if (callback) {
            delete pendingRequests[msg.id];
            if (msg.error) {
                callback(null, msg.error);
            } else {
                callback(msg.result);
            }
        }
        return;
    }

    if (msg.method) {
        switch (msg.method) {
            case 'initialize':
                sendLsp({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {
                        protocolVersion: 1,
                        capabilities: {
                            textDocumentSync: 1,
                            workspace: { workspaceFolders: { supported: true } }
                        }
                    }
                });
                logMsg('WebServer language server ready', 3);
                break;
            case 'initialized':
                startServer();
                break;
            case 'shutdown':
                sendLsp({ jsonrpc: '2.0', id: msg.id, result: null });
                break;
            case 'exit':
                stopServer();
                process.exit(0);
                break;
            default:
                break;
        }
    }
}

function createSelfSignedCert() {
    const certFile = path.join(os.tmpdir(), 'webserver-cert.pem');
    const keyFile = path.join(os.tmpdir(), 'webserver-key.pem');

    if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
        try {
            execSync(
                'openssl req -x509 -newkey rsa:2048 -keyout "' + keyFile + '" -out "' + certFile + '" -days 365 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null',
                { stdio: 'ignore', timeout: 10000 }
            );
            logMsg('Generated self-signed certificate', 3);
        } catch (e) {
            logMsg('openssl not available, falling back to HTTP', 2);
            return null;
        }
    }

    return {
        key: fs.readFileSync(keyFile),
        cert: fs.readFileSync(certFile)
    };
}

function startServer() {
    if (isRunning) {
        logMsg('WebServer already running on port ' + PORT, 3);
        return;
    }
    isRunning = true;

    const FORCE_HTTPS = process.env.WEBSERVER_FORCE_HTTPS === '1';
    let serverOptions = null;
    if (FORCE_HTTPS && !FORCE_HTTP) {
        try {
            serverOptions = createSelfSignedCert();
        } catch (e) {
            logMsg('HTTPS setup failed, falling back to HTTP: ' + e.message, 1);
        }
    } else {
        logMsg('HTTP selected (set WEBSERVER_FORCE_HTTPS=1 for HTTPS)', 3);
    }

    isHttps = !!serverOptions;
    const protocol = isHttps ? 'https' : 'http';

    const handler = createRequestHandler();

    if (serverOptions) {
        httpServer = https.createServer(serverOptions, handler);
    } else {
        httpServer = http.createServer(handler);
    }

    httpServer.on('upgrade', function(req, socket, head) {
        if (wss) {
            wss.handleUpgrade(req, socket, head, function(ws) {
                wss.emit('connection', ws, req);
            });
        } else {
            handleWebSocketUpgrade(req, socket);
        }
    });

    httpServer.on('error', function(err) {
        if (err.code === 'EADDRINUSE') {
            logMsg('Port ' + PORT + ' is already in use — server may already be running', 1);
            showMessage('Port ' + PORT + ' in use. Run /webserver-stop first.', 1);
        } else {
            logMsg('Server error: ' + err.message, 1);
        }
    });

    httpServer.listen(PORT, function() {
        logMsg('WebServer ' + protocol + '://localhost:' + PORT + ' serving: ' + ROOT, 3);
        showMessage('WebServer started on ' + protocol + '://localhost:' + PORT, 3);
        startFileWatcher();
    });
}

function openBrowser() {
    const protocol = isHttps ? 'https' : 'http';
    const url = protocol + '://localhost:' + PORT;
    let cmd;
    const platform = os.platform();

    if (platform === 'darwin') {
        cmd = 'open "' + url + '"';
    } else if (platform === 'win32') {
        cmd = 'start "" "' + url + '"';
    } else {
        cmd = 'xdg-open "' + url + '"';
    }

    exec(cmd, function(err) {
        if (err) {
            logMsg('Failed to open browser: ' + err.message, 1);
        } else {
            logMsg('Browser opened at ' + url, 3);
        }
    });
}

function handleWebSocketUpgrade(req, socket) {
    const url = req.url || '';
    if (url.indexOf('/webserver/ws') !== 0 && url.indexOf('/ws') !== 0) {
        socket.destroy();
        return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
        socket.destroy();
        return;
    }

    const accept = crypto
        .createHash('sha1')
        .update(key + WS_MAGIC)
        .digest('base64');

    const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Accept: ' + accept,
        '', ''
    ].join('\r\n');

    socket.write(headers);

    const client = { socket: socket };
    wsClients.push(client);

    socket.on('data', function() {});
    socket.on('error', function() { cleanupClient(client); });
    socket.on('close', function() { cleanupClient(client); });
}

function cleanupClient(client) {
    const idx = wsClients.indexOf(client);
    if (idx !== -1) wsClients.splice(idx, 1);
}

function sendWsFrame(client, message) {
    const msg = JSON.stringify(message);
    try {
        if (typeof client.socket.send === 'function') {
            client.socket.send(msg);
        } else {
            const payload = Buffer.from(msg, 'utf8');
            const frame = createTextFrame(payload);
            client.socket.write(frame);
        }
    } catch (e) {
        cleanupClient(client);
    }
}

function createTextFrame(payload) {
    const len = payload.length;
    let header;

    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }

    return Buffer.concat([header, payload]);
}

function broadcastWs(message) {
    for (let i = wsClients.length - 1; i >= 0; i--) {
        try {
            sendWsFrame(wsClients[i], message);
        } catch (e) {
            wsClients.splice(i, 1);
        }
    }
}

function createRequestHandler() {
    return function(req, res) {
        const url = req.url || '/';

        if (url === '/webserver/client.js' || url === '/webserver-reload.js') {
            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-cache'
            });
            res.end(CLIENT_JS);
            return;
        }

        let urlPath = url.split('?')[0];
        if (urlPath === '/') urlPath = '/index.html';

        const decoded = decodeURIComponent(urlPath);
        const safePath = path.normalize(decoded).replace(/^(\.\.[\/\\])+/, '');
        const filePath = path.join(ROOT, safePath);

        fs.stat(filePath, function(err, stats) {
            if (err || !stats.isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
                return;
            }

            fs.readFile(filePath, function(readErr, content) {
                if (readErr) {
                    res.writeHead(500);
                    res.end('Internal Server Error');
                    return;
                }

                const ext = path.extname(filePath).toLowerCase();
                const mime = MIME_TYPES[ext] || 'application/octet-stream';

                let body = content;
                if (ext === '.html' || ext === '.htm') {
                    let html = content.toString('utf8');
                    if (!html.includes('__webserver_injected__')) {
                        const inject = '<script src="/webserver/client.js"></script><!--__webserver_injected__-->';
                        html = html.replace(/<\/head>/i, inject + '</head>');
                        if (!html.includes('__webserver_injected__')) {
                            html = inject + '\n' + html;
                        }
                        body = Buffer.from(html, 'utf8');
                    }
                }

                res.writeHead(200, { 'Content-Type': mime });
                res.end(body);
            });
        });
    };
}

function watchDirectory(dir) {
    try {
        const watcher = fs.watch(dir, { persistent: true }, function(event, filename) {
            handleFileChange(filename, dir);
        });
    } catch (e) {}

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.svn') continue;
            if (entry.isDirectory()) {
                const full = path.join(dir, entry.name);
                if (full !== ROOT) watchDirectory(full);
            }
        }
    } catch (e) {}
}

function handleFileChange(filename, dir) {
    if (!filename) {
        if (wsClients.length > 0) {
            broadcastWs({ type: 'reload', message: 'Files Changed' });
        }
        return;
    }

    const ext = path.extname(filename).toLowerCase();
    let fileType = FILE_TYPE_MAP[ext];

    if (!fileType) return;

    const key = ext;
    if (debounceTimers[key]) clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(function() {
        logMsg(fileType + ' changes detected, reloading clients');
        showMessage(fileType + ' Updated — Developed by: minnardev', 3);
        broadcastWs({ type: fileType.toLowerCase(), message: fileType + ' Updated' });
        delete debounceTimers[key];
    }, 50);
}

function startFileWatcher() {
    watchDirectory(ROOT);
    logMsg('File watcher started on: ' + ROOT, 3);
}

function stopServer() {
    if (httpServer) {
        httpServer.close(function() {});
        httpServer = null;
    }
    for (const c of wsClients) {
        try { c.socket.destroy(); } catch (e) {}
    }
    wsClients = [];
    isRunning = false;
}

// Fallback: if LSP didn't initialize within 5 seconds, start server standalone
setTimeout(function() {
    if (!isRunning) {
        if (LS_MODE) {
            logMsg('LSP did not initialize, starting in standalone mode', 2);
        }
        startServer();
    }
}, 5000);

// In LS_MODE: wait for 'initialize' before starting (ensures LSP handshake completes)
// In standalone mode (TTY): start immediately
if (!LS_MODE) {
    startServer();
}

logMsg('WebServer extension loaded (port=' + PORT + ', root=' + ROOT + ')', 3);
