import { chromium, type BrowserContext, type Page } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const PROFILE_DIR =
  process.env.NOTEBOOKLM_PROFILE_DIR ??
  join(homedir(), ".notebooklm-mcp", "chrome-profile");

const NOTEBOOKLM_URL = "https://notebooklm.google.com";

let ctxPromise: Promise<BrowserContext> | null = null;

export async function getContext(headless = true): Promise<BrowserContext> {
  if (!ctxPromise) {
    mkdirSync(PROFILE_DIR, { recursive: true });
    ctxPromise = chromium.launchPersistentContext(PROFILE_DIR, {
      headless,
      viewport: { width: 1280, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }
  return ctxPromise;
}

export async function closeContext() {
  if (ctxPromise) {
    const ctx = await ctxPromise;
    await ctx.close();
    ctxPromise = null;
  }
}

async function newPage(): Promise<Page> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  return page;
}

async function ensureLoggedIn(page: Page) {
  if (page.url().includes("accounts.google.com")) {
    throw new Error(
      "Not logged in. Run `npm run login` to authenticate, then retry.",
    );
  }
}

export type NotebookSummary = {
  id: string;
  title: string;
  url: string;
  emoji?: string;
  meta?: string;
};

export async function listNotebooks(): Promise<NotebookSummary[]> {
  const page = await newPage();
  try {
    await page.goto(NOTEBOOKLM_URL, { waitUntil: "domcontentloaded" });
    await ensureLoggedIn(page);
    // Wait for at least one notebook anchor to appear; if zero notebooks
    // exist, fall back to a fixed delay so the empty state can render.
    await Promise.race([
      page.waitForSelector('a[href*="/notebook/"]', { timeout: 20000 }),
      page.waitForTimeout(8000),
    ]);

    // NotebookLM renders notebook cards as anchors to /notebook/<id>.
    // We grab href + visible title text. Selector is intentionally loose so
    // it survives minor DOM changes; if Google overhauls the homepage this
    // is the first place to update.
    const items = await page.evaluate(() => {
      const out: {
        id: string;
        title: string;
        url: string;
        emoji?: string;
        meta?: string;
      }[] = [];
      const anchors = document.querySelectorAll<HTMLAnchorElement>(
        'a[href*="/notebook/"]',
      );
      for (const a of anchors) {
        const m = a.href.match(/\/notebook\/([0-9a-f-]{8,})/);
        if (!m) continue;
        // Title sits in the anchor's parent. Format observed:
        //   "<emoji>\nmore_vert\n<title>\n<date>·<N sources>"
        const parentText = (a.parentElement?.innerText ?? "").trim();
        const lines = parentText.split("\n").map((l) => l.trim()).filter(Boolean);
        // Drop "more_vert" icon-text and any leading emoji-only line
        const filtered = lines.filter((l) => l !== "more_vert");
        let emoji: string | undefined;
        if (filtered[0] && /^\p{Extended_Pictographic}/u.test(filtered[0]) && filtered[0].length <= 4) {
          emoji = filtered.shift();
        }
        const title = filtered[0] ?? "";
        const meta = filtered[1];
        if (!title) continue;
        out.push({ id: m[1], title, url: a.href, emoji, meta });
      }
      const seen = new Set<string>();
      return out.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
    });

    return items;
  } finally {
    await page.close();
  }
}

export async function queryNotebook(
  notebookId: string,
  question: string,
): Promise<string> {
  const page = await newPage();
  try {
    await page.goto(`${NOTEBOOKLM_URL}/notebook/${notebookId}`, {
      waitUntil: "domcontentloaded",
    });
    await ensureLoggedIn(page);
    await page.waitForTimeout(4000);

    const input = page.locator('textarea, [contenteditable="true"]').first();
    await input.waitFor({ state: "visible", timeout: 15000 });
    await input.click();
    await input.fill(question).catch(async () => {
      // contenteditable doesn't support fill; type instead
      await input.type(question);
    });
    await page.keyboard.press("Enter");

    // Wait for a fresh response block. NotebookLM streams the answer; we
    // poll until the latest assistant message stops growing for 1.5s.
    const responseSel =
      '[data-testid="chat-message"], .response-content, [role="article"]';
    await page.waitForSelector(responseSel, { timeout: 30000 });

    let prev = "";
    let stable = 0;
    const start = Date.now();
    while (Date.now() - start < 90000) {
      const text = await page.evaluate((sel) => {
        const nodes = document.querySelectorAll(sel);
        const last = nodes[nodes.length - 1] as HTMLElement | undefined;
        return last?.innerText ?? "";
      }, responseSel);
      if (text && text === prev) {
        stable++;
        if (stable >= 3) return text;
      } else {
        stable = 0;
        prev = text;
      }
      await page.waitForTimeout(500);
    }
    return prev || "(no response captured)";
  } finally {
    await page.close();
  }
}

export async function createNotebook(
  title?: string,
): Promise<{ id: string; url: string; title?: string }> {
  const page = await newPage();
  try {
    await page.goto(NOTEBOOKLM_URL, { waitUntil: "domcontentloaded" });
    await ensureLoggedIn(page);
    await page.waitForTimeout(4000);

    // "Create new" / "Create new notebook" button on home page.
    const createBtn = page
      .locator(
        'button:has-text("Create new notebook"), button:has-text("Create new"), button[aria-label*="Create" i]',
      )
      .first();
    await createBtn.click({ timeout: 10000 });

    // Wait for navigation to /notebook/<new-id>
    await page.waitForURL(/\/notebook\/[0-9a-f-]{8,}/, { timeout: 20000 });
    const id = page.url().match(/\/notebook\/([^/?#]+)/)?.[1] ?? "";

    // Optionally rename. NotebookLM defaults the title to "Untitled notebook";
    // clicking the title in the header turns it into an editable input.
    if (title) {
      try {
        const titleEl = page
          .locator('h1, [role="heading"], [aria-label*="title" i]')
          .first();
        await titleEl.click({ timeout: 5000 });
        await page.keyboard.press("Meta+A").catch(() => {});
        await page.keyboard.type(title);
        await page.keyboard.press("Tab");
      } catch {
        // Rename is best-effort; notebook is created either way.
      }
    }

    return { id, url: page.url(), title };
  } finally {
    await page.close();
  }
}

export type SourceSummary = { title: string; index: number };

export async function listSources(
  notebookId: string,
): Promise<SourceSummary[]> {
  const page = await newPage();
  try {
    await page.goto(`${NOTEBOOKLM_URL}/notebook/${notebookId}`, {
      waitUntil: "domcontentloaded",
    });
    await ensureLoggedIn(page);
    await page.waitForTimeout(5000);

    // Each source row exposes a button with class .source-stretched-button
    // whose aria-label is the source title. Order matches the visible list,
    // so we use array index as the stable handle for get_source_text.
    await page.waitForSelector(".source-stretched-button", { timeout: 15000 }).catch(() => {});
    const sources = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>(".source-stretched-button"),
      );
      return buttons.map((b, i) => ({
        title: b.getAttribute("aria-label") ?? "",
        index: i,
      }));
    });

    return sources;
  } finally {
    await page.close();
  }
}

export async function getSourceText(
  notebookId: string,
  sourceIndex: number,
): Promise<{ title: string; text: string }> {
  const page = await newPage();
  try {
    await page.goto(`${NOTEBOOKLM_URL}/notebook/${notebookId}`, {
      waitUntil: "domcontentloaded",
    });
    await ensureLoggedIn(page);
    await page.waitForSelector(".source-stretched-button", { timeout: 15000 });

    const buttons = page.locator(".source-stretched-button");
    const count = await buttons.count();
    if (sourceIndex < 0 || sourceIndex >= count) {
      throw new Error(
        `source_index ${sourceIndex} out of range (notebook has ${count} sources)`,
      );
    }
    const target = buttons.nth(sourceIndex);
    const title = (await target.getAttribute("aria-label")) ?? "";
    await target.click();

    // Wait for the source viewer panel to render the content.
    await page.waitForSelector("section.source-panel .scroll-container", {
      timeout: 15000,
    });
    // Give the body a moment to fully populate (long sources stream in).
    await page.waitForTimeout(1500);

    const text = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(
        "section.source-panel .scroll-container",
      );
      return (el?.innerText ?? "").trim();
    });

    return { title, text };
  } finally {
    await page.close();
  }
}

