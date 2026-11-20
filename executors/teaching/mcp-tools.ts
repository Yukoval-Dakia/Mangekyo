import { createHash } from 'node:crypto';
import { callMcpTool, discoverMcpTools, type McpServer, type McpTurnConnections } from './mcp-client.ts';
import type { TeachingDependencies, TeachingDispatch } from './index.ts';
import { TeachingError } from './provider.ts';

type ToolSchema = Awaited<ReturnType<typeof discoverMcpTools>>[number];
export type RemoteTool = { server: McpServer; tool: ToolSchema; stateful: boolean };

export async function loadMcpTools(servers: readonly McpServer[], model: string, runEffect: TeachingDependencies['runEffect'], connections: McpTurnConnections) {
  const catalog = new Map<string, RemoteTool>();
  let catalogBytes = 0;
  for (const [position, server] of servers.entries()) {
    const {id, url, allowedTools} = server;
    // Discovery changes over time. Replay must offer the same schema to the model.
    const requestDigest = createHash('sha256').update(JSON.stringify([id, url, allowedTools])).digest('hex');
    const readCatalog = (index: number) => runEffect({index, provider: 'tool:mcp:' + id, model, requestDigest}, async (_, dispatch) => {
      try {
        const tools = await discoverMcpTools(server, connections, dispatch);
        return JSON.stringify({tools, stateful: connections.hasStatefulSession(server)});
      } catch {
        return 'null';
      }
    });
    const first = await readCatalog(20_000 + position);
    // Listing tools is read-only. A second authorized attempt can recover from a dropped connection.
    const saved = first === 'null' ? await readCatalog(30_000 + position) : first;
    const snapshot: {tools: ToolSchema[]; stateful: boolean} | ToolSchema[] | null = JSON.parse(saved);
    if (!snapshot) throw new TeachingError('provider_unavailable', '无法读取 MCP 服务 ' + id + ' 的工具列表，请检查设置后重新发送。');
    // An older journal entry does not establish that an interrupted session was stateless.
    const stateful = Array.isArray(snapshot) || snapshot.stateful;
    const tools = Array.isArray(snapshot) ? snapshot : snapshot.tools;
    for (const tool of tools) {
      if (!allowedTools.includes(tool.name)) continue;
      catalogBytes += Buffer.byteLength(JSON.stringify(tool));
      if (catalog.size >= 96 || catalogBytes > 256 * 1024)
        throw new TeachingError('evidence_limit', '本轮所选 MCP 工具过多或说明过长，请减少所选服务或工具。');
      const suffix = createHash('sha256').update(JSON.stringify([id, tool.name])).digest('hex').slice(0, 12);
      const name = 'mcp_' + tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 45) + '_' + suffix;
      catalog.set(name, {server, tool, stateful});
    }
    if (allowedTools.some(name => !tools.some(tool => tool.name === name)))
      throw new TeachingError('provider_configuration', 'MCP 服务 ' + id + ' 当前没有提供全部已选工具，请核对工具名称。');
  }
  return catalog;
}

export function invokeMcpTool(remote: RemoteTool, args: Record<string, unknown>, connections: McpTurnConnections, dispatch?: TeachingDispatch) {
  return callMcpTool(remote.server, remote.tool.name, args, connections, dispatch);
}
