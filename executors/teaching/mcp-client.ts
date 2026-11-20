import {cancelBody, responseTooLarge, readBoundedText} from './bounded-response.ts';
import type {TeachingDispatch} from './index.ts';
export type McpServer = {
  id: string;
  url: string;
  token?: string;
  allowedTools: string[];
};

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type JsonObject = Record<string, unknown>;

type ServerConfig = {
  url: string;
  token: string | undefined;
  allowedTools: Set<string>;
};

type Deadline = {
  signal: AbortSignal;
  remaining: () => number;
  dispose: () => void;
};

const protocolVersion = '2025-11-25';
const supportedProtocolVersions = new Set([protocolVersion, '2025-06-18', '2025-03-26']);
const operationTimeoutMs = 20_000;
const closeTimeoutMs = 2_000;
const maximumRequestBytes = 512 * 1024;
const maximumResponseBytes = 1024 * 1024;
const maximumDiscoveryBytes = 4 * 1024 * 1024;
const maximumEventBytes = 512 * 1024;
const maximumToolPages = 20;
const maximumTools = 500;
const maximumToolBytes = 64 * 1024;
const maximumContentBlocks = 256;
const visibleAscii = /^[\x21-\x7e]+$/;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && visibleAscii.test(value);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const parts = host.split('.');
  return parts.length === 4 &&
    parts[0] === '127' &&
    parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function serverConfig(server: McpServer): ServerConfig {
  if (
    !isObject(server) ||
    typeof server.id !== 'string' ||
    server.id.length > 200 ||
    !server.id.trim()
  ) {
    throw new Error('MCP server configuration is invalid');
  }
  if (typeof server.url !== 'string') throw new Error('MCP server URL is invalid');

  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new Error('MCP server URL is invalid');
  }
  if (
    url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
  ) {
    throw new Error('MCP server URL must use HTTPS or loopback HTTP');
  }

  if (!Array.isArray(server.allowedTools) || server.allowedTools.length > maximumTools) {
    throw new Error('MCP allowedTools is invalid');
  }
  const allowedTools = new Set<string>();
  for (const name of server.allowedTools) {
    if (!validName(name)) throw new Error('MCP allowedTools contains an invalid name');
    allowedTools.add(name);
  }

  if (
    server.token !== undefined &&
    (typeof server.token !== 'string' || server.token.length > 4096 || !visibleAscii.test(server.token))
  ) {
    throw new Error('MCP bearer token is invalid');
  }

  return { url: url.href, token: server.token, allowedTools };
}

function createDeadline(timeoutMs: number): Deadline {
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    remaining: () => Math.max(1, Math.ceil(expiresAt - performance.now())),
    dispose: () => clearTimeout(timer),
  };
}

function mediaType(response: Response): string {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function responseMessage(value: unknown, id: number): JsonObject | undefined {
  const messages = Array.isArray(value) ? value : [value];
  for (const message of messages) {
    if (isObject(message) && message.id === id && ('result' in message || 'error' in message)) {
      return message;
    }
  }
  return undefined;
}

function parseResponsePayload(payload: string, id: number): JsonObject | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('MCP response is not valid JSON');
  }
  return responseMessage(value, id);
}

async function readJsonResponse(response: Response, id: number): Promise<JsonObject> {
  const text = await readBoundedText(response, maximumResponseBytes);
  const message = parseResponsePayload(text, id);
  if (!message) throw new Error('MCP response does not match the request');
  return message;
}

