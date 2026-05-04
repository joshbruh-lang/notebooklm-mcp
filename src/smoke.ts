import { listNotebooks, closeContext } from "./notebooklm.js";

const notebooks = await listNotebooks();
console.log(JSON.stringify(notebooks, null, 2));
console.log(`\nFound ${notebooks.length} notebooks`);
await closeContext();
