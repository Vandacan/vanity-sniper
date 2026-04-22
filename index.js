"use strict";

process.env.UV_THREADPOOL_SIZE = 4096;
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
process.env.NODE_PENDING_DEPRECATION = "0";
process.env.NODE_NO_WARNINGS = "1";
process.env.NODE_OPTIONS = '--max-old-space-size=4096 --optimize-for-size --no-warnings';
process.env.UV_TCP_SINGLE_ACCEPT = "1";
process.env.NODE_TLS_EARLY_DATA = "1";

const tls = require("tls");
const WebSocket = require("ws");
const fs = require("fs");

try {
  process.setpriority(process.pid, -20);
  require("child_process").execSync(
    `powershell "Get-Process -Id ${process.pid} | ForEach-Object { $_.PriorityClass = 'RealTime' }"`
  );
} catch {}

const CONFIG = {
  TOKEN: "MTI3MTQzNjEwMjE3NTI5NGyFRJW.IWzje6u_6Z",
  TARGET_GUILD_ID: "1419283581",
  TLS_POOL_SIZE: 2,
  MFA_PATH: "mfa.txt"
};

const wsMeta = [
  { name: "main", url: "wss://gateway.discord.gg/?v=9&encoding=json" },
  { name: "us-east1-b", url: "wss://gateway-us-east1-b.discord.gg/?v=9&encoding=json" }
];

const vanityRequestCache = new Map();
let mfaToken = null;
let lastMfaToken = null;
const guilds = new Map();           
let vanity = null;
let currentGatewayIndex = 0;
let ws = null;
let tlsSession = null;

const pinnedBuffers = new Array(10);
for (let i = 0; i < pinnedBuffers.length; i++)
  pinnedBuffers[i] = Buffer.allocUnsafeSlow(16 * 1024);
let pinnedBufferIndex = 0;

const tlsPool = new Array(CONFIG.TLS_POOL_SIZE);
const readySockets = [];

const KEEP_ALIVE_REQUEST = Buffer.from(
  "GET / HTTP/1.1\r\nHost: canary.discord.com\r\nConnection: keep-alive\r\n\r\n"
);

const TLS_OPTIONS = {
  host: "canary.discord.com",
  port: 443,
  servername: "canary.discord.com",
  ALPNProtocols: ["http/1.2"],
  rejectUnauthorized: false,
  zeroRtt: true,
  session: null,
  requestOCSP: false,
  enableTrace: false,
  ticketKeys: null,
  ciphers:
    "TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384",
  ecdhCurve: "X25519",
  honorCipherOrder: true,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.3",
  checkServerIdentity: () => undefined,
  keepAlive: true,
  keepAliveInitialDelay: 0
};

TLS_OPTIONS.ticketKeys = Buffer.alloc(48);
for (let i = 0; i < 48; i++)
  TLS_OPTIONS.ticketKeys[i] = Math.floor(Math.random() * 256);

function optimizeSocket(socket) {
  if (!socket) return;
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 0);
  if (socket.setRecvBufferSize) socket.setRecvBufferSize(2 * 1024 * 1024);
  if (socket.setSendBufferSize) socket.setSendBufferSize(2 * 1024 * 1024);
}

function buildVanityRequest(code) {
  if (vanityRequestCache.has(code)) return vanityRequestCache.get(code);
  pinnedBufferIndex = (pinnedBufferIndex + 1) % pinnedBuffers.length;
  const pinnedBuffer = pinnedBuffers[pinnedBufferIndex];
  const payload = '{"code":"' + code + '"}';
  const requestStr =
    "PATCH /api/v7/guilds/" +
    CONFIG.TARGET_GUILD_ID +
    "/vanity-url HTTP/1.1\r\n" +
    "Host: canary.discord.com\r\n" +
    "Authorization: " +
    CONFIG.TOKEN +
    "\r\n" +
    (mfaToken ? "X-Discord-MFA-Authorization: " + mfaToken + "\r\n" : "") +
    "User-Agent: Chrome/124\r\n" +
    "X-Super-Properties: eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ==\r\n" +
    "Content-Type: application/json\r\n" +
    "Connection: keep-alive\r\n" +
    "Content-Length: " +
    Buffer.byteLength(payload) +
    "\r\n\r\n" +
    payload;

  const reqTmp = Buffer.from(requestStr);
  reqTmp.copy(pinnedBuffer, 0, 0, Math.min(reqTmp.length, pinnedBuffer.length));
  const cached = Buffer.from(reqTmp);
  vanityRequestCache.set(code, cached);
  if (vanityRequestCache.size > 50) {
    const firstKey = vanityRequestCache.keys().next().value;
    vanityRequestCache.delete(firstKey);
  }
  console.log(`[BUILD] Cached request for ${code}`);
  return cached;
}

