#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createArchiveServer } from "./archive/server.js";

const server = createArchiveServer(process.env.AGENT_HUB_DATA_DIR);
const transport = new StdioServerTransport();
await server.connect(transport);
