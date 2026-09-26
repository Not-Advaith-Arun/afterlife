"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-search-field-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const records=Array.from({length:205},(_,i)=>({id:`note-${i}`,title:i%2===0?`Target title ${i}`:`Other title ${i}`,body:i%2===0?"Other body":"Target body",pages:i,archived:false}));
  const data=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(data,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",data,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser,{acceptDownloads:true}),page=await context.newPage(),errors=[],network=[];
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await page.goto(pathToFileURL(artifact).href);
  const payload=await page.evaluate(()=>JSON.parse(document.querySelector("#afterlife-data").textContent));
  await page.getByRole("searchbox").fill("tArGeT");assert.match(await page.locator(".count").textContent(),/^205 of 205/);
  await page.locator("#search-field").selectOption("title");assert.match(await page.locator(".count").textContent(),/^103 of 205/);
  await page.getByRole("button",{name:"Next page",exact:true}).click();assert.equal(await page.locator("tbody tr").count(),3);assert.equal(await page.locator("#search-field").inputValue(),"title");
  const download=page.waitForEvent("download");await page.getByRole("button",{name:"Export matching JSON",exact:true}).click();const output=path.join(directory,"title.json");await (await download).saveAs(output);
  assert.deepEqual(JSON.parse(await fs.readFile(output,"utf8")).records.map(r=>r.id),records.filter((r,i)=>i%2===0).map(r=>r.id));
  await page.locator("#search-field").selectOption("body");assert.match(await page.locator(".count").textContent(),/^102 of 205/);assert.equal(await page.locator("tbody tr").count(),100);
  await page.getByRole("combobox",{name:"Integer range field",exact:true}).selectOption("pages");await page.getByRole("textbox",{name:"Minimum integer",exact:true}).fill("200");await page.getByRole("button",{name:"Apply integer range",exact:true}).click();
  assert.match(await page.locator(".count").textContent(),/^2 of 205/);
  await page.getByRole("button",{name:"Reset view",exact:true}).click();assert.match(await page.locator(".count").textContent(),/^205 of 205/);assert.equal(await page.locator("#search-field").inputValue(),"");assert.equal(await page.getByRole("searchbox").inputValue(),"");
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),payload.storage_key),null);assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Field search:all/title/body subsets, all-page export, integer-range composition and reset passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
