import { MCPConfiguration } from "@voltagent/core";

import { config } from "./config.js";

/** What `MCPConfiguration.getTools()` hands back, without naming `Tool<any>`. */
type McpTools = Awaited<ReturnType<MCPConfiguration["getTools"]>>;

/**
 * Remote MCP servers the agents may call.
 *
 * The map key becomes the tool-name prefix — `graphiti` exposes the server's
 * `search_nodes` as `graphiti_search_nodes` — so keep keys to
 * `[a-zA-Z0-9_-]`: the joined name goes to the model as a tool name.
 *
 * `type: "http"` tries streamable HTTP first and falls back to SSE.
 */
const mcp = config.mcpUrl
  ? new MCPConfiguration({
      servers: {
        graphiti: {
          type: "http",
          url: config.mcpUrl,
          timeout: config.mcpTimeoutMs,
        },
      },
    })
  : undefined;

/**
 * Resolved per agent run, not at module load: connecting needs a live server,
 * and a webhook service has to boot whether or not the MCP host answers.
 * `MCPConfiguration` caches the connected client and revives a dead one on the
 * next lookup, so this is one round trip per email, not one connection.
 *
 * Failures are swallowed by VoltAgent (per-server, returning no tools), which
 * matches how the rest of the pipeline treats a missing dependency: the email
 * is still processed, just without the tools.
 */
export const mcpTools = async (): Promise<McpTools> => (mcp ? mcp.getTools() : []);

/** Closes the MCP transports on shutdown. */
export async function disconnectMcp(): Promise<void> {
  await mcp?.disconnect();
}
