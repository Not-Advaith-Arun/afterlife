"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-exact-search-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const records=Array.from({length:205},(_,i)=>({id:`n-${i}`,title:i%2?"Target suffix":"Target",body:i===0?"[literal.*]":"private",pages:0,archived:false}));
  const data=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(data,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",data,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser,{acceptDownloads:true}),page=await context.newPage(),errors=[],network=[];
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await page.goto(pathToFileURL(artifact).href);
  await page.locator("#search-field").selectOption("title");await page.getByRole("searchbox").fill("TaRgEt");assert.match(await page.locator(".count").textContent(),/^205 of 205/);
  await page.getByRole("combobox",{name:"Search match",exact:true}).selectOption("exact");assert.match(await page.locator(".count").textContent(),/^103 of 205/);
  await page.getByRole("button",{name:"Next page",exact:true}).click();assert.equal(await page.locator("tbody tr").count(),3);
  const wait=page.waitForEvent("download");await page.getByRole("button",{name:"Export matching JSON",exact:true}).click();const output=path.join(directory,"exact.json");await(await wait).saveAs(output);assert.deepEqual(JSON.parse(await fs.readFile(output,"utf8")).records.map(r=>r.id),records.filter(r=>r.title==="Target").map(r=>r.id));
  await page.locator("#search-field").selectOption("body");await page.getByRole("searchbox").fill("[literal.*]");assert.match(await page.locator(".count").textContent(),/^1 of 205/);
  await page.getByRole("searchbox").fill(".*");assert.match(await page.locator(".count").textContent(),/^0 of 205/);
  await page.getByRole("searchbox").fill("");assert.match(await page.locator(".count").textContent(),/^205 of 205/);
  await page.getByRole("button",{name:"Reset view",exact:true}).click();assert.equal(await page.getByRole("combobox",{name:"Search match",exact:true}).inputValue(),"contains");
  assert.equal(await page.evaluate(()=>localStorage.length),0);assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Whole-value search:exact all-page selection, literal punctuation, blank/reset passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