async function readSseResponse(
  response: Response,
  id: number,
  deadline: Deadline,
): Promise<JsonObject> {
  if (responseTooLarge(response, maximumResponseBytes)) {
    await cancelBody(response);
    throw new Error('MCP response exceeds the byte limit');
  }
  if (!response.body) throw new Error('MCP response has no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let line = '';
  let data: string[] = [];
  let eventBytes = 0;
  let pendingCarriageReturn = false;
  let found: JsonObject | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const dispatch = () => {
    if (found || data.length === 0) {
      data = [];
      eventBytes = 0;
      return;
    }
    const payload = data.join('\n');
    data = [];
    eventBytes = 0;
    if (payload.trim()) found = parseResponsePayload(payload, id);
  };

  const processLine = () => {
    if (line === '') {
      dispatch();
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      if (field === 'data') {
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        eventBytes += Buffer.byteLength(value);
        if (eventBytes > maximumEventBytes) throw new Error('MCP event exceeds the byte limit');
        data.push(value);
      }
    }
    line = '';
  };

  const consume = (text: string) => {
    for (const character of text) {
      if (pendingCarriageReturn) {
        pendingCarriageReturn = false;
        processLine();
        if (character === '\n') continue;
      }
      if (character === '\r') {
        pendingCarriageReturn = true;
      } else if (character === '\n') {
        processLine();
      } else {
        line += character;
        if (Buffer.byteLength(line) > maximumEventBytes) throw new Error('MCP event exceeds the byte limit');
      }
    }
  };

  try {
    if (!deadline.signal.aborted) {
      deadlineTimer = setTimeout(() => reader.cancel().catch(() => undefined), deadline.remaining());
      deadlineTimer.unref();
    }
    while (!found) {
      if (deadline.signal.aborted) throw new Error('MCP operation timed out');
      const { done, value } = await reader.read();
      bytes += value?.byteLength ?? 0;
      if (bytes > maximumResponseBytes) throw new Error('MCP response exceeds the byte limit');
      if (value) consume(decoder.decode(value, { stream: !done }));
      if (done) break;
    }
    if (!found) {
      consume(decoder.decode());
      if (pendingCarriageReturn) {
        pendingCarriageReturn = false;
        processLine();
      }
      if (line !== '') processLine();
      dispatch();
    }
    if (!found) throw new Error('MCP stream ended without a response');
    return found;
  } finally {
    clearTimeout(deadlineTimer);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readRpcResponse(response: Response, id: number, deadline: Deadline): Promise<JsonObject> {
  if (!response.ok) {
    await cancelBody(response);
    throw new Error(`MCP request failed with HTTP ${response.status}`);
  }
  const type = mediaType(response);
  if (!type || type === 'application/json' || type.endsWith('+json')) {
    return readJsonResponse(response, id);
  }
  if (type === 'text/event-stream') return readSseResponse(response, id, deadline);
  await cancelBody(response);
  throw new Error('MCP response has an unsupported content type');
}

function rpcResult(message: JsonObject): unknown {
  if ('error' in message) {
    const code = isObject(message.error) && typeof message.error.code === 'number'
      ? message.error.code
      : undefined;
    throw new Error(code === undefined ? 'MCP JSON-RPC request failed' : `MCP JSON-RPC request failed (${code})`);
  }
  return message.result;
}

class McpSession {
  readonly server: ServerConfig;
  private nextId = 1;
  private sessionId: string | undefined;
  private negotiatedVersion: string | undefined;
  initialized = false;

  constructor(server: ServerConfig) {
    this.server = server;
  }

  get stateful() { return this.sessionId !== undefined; }

  private headers(): Headers {
    const headers = new Headers({
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    });
    if (this.server.token !== undefined) headers.set('authorization', `Bearer ${this.server.token}`);
    if (this.sessionId !== undefined) headers.set('mcp-session-id', this.sessionId);
    if (this.negotiatedVersion !== undefined) headers.set('mcp-protocol-version', this.negotiatedVersion);
    return headers;
  }

  private async post(payload: unknown, deadline: Deadline, dispatch?: TeachingDispatch): Promise<Response> {
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch {
      throw new Error('MCP request is not serializable');
    }
    if (Buffer.byteLength(body) > maximumRequestBytes) {
      throw new Error('MCP request exceeds the byte limit');
    }

    const send = async () => {
      try {
        return await fetch(this.server.url, {
          method: 'POST', headers: this.headers(), body, redirect: 'error', signal: deadline.signal,
        });
      } catch {
        if (deadline.signal.aborted) throw new Error('MCP operation timed out');
        throw new Error('MCP request failed');
      }
    };
    return dispatch ? dispatch(send) : send();
  }

  async initialize(deadline: Deadline, dispatch?: TeachingDispatch): Promise<void> {
    const id = this.nextId++;
    const response = await this.post({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'mangekyo-teaching', version: '1' },
      },
    }, deadline, dispatch);

    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId !== null) {
      if (sessionId.length > 1024 || !visibleAscii.test(sessionId)) {
        await cancelBody(response);
        throw new Error('MCP session ID is invalid');
      }
      this.sessionId = sessionId;
    }

    const result = rpcResult(await readRpcResponse(response, id, deadline));
    if (
      !isObject(result) ||
      typeof result.protocolVersion !== 'string' ||
      !supportedProtocolVersions.has(result.protocolVersion) ||
      !isObject(result.capabilities)
    ) {
      throw new Error('MCP initialize result is invalid');
    }
    this.negotiatedVersion = result.protocolVersion;
  }

  async notifyInitialized(deadline: Deadline, dispatch?: TeachingDispatch): Promise<void> {
    const response = await this.post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, deadline, dispatch);
    await cancelBody(response);
    if (!response.ok) throw new Error(`MCP initialized notification failed with HTTP ${response.status}`);
    this.initialized = true;
  }

  async request(method: string, params: JsonObject, deadline: Deadline, dispatch?: TeachingDispatch): Promise<unknown> {
    if (!this.initialized) throw new Error('MCP session is not initialized');
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, deadline, dispatch);
    return rpcResult(await readRpcResponse(response, id, deadline));
  }

  async close(): Promise<void> {
    if (this.sessionId === undefined) return;
    const sessionId = this.sessionId;
    this.sessionId = undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), closeTimeoutMs);
    timer.unref();
    try {
      const headers = this.headers();
      headers.set('accept', 'application/json');
      headers.set('mcp-session-id', sessionId);
      headers.delete('content-type');
      await fetch(this.server.url, {
        method: 'DELETE',
        headers,
        redirect: 'error',
        signal: controller.signal,
      }).then(cancelBody);
    } catch {
      // Session cleanup is best effort and never changes the primary outcome.
    } finally {
      clearTimeout(timer);
    }
  }
}

