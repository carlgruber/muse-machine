#!/usr/bin/env node
// Muse Machine MCP server (Streamable HTTP transport) — for Claude Desktop's
// "basic chat" Connectors UI, which only accepts a "Remote MCP server URL",
// not a local spawn command. Runs on the same machine; localhost is fine
// as a "remote" URL since the transport is network-based either way.
//
// The connector UI requires https://, so this serves TLS using a
// locally-trusted cert from mkcert (see mcp/certs/README or just run:
//   mkcert -install
//   mkcert -cert-file mcp/certs/localhost-cert.pem -key-file mcp/certs/localhost-key.pem localhost 127.0.0.1 ::1
//
// Unlike server.js (spawned automatically by Claude Code), this must be
// started manually and kept running:
//   node mcp/server-http.js
// Then add https://localhost:8790/mcp as a custom connector in Claude Desktop.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createBridge, registerTools, APP_URL, WS_PORT } from './bridge.js';

const HTTP_PORT = 8790;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(__dirname, 'certs');
const CERT_FILE = path.join(CERT_DIR, 'localhost-cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'localhost-key.pem');

if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
  console.error(`Missing TLS cert/key at ${CERT_DIR}. Generate one with:`);
  console.error('  mkcert -install');
  console.error(`  mkcert -cert-file "${CERT_FILE}" -key-file "${KEY_FILE}" localhost 127.0.0.1 ::1`);
  process.exit(1);
}

const bridge = createBridge();

// One MCP server + transport per session, keyed by the session id the
// transport itself generates on initialize.
const sessions = new Map(); // sessionId -> { server, transport }

async function newSession() {
  const server = new McpServer({ name: 'muse-machine', version: '1.0.0' });
  registerTools(server, bridge);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: id => sessions.set(id, { server, transport }),
  });
  transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
  await server.connect(transport);
  return transport;
}

const tlsOptions = { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, mcp-session-id, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

const httpServer = https.createServer(tlsOptions, async (req, res) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.url} session=${req.headers['mcp-session-id'] || '-'} origin=${req.headers.origin || '-'}`);
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (!req.url.startsWith('/mcp')) {
    res.writeHead(404).end('not found');
    return;
  }
  const sessionId = req.headers['mcp-session-id'];
  const existing = sessionId && sessions.get(sessionId);

  try {
    if (existing) {
      await existing.transport.handleRequest(req, res);
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : undefined;
      if (!isInitializeRequest(parsed)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'no session — expected an initialize request' }, id: null }));
        return;
      }
      const transport = await newSession();
      await transport.handleRequest(req, res, parsed);
      return;
    }
    res.writeHead(400).end('missing or unknown mcp-session-id');
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null }));
  }
});

httpServer.on('tlsClientError', err => {
  console.error(`[${new Date().toISOString()}] TLS handshake failed before any request arrived: ${err.message}`);
});
httpServer.on('connection', socket => {
  console.error(`[${new Date().toISOString()}] raw TCP connection opened from ${socket.remoteAddress}:${socket.remotePort}`);
});

httpServer.listen(HTTP_PORT, () => {
  console.error(`muse-machine MCP server (Streamable HTTPS) up on https://localhost:${HTTP_PORT}/mcp`);
  console.error(`waiting for the app at ${APP_URL} to connect on ws://localhost:${WS_PORT}`);
});
