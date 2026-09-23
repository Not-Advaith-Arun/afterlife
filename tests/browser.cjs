/* Optional end-to-end test: uses Playwright only as a development dependency. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {launch, offlineContext} = require("./browser_support.cjs");
const {execFileSync} = require("node:child_process");

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "afterlife-browser-"));
  const root = path.resolve(__dirname, "..");
  const artifact = path.join(directory, "app.html");
  execFileSync(process.env.PYTHON || "python3", ["-m", "afterlife", "examples/task-tracker/app.json",
    "examples/task-tracker/records.json", "-o", artifact], {cwd: root});
  const browser = await launch();
  try {
    const context = await offlineContext(browser, {acceptDownloads: true, offline: true});
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
    const formulaNotes = '=HYPERLINK("https://example.invalid/","regression")\n=1+1';
    await page.getByLabel("Notes", {exact: true}).fill(formulaNotes);
    await page.getByLabel("Hours", {exact: true}).fill("7");
    await page.getByRole("button", {name: "Save record", exact: true}).click();
    await page.locator("aside.editor").waitFor({state: "hidden"});
    assert.equal(await page.locator("tbody tr").count(), 4);
    assert.equal(await page.locator("tbody img").count(), 0);
    assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
    await page.reload();
    assert.equal(await page.locator("tbody tr").count(), 4);
    await page.getByRole("searchbox").fill("regression");
    assert.equal(await page.locator("tbody tr").count(), 1);
    await page.getByRole("button", {name: "Edit", exact: true}).click();
    const numericStorageKey = await page.evaluate(() => JSON.parse(document.querySelector("#afterlife-data").textContent).storage_key);
    const beforeNumeric = await page.evaluate(key => localStorage.getItem(key), numericStorageKey);
    for (const inexact of ["1.0000000000000001", "9007199254740991.1", "1e-9999"]) {
      await page.getByLabel("Hours", {exact: true}).fill(inexact);
      await page.getByRole("button", {name: "Save record", exact: true}).click();
      await page.waitForFunction(() => !document.querySelector('aside.editor button[type="submit"]').disabled);
      assert.equal(await page.locator("aside.editor").isVisible(), true, `Fractional input silently saved: ${inexact}`);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), numericStorageKey), beforeNumeric);
    }
    const exactIntegers = [["-9007199254740991", -9007199254740991], ["9007199254740991.0", 9007199254740991],
      ["80e-1", 8], ["0e-9999", 0], ["8e0", 8]];
    for (const [index, [text, expected]] of exactIntegers.entries()) {
      await page.getByLabel("Hours", {exact: true}).fill(text);
      await page.getByRole("button", {name: "Save record", exact: true}).click();
      await page.locator("aside.editor").waitFor({state: "hidden"});
      const savedHours = await page.evaluate(({key, title}) =>
        JSON.parse(localStorage.getItem(key)).records.find(record => record.title === title).hours,
        {key: numericStorageKey, title: attack});
      assert.equal(savedHours, expected, `Exact integer changed meaning: ${text}`);
      if (index + 1 < exactIntegers.length) await page.getByRole("button", {name: "Edit", exact: true}).click();
    }
    assert.ok((await page.locator("tbody").innerText()).includes("8"));
    await page.getByRole("button", {name: "Delete", exact: true}).click();
    await page.getByText("Record deleted. Undo is available until the next import or reload.", {exact: true}).waitFor();
    assert.equal(await page.locator("tbody tr").count(), 0);
    await page.getByRole("button", {name: "Undo delete", exact: true}).click();
    await page.getByText("Deleted record restored.", {exact: true}).waitFor();
    assert.equal(await page.locator("tbody tr").count(), 1);

    const jsonDownload = page.waitForEvent("download");
    await page.getByRole("button", {name: "Export JSON", exact: true}).click();
    const jsonFile = path.join(directory, "export.json");
    await (await jsonDownload).saveAs(jsonFile);
    const exported = JSON.parse(await fs.readFile(jsonFile, "utf8"));
    assert.equal(exported.records.length, 4);
    assert.equal(exported.records.find(record => record.title === attack).hours, 8);
    assert.equal(exported.records.find(record => record.title === attack).notes, formulaNotes);
    // Exercise the actual toolbar/download boundary, not only the CSV helper.
    const csvDownload = page.waitForEvent("download");
    await page.getByRole("button", {name: "Export CSV", exact: true}).click();
    const csvFile = path.join(directory, "literal-text.csv");
    await (await csvDownload).saveAs(csvFile);
    const csvRows = JSON.parse(execFileSync(process.env.PYTHON || "python3", ["-c",
      "import csv,io,json,sys; print(json.dumps(list(csv.reader(io.StringIO(sys.stdin.read())))))"],
      {input: await fs.readFile(csvFile, "utf8"), encoding: "utf8"}));
    const header = csvRows[0], titleIndex = header.indexOf("title"), notesIndex = header.indexOf("notes");
    const csvRecord = csvRows.slice(1).find(row => row[titleIndex] === "'" + attack);
    assert.equal(csvRows.length, 5); // Export all records even though the table is filtered to one.
    assert.equal(csvRecord[notesIndex], "'" + formulaNotes);
    assert.equal(csvRecord[header.indexOf("hours")], "8");
    assert.ok(csvRows.every(row => row.length === header.length));
    assert.equal(await page.locator("tbody tr").count(), 1);

    const htmlDownload = page.waitForEvent("download");
    await page.getByRole("button", {name: "Download app", exact: true}).click();
    const snapshot = path.join(directory, "snapshot.html");
    await (await htmlDownload).saveAs(snapshot);
    // A fresh browser context proves persistence is in the downloaded file.
    const cleanContext = await offlineContext(browser, {offline: true});
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
    const precisionBackup = path.join(directory, "inexact-number.json");
    const precisionData = JSON.parse(JSON.stringify(exported));
    precisionData.records[0].hours = 87654321;
    const restoredStorageKey = await restored.evaluate(() => JSON.parse(document.querySelector("#afterlife-data").textContent).storage_key);
    const beforePrecisionImport = await restored.evaluate(key => localStorage.getItem(key), restoredStorageKey);
    for (const rawNumber of ["1.0000000000000001", "9007199254740991.1", "1e-9999"]) {
      await fs.writeFile(precisionBackup, JSON.stringify(precisionData).replace('"hours":87654321', '"hours":' + rawNumber));
      await restored.locator("#import-file").setInputFiles(precisionBackup);
      await restored.getByText("JSON numbers must be exact safe integers.", {exact: false}).waitFor({timeout: 2000});
      assert.equal(await restored.getByRole("heading", {name: "Review import", exact: true}).isVisible(), false);
      assert.equal(await restored.locator("tbody tr").count(), 4);
      assert.equal(await restored.evaluate(key => localStorage.getItem(key), restoredStorageKey), beforePrecisionImport);
    }
    const editedBackup = path.join(directory, "edited-backup.json");
    const duplicateBackup = path.join(directory, "duplicate-keys.json");
    const ordinaryBackup = JSON.stringify(exported);
    const duplicates = [ordinaryBackup.replace('"records":[', '"records":[],"records":['),
      ordinaryBackup.replace('"title":', '"title":"overwritten","title":'),
      ordinaryBackup.replace('"title":', '"\\u0074itle":"overwritten","title":')];
    for (const raw of duplicates) {
      await fs.writeFile(duplicateBackup, raw);
      await restored.locator("#import-file").setInputFiles(duplicateBackup);
      await restored.getByText("Duplicate JSON key.", {exact: false}).waitFor({timeout: 2000});
      assert.equal(await restored.getByRole("heading", {name: "Review import", exact: true}).isVisible(), false);
      assert.equal(await restored.locator("tbody tr").count(), 4);
      assert.equal(await restored.evaluate(key => localStorage.getItem(key), restoredStorageKey), beforePrecisionImport);
    }
    const edited = JSON.parse(JSON.stringify(exported));
    edited.records[0].hours += 1;
    edited.records[0].notes = "Private incoming review detail";
    await fs.writeFile(editedBackup, JSON.stringify(edited));
    await restored.locator("#import-file").setInputFiles(editedBackup);
    await restored.getByRole("heading", {name: "Review import", exact: true}).waitFor();
    const changedReview = restored.getByRole("region", {name: "Import review"});
    assert.match(await changedReview.innerText(), /0 added, 0 removed, 1 changed, 3 unchanged/);
    await changedReview.getByText("Review affected record IDs", {exact: true}).click();
    const details = JSON.parse(await changedReview.locator("pre").innerText());
    assert.deepEqual(details.changed_fields, [{id: edited.records[0].id, fields: ["hours", "notes"]}]);
    assert.doesNotMatch(await changedReview.innerText(), /Private incoming review detail/);
    const reviewDownload = restored.waitForEvent("download");
    await changedReview.getByRole("button", {name: "Export review JSON", exact: true}).click();
    const reviewFile = path.join(directory, "import-review.json");
    await (await reviewDownload).saveAs(reviewFile);
    const reviewJSON = await fs.readFile(reviewFile, "utf8");
    const review = JSON.parse(reviewJSON);
    assert.equal(review.format, "afterlife-import-summary/v1");
    assert.equal(review.app_id, exported.app_id);
    assert.equal(review.spec_fingerprint, exported.spec_fingerprint);
    assert.deepEqual(review.counts, {current: 4, incoming: 4, added: 0, removed: 0, changed: 1, unchanged: 3});
    assert.deepEqual(review.changed_fields, details.changed_fields);
    assert.equal(review.retained_order_changed, false);
    assert.doesNotMatch(reviewJSON, /Private incoming review detail/);
    assert.equal(Object.hasOwn(review, "records"), false);
    assert.equal(await restored.locator("tbody tr").count(), 4);
    await restored.getByRole("button", {name: "Cancel import", exact: true}).click();
    await restored.reload();
    assert.doesNotMatch(await restored.locator("tbody").innerText(), /Private incoming review detail/);
    const reversed = path.join(directory, "reversed.json");
    await fs.writeFile(reversed, JSON.stringify({...exported, records: [...exported.records].reverse()}));
    const originalOrder = await restored.locator("tbody tr").allTextContents();
    await restored.locator("#import-file").setInputFiles(reversed);
    await restored.getByRole("heading", {name: "Review import", exact: true}).waitFor();
    const orderReview = restored.getByRole("region", {name: "Import review"});
    assert.match(await orderReview.innerText(), /0 added, 0 removed, 0 changed, 4 unchanged/);
    assert.match(await orderReview.innerText(), /Retained record order will change/);
    assert.deepEqual(await restored.locator("tbody tr").allTextContents(), originalOrder);
    await restored.getByRole("button", {name: "Cancel import", exact: true}).click();
    await restored.reload();
    assert.deepEqual(await restored.locator("tbody tr").allTextContents(), originalOrder);
    await restored.locator("#import-file").setInputFiles(reversed);
    await restored.getByRole("heading", {name: "Review import", exact: true}).waitFor();
    await restored.getByRole("button", {name: "Apply import", exact: true}).click();
    await restored.getByText("Imported 4 records.", {exact: true}).waitFor();
    await restored.reload();
    assert.deepEqual(await restored.locator("tbody tr").allTextContents(), [...originalOrder].reverse());

    const valid = path.join(directory, "valid.json");
    await fs.writeFile(valid, JSON.stringify({...exported, records: [exported.records[0]]}));
    await restored.locator("#import-file").setInputFiles(valid);
    await restored.getByRole("heading", {name: "Review import", exact: true}).waitFor();
    assert.equal(await restored.locator("tbody tr").count(), 4);
    assert.match(await restored.getByRole("region", {name: "Import review"}).innerText(), /0 added, 3 removed, 0 changed, 1 unchanged/);
    assert.doesNotMatch(await restored.getByRole("region", {name: "Import review"}).innerText(), /Retained record order will change/);
    await restored.getByRole("button", {name: "Cancel import", exact: true}).click();
    await restored.getByText("Import cancelled. Current records kept.", {exact: true}).waitFor();
    await restored.reload();
    assert.equal(await restored.locator("tbody tr").count(), 4);

    await restored.locator("#import-file").setInputFiles(valid);
    await restored.getByRole("heading", {name: "Review import", exact: true}).waitFor();
    await restored.locator("tbody tr").first().getByRole("button", {name: "Edit", exact: true}).click();
    await restored.getByLabel("Hours", {exact: true}).fill("11");
    await restored.getByRole("button", {name: "Save record", exact: true}).click();
    await restored.locator("aside.editor").waitFor({state: "hidden"});
    const noStaleDownload = restored.waitForEvent("download", {timeout: 300}).then(() => false, () => true);
    await restored.getByRole("button", {name: "Export review JSON", exact: true}).click();
    await restored.getByText("Review is stale.", {exact: false}).waitFor();
    assert.equal(await noStaleDownload, true);
    await restored.getByRole("button", {name: "Apply import", exact: true}).click();
    await restored.getByText("Records changed after this preview.", {exact: false}).waitFor();
    assert.equal(await restored.locator("tbody tr").count(), 4);
    assert.match(await restored.locator("tbody tr").first().innerText(), /11/);
    await restored.reload();
    assert.equal(await restored.locator("tbody tr").count(), 4);
    assert.match(await restored.locator("tbody tr").first().innerText(), /11/);

    await restored.getByRole("button", {name: "New task", exact: true}).click();
    await restored.getByLabel("Task *", {exact: true}).fill("Keep this unsaved draft");
    await restored.locator("#import-file").setInputFiles(valid);
    await restored.getByRole("heading", {name: "Review import", exact: true}).waitFor();
    restored.removeAllListeners("dialog");
    const rejectedConfirmation = restored.waitForEvent("dialog");
    const rejectedApply = restored.getByRole("button", {name: "Apply import", exact: true}).click();
    const confirmation = await rejectedConfirmation;
    assert.equal(confirmation.type(), "confirm");
    assert.match(confirmation.message(), /Discard unsaved editor changes/);
    await confirmation.dismiss();
    await rejectedApply;
    assert.equal(await restored.getByLabel("Task *", {exact: true}).inputValue(), "Keep this unsaved draft");
    assert.equal(await restored.locator("tbody tr").count(), 4);
    await restored.getByRole("button", {name: "Cancel import", exact: true}).click();
    assert.equal(await restored.getByLabel("Task *", {exact: true}).inputValue(), "Keep this unsaved draft");
    restored.on("dialog", dialog => dialog.accept());
    await restored.locator("#import-file").setInputFiles(valid);
    await restored.getByRole("heading", {name: "Review import", exact: true}).waitFor();
    await restored.getByRole("button", {name: "Apply import", exact: true}).click();
    await restored.getByText("Imported 1 records.", {exact: true}).waitFor();
    await restored.locator("aside.editor").waitFor({state: "hidden"});
    await restored.reload();
    assert.equal(await restored.locator("tbody tr").count(), 1);
    await restored.setViewportSize({width: 390, height: 844});
    assert.ok(await restored.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    const deniedContext = await offlineContext(browser, {offline: true, acceptDownloads: true});
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
    await denied.locator("aside.editor").waitFor({state: "hidden"});
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
    const precisionContext = await offlineContext(browser, {offline: true});
    const precisionStored = await precisionContext.newPage();
    precisionStored.on("pageerror", error => errors.push(error.message));
    const rawPrecision = JSON.stringify(precisionData).replace('"hours":87654321', '"hours":1.0000000000000001');
    await precisionStored.addInitScript(({key, raw}) => localStorage.setItem(key, raw),
      {key: numericStorageKey, raw: rawPrecision});
    await precisionStored.goto(pathToFileURL(artifact).href);
    assert.match(await precisionStored.locator("#storage-status").innerText(), /Browser storage is unavailable or invalid\./);
    assert.equal(await precisionStored.locator("tbody tr").count(), 3);
    assert.equal(await precisionStored.evaluate(key => localStorage.getItem(key), numericStorageKey), rawPrecision);
    await precisionContext.close();
    const quotaContext = await offlineContext(browser, {offline: true, acceptDownloads: true});
    const quota = await quotaContext.newPage();
    quota.on("pageerror", error => errors.push(error.message));
    quota.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await quota.goto(pathToFileURL(artifact).href);
    await quota.getByRole("button", {name: "New task", exact: true}).click();
    await quota.getByLabel("Task *", {exact: true}).fill("Persisted before quota");
    await quota.getByLabel("Status *", {exact: true}).selectOption("Planned");
    await quota.getByRole("button", {name: "Save record", exact: true}).click();
    await quota.locator("aside.editor").waitFor({state: "hidden"});
    const storageKey = await quota.evaluate(() => JSON.parse(document.querySelector("#afterlife-data").textContent).storage_key);
    const beforeQuota = await quota.evaluate(key => localStorage.getItem(key), storageKey);
    assert.match(beforeQuota, /Persisted before quota/);
    await quota.evaluate(() => {
      Storage.prototype.setItem = function () { throw new DOMException("Synthetic quota boundary", "QuotaExceededError"); };
    });
    await quota.getByRole("button", {name: "New task", exact: true}).click();
    await quota.getByLabel("Task *", {exact: true}).fill("Recover this quota edit");
    await quota.getByLabel("Status *", {exact: true}).selectOption("Planned");
    await quota.getByRole("button", {name: "Save record", exact: true}).click();
    await quota.locator("aside.editor").waitFor({state: "hidden"});
    await quota.getByText("Browser storage is full.", {exact: false}).waitFor();
    assert.equal(await quota.locator("tbody tr").count(), 5);
    assert.equal(await quota.evaluate(key => localStorage.getItem(key), storageKey), beforeQuota);
    const quotaDownload = quota.waitForEvent("download");
    await quota.getByRole("button", {name: "Export JSON", exact: true}).click();
    const quotaFile = path.join(directory, "quota-recovery.json");
    await (await quotaDownload).saveAs(quotaFile);
    const rescued = JSON.parse(await fs.readFile(quotaFile, "utf8"));
    assert.equal(rescued.records.length, 5);
    assert.ok(rescued.records.some(row => row.title === "Recover this quota edit"));
    await quota.reload();
    assert.equal(await quota.locator("tbody tr").count(), 4);
    assert.doesNotMatch(await quota.locator("tbody").innerText(), /Recover this quota edit/);
    assert.equal(await quota.evaluate(key => localStorage.getItem(key), storageKey), beforeQuota);
    await quotaContext.close();
    // Actual maximum-size collection: rejecting a duplicate must retain the
    // saved data and editable draft; freeing one slot permits a safe retry.
    const capacityInput = path.join(directory, "capacity.json"), capacityArtifact = path.join(directory, "capacity.html");
    await fs.writeFile(capacityInput, JSON.stringify({records: Array.from({length: 10000}, (_, index) =>
      ({id: `capacity-${index}`, title: `Capacity record ${index}`, status: "Planned"}))}));
    execFileSync(process.env.PYTHON || "python3", ["-m", "afterlife", "examples/task-tracker/app.json", capacityInput,
      "-o", capacityArtifact], {cwd: root});
    const capacityContext = await offlineContext(browser, {acceptDownloads: true, offline: true});
    const capacity = await capacityContext.newPage();
    capacity.on("pageerror", error => errors.push(error.message));
    capacity.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    capacity.on("dialog", dialog => dialog.accept());
    await capacity.goto(pathToFileURL(capacityArtifact).href);
    assert.equal(await capacity.locator("tbody tr").count(), 100);
    await capacity.locator('tr[data-record-id="capacity-0"]').getByRole("button", {name: "Edit", exact: true}).click();
    await capacity.locator("#field-title").fill("Retained capacity source");
    await capacity.getByRole("button", {name: "Save record", exact: true}).click();
    await capacity.locator("aside.editor").waitFor({state: "hidden"});
    const capacityKey = await capacity.evaluate(() => JSON.parse(document.querySelector("#afterlife-data").textContent).storage_key);
    const retainedCapacity = await capacity.evaluate(key => localStorage.getItem(key), capacityKey);
    assert.equal(JSON.parse(retainedCapacity).records.length, 10000);
    await capacity.locator('tr[data-record-id="capacity-0"]').getByRole("button", {name: "Duplicate", exact: true}).click();
    await capacity.locator("#field-title").fill("Rejected overflow draft");
    await capacity.getByRole("button", {name: "Save record", exact: true}).click();
    await capacity.locator("#message").filter({hasText: "Expected at most 10,000 records."}).waitFor();
    assert.equal(await capacity.locator("aside.editor").isVisible(), true);
    assert.equal(await capacity.locator("#field-title").inputValue(), "Rejected overflow draft");
    assert.equal(await capacity.evaluate(key => localStorage.getItem(key), capacityKey), retainedCapacity);
    const capacityDownload = capacity.waitForEvent("download");
    await capacity.getByRole("button", {name: "Export JSON", exact: true}).click();
    const capacityExport = path.join(directory, "retained-capacity.json");
    await (await capacityDownload).saveAs(capacityExport);
    const capacityRecords = JSON.parse(await fs.readFile(capacityExport, "utf8")).records;
    assert.equal(capacityRecords.length, 10000);
    assert.equal(capacityRecords.some(row => row.title === "Rejected overflow draft"), false);
    await capacity.getByRole("button", {name: "Cancel", exact: true}).click();
    await capacity.getByRole("searchbox").fill("Capacity record 9999");
    await capacity.getByRole("button", {name: "Delete", exact: true}).click();
    await capacity.getByText("Record deleted. Undo is available until the next import or reload.", {exact: true}).waitFor();
    await capacity.getByRole("searchbox").fill("");
    await capacity.locator('tr[data-record-id="capacity-0"]').getByRole("button", {name: "Duplicate", exact: true}).click();
    await capacity.locator("#field-title").fill("Fits after freeing one slot");
    await capacity.getByRole("button", {name: "Save record", exact: true}).click();
    await capacity.locator("aside.editor").waitFor({state: "hidden"});
    const fullAgain = JSON.parse(await capacity.evaluate(key => localStorage.getItem(key), capacityKey)).records;
    assert.equal(fullAgain.length, 10000);
    assert.equal(fullAgain.find(row => row.id === "capacity-0").title, "Retained capacity source");
    assert.notEqual(fullAgain.find(row => row.title === "Fits after freeing one slot").id, "capacity-0");
    await capacity.reload();
    await capacity.getByRole("searchbox").fill("Fits after freeing one slot");
    assert.equal(await capacity.locator("tbody tr").count(), 1);
    await capacityContext.close();
    assert.deepEqual(network, []);
    assert.deepEqual(errors, []);
    console.log("PASS: offline create/edit/delete/undo/search, reload, injection safety, JSON export/reviewed import with cancel/stale guards, portable HTML reopening, storage-denied recovery, mobile width, actual 10000-record capacity rejection/recovery, no HTTP requests or page errors");
    await deniedContext.close();
    await cleanContext.close();
    await context.close();
  } finally {
    await browser.close();
    await fs.rm(directory, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
