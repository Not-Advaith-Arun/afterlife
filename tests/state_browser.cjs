/* One Python-to-browser journey spans pagination, persistent reload and tab conflicts. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const {pathToFileURL} = require("node:url");
const {launch, offlineContext} = require("./browser_support.cjs");

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "afterlife-e2e-"));
  const root = path.resolve(__dirname, "..");
  const browser = await launch();
  try {
    const input = path.join(directory, "records.json"), artifact = path.join(directory, "app.html");
    const records = Array.from({length: 205}, (_, index) => ({
      id: `note-${index}`, title: `Note ${index}`, pages: index, archived: false,
    }));
    await fs.writeFile(input, JSON.stringify({records}));
    execFileSync(process.env.PYTHON || "python3", ["-m", "afterlife", "from-python",
      "examples/python-notebook/model.py", input, "-o", artifact], {cwd: root});
    const context = await offlineContext(browser, {acceptDownloads: true});
    const errors = [], network = [];
    const newPage = async () => {
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
      page.on("dialog", dialog => dialog.accept());
      await page.goto(pathToFileURL(artifact).href);
      return page;
    };
    const first = await newPage();
    assert.equal(await first.locator("tbody tr").count(), 100);
    await first.getByRole("button", {name: "Last page", exact: true}).click();
    assert.equal(await first.locator("tbody tr").count(), 5);
    await first.getByRole("button", {name: "New note", exact: true}).click();
    assert.equal(await first.locator("#field-pages").inputValue(), "0");
    await first.locator("#field-title").fill("Saved note");
    await first.getByRole("button", {name: "Save record", exact: true}).click();
    await first.locator("aside.editor").waitFor({state: "hidden"});
    await first.reload();
    await first.getByRole("button", {name: "Last page", exact: true}).click();
    assert.equal(await first.locator("tbody tr").count(), 6);
    assert.match(await first.locator("tbody").innerText(), /Saved note/);
    const second = await newPage();
    await second.getByRole("button", {name: "New note", exact: true}).click();
    await second.locator("#field-title").fill("Preserved draft");
    await first.getByRole("button", {name: "New note", exact: true}).click();
    await first.locator("#field-title").fill("Winning note");
    await first.getByRole("button", {name: "Save record", exact: true}).click();
    await first.locator("aside.editor").waitFor({state: "hidden"});
    await second.getByText("Another tab changed this app.", {exact: false}).waitFor();
    await second.getByRole("button", {name: "Save record", exact: true}).click();
    assert.equal(await second.locator("#field-title").inputValue(), "Preserved draft");
    const payload = JSON.parse((await fs.readFile(artifact, "utf8"))
      .match(/<script type="application\/json" id="afterlife-data">(.*?)<\/script>/s)[1]);
    const winning = await first.evaluate(key => localStorage.getItem(key), payload.storage_key);
    assert.match(winning, /Winning note/);
    assert.doesNotMatch(winning, /Preserved draft/);
    await second.getByRole("button", {name: "Keep editing a separate copy", exact: true}).click();
    await second.getByRole("button", {name: "Save record", exact: true}).click();
    await second.locator("aside.editor").waitFor({state: "hidden"});
    assert.equal(await first.evaluate(key => localStorage.getItem(key), payload.storage_key), winning);
    const download = second.waitForEvent("download");
    await second.getByRole("button", {name: "Export JSON", exact: true}).click();
    const exported = path.join(directory, "fork.json");
    await (await download).saveAs(exported);
    assert.match(await fs.readFile(exported, "utf8"), /Preserved draft/);
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    await context.close();
    console.log("PASS Python conversion, page bounds, persistent reload and conflict-copy recovery");
  } finally {
    await browser.close();
    await fs.rm(directory, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
