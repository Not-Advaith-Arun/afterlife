"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-secondary-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const records=Array.from({length:205},(_,i)=>({id:`n-${i}`,title:`T${String(205-i).padStart(3,"0")}`,pages:i%2,archived:false}));
  const data=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(data,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",data,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser,{acceptDownloads:true}),page=await context.newPage(),errors=[],network=[];
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await page.goto(pathToFileURL(artifact).href);
  const secondary=page.getByRole("combobox",{name:"Secondary sort field",exact:true});assert.equal(await secondary.isDisabled(),true);
  await page.locator("#sort-field").selectOption("pages");await secondary.selectOption("title");
  const exported=async name=>{const wait=page.waitForEvent("download");await page.getByRole("button",{name:"Export matching JSON",exact:true}).click();const out=path.join(directory,name);await(await wait).saveAs(out);return JSON.parse(await fs.readFile(out,"utf8")).records.map(r=>r.id);};
  const evens=Array.from({length:103},(_,i)=>`n-${204-2*i}`),odds=Array.from({length:102},(_,i)=>`n-${203-2*i}`);
  assert.deepEqual(await exported("ascending.json"),[...evens,...odds]);await page.getByRole("button",{name:"Reverse sort direction",exact:true}).click();assert.deepEqual(await exported("descending.json"),[...odds,...evens]);
  await page.getByRole("button",{name:"Reset view",exact:true}).click();assert.equal(await secondary.inputValue(),"");assert.equal(await secondary.isDisabled(),true);assert.deepEqual(await exported("original.json"),records.map(r=>r.id));
  assert.equal(await page.evaluate(()=>localStorage.length),0);assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Secondary order:205-row grouped/export order,independent primary direction and reset passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
