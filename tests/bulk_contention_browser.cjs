"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-bulk-contention-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const records=Array.from({length:205},(_,i)=>({id:`note-${i}`,title:`Note ${i}`,pages:i,archived:i%2===0}));
  const data=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(data,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",data,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser,{acceptDownloads:true}),errors=[],network=[];
  // Preserve actual browser storage events but withhold app notification until
  // after a competing write. Ordinary stale-tab tests already deliver them.
  await context.addInitScript(()=>{const add=window.addEventListener.bind(window);window.pendingStorage=[];window.addEventListener=(type,listener,options)=>add(type,type==="storage"?event=>window.pendingStorage.push({listener,event}):listener,options);});
  const open=async()=>{const p=await context.newPage();p.on("pageerror",e=>errors.push(e.message));p.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await p.goto(pathToFileURL(artifact).href);return p;};
  const actor=await open(),writer=await open(),holder=await open(),payload=await actor.evaluate(()=>JSON.parse(document.querySelector("#afterlife-data").textContent)),key=payload.storage_key;
  await actor.getByRole("combobox",{name:"Matching field value",exact:true}).selectOption(JSON.stringify(["archived",true]));
  await holder.evaluate(key=>{window.holdReady=false;window.holdDone=navigator.locks.request("afterlife-write:"+key,async()=>{window.holdReady=true;await new Promise(resolve=>window.releaseHold=resolve);});},key);
  await holder.waitForFunction(()=>window.holdReady);
  actor.once("dialog",d=>d.accept());await actor.getByRole("button",{name:"Update matching records",exact:true}).click();
  await actor.locator("#message").filter({hasText:"Another tab is saving"}).waitFor();assert.equal(await actor.evaluate(key=>localStorage.getItem(key),key),null);
  await holder.evaluate(()=>window.releaseHold());await holder.evaluate(()=>window.holdDone);
  await writer.getByRole("button",{name:"New note",exact:true}).click();await writer.locator("#field-title").fill("Actual concurrent winner");await writer.getByRole("button",{name:"Save record",exact:true}).click();await writer.locator("aside.editor").waitFor({state:"hidden"});
  const winning=await writer.evaluate(key=>localStorage.getItem(key),key);assert.equal(JSON.parse(winning).records.length,206);
  await actor.waitForFunction(()=>window.pendingStorage.length>0);
  actor.once("dialog",d=>d.accept());await actor.getByRole("button",{name:"Update matching records",exact:true}).click();
  await actor.getByText("Another tab changed this app.",{exact:false}).waitFor();assert.equal(await actor.evaluate(key=>localStorage.getItem(key),key),winning);
  await actor.getByRole("button",{name:"Keep editing a separate copy",exact:true}).click();
  actor.once("dialog",d=>d.accept());await actor.getByRole("button",{name:"Update matching records",exact:true}).click();await actor.locator("#message").filter({hasText:"Updated 102 matching records"}).waitFor();
  const download=actor.waitForEvent("download");await actor.getByRole("button",{name:"Export JSON",exact:true}).click();const output=path.join(directory,"recovered.json");await (await download).saveAs(output);
  assert.deepEqual(JSON.parse(await fs.readFile(output,"utf8")).records,payload.records.map(r=>({...r,archived:true})));
  assert.equal(await writer.evaluate(key=>localStorage.getItem(key),key),winning);assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();
  console.log("Bulk save contention:actual Web Lock busy refusal, withheld storage notification CAS refusal and complete separate-copy recovery passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
