#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOrchestratorServer } from "./orchestrator/server.js";

const server = createOrchestratorServer(process.env.AGENT_HUB_DATA_DIR);
const transport = new StdioServerTransport();
await server.connect(transport);
