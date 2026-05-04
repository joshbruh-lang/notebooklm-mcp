// Local-only smoke test. Run with:
//   NOTEBOOK_ID=<your-notebook-id> npx tsx src/inspect-source.ts
import { listSources, getSourceText, closeContext } from "./notebooklm.js";

const id = process.env.NOTEBOOK_ID;
if (!id) {
  console.error("Set NOTEBOOK_ID env var to a notebook UUID before running.");
  process.exit(1);
}

const sources = await listSources(id);
console.log(JSON.stringify(sources, null, 2));

if (sources.length > 0) {
  const { title, text } = await getSourceText(id, 0);
  console.log("\n---", title, "---");
  console.log(text.slice(0, 400));
}

await closeContext();
