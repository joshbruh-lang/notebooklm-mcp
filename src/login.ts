// Run once: `npm run login`
// Opens a real Chrome window so you can sign into Google. The session
// persists in the profile dir and is reused by the MCP server in headless.
import { getContext, closeContext } from "./notebooklm.js";

async function main() {
  const ctx = await getContext(false);
  const page = await ctx.newPage();
  await page.goto("https://notebooklm.google.com");
  console.error(
    "\n[login] A browser window opened. Sign into Google, wait until you see your NotebookLM home, then press Enter here.",
  );
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });
  await page.close();
  await closeContext();
  console.error("[login] Session saved. You can now run the MCP server.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
