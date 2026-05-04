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

    const input = page.locator('textarea[aria-label="Query box"], textarea.query-box-input').first();
    await input.waitFor({ state: "visible", timeout: 15000 });
    await input.click();
    await input.fill(question);
    const pairCountBefore = await page.locator(".chat-message-pair").count();
    await page.keyboard.press("Enter");

    // Wait for a new chat-message-pair to appear (the user+assistant turn).
    await page
      .waitForFunction(
        (n) => document.querySelectorAll(".chat-message-pair").length > n,
        pairCountBefore,
        { timeout: 30000 },
      )
      .catch(() => {});

    // Poll until the answer has streamed in and stabilized. NotebookLM
    // shows transient loading text ("Reading through pages...", "Thinking...")
    // before the real answer streams. We require:
    //   1. text length > 60 chars (rules out loaders)
    //   2. text doesn't match known loader phrases
    //   3. text is unchanged across ~3 seconds of polling
    const LOADER_RE = /^(reading through|thinking|searching|analyzing|generating|retrieving|loading|preparing)/i;
    let prev = "";
    let stable = 0;
    const start = Date.now();
    while (Date.now() - start < 120000) {
      const text = await page.evaluate(() => {
        const pairs = document.querySelectorAll<HTMLElement>(".chat-message-pair");
        const last = pairs[pairs.length - 1];
        if (!last) return "";
        const userEl = last.querySelector<HTMLElement>(".from-user-message-card-content");
        const userText = (userEl?.innerText ?? "").trim();
        const full = (last.innerText ?? "").trim();
        // The completion action bar (Save to note, thumb_up, thumb_down)
        // appears once streaming finishes — strip it from the answer.
        let body = full.startsWith(userText) ? full.slice(userText.length).trim() : full;
        body = body.replace(/\n*(keep\s+)?Save to note\s*\n?copy_all\s*\n?thumb_up\s*\n?thumb_down[\s\S]*$/i, "").trim();
        return body;
      });
      const isLoader = LOADER_RE.test(text) || text.length < 60;
      if (!isLoader && text && text === prev) {
        stable++;
        if (stable >= 4) return text;
      } else {
        stable = 0;
        prev = text;
      }
      await page.waitForTimeout(800);
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

    // Close this page before renaming — renameNotebook navigates to the
    // home page where the in-line title editor (Edit title) lives. The
    // inline header on the new-notebook screen is blocked by the
    // auto-opened add-source dialog, so doing it via the home card menu
    // is more reliable.
    await page.close();
    if (title) {
      await renameNotebook(id, title);
    }
    return { id, url: `${NOTEBOOKLM_URL}/notebook/${id}`, title };
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
  source: { kind: "url" | "text" | "file"; value: string; title?: string },
): Promise<{ ok: true }> {
  const page = await newPage();
  try {
    // ?addSource=true auto-opens the add-source dialog. Works on both new
    // and existing notebooks, sidestepping the brittle "+" button selector.
    await page.goto(
      `${NOTEBOOKLM_URL}/notebook/${notebookId}?addSource=true`,
      { waitUntil: "domcontentloaded" },
    );
    await ensureLoggedIn(page);

    // Wait for the add-source dialog (distinguished from the always-present
    // emoji-picker dialog by its content).
    const dialog = page
      .locator('[role="dialog"], mat-dialog-container')
      .filter({ hasText: /Audio and Video|websites|drop your files/i })
      .first();
    await dialog.waitFor({ state: "visible", timeout: 15000 });

    if (source.kind === "url") {
      await dialog.locator('button:has-text("Websites")').first().click();
      const urlInput = page
        .locator('textarea[aria-label="Enter URLs"], textarea[placeholder*="links" i]')
        .first();
      await urlInput.waitFor({ state: "visible", timeout: 10000 });
      await urlInput.fill(source.value);
      await page.locator('button:has-text("Insert")').first().click();
    } else if (source.kind === "text") {
      await dialog.locator('button:has-text("Copied text")').first().click();
      const textInput = page.locator('textarea').last();
      await textInput.waitFor({ state: "visible", timeout: 10000 });
      await textInput.fill(source.value);
      await page.locator('button:has-text("Insert")').first().click();
    } else {
      // file: trigger the OS file chooser by clicking "Upload files".
      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10000 }),
        dialog.locator('button:has-text("Upload files")').first().click(),
      ]);
      await fileChooser.setFiles(source.value);
    }

    // Upload/parse takes longer for files than for URLs; give Google time.
    await page.waitForTimeout(source.kind === "file" ? 12000 : 5000);
    return { ok: true };
  } finally {
    await page.close();
  }
}

