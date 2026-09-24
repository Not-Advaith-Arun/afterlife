"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-field-undo-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const records=Array.from({length:205},(_,i)=>({id:`n-${i}`,title:`Note ${i}`,pages:i,archived:i%2===0}));
  const data=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(data,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",data,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser),errors=[],network=[];
  const open=async()=>{const p=await context.newPage();p.on("pageerror",e=>errors.push(e.message));p.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await p.goto(pathToFileURL(artifact).href);return p;};
  const page=await open(),payload=await page.evaluate(()=>JSON.parse(document.querySelector("#afterlife-data").textContent)),key=payload.storage_key;
  const stored=async()=>JSON.parse(await page.evaluate(key=>localStorage.getItem(key),key)).records;
  const bulk=async()=>{await page.locator("#filter-field").selectOption("archived");await page.locator("#filter-value").selectOption("true");await page.getByRole("combobox",{name:"Matching field value",exact:true}).selectOption(JSON.stringify(["archived",false]));page.once("dialog",d=>d.accept());await page.getByRole("button",{name:"Update matching records",exact:true}).click();await page.locator("#message").filter({hasText:"Updated 103 matching records"}).waitFor();};
  await bulk();assert.deepEqual(await stored(),payload.records.map(r=>({...r,archived:false})));
  await page.getByRole("button",{name:"Undo field update",exact:true}).click();await page.locator("#message").filter({hasText:"field update undone"}).waitFor();assert.deepEqual(await stored(),payload.records);
  await bulk();await page.getByRole("button",{name:"Reset view",exact:true}).click();await page.locator('tr[data-record-id="n-0"]').getByRole("button",{name:"Edit",exact:true}).click();await page.locator("#field-title").fill("Later local correction");
  await page.getByRole("button",{name:"Undo field update",exact:true}).click();assert.match(await page.locator("#message").textContent(),/Save or cancel editor/);
  await page.getByRole("button",{name:"Save record",exact:true}).click();await page.locator("aside.editor").waitFor({state:"hidden"});const changed=await stored();await page.getByRole("button",{name:"Undo field update",exact:true}).click();assert.match(await page.locator("#message").textContent(),/Undo refused/);assert.deepEqual(await stored(),changed);
  await page.reload();assert.equal(await page.getByRole("button",{name:"Undo field update",exact:true}).isVisible(),false);
  await page.getByRole("combobox",{name:"Matching field value",exact:true}).selectOption(JSON.stringify(["archived",true]));page.once("dialog",d=>d.accept());await page.getByRole("button",{name:"Update matching records",exact:true}).click();await page.locator("#message").filter({hasText:"Updated 205 matching records"}).waitFor();
  const writer=await open();await writer.locator('tr[data-record-id="n-0"]').getByRole("button",{name:"Edit",exact:true}).click();await writer.locator("#field-title").fill("Foreign winning title");await writer.getByRole("button",{name:"Save record",exact:true}).click();await writer.locator("aside.editor").waitFor({state:"hidden"});const winning=await stored();await page.getByText("Another tab changed this app.",{exact:false}).waitFor();
  await page.getByRole("button",{name:"Undo field update",exact:true}).click();assert.deepEqual(await stored(),winning);
  assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Bulk undo:exact103-row restoration,draft protection,intervening edit refusal and reload expiry passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