// A tool server can keep a cursor, scratch document, or other state for one learning turn.
export class McpTurnConnections {
  private sessions = new Map<McpServer, McpSession>();

  session(server: McpServer) {
    const current = this.sessions.get(server);
    if (current) return current;
    const session = new McpSession(serverConfig(server));
    this.sessions.set(server, session);
    return session;
  }

  hasStatefulSession(server: McpServer) {
    return this.sessions.get(server)?.stateful === true;
  }

  async discard(server: McpServer) {
    const session = this.sessions.get(server);
    this.sessions.delete(server);
    await session?.close();
  }

  async close() {
    await Promise.all([...this.sessions.values()].map(session => session.close()));
    this.sessions.clear();
  }
}

type SessionAction<T> = (request: (method: string, params: JsonObject) => Promise<unknown>, config: ServerConfig) => Promise<T>;

async function withSession<T>(server: McpServer, action: SessionAction<T>, connections?: McpTurnConnections, dispatch?: TeachingDispatch): Promise<T> {
  const session = connections?.session(server) ?? new McpSession(serverConfig(server));
  const deadline = createDeadline(operationTimeoutMs);
  try {
    if (!session.initialized) {
      await session.initialize(deadline, dispatch);
      await session.notifyInitialized(deadline, dispatch);
    }
    return await action((method, params) => session.request(method, params, deadline, dispatch), session.server);
  } catch (error) {
    if (connections) await connections.discard(server);
    if (deadline.signal.aborted) throw new Error('MCP operation timed out');
    throw error;
  } finally {
    deadline.dispose();
    if (!connections) await session.close();
  }
}