export async function shareNotebook(
  notebookId: string,
  emails: string[],
  notify: boolean = true,
): Promise<{ ok: true; sharedWith: string[] }> {
  const page = await newPage();
  try {
    await page.goto(`${NOTEBOOKLM_URL}/notebook/${notebookId}`, {
      waitUntil: "domcontentloaded",
    });
    await ensureLoggedIn(page);
    await page.waitForTimeout(5000);

    await page
      .locator('button[aria-label="Share notebook"], button:has-text("Share")')
      .first()
      .click({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const dialog = page.locator('mat-dialog-container, .mat-mdc-dialog-container').first();
    const input = dialog.locator('input[type="text"]').first();
    await input.waitFor({ state: "visible", timeout: 8000 });

    for (const email of emails) {
      await input.fill(email);
      // Pressing Enter or Tab usually commits the chip in Material email pickers.
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
    }

    // The "Notify people" checkbox is on by default. If notify=false, click to uncheck.
    if (!notify) {
      await dialog.locator('input[type="checkbox"]').first().click({ timeout: 3000 }).catch(() => {});
    }

    await dialog
      .locator("button")
      .filter({ hasText: /\bSave\b/ })
      .first()
      .click({ timeout: 5000 });
    await page.waitForTimeout(2000);
    return { ok: true, sharedWith: emails };
  } finally {
    await page.close();
  }
}

// ---- Tier 1 additions: deletes, renames, studio generation ----

async function openSourceMenu(page: Page, sourceIndex: number): Promise<string> {
  await page.waitForSelector(".source-stretched-button", { timeout: 15000 });
  const buttons = page.locator(".source-stretched-button");
  const count = await buttons.count();
  if (sourceIndex < 0 || sourceIndex >= count) {
    throw new Error(`source_index ${sourceIndex} out of range (notebook has ${count} sources)`);
  }
  const title = (await buttons.nth(sourceIndex).getAttribute("aria-label")) ?? "";
  // The "more" button is hidden until row hover; bypass via JS click on the
  // nth source-item-more-button.
  const ok = await page.evaluate((idx) => {
    const moreBtns = document.querySelectorAll<HTMLButtonElement>(
      'button[id^="source-item-more-button-"]',
    );
    if (idx >= moreBtns.length) return false;
    moreBtns[idx].click();
    return true;
  }, sourceIndex);
  if (!ok) throw new Error("could not open source menu");
  await page.waitForTimeout(800);
  return title;
}

export async function deleteSource(
  notebookId: string,
  sourceIndex: number,
): Promise<{ ok: true; deleted: string }> {
  const page = await newPage();
  try {
    await page.goto(`${NOTEBOOKLM_URL}/notebook/${notebookId}`, {
      waitUntil: "domcontentloaded",
    });
    await ensureLoggedIn(page);
    await page.waitForTimeout(4000);

    const title = await openSourceMenu(page, sourceIndex);
    await page
      .locator('[role="menuitem"], .mat-mdc-menu-item')
      .filter({ hasText: /remove source/i })
      .first()
      .click({ timeout: 5000 });

    // Confirm dialog has buttons "Cancel" and "Delete".
    await page
      .locator('[role="dialog"] button, mat-dialog-container button')
      .filter({ hasText: /^\s*Delete\s*$/ })
      .first()
      .click({ timeout: 8000 });
    await page.waitForTimeout(2500);
    return { ok: true, deleted: title };
  } finally {
    await page.close();
  }
}

export async function renameSource(
  notebookId: string,
  sourceIndex: number,
  newTitle: string,
): Promise<{ ok: true }> {
  const page = await newPage();
  try {
    await page.goto(`${NOTEBOOKLM_URL}/notebook/${notebookId}`, {
      waitUntil: "domcontentloaded",
    });
    await ensureLoggedIn(page);
    await page.waitForTimeout(4000);

    await openSourceMenu(page, sourceIndex);
    await page
      .locator('[role="menuitem"], .mat-mdc-menu-item')
      .filter({ hasText: /rename source/i })
      .first()
      .click({ timeout: 5000 });

    // mat-dialog-container is the real dialog; bare [role="dialog"] also
    // matches the persistent (hidden) emoji-picker on notebook pages.
    const input = page.locator('mat-dialog-container input, .mat-mdc-dialog-container input').first();
    await input.waitFor({ state: "visible", timeout: 8000 });
    await input.fill(newTitle);
    await page
      .locator('[role="dialog"] button, mat-dialog-container button')
      .filter({ hasText: /\b(save|rename|confirm|ok)\b/i })
      .first()
      .click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    return { ok: true };
  } finally {
    await page.close();
  }
}

async function openHomeCardMenu(page: Page, notebookId: string): Promise<void> {
  await page.goto(NOTEBOOKLM_URL, { waitUntil: "domcontentloaded" });
  await ensureLoggedIn(page);
  await page.waitForSelector('a[href*="/notebook/"]', { timeout: 15000 });
  const ok = await page.evaluate((id) => {
    // Each notebook card has an anchor /notebook/<id> and a "more" button as
    // a sibling within the card. Walk up from the anchor to the card root,
    // then find the "More" button inside it.
    const anchor = document.querySelector<HTMLAnchorElement>(
      `a[href*="/notebook/${id}"]`,
    );
    if (!anchor) return false;
    let card: HTMLElement | null = anchor;
    for (let i = 0; i < 5 && card; i++) {
      card = card.parentElement;
      if (!card) break;
      const moreBtn = card.querySelector<HTMLButtonElement>(
        'button[aria-label="More" i], button[aria-haspopup="menu"]',
      );
      if (moreBtn) {
        moreBtn.click();
        return true;
      }
    }
    return false;
  }, notebookId);
  if (!ok) throw new Error(`could not find notebook card for ${notebookId}`);
  await page.waitForTimeout(800);
}

export async function deleteNotebook(
  notebookId: string,
): Promise<{ ok: true }> {
  const page = await newPage();
  try {
    await openHomeCardMenu(page, notebookId);
    await page
      .locator('[role="menuitem"], .mat-mdc-menu-item')
      .filter({ hasText: /\bdelete\b/i })
      .first()
      .click({ timeout: 5000 });
    const confirm = page
      .locator('[role="dialog"] button, mat-dialog-container button')
      .filter({ hasText: /^\s*Delete\s*$/ })
      .first();
    await confirm.click({ timeout: 8000 });
    await page.waitForTimeout(2500);
    return { ok: true };
  } finally {
    await page.close();
  }
}

export async function renameNotebook(
  notebookId: string,
  newTitle: string,
): Promise<{ ok: true }> {
  const page = await newPage();
  try {
    await openHomeCardMenu(page, notebookId);
    await page
      .locator('[role="menuitem"], .mat-mdc-menu-item')
      .filter({ hasText: /edit title/i })
      .first()
      .click({ timeout: 5000 });
    // mat-dialog-container is the real dialog; bare [role="dialog"] also
    // matches the persistent (hidden) emoji-picker on notebook pages.
    const input = page.locator('mat-dialog-container input, .mat-mdc-dialog-container input').first();
    await input.waitFor({ state: "visible", timeout: 8000 });
    await input.fill(newTitle);
    await page
      .locator('[role="dialog"] button, mat-dialog-container button')
      .filter({ hasText: /\b(save|rename|confirm|ok)\b/i })
      .first()
      .click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    return { ok: true };
  } finally {
    await page.close();
  }
}

// Map artifact icon glyph (Material Symbols name) to a friendly type label.
const ICON_TO_TYPE: Record<string, string> = {
  subscriptions: "Video Overview",
  audio_magic_eraser: "Audio Overview",
  flowchart: "Mind Map",
  auto_tab_group: "Report",
  table_view: "Data Table",
  tablet: "Slide Deck",
  cards_star: "Flashcards",
  quiz: "Quiz",
  stacked_bar_chart: "Infographic",
  sticky_note_2: "Note",
};

export type ArtifactSummary = {
  index: number;
  title: string;
  type: string;
  details: string;
};

export async function listArtifacts(
  notebookId: string,
): Promise<ArtifactSummary[]> {
  const page = await newPage();
  try {
    await page.goto(`${NOTEBOOKLM_URL}/notebook/${notebookId}`, {
      waitUntil: "domcontentloaded",
    });
    await ensureLoggedIn(page);
    await page.waitForTimeout(5000);

    return await page.evaluate((iconMap) => {
      return Array.from(
        document.querySelectorAll<HTMLElement>(".artifact-item-button"),
      ).map((el, i) => {
        const icon = el.querySelector<HTMLElement>(".artifact-icon")?.innerText.trim() ?? "";
        const title = el.querySelector<HTMLElement>(".artifact-title")?.innerText.trim() ?? "";
        const details = el.querySelector<HTMLElement>(".artifact-details")?.innerText.trim() ?? "";
        return {
          index: i,
          title,
          type: iconMap[icon] ?? icon,
          details,
        };
      });
    }, ICON_TO_TYPE);
  } finally {
    await page.close();
  }
}

async function openArtifactMenu(page: Page, artifactIndex: number): Promise<void> {
  await page.waitForSelector(".artifact-item-button", { timeout: 15000 });
  const item = page.locator(".artifact-item-button").nth(artifactIndex);
  await item.scrollIntoViewIfNeeded();
  await item.hover();
  await item.locator('button[aria-label="More"]').click({ timeout: 5000 });
  await page.waitForTimeout(800);
}

export async function downloadArtifact(
  notebookId: string,
  artifactIndex: number,
  savePath?: string,
): Promise<{ ok: true; path: string; filename: string }> {
  const page = await newPage();
  try {
    await page.goto(`${NOTEBOOKLM_URL}/notebook/${notebookId}`, {
      waitUntil: "domcontentloaded",
    });
    await ensureLoggedIn(page);
    await page.waitForTimeout(5000);

    await openArtifactMenu(page, artifactIndex);

    const downloadItem = page
      .locator('[role="menuitem"], .mat-mdc-menu-item')
      .filter({ hasText: /\bdownload\b/i })
      .first();
    if ((await downloadItem.count()) === 0) {
      throw new Error(
        "This artifact type has no Download option (Mind Maps, Reports, Slide Decks export to Google Workspace instead).",
      );
    }
    const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
    await downloadItem.click({ timeout: 5000 });
    const download = await downloadPromise;

    const filename = download.suggestedFilename();
    const target = savePath ?? join(homedir(), "Downloads", filename);
    await download.saveAs(target);
    return { ok: true, path: target, filename };
  } finally {
    await page.close();
  }
}

export async function deleteArtifact(
  notebookId: string,
  artifactIndex: number,
): Promise<{ ok: true }> {
  const page = await newPage();
  try {
    await page.goto(`${NOTEBOOKLM_URL}/notebook/${notebookId}`, {
      waitUntil: "domcontentloaded",
    });
    await ensureLoggedIn(page);
    await page.waitForTimeout(5000);

    await openArtifactMenu(page, artifactIndex);
    await page
      .locator('[role="menuitem"], .mat-mdc-menu-item')
      .filter({ hasText: /delete/i })
      .first()
      .click({ timeout: 5000 });
    await page
      .locator('mat-dialog-container button, .mat-mdc-dialog-container button')
      .filter({ hasText: /^\s*Delete\s*$/ })
      .first()
      .click({ timeout: 8000 });
    await page.waitForTimeout(2000);
    return { ok: true };
  } finally {
    await page.close();
  }
}

export const STUDIO_TYPES = [
  "Audio Overview",
  "Slide Deck",
  "Video Overview",
  "Mind Map",
  "Reports",
  "Flashcards",
  "Quiz",
  "Infographic",
  "Data Table",
] as const;
export type StudioType = (typeof STUDIO_TYPES)[number];

export async function generateStudio(
  notebookId: string,
  type: StudioType,
): Promise<{ ok: true; type: StudioType; note: string }> {
  const page = await newPage();
  try {
    await page.goto(`${NOTEBOOKLM_URL}/notebook/${notebookId}`, {
      waitUntil: "domcontentloaded",
    });
    await ensureLoggedIn(page);
    await page.waitForTimeout(5000);

    // Each studio artifact card is a div with role/aria-label = type.
    const card = page
      .locator(`.create-artifact-button-container[aria-label="${type}"]`)
      .first();
    await card.waitFor({ state: "visible", timeout: 10000 });
    await card.click();

    // Generation runs server-side and takes anywhere from 30s (mind map)
    // to 5+ minutes (audio). We don't wait for completion — clients should
    // re-check in NotebookLM directly. Return immediately after triggering.
    await page.waitForTimeout(2000);
    return {
      ok: true,
      type,
      note: "Generation triggered. Check the notebook's studio panel in NotebookLM — audio overviews can take several minutes.",
    };
  } finally {
    await page.close();
  }
}
