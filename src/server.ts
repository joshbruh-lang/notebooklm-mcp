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
  deleteNotebook,
  deleteSource,
  generateStudio,
  getSourceText,
  listNotebooks,
  listSources,
  queryNotebook,
  renameNotebook,
  renameSource,
  STUDIO_TYPES,
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
  {
    name: "delete_source",
    description:
      "Permanently remove a source from a notebook. Destructive — confirm with the user before invoking.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        source_index: { type: "integer", minimum: 0, description: "Zero-based index from list_sources" },
      },
      required: ["notebook_id", "source_index"],
      additionalProperties: false,
    },
  },
  {
    name: "rename_source",
    description: "Rename a source in a notebook.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        source_index: { type: "integer", minimum: 0 },
        new_title: { type: "string" },
      },
      required: ["notebook_id", "source_index", "new_title"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_notebook",
    description:
      "Permanently delete an entire notebook and all its sources. Destructive and irreversible — always confirm with the user before invoking.",
    inputSchema: {
      type: "object",
      properties: { notebook_id: { type: "string" } },
      required: ["notebook_id"],
      additionalProperties: false,
    },
  },
  {
    name: "rename_notebook",
    description: "Rename a notebook.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        new_title: { type: "string" },
      },
      required: ["notebook_id", "new_title"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_studio",
    description:
      "Trigger generation of a Studio artifact (Audio Overview, Mind Map, etc.). Returns immediately after triggering — generation runs server-side for 30s (mind map) to 5+ minutes (audio). Check the notebook in NotebookLM to see results.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        type: {
          type: "string",
          enum: [...STUDIO_TYPES],
          description: "Studio artifact type to generate",
        },
      },
      required: ["notebook_id", "type"],
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
const DeleteSourceSchema = z.object({ notebook_id: z.string(), source_index: z.number().int().min(0) });
const RenameSourceSchema = z.object({
  notebook_id: z.string(),
  source_index: z.number().int().min(0),
  new_title: z.string(),
});
const DeleteNotebookSchema = z.object({ notebook_id: z.string() });
const RenameNotebookSchema = z.object({ notebook_id: z.string(), new_title: z.string() });
const GenerateStudioSchema = z.object({
  notebook_id: z.string(),
  type: z.enum([...STUDIO_TYPES] as [string, ...string[]]),
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
    if (name === "delete_source") {
      const { notebook_id, source_index } = DeleteSourceSchema.parse(args);
      const res = await deleteSource(notebook_id, source_index);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }
    if (name === "rename_source") {
      const { notebook_id, source_index, new_title } = RenameSourceSchema.parse(args);
      const res = await renameSource(notebook_id, source_index, new_title);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }
    if (name === "delete_notebook") {
      const { notebook_id } = DeleteNotebookSchema.parse(args);
      const res = await deleteNotebook(notebook_id);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }
    if (name === "rename_notebook") {
      const { notebook_id, new_title } = RenameNotebookSchema.parse(args);
      const res = await renameNotebook(notebook_id, new_title);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }
    if (name === "generate_studio") {
      const { notebook_id, type } = GenerateStudioSchema.parse(args);
      const res = await generateStudio(notebook_id, type as never);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
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
