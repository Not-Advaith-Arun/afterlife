"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-integer-summary-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const records=Array.from({length:205},(_,i)=>({id:`n-${i}`,title:i%2?"Other":"Keep",pages:9007199254740991,rating:i%2?null:-9007199254740991,archived:false}));
  const data=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(data,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",data,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser),page=await context.newPage(),errors=[],network=[];
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await page.goto(pathToFileURL(artifact).href);
  const field=page.getByRole("combobox",{name:"Integer summary field",exact:true}),summary=page.locator(".integer-summary");
  await field.selectOption("pages");assert.match(await summary.textContent(),/205 integer values; 0 empty; sum 1846475847221903155; min 9007199254740991; max 9007199254740991/);
  await page.getByRole("button",{name:"Last page",exact:true}).click();assert.equal(await page.locator("tbody tr").count(),5);assert.match(await summary.textContent(),/sum 1846475847221903155/);
  await field.selectOption("rating");assert.match(await summary.textContent(),/103 integer values; 102 empty; sum -927741523238322073/);
  await page.locator("#search-field").selectOption("title");await page.getByRole("searchbox").fill("Other");assert.match(await summary.textContent(),/0 integer values; 102 empty; sum 0; min none; max none/);
  await page.getByRole("button",{name:"Reset view",exact:true}).click();assert.equal(await field.inputValue(),"");assert.equal(await summary.isVisible(),false);
  assert.equal(await page.evaluate(()=>localStorage.length),0);assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Integer summary:exact overflow-safe all-page totals,negative/null boundaries,filtered empty scope and reset passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
