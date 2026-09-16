/* Optional end-to-end test: uses Playwright only as a development dependency. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require(process.env.AFTERLIFE_PLAYWRIGHT_MODULE || "playwright");
const {execFileSync} = require("node:child_process");

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "afterlife-browser-"));
  const root = path.resolve(__dirname, "..");
  const artifact = path.join(directory, "app.html");
  execFileSync(process.env.PYTHON || "python3", ["-m", "afterlife", "examples/task-tracker/app.json",
    "examples/task-tracker/records.json", "-o", artifact], {cwd: root});
  const browser = await chromium.launch({headless: true,
    ...(process.env.AFTERLIFE_CHROMIUM ? {executablePath: process.env.AFTERLIFE_CHROMIUM} : {})});
  try {
    const context = await browser.newContext({acceptDownloads: true, offline: true});
    const page = await context.newPage();
    const errors = [];
    const network = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    page.on("dialog", dialog => dialog.accept());
    await page.goto(pathToFileURL(artifact).href);
    assert.equal(await page.locator("tbody tr").count(), 3);
    await page.getByRole("button", {name: "New task", exact: true}).click();
    const attack = '</script><img src="https://example.invalid/x" onerror="globalThis.pwned=true">';
    await page.getByLabel("Task *", {exact: true}).fill(attack);
    await page.getByLabel("Status *", {exact: true}).selectOption("Planned");
    await page.getByLabel("Notes", {exact: true}).fill("Browser regression record");
    await page.getByLabel("Hours", {exact: true}).fill("7");
    await page.getByRole("button", {name: "Save record", exact: true}).click();
    assert.equal(await page.locator("tbody tr").count(), 4);
    assert.equal(await page.locator("tbody img").count(), 0);
    assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
    await page.reload();
    assert.equal(await page.locator("tbody tr").count(), 4);
    await page.getByRole("searchbox").fill("regression");
    assert.equal(await page.locator("tbody tr").count(), 1);
    await page.getByRole("button", {name: "Edit", exact: true}).click();
    await page.getByLabel("Hours", {exact: true}).fill("8");
    await page.getByRole("button", {name: "Save record", exact: true}).click();
    assert.ok((await page.locator("tbody").innerText()).includes("8"));
    await page.getByRole("button", {name: "Delete", exact: true}).click();
    assert.equal(await page.locator("tbody tr").count(), 0);
    await page.getByRole("button", {name: "Undo delete", exact: true}).click();
    assert.equal(await page.locator("tbody tr").count(), 1);

    const jsonDownload = page.waitForEvent("download");
    await page.getByRole("button", {name: "Export JSON", exact: true}).click();
    const jsonFile = path.join(directory, "export.json");
    await (await jsonDownload).saveAs(jsonFile);
    const exported = JSON.parse(await fs.readFile(jsonFile, "utf8"));
    assert.equal(exported.records.length, 4);
    assert.equal(exported.records.find(record => record.title === attack).hours, 8);

    const htmlDownload = page.waitForEvent("download");
    await page.getByRole("button", {name: "Download app", exact: true}).click();
    const snapshot = path.join(directory, "snapshot.html");
    await (await htmlDownload).saveAs(snapshot);
    // A fresh browser context proves persistence is in the downloaded file.
    const cleanContext = await browser.newContext({offline: true});
    const restored = await cleanContext.newPage();
    restored.on("pageerror", error => errors.push(error.message));
    restored.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    restored.on("dialog", dialog => dialog.accept());
    await restored.goto(pathToFileURL(snapshot).href);
    assert.equal(await restored.locator("tbody tr").count(), 4);
    assert.ok((await restored.locator("tbody").innerText()).includes(attack));

    const invalid = path.join(directory, "invalid.json");
    await fs.writeFile(invalid, JSON.stringify({...exported, app_id: "other"}));
    await restored.locator("#import-file").setInputFiles(invalid);
    await restored.getByText("Import failed:", {exact: false}).waitFor();
    assert.equal(await restored.locator("tbody tr").count(), 4);
    const valid = path.join(directory, "valid.json");
    await fs.writeFile(valid, JSON.stringify({...exported, records: [exported.records[0]]}));
    await restored.locator("#import-file").setInputFiles(valid);
    await restored.getByText("Imported 1 records.", {exact: true}).waitFor();
    assert.equal(await restored.locator("tbody tr").count(), 1);
    await restored.setViewportSize({width: 390, height: 844});
    assert.ok(await restored.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    const deniedContext = await browser.newContext({offline: true, acceptDownloads: true});
    await deniedContext.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {get() { throw new DOMException("Storage denied", "SecurityError"); }});
    });
    const denied = await deniedContext.newPage();
    denied.on("pageerror", error => errors.push(error.message));
    denied.on("dialog", dialog => dialog.accept());
    denied.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await denied.goto(pathToFileURL(artifact).href);
    assert.ok((await denied.locator("#storage-status").innerText()).includes("unavailable"));
    await denied.getByRole("button", {name: "New task", exact: true}).click();
    await denied.getByLabel("Task *", {exact: true}).fill("Survives denied storage");
    await denied.getByLabel("Status *", {exact: true}).selectOption("Planned");
    await denied.getByRole("button", {name: "Save record", exact: true}).click();
    assert.equal(await denied.locator("tbody tr").count(), 4);
    assert.ok((await denied.locator("#storage-status").innerText()).includes("only in memory"));
    const deniedDownload = denied.waitForEvent("download");
    await denied.getByRole("button", {name: "Download app", exact: true}).click();
    const memorySnapshot = path.join(directory, "memory-snapshot.html");
    await (await deniedDownload).saveAs(memorySnapshot);
    const fromMemory = await cleanContext.newPage();
    fromMemory.on("pageerror", error => errors.push(error.message));
    await fromMemory.goto(pathToFileURL(memorySnapshot).href);
    assert.ok((await fromMemory.locator("tbody").innerText()).includes("Survives denied storage"));
    if (process.env.AFTERLIFE_SCREENSHOT) {
      await page.getByRole("searchbox").fill("");
      await page.screenshot({path: process.env.AFTERLIFE_SCREENSHOT, fullPage: true});
    }
    assert.deepEqual(network, []);
    assert.deepEqual(errors, []);
    console.log("PASS: offline create/edit/delete/undo/search, reload, injection safety, JSON export/import, portable HTML reopening, storage-denied recovery, mobile width, no HTTP requests or page errors");
    await deniedContext.close();
    await cleanContext.close();
    await context.close();
  } finally {
    await browser.close();
    await fs.rm(directory, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
