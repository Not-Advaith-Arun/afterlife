"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-page-size-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const records=Array.from({length:205},(_,i)=>({id:`n-${i}`,title:`Note ${i}`,pages:i,archived:false}));
  const data=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(data,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",data,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser,{acceptDownloads:true}),page=await context.newPage(),errors=[],network=[];
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await page.goto(pathToFileURL(artifact).href);
  const size=page.getByRole("combobox",{name:"Records per page",exact:true});assert.equal(await page.locator("tbody tr").count(),100);await page.getByRole("button",{name:"Next page",exact:true}).click();
  await size.selectOption("25");assert.equal(await page.locator("tbody tr").count(),25);assert.equal(await page.locator("tbody tr").first().getAttribute("data-record-id"),"n-100");assert.match(await page.locator("#page-status").textContent(),/Page 5 of 9/);
  await size.selectOption("50");assert.equal(await page.locator("tbody tr").count(),50);assert.equal(await page.locator("tbody tr").first().getAttribute("data-record-id"),"n-100");
  await page.getByRole("button",{name:"Last page",exact:true}).click();assert.equal(await page.locator("tbody tr").count(),5);
  const wait=page.waitForEvent("download");await page.getByRole("button",{name:"Export matching JSON",exact:true}).click();const output=path.join(directory,"all.json");await(await wait).saveAs(output);assert.deepEqual(JSON.parse(await fs.readFile(output,"utf8")).records.map(r=>r.id),records.map(r=>r.id));
  await page.getByRole("button",{name:"Reset view",exact:true}).click();assert.equal(await size.inputValue(),"100");assert.equal(await page.locator("tbody tr").first().getAttribute("data-record-id"),"n-0");assert.equal(await page.locator("tbody tr").count(),100);
  assert.equal(await page.evaluate(()=>localStorage.length),0);assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Page sizes:25/50 anchor preservation,lastpage/full export/reset passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