function readTool(value: unknown): McpTool {
  if (
    !isObject(value) ||
    !validName(value.name) ||
    (value.description !== undefined && value.description !== null && typeof value.description !== 'string') ||
    !isObject(value.inputSchema)
  ) {
    throw new Error('MCP tools/list returned an invalid tool');
  }
  const description = typeof value.description === 'string' ? value.description : '';
  if (description.length > maximumToolBytes) throw new Error('MCP tool metadata exceeds the byte limit');
  return { name: value.name, description, inputSchema: value.inputSchema };
}

export function discoverMcpTools(server: McpServer, connections?: McpTurnConnections, dispatch?: TeachingDispatch): Promise<McpTool[]> {
  return listTools(server, true, connections, dispatch);
}

// Settings can browse the catalog before granting any tool to a turn.
export async function browseMcpTools(server: McpServer) {
  return (await listTools(server, false)).map(({name, description}) => ({name, description}));
}

async function listTools(server: McpServer, authorizedOnly: boolean, connections?: McpTurnConnections, dispatch?: TeachingDispatch): Promise<McpTool[]> {
  return withSession(server, async (request, config) => {
    const tools: McpTool[] = [];
    const seenNames = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let totalBytes = 0;

    for (let page = 0; page < maximumToolPages; page++) {
      const result = await request('tools/list', cursor === undefined ? {} : { cursor });
      const pageBytes = isObject(result) ? Buffer.byteLength(JSON.stringify(result)) : 0;
      totalBytes += pageBytes;
      if (
        !isObject(result) ||
        !Array.isArray(result.tools) ||
        result.tools.length > maximumTools ||
        totalBytes > maximumDiscoveryBytes
      ) {
        throw new Error('MCP tools/list result is invalid');
      }

      for (const value of result.tools) {
        const tool = readTool(value);
        if ((authorizedOnly && !config.allowedTools.has(tool.name)) || seenNames.has(tool.name)) continue;
        if (tools.length >= maximumTools) throw new Error('MCP discovery returned too many tools');
        seenNames.add(tool.name);
        tools.push(tool);
      }

      const next = result.nextCursor;
      if (next === undefined || next === null) return tools;
      if (
        typeof next !== 'string' || next.length === 0 || next.length > 2048 ||
        seenCursors.has(next)
      ) {
        throw new Error('MCP tools/list returned an invalid cursor');
      }
      seenCursors.add(next);
      cursor = next;
    }
    throw new Error('MCP tools/list exceeded the page limit');
  }, connections, dispatch);
}

function renderToolResult(value: unknown): string {
  if (
    !isObject(value) ||
    !Array.isArray(value.content) ||
    value.content.length > maximumContentBlocks ||
    (value.isError !== undefined && typeof value.isError !== 'boolean') ||
    (value.structuredContent !== undefined && !isObject(value.structuredContent))
  ) {
    throw new Error('MCP tools/call result is invalid');
  }

  const parts: string[] = [];
  for (const block of value.content) {
    if (!isObject(block) || typeof block.type !== 'string') {
      throw new Error('MCP tools/call content is invalid');
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw new Error('MCP text content is invalid');
      parts.push(block.text);
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  const text = parts.join('\n');
  const structured = value.structuredContent === undefined
    ? ''
    : JSON.stringify(value.structuredContent);
  const rendered = [text, structured].filter(part => part.length > 0).join('\n\n');
  return value.isError === true ? `error: ${rendered}` : rendered;
}

export async function callMcpTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
  connections?: McpTurnConnections,
  dispatch?: TeachingDispatch,
): Promise<string> {
  const config = serverConfig(server);
  if (!validName(name) || !config.allowedTools.has(name)) {
    throw new Error('MCP tool is not allowed');
  }
  if (!isObject(args)) throw new Error('MCP tool arguments must be an object');

  return withSession(server, async request => {
    const result = await request('tools/call', { name, arguments: args });
    return renderToolResult(result);
  }, connections, dispatch);
}
