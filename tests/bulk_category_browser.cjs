"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-category-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const spec=JSON.parse(await fs.readFile(path.join(root,"examples/task-tracker/app.json"),"utf8"));spec.fields.push({name:"group",label:"Group",type:"select",options:["A","B"]});
  const records=Array.from({length:205},(_,i)=>({id:`task-${i}`,title:`Task ${i}`,status:i%2===0?"Planned":"In progress",group:"A"}));
  const source=path.join(directory,"spec.json"),data=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(source,JSON.stringify(spec));await fs.writeFile(data,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife",source,data,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser),page=await context.newPage(),errors=[],network=[];
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await page.goto(pathToFileURL(artifact).href);
  const payload=await page.evaluate(()=>JSON.parse(document.querySelector("#afterlife-data").textContent)),key=payload.storage_key,choice=page.getByRole("combobox",{name:"Matching field value",exact:true}),update=page.getByRole("button",{name:"Update matching records",exact:true});
  const values=await choice.locator("option").evaluateAll(options=>options.map(o=>o.value));assert.equal(values.includes(JSON.stringify(["status",""])),false);assert.equal(values.includes(JSON.stringify(["group",""])),true);
  await page.locator("#filter-field").selectOption("status");await page.locator("#filter-value").selectOption(JSON.stringify("Planned"));await choice.selectOption(JSON.stringify(["status","Done"]));
  page.once("dialog",d=>{assert.match(d.message(),/Status to Done for 103/);return d.dismiss();});await update.click();assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),null);
  page.once("dialog",d=>d.accept());await update.click();await page.locator("#message").filter({hasText:"Updated 103 matching records"}).waitFor();
  const expected=payload.records.map(r=>r.status==="Planned"?{...r,status:"Done"}:r);assert.deepEqual(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),key)).records,expected);
  await page.getByRole("button",{name:"Reset view",exact:true}).click();await choice.selectOption(JSON.stringify(["group",""]));page.once("dialog",d=>d.accept());await update.click();await page.locator("#message").filter({hasText:"Updated 205 matching records"}).waitFor();
  const cleared=expected.map(r=>({...r,group:""}));assert.deepEqual(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),key)).records,cleared);
  await update.click();assert.match(await page.locator("#message").textContent(),/No matching records need/);await page.reload();assert.deepEqual(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),key)).records,cleared);
  assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Bulk categories:103 all-page status changes, required/optional blank choices, cancel/no-op/reload and exact preservation passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
