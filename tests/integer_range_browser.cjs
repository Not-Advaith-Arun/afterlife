"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-range-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const base=Array.from({length:205},(_,i)=>({id:`note-${i}`,title:`Note ${i}`,pages:i,rating:i,archived:false}));
  const records=[...base,{...base[0],id:"empty",rating:null},{...base[0],id:"maximum",rating:Number.MAX_SAFE_INTEGER},{...base[0],id:"negative",rating:-2}];
  const input=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(input,JSON.stringify({records}));
  execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",input,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser,{acceptDownloads:true}),page=await context.newPage(),errors=[],network=[];
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await page.goto(pathToFileURL(artifact).href);
  const payload=await page.evaluate(()=>JSON.parse(document.querySelector("#afterlife-data").textContent));
  const minimum=page.getByRole("textbox",{name:"Minimum integer",exact:true}),maximum=page.getByRole("textbox",{name:"Maximum integer",exact:true}),apply=page.getByRole("button",{name:"Apply integer range",exact:true});
  await page.getByRole("combobox",{name:"Integer range field",exact:true}).selectOption("rating");
  await minimum.fill("20");await maximum.fill("150");await apply.click();
  assert.match(await page.locator(".count").textContent(),/^131 of 208/);assert.equal(await page.locator("tbody tr").count(),100);
  await page.getByRole("button",{name:"Next page",exact:true}).click();assert.equal(await page.locator("tbody tr").count(),31);
  await page.locator("#sort-field").selectOption("pages");await page.getByRole("button",{name:"Reverse sort direction",exact:true}).click();
  const download=page.waitForEvent("download");await page.getByRole("button",{name:"Export matching JSON",exact:true}).click();
  const output=path.join(directory,"matching.json");await (await download).saveAs(output);
  assert.deepEqual(JSON.parse(await fs.readFile(output,"utf8")).records.map(r=>r.id),base.filter(r=>r.pages>=20&&r.pages<=150).reverse().map(r=>r.id));
  for(const invalid of ["9007199254740990.1","9007199254740992","1e-1000"]){await minimum.fill(invalid);await apply.click();assert.match(await page.locator("#message").textContent(),/Previous range kept/);assert.match(await page.locator(".count").textContent(),/^131 of 208/);}
  await minimum.fill("151");await apply.click();assert.match(await page.locator("#message").textContent(),/Minimum must not exceed maximum/);
  await minimum.fill(String(Number.MAX_SAFE_INTEGER));await maximum.fill("");await apply.click();assert.equal(await page.locator("tbody tr").count(),1);assert.equal(await page.locator("tbody tr").first().getAttribute("data-record-id"),"maximum");
  await minimum.fill("-2");await maximum.fill("1");await apply.click();assert.match(await page.locator(".count").textContent(),/^3 of 208/);
  await page.getByRole("button",{name:"Reset view",exact:true}).click();assert.match(await page.locator(".count").textContent(),/^208 of 208/);
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),payload.storage_key),null);
  assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Exact integer ranges:inclusive all-page exports, null/negative/safe-max boundaries, invalid-bound preservation and reset passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
