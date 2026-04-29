import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAtlaSentServer } from "./server.js";

const apiKey = process.env["ATLASENT_API_KEY"];
if (!apiKey) {
  process.stderr.write(
    "atlasent-mcp: ATLASENT_API_KEY environment variable is required\n",
  );
  process.exit(1);
}

const server = createAtlaSentServer({ apiKey });
const transport = new StdioServerTransport();

await server.connect(transport);
