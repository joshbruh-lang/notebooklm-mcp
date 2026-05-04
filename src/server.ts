#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  addSource,
  closeContext,
  createNotebook,
  getSourceText,
  listNotebooks,
  listSources,
  queryNotebook,
} from "./notebooklm.js";

const server = new Server(
  { name: "notebooklm-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const tools = [
  {
    name: "list_notebooks",
    description: "List all NotebookLM notebooks visible to the signed-in account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "query_notebook",
    description:
      "Ask a question against a specific NotebookLM notebook and return the model's answer.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "Notebook ID (from list_notebooks)" },
        question: { type: "string", description: "Question to ask" },
      },
      required: ["notebook_id", "question"],
      additionalProperties: false,
    },
  },
  {
    name: "create_notebook",
    description:
      "Create a new empty NotebookLM notebook. Returns the new notebook's id and url. Optional title renames it after creation.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Optional title for the new notebook" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_sources",
    description:
      "List the sources currently attached to a NotebookLM notebook. Returns titles in display order.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "Notebook ID (from list_notebooks)" },
      },
      required: ["notebook_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_source_text",
    description:
      "Read the text content of a single source attached to a notebook. Returns the rendered text NotebookLM displays in its source viewer (works for markdown, web pages, PDFs — formatting is flattened to plain text).",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        source_index: {
          type: "integer",
          description: "Zero-based index from list_sources",
          minimum: 0,
        },
      },
      required: ["notebook_id", "source_index"],
      additionalProperties: false,
    },
  },
  {
    name: "add_source",
    description:
      "Add a source to a notebook. kind=url for a webpage; kind=text to paste raw text.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        kind: { type: "string", enum: ["url", "text"] },
        value: { type: "string" },
        title: { type: "string" },
      },
      required: ["notebook_id", "kind", "value"],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

const QuerySchema = z.object({
  notebook_id: z.string(),
  question: z.string(),
});
const CreateNotebookSchema = z.object({ title: z.string().optional() });
const ListSourcesSchema = z.object({ notebook_id: z.string() });
const GetSourceTextSchema = z.object({
  notebook_id: z.string(),
  source_index: z.number().int().min(0),
});
const AddSourceSchema = z.object({
  notebook_id: z.string(),
  kind: z.enum(["url", "text"]),
  value: z.string(),
  title: z.string().optional(),
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "list_notebooks") {
      const notebooks = await listNotebooks();
      return {
        content: [{ type: "text", text: JSON.stringify(notebooks, null, 2) }],
      };
    }
    if (name === "query_notebook") {
      const { notebook_id, question } = QuerySchema.parse(args);
      const answer = await queryNotebook(notebook_id, question);
      return { content: [{ type: "text", text: answer }] };
    }
    if (name === "create_notebook") {
      const { title } = CreateNotebookSchema.parse(args);
      const res = await createNotebook(title);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (name === "list_sources") {
      const { notebook_id } = ListSourcesSchema.parse(args);
      const sources = await listSources(notebook_id);
      return { content: [{ type: "text", text: JSON.stringify(sources, null, 2) }] };
    }
    if (name === "get_source_text") {
      const { notebook_id, source_index } = GetSourceTextSchema.parse(args);
      const res = await getSourceText(notebook_id, source_index);
      return {
        content: [{ type: "text", text: `# ${res.title}\n\n${res.text}` }],
      };
    }
    if (name === "add_source") {
      const { notebook_id, kind, value, title } = AddSourceSchema.parse(args);
      const res = await addSource(notebook_id, { kind, value, title });
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    };
  }
});

process.on("SIGINT", async () => {
  await closeContext();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await closeContext();
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[notebooklm-mcp] ready");
