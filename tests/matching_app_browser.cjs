"use strict";
const assert=require("node:assert/strict"), fs=require("node:fs/promises"), os=require("node:os"), path=require("node:path");
const {execFileSync}=require("node:child_process"), {pathToFileURL}=require("node:url");
const {launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-matching-app-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const records=Array.from({length:205},(_,i)=>({id:`note-${i}`,title:i%2===0?`Selected ${i}`:`Excluded-private-value-${i}`,pages:i,archived:i%2===0}));
  const input=path.join(directory,"data.json"),artifact=path.join(directory,"app.html"),subset=path.join(directory,"subset.html");
  await fs.writeFile(input,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",input,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser,{acceptDownloads:true}),errors=[],network=[];
  const open=async(file,ctx=context)=>{const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));p.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await p.goto(pathToFileURL(file).href);return p;};
  const page=await open(artifact),payload=await page.evaluate(()=>JSON.parse(document.querySelector("#afterlife-data").textContent));
  // Save the complete collection first, so accidental storage identity reuse is observable.
  await page.locator('tr[data-record-id="note-0"]').getByRole("button",{name:"Edit",exact:true}).click();
  await page.getByRole("button",{name:"Save record",exact:true}).click();await page.locator("aside.editor").waitFor({state:"hidden"});
  const saved=await page.evaluate(key=>localStorage.getItem(key),payload.storage_key);
  await page.locator("#filter-field").selectOption("archived");await page.locator("#filter-value").selectOption("true");
  await page.locator("#sort-field").selectOption("pages");await page.getByRole("button",{name:"Reverse sort direction",exact:true}).click();
  const download=page.waitForEvent("download");await page.getByRole("button",{name:"Download matching app",exact:true}).click();await (await download).saveAs(subset);
  const raw=await fs.readFile(subset,"utf8");assert.equal(raw.includes("Excluded-private-value"),false);
  const expected=payload.records.filter(r=>r.archived).reverse();
  const same=await open(subset),selected=await same.evaluate(()=>JSON.parse(document.querySelector("#afterlife-data").textContent));
  assert.deepEqual(selected.records,expected);assert.notEqual(selected.storage_key,payload.storage_key);
  assert.equal(await same.locator("tbody tr").count(),100);await same.getByRole("button",{name:"Next page",exact:true}).click();assert.equal(await same.locator("tbody tr").count(),3);
  await same.getByRole("button",{name:"New note",exact:true}).click();await same.locator("#field-title").fill("Subset-only edit");
  await same.getByRole("button",{name:"Save record",exact:true}).click();await same.locator("aside.editor").waitFor({state:"hidden"});
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),payload.storage_key),saved);
  const fresh=await offlineContext(browser),reopened=await open(subset,fresh);
  assert.deepEqual(await reopened.evaluate(()=>JSON.parse(document.querySelector("#afterlife-data").textContent).records),expected);
  assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  await fresh.close();await context.close();console.log("Matching portable app:103 sorted records across pages, excluded plaintext absent, independent storage and offline reopening passed.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