export async function addSource(
  notebookId: string,
  source: { kind: "url" | "text"; value: string; title?: string },
): Promise<{ ok: true }> {
  const page = await newPage();
  try {
    await page.goto(`${NOTEBOOKLM_URL}/notebook/${notebookId}`, {
      waitUntil: "domcontentloaded",
    });
    await ensureLoggedIn(page);
    await page.waitForTimeout(4000);

    // Open "Add source" dialog. Button label is locale-dependent; match on
    // common variants and aria-labels.
    const addBtn = page
      .locator(
        'button:has-text("Add"), button[aria-label*="Add source" i], button[aria-label*="add" i]',
      )
      .first();
    await addBtn.click({ timeout: 10000 });

    if (source.kind === "url") {
      await page.locator('button:has-text("Website"), button:has-text("URL")').first().click();
      await page.locator('input[type="url"], input[type="text"]').first().fill(source.value);
      await page.locator('button:has-text("Insert"), button:has-text("Add")').last().click();
    } else {
      await page.locator('button:has-text("Paste"), button:has-text("Text")').first().click();
      await page
        .locator('textarea, [contenteditable="true"]')
        .first()
        .fill(source.value);
      await page.locator('button:has-text("Insert"), button:has-text("Add")').last().click();
    }

    await page.waitForTimeout(3000);
    return { ok: true };
  } finally {
    await page.close();
  }
}