function createTlsConnection(index) {
  const options = { ...TLS_OPTIONS };
  if (tlsSession) options.session = tlsSession;
  const conn = tls.connect(options);
  conn.setNoDelay(true);
  conn.setKeepAlive(true, 0);
  optimizeSocket(conn);
  const responseChunks = [];
  conn.on("data", (data) => {
    responseChunks.push(data);
    const raw = Buffer.concat(responseChunks);
    const text = raw.toString();
    const splitIndex = text.indexOf("\r\n\r\n");
    if (splitIndex !== -1) {
      const bodyText = text.slice(splitIndex + 4);
      const start = bodyText.indexOf("{");
      const end = bodyText.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        const jsonStr = bodyText.substring(start, end + 1);
        try {
          const parsed = JSON.parse(jsonStr);
          console.log(`[TLS-${index}] Response for ${vanity}:`, parsed);
          if (parsed.code === 60003) {
            console.log("[TLS] MFA expired, reloading token...");
            loadMfaToken();
            conn.destroy();
            return;
          }
        } catch {}
      }
      responseChunks.length = 0;
    }
  });
  const cleanup = () => {
    const idx = readySockets.indexOf(conn);
    if (idx > -1) readySockets.splice(idx, 1);
    if (tlsPool[index] === conn) {
      tlsPool[index] = null;
      console.log(`[TLS] Connection ${index} closed, recreating...`);
      process.nextTick(() => {
        tlsPool[index] = createTlsConnection(index);
      });
    }
  };
  conn.on("error", cleanup);
  conn.on("close", cleanup);
  conn.on("timeout", cleanup);
  conn.on("secureConnect", () => {
    readySockets.push(conn);
    conn.write(KEEP_ALIVE_REQUEST);
    console.log(`[TLS] Connection ${index} ready`);
    if (!tlsSession) tlsSession = conn.getSession();
  });
  return conn;
}

function sendPatchRequests(code) {
  vanity = code;
  const req = buildVanityRequest(code);
  if (!req) return;
  const arr = readySockets;
  for (let i = arr.length - 1; i >= 0; --i) {
    const s = arr[i];
    if (s && s.writable) s.write(req);
  }
}

async function loadMfaToken() {
  try {
    const token = await fs.promises.readFile(CONFIG.MFA_PATH, "utf8");
    const trimmed = token.trim();
    if (trimmed && trimmed !== lastMfaToken) {
      lastMfaToken = trimmed;
      mfaToken = trimmed;
      vanityRequestCache.clear();
      console.log("[MFA] Token updated and cache cleared");
    }
  } catch {}
}

