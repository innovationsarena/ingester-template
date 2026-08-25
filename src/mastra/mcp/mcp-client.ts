import { MCPClient } from '@mastra/mcp';
import type { IMastraLogger } from '@mastra/core/logger';
import type { ToolsInput } from '@mastra/core/agent';

const serverUrl = process.env.MCP_SERVER_URL;
const serverToken = process.env.MCP_SERVER_TOKEN;

let client: MCPClient | undefined;

/**
 * Lazily builds the MCP client. Returns `undefined` when `MCP_SERVER_URL` is not
 * set so the app still boots (and Studio still loads) without MCP configured.
 */
export function getMcpClient(): MCPClient | undefined {
  if (!serverUrl) return undefined;

  if (!client) {
    const url = new URL(serverUrl);

    client = new MCPClient({
      // An explicit id avoids the duplicate-configuration error if this module
      // is ever evaluated more than once (e.g. dev server reloads).
      id: 'ingest-mcp',
      timeout: 30_000,
      servers: {
        ingest: {
          url,
          ...(serverToken
            ? { requestInit: { headers: { Authorization: `Bearer ${serverToken}` } } }
            : {}),
          // The URL comes from the environment; pin the client to that host so a
          // redirect can't be used to reach internal services.
          allowedHosts: [url.host],
          // The workflow runs from a webhook with nobody to approve anything, so
          // an approval prompt would suspend the run indefinitely.
          requireToolApproval: false,
        },
      },
    });
  }

  return client;
}

/**
 * Resolves MCP tools for an agent. A server that is down or slow yields an empty
 * tool map plus a logged error instead of failing the whole run.
 */
export async function resolveMcpTools(logger?: IMastraLogger): Promise<ToolsInput> {
  const mcp = getMcpClient();

  if (!mcp) {
    logger?.warn('MCP_SERVER_URL is not set; the ingest agent has no MCP tools.');
    return {};
  }

  const { tools, errors } = await mcp.listToolsWithErrors({ perServerTimeoutMs: 10_000 });

  for (const [server, error] of Object.entries(errors)) {
    logger?.error('MCP tool discovery failed', { server, error });
  }

  return tools as ToolsInput;
}
