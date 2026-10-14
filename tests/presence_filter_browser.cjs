"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-presence-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const records=Array.from({length:205},(_,i)=>({id:`n-${i}`,title:`Note ${i}`,body:i%2?"":"present",pages:0,archived:false,rating:i%2?0:null}));
  const data=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(data,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",data,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser,{acceptDownloads:true}),page=await context.newPage(),errors=[],network=[];
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await page.goto(pathToFileURL(artifact).href);
  await page.getByRole("combobox",{name:"Presence field",exact:true}).selectOption("rating");assert.match(await page.locator(".count").textContent(),/^103 of 205/);
  await page.getByRole("button",{name:"Next page",exact:true}).click();assert.equal(await page.locator("tbody tr").count(),3);
  const wait=page.waitForEvent("download");await page.getByRole("button",{name:"Export matching JSON",exact:true}).click();const output=path.join(directory,"empty.json");await(await wait).saveAs(output);assert.deepEqual(JSON.parse(await fs.readFile(output,"utf8")).records.map(r=>r.id),records.filter(r=>r.rating===null).map(r=>r.id));
  await page.getByRole("combobox",{name:"Field presence",exact:true}).selectOption("present");assert.match(await page.locator(".count").textContent(),/^102 of 205/);
  for(const name of ["pages","archived"]){await page.getByRole("combobox",{name:"Presence field",exact:true}).selectOption(name);assert.match(await page.locator(".count").textContent(),/^205 of 205/);}
  await page.getByRole("combobox",{name:"Presence field",exact:true}).selectOption("body");await page.getByRole("combobox",{name:"Field presence",exact:true}).selectOption("empty");assert.match(await page.locator(".count").textContent(),/^102 of 205/);
  await page.getByRole("button",{name:"Reset view",exact:true}).click();assert.match(await page.locator(".count").textContent(),/^205 of 205/);assert.equal(await page.getByRole("combobox",{name:"Presence field",exact:true}).inputValue(),"");
  assert.equal(await page.evaluate(()=>localStorage.length),0);assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Presence selection:null/empty versus zero/false, full-page export and reset passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
