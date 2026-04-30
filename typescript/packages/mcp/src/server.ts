import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AtlaSentClient } from "@atlasent/sdk";
import type { AtlaSentClientOptions } from "@atlasent/sdk";
import {
  toolEvaluate,
  toolKeySelf,
  toolProtect,
  toolVerifyPermit,
  formatError,
  type EvaluateArgs,
  type ProtectArgs,
  type VerifyPermitArgs,
} from "./tools.js";

const PACKAGE_VERSION = "1.5.1";

export interface McpServerOptions
  extends Omit<AtlaSentClientOptions, "apiKey"> {
  /**
   * AtlaSent API key. Falls back to `ATLASENT_API_KEY` env var when absent.
   */
  apiKey?: string;
}

/**
 * Creates a configured MCP {@link Server} that exposes the AtlaSent
 * authorization API as Claude tools.
 *
 * Tools registered:
 *   - `atlasent_evaluate`      — evaluate one agent/action pair
 *   - `atlasent_protect`       — evaluate + verify (full protect flow)
 *   - `atlasent_verify_permit` — verify a previously-issued permit
 *   - `atlasent_key_self`      — introspect the active API key
 *
 * @example
 * ```ts
 * import { createAtlaSentServer } from "@atlasent/mcp";
 * import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 *
 * const server = createAtlaSentServer();
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function createAtlaSentServer(options: McpServerOptions = {}): Server {
  const apiKey =
    options.apiKey ?? process.env["ATLASENT_API_KEY"] ?? "";

  const clientOpts: AtlaSentClientOptions = { ...options, apiKey };
  const client = new AtlaSentClient(clientOpts);

  const server = new Server(
    { name: "@atlasent/mcp", version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "atlasent_evaluate",
        description:
          "Ask the AtlaSent policy engine whether an agent action is permitted. " +
          "Returns a decision (ALLOW/DENY) with a permit_id, reason, and audit_hash. " +
          "A DENY is returned as data — the tool does not throw on policy denial.",
        inputSchema: {
          type: "object" as const,
          properties: {
            agent: {
              type: "string",
              description:
                "The agent requesting the action (e.g. 'user:123', 'service:deploy-bot')",
            },
            action: {
              type: "string",
              description:
                "The action being requested (e.g. 'deploy_to_production')",
            },
            context: {
              type: "object",
              description: "Additional key-value context for the policy engine",
              additionalProperties: true,
            },
          },
          required: ["agent", "action"],
        },
      },
      {
        name: "atlasent_protect",
        description:
          "Evaluate an agent action and cryptographically verify the resulting permit " +
          "in a single call (the full AtlaSent protect flow). " +
          "Returns a Permit on ALLOW+verified. Returns an error on policy DENY or " +
          "if the permit fails verification.",
        inputSchema: {
          type: "object" as const,
          properties: {
            agent: { type: "string" },
            action: { type: "string" },
            context: {
              type: "object",
              additionalProperties: true,
            },
          },
          required: ["agent", "action"],
        },
      },
      {
        name: "atlasent_verify_permit",
        description:
          "Verify that a previously-issued permit (decision_id) is still valid " +
          "and has not been revoked. Returns verified: true/false plus the permit_hash.",
        inputSchema: {
          type: "object" as const,
          properties: {
            permitId: {
              type: "string",
              description: "The permit_id / decision_id to verify",
            },
            agent: { type: "string" },
            action: { type: "string" },
            context: { type: "object", additionalProperties: true },
          },
          required: ["permitId"],
        },
      },
      {
        name: "atlasent_key_self",
        description:
          "Introspect the active API key — returns its key_id, environment, and scopes. " +
          "Useful for confirming which AtlaSent environment the MCP server is connected to.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case "atlasent_evaluate":
          result = await toolEvaluate(client, args as unknown as EvaluateArgs);
          break;
        case "atlasent_protect":
          result = await toolProtect(client, args as unknown as ProtectArgs);
          break;
        case "atlasent_verify_permit":
          result = await toolVerifyPermit(client, args as unknown as VerifyPermitArgs);
          break;
        case "atlasent_key_self":
          result = await toolKeySelf(client);
          break;
        default:
          return {
            content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: formatError(err) }],
        isError: true,
      };
    }
  });

  return server;
}
