/* Compare actual offline form operations with independent Python applications. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {execFileSync} = require("node:child_process");
const {chromium} = require(process.env.AFTERLIFE_PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "afterlife-source-browser-"));
  const root = path.resolve(__dirname, "..");
  const python = process.env.PYTHON || "python3";
  const browser = await chromium.launch({headless: true,
    ...(process.env.AFTERLIFE_CHROMIUM ? {executablePath: process.env.AFTERLIFE_CHROMIUM} : {})});
  const network = [], errors = [];
  try {
    for (const fixture of [
      {directory: "python-tracker", label: "task", text: "title", number: "priority", checkbox: "done", checked: false, defaultText: "Untitled task", defaultNumber: 2, seed: "task-2"},
      {directory: "python-equipment", label: "equipment", text: "name", number: "quantity", checkbox: "available", checked: true, defaultText: "Unlabeled equipment", defaultNumber: 1, seed: "equipment-2"},
    ]) {
      const source = path.join(root, "examples", fixture.directory);
      const artifact = path.join(directory, `${fixture.directory}.html`);
      execFileSync(python, ["-m", "afterlife", "from-python", path.join(source, "model.py"), path.join(source, "records.json"), "-o", artifact], {cwd: root});
      const context = await browser.newContext({offline: true, acceptDownloads: true});
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
      page.on("dialog", dialog => dialog.accept());
      await page.goto(pathToFileURL(artifact).href);
      let count = 0;
      const exported = async () => {
        const download = page.waitForEvent("download");
        await page.getByRole("button", {name: "Export JSON", exact: true}).click();
        const target = path.join(directory, `${fixture.directory}-${count++}.json`);
        await (await download).saveAs(target);
        return JSON.parse(await fs.readFile(target, "utf8")).records;
      };
      const initial = await exported();
      const operations = [], outcomes = [];
      await page.getByRole("button", {name: `New ${fixture.label}`, exact: true}).click();
      assert.equal(await page.locator(`#field-${fixture.text}`).inputValue(), fixture.defaultText);
      assert.equal(await page.locator(`#field-${fixture.number}`).inputValue(), String(fixture.defaultNumber));
      assert.equal(await page.locator(`#field-${fixture.checkbox}`).isChecked(), fixture.checked);
      await page.getByRole("button", {name: "Save record", exact: true}).click();
      let records = await exported();
      const id = records[records.length - 1].id;
      operations.push({op: "create", record: {id}});
      outcomes.push({ok: true, records});
      await page.locator(`[data-record-id="${id}"]`).getByRole("button", {name: "Edit", exact: true}).click();
      await page.locator(`#field-${fixture.number}`).fill("");
      await page.getByRole("button", {name: "Save record", exact: true}).click();
      assert.ok((await page.locator("#message").innerText()).includes("required"));
      operations.push({op: "edit", id, changes: {[fixture.number]: null}});
      outcomes.push({ok: false, records: await exported()});
      const attack = '</script><img src="https://example.invalid" onerror="globalThis.pwned=true">';
      await page.locator(`#field-${fixture.number}`).fill("0");
      await page.locator(`#field-${fixture.text}`).fill(attack);
      await page.getByRole("button", {name: "Save record", exact: true}).click();
      assert.equal(await page.locator("tbody img").count(), 0);
      assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
      operations.push({op: "edit", id, changes: {[fixture.number]: 0, [fixture.text]: attack}});
      outcomes.push({ok: true, records: await exported()});
      await page.locator(`[data-record-id="${fixture.seed}"]`).getByRole("button", {name: "Delete", exact: true}).click();
      operations.push({op: "delete", id: fixture.seed});
      outcomes.push({ok: true, records: await exported()});
      const traceFile = path.join(directory, `${fixture.directory}-trace.json`);
      await fs.writeFile(traceFile, JSON.stringify({format: "afterlife-trace/v1", operations}));
      const original = JSON.parse(execFileSync(python, [path.join(source, "app.py"), traceFile], {encoding: "utf8"}));
      assert.deepEqual({initial, outcomes}, original);
      const download = page.waitForEvent("download");
      await page.getByRole("button", {name: "Download app", exact: true}).click();
      const snapshot = path.join(directory, `${fixture.directory}-saved.html`);
      await (await download).saveAs(snapshot);
      const freshContext = await browser.newContext({offline: true});
      const restored = await freshContext.newPage();
      restored.on("pageerror", error => errors.push(error.message));
      restored.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
      await restored.goto(pathToFileURL(snapshot).href);
      assert.equal(await restored.locator("tbody tr").count(), 2);
      assert.ok((await restored.locator("tbody").innerText()).includes(attack));
      if (process.env.AFTERLIFE_SOURCE_SCREENSHOT && fixture.directory === "python-equipment") {
        await restored.screenshot({path: process.env.AFTERLIFE_SOURCE_SCREENSHOT, fullPage: true});
      }
      await freshContext.close();
      await context.close();
      console.log(`PASS ${fixture.directory}: offline browser create/defaults, invalid edit atomicity, valid edit, delete match original Python app; portable HTML restores in fresh context`);
    }
    // HTML text inputs erase newlines, while textareas normalize CR/CRLF to LF.
    // Neither may change an untouched supported Python string during form save.
    const textModel = path.join(directory, "text-model.py");
    const textData = path.join(directory, "text-records.json");
    const textArtifact = path.join(directory, "text.html");
    const originalText = "first\r\nsecond\rthird\nfourth\t😀";
    await fs.writeFile(textModel, 'from dataclasses import dataclass\n@dataclass\nclass Note:\n    id: str\n    body: str = "first\\r\\nsecond\\rthird\\nfourth\\t😀"\n    count: int = 1\n');
    await fs.writeFile(textData, JSON.stringify({records: [{id: "seed", body: originalText, count: 1}]}));
    execFileSync(python, ["-m", "afterlife", "from-python", textModel, textData, "-o", textArtifact], {cwd: root});
    const textContext = await browser.newContext({offline: true, acceptDownloads: true});
    const textPage = await textContext.newPage();
    textPage.on("pageerror", error => errors.push(error.message));
    textPage.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await textPage.goto(pathToFileURL(textArtifact).href);
    await textPage.getByRole("button", {name: "New note", exact: true}).click();
    assert.equal(await textPage.locator("#field-body").evaluate(element => element.tagName), "TEXTAREA");
    assert.equal(await textPage.locator("#field-body").inputValue(), originalText.replace(/\r\n?/g, "\n"));
    await textPage.getByRole("button", {name: "Save record", exact: true}).click();
    await textPage.locator('[data-record-id="seed"]').getByRole("button", {name: "Edit", exact: true}).click();
    await textPage.locator("#field-count").fill("2");
    await textPage.getByRole("button", {name: "Save record", exact: true}).click();
    const textDownload = textPage.waitForEvent("download");
    await textPage.getByRole("button", {name: "Export JSON", exact: true}).click();
    const textExport = path.join(directory, "text-export.json");
    await (await textDownload).saveAs(textExport);
    const textRecords = JSON.parse(await fs.readFile(textExport, "utf8")).records;
    assert.equal(textRecords.length, 2);
    assert.equal(textRecords[0].body, originalText);
    assert.equal(textRecords[0].count, 2);
    assert.equal(textRecords[1].body, originalText);
    assert.equal(textRecords[1].count, 1);
    await textPage.locator('[data-record-id="seed"]').getByRole("button", {name: "Edit", exact: true}).click();
    await textPage.locator("#field-body").fill("new\nmultiline\ntext");
    await textPage.getByRole("button", {name: "Save record", exact: true}).click();
    const editedDownload = textPage.waitForEvent("download");
    await textPage.getByRole("button", {name: "Export JSON", exact: true}).click();
    await (await editedDownload).saveAs(textExport);
    assert.equal(JSON.parse(await fs.readFile(textExport, "utf8")).records[0].body, "new\nmultiline\ntext");
    await textContext.close();
    console.log("PASS text preservation: LF/CR/CRLF defaults and existing strings survive unrelated form edits; new multiline content remains editable");
    assert.deepEqual(network, []);
    assert.deepEqual(errors, []);
    console.log("PASS: both source-derived artifacts made no HTTP requests and produced no page errors");
  } finally {
    await browser.close();
    await fs.rm(directory, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
