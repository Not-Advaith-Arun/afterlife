"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-undo-capacity-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const records=Array.from({length:10000},(_,i)=>({id:`n-${i}`,title:`Note ${i}`,body:"Private retained content ".repeat(26),pages:i,archived:false}));
  const data=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(data,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",data,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser,{acceptDownloads:true}),page=await context.newPage(),errors=[],network=[];
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await page.goto(pathToFileURL(artifact).href);
  const payload=await page.evaluate(()=>JSON.parse(document.querySelector("#afterlife-data").textContent));assert.equal(payload.records.length,10000);
  await page.getByRole("combobox",{name:"Matching field value",exact:true}).selectOption(JSON.stringify(["archived",true]));page.once("dialog",d=>d.accept());await page.getByRole("button",{name:"Update matching records",exact:true}).click();await page.locator("#message").filter({hasText:"Updated 10000 matching records"}).waitFor();
  assert.match(await page.locator("#storage-status").textContent(),/Browser storage is full/);
  await page.getByRole("button",{name:"Undo field update",exact:true}).click();await page.locator("#message").filter({hasText:"field update undone"}).waitFor();
  const wait=page.waitForEvent("download");await page.getByRole("button",{name:"Export matching JSON",exact:true}).click();const output=path.join(directory,"restored.json");await(await wait).saveAs(output);assert.deepEqual(JSON.parse(await fs.readFile(output,"utf8")).records,payload.records);
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),payload.storage_key),null);assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Bulk undo capacity:10000 records,native storage-quota fallback and exact complete export restoration passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
