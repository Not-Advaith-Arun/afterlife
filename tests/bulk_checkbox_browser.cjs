"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-checkbox-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const records=Array.from({length:205},(_,i)=>({id:`note-${i}`,title:`Note ${i}`,pages:i,archived:i%2===0}));
  const data=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(data,JSON.stringify({records}));
  execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",data,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser),errors=[],network=[];
  const open=async()=>{const p=await context.newPage();p.on("pageerror",e=>errors.push(e.message));p.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await p.goto(pathToFileURL(artifact).href);return p;};
  const page=await open(),payload=await page.evaluate(()=>JSON.parse(document.querySelector("#afterlife-data").textContent)),key=payload.storage_key;
  const stored=()=>page.evaluate(key=>localStorage.getItem(key),key);
  await page.locator("#filter-field").selectOption("archived");await page.locator("#filter-value").selectOption("true");
  const choice=page.getByRole("combobox",{name:"Matching field value",exact:true}),update=page.getByRole("button",{name:"Update matching records",exact:true});
  assert.equal(await update.isDisabled(),true);await choice.selectOption(JSON.stringify(["archived",false]));
  page.once("dialog",d=>{assert.match(d.message(),/103 matching records/);assert.match(d.message(),/undo this field update/);return d.dismiss();});
  await update.click();assert.equal(await stored(),null);
  await page.locator('tr[data-record-id="note-0"]').getByRole("button",{name:"Edit",exact:true}).click();await page.locator("#field-title").fill("Unsaved draft");
  await update.click();assert.match(await page.locator("#message").textContent(),/Save or cancel editor/);assert.equal(await stored(),null);
  page.once("dialog",d=>d.accept());await page.getByRole("button",{name:"Cancel",exact:true}).click();
  // A clean editor must not keep a stale checkbox value after bulk update.
  await page.locator('tr[data-record-id="note-0"]').getByRole("button",{name:"Edit",exact:true}).click();
  page.once("dialog",d=>d.accept());await update.click();await page.locator("#message").filter({hasText:"Updated 103 matching records"}).waitFor();
  await page.locator("aside.editor").waitFor({state:"hidden"});
  const expected=payload.records.map(r=>({...r,archived:false}));assert.deepEqual(JSON.parse(await stored()).records,expected);
  await update.click();assert.match(await page.locator("#message").textContent(),/No matching records need/);
  await page.reload();assert.deepEqual(JSON.parse(await stored()).records,expected);
  const writer=await open();await writer.getByRole("button",{name:"New note",exact:true}).click();await writer.locator("#field-title").fill("Newer writer record");
  await writer.getByRole("button",{name:"Save record",exact:true}).click();await writer.locator("aside.editor").waitFor({state:"hidden"});
  const winning=await stored();await page.getByText("Another tab changed this app.",{exact:false}).waitFor();
  await page.getByRole("combobox",{name:"Matching field value",exact:true}).selectOption(JSON.stringify(["archived",true]));
  page.once("dialog",d=>d.accept());await page.getByRole("button",{name:"Update matching records",exact:true}).click();
  assert.equal(await stored(),winning);assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  await context.close();console.log("Bulk checkbox:103 all-page updates, cancel/draft/clean-editor/no-op/reload/stale-tab preservation passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
