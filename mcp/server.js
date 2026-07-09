#!/usr/bin/env node
// Muse Machine MCP server (stdio transport) — for Claude Code / any local
// agent that spawns MCP servers as a subprocess via command+args.
// For Claude Desktop's "basic chat" connectors UI (which only takes a URL,
// not a spawn command), run server-http.js instead.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge, registerTools, APP_URL, WS_PORT } from './bridge.js';

const bridge = createBridge();
const server = new McpServer({ name: 'muse-machine', version: '1.0.0' });
registerTools(server, bridge);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`muse-machine MCP server (stdio) up — waiting for the app at ${APP_URL} to connect on ws://localhost:${WS_PORT}`);