function connectWebSocket() {
  const gateway = wsMeta[currentGatewayIndex];
  console.log(`[WS] Connecting to ${gateway.name} gateway: ${gateway.url}`);

  ws = new WebSocket(gateway.url, {
    perMessageDeflate: false,
    skipUTF8Validation: true,
    handshakeTimeout: 5000
  });

  ws.on("open", () => {
    console.log(`[WS] Connected to ${gateway.name} gateway`);
    if (ws._socket) {
      ws._socket.setNoDelay(true);
      ws._socket.setTimeout(0);
      optimizeSocket(ws._socket);
    }

    ws.send(JSON.stringify({
      op: 2,
      d: {
        token: CONFIG.TOKEN,
        intents: 1 << 0,
        properties: { os: "Linux", browser: "Firefox", device: "Discord Android" },
        compress: false
      }
    }));
  });

  let heartbeatInterval = null;
  let heartbeatSequence = null;

  const guildUpdateStr = '"t":"GUILD_UPDATE"';
  const readyStr = '"t":"READY"';
  const op10Str = '"op":10';
  const op7Str = '"op":7';

  ws.on("message", (data) => {
    try {
      const str = data.toString();

      if (str.includes(guildUpdateStr)) {
        const payload = JSON.parse(str);
        heartbeatSequence = payload.s;
        const guild_id = payload.d.guild_id;
        const new_vanity = payload.d.vanity_url_code;

        const prev = guilds.get(guild_id);
        if (prev && prev !== new_vanity) {
          vanity = prev;
          sendPatchRequests(prev);
        }
      }
      else if (str.includes(readyStr)) {
        const payload = JSON.parse(str);
        heartbeatSequence = payload.s;

        if (payload.d.guilds) {
          guilds.clear();
          let vanityCount = 0;
          for (const g of payload.d.guilds) {
            if (g.vanity_url_code) {
              guilds.set(g.id, g.vanity_url_code);
              vanityCount++;
            }
          }

          for (const code of guilds.values()) buildVanityRequest(code);
        }
      }
      else if (str.includes(op10Str)) {
        const payload = JSON.parse(str);
        if (heartbeatInterval) clearInterval(heartbeatInterval);

        const interval = payload.d.heartbeat_interval;
        const jitter = Math.random() * interval;

        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 1, d: heartbeatSequence }));
            heartbeatInterval = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: 1, d: heartbeatSequence }));
              }
            }, interval);
          }
        }, jitter);
      }
      else if (str.includes(op7Str)) {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        console.log("[WS] OP7 received, reconnecting...");
        currentGatewayIndex = (currentGatewayIndex + 1) % wsMeta.length;
        setTimeout(connectWebSocket, 10);
        ws.terminate();
        return;
      }
    } catch {}
  });

  ws.on("close", () => {
    console.log("[WS] Closed, reconnecting...");
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    currentGatewayIndex = (currentGatewayIndex + 1) % wsMeta.length;
    setTimeout(connectWebSocket, 10);
  });

  ws.on("error", (err) => {
    console.log("[WS] Error:", err.message);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    currentGatewayIndex = (currentGatewayIndex + 1) % wsMeta.length;
    setTimeout(connectWebSocket, 10);
  });
}

function keepConnectionsAlive() {
  for (let i = 0; i < readySockets.length; i++)
    if (readySockets[i]?.writable) readySockets[i].write(KEEP_ALIVE_REQUEST);
}

async function initialize() {
  console.log("[INIT] Starting...");
  await loadMfaToken();
  console.log(`[INIT] Creating ${CONFIG.TLS_POOL_SIZE} TLS sockets...`);
  for (let i = 0; i < CONFIG.TLS_POOL_SIZE; i++)
    setTimeout(() => {
      tlsPool[i] = createTlsConnection(i);
    }, i * 5);
  setTimeout(connectWebSocket, 1000);
  const keepAliveInterval = setInterval(keepConnectionsAlive, 2000);
  const mfaInterval = setInterval(loadMfaToken, 10000);
  try {
    fs.watch(CONFIG.MFA_PATH, (eventType) => {
      if (eventType === "change") loadMfaToken();
    });
  } catch {}
  process.on("SIGINT", () => {
    console.log("[EXIT] Cleaning up...");
    clearInterval(keepAliveInterval);
    clearInterval(mfaInterval);
    for (let i = 0; i < readySockets.length; i++)
      if (readySockets[i]?.end) readySockets[i].end();
    process.exit(0);
  });
}

process.on("uncaughtException", (e) => console.log("[ERROR]", e.message));
process.on("unhandledRejection", (e) => console.log("[ERROR]", e?.message));

initialize();
