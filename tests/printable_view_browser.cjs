"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-print-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const attack='</td><script>window.printAttack=true</script><img src="https://invalid.example/tracker">';
  const records=Array.from({length:205},(_,i)=>({id:`note-${i}`,title:i===0?attack:i%2===0?`Selected ${i}`:`Excluded-private-${i}`,pages:i,archived:i%2===0}));
  const input=path.join(directory,"data.json"),artifact=path.join(directory,"app.html"),print=path.join(directory,"print.html");await fs.writeFile(input,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",input,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser,{acceptDownloads:true}),page=await context.newPage(),errors=[],network=[];
  const monitor=p=>{p.on("pageerror",e=>errors.push(e.message));p.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});};monitor(page);await page.goto(pathToFileURL(artifact).href);
  const payload=await page.evaluate(()=>JSON.parse(document.querySelector("#afterlife-data").textContent));
  await page.locator("#filter-field").selectOption("archived");await page.locator("#filter-value").selectOption("true");await page.locator("#sort-field").selectOption("pages");await page.getByRole("button",{name:"Reverse sort direction",exact:true}).click();
  const download=page.waitForEvent("download");await page.getByRole("button",{name:"Download printable view",exact:true}).click();await (await download).saveAs(print);
  const raw=await fs.readFile(print,"utf8");assert.equal(raw.includes("Excluded-private"),false);assert.equal(raw.includes("<script>"),false);
  const printed=await context.newPage();monitor(printed);await printed.goto(pathToFileURL(print).href);
  assert.equal(await printed.locator("tbody tr").count(),103);assert.match(await printed.locator("p").textContent(),/103 matching records of 205/);
  const ids=await printed.locator("tbody tr td:first-child").allTextContents();assert.deepEqual(ids,records.filter(r=>r.archived).reverse().map(r=>r.id));
  assert.equal(await printed.locator("tbody tr").last().locator("td").nth(1).textContent(),attack);assert.equal(await printed.evaluate(()=>window.printAttack),undefined);assert.equal(await printed.locator("script,img,input,button").count(),0);
  await page.getByRole("searchbox").fill("no-such-record");const emptyDownload=page.waitForEvent("download");await page.getByRole("button",{name:"Download printable view",exact:true}).click();const empty=path.join(directory,"empty.html");await (await emptyDownload).saveAs(empty);await printed.goto(pathToFileURL(empty).href);assert.equal(await printed.locator("tbody tr").count(),0);assert.match(await printed.locator("p").textContent(),/0 matching records/);
  const wideData=path.join(directory,"wide.json"),wideHTML=path.join(directory,"wide.html");
  await fs.writeFile(wideData,JSON.stringify({records:Array.from({length:300},(_,i)=>({id:`wide-${i}`,title:"Wide",pages:0,body:"<".repeat(10000)}))}));
  execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",wideData,"-o",wideHTML],{cwd:root});
  const wide=await context.newPage();monitor(wide);await wide.goto(pathToFileURL(wideHTML).href);
  let oversizedDownloads=0;wide.on("download",()=>oversizedDownloads++);await wide.getByRole("button",{name:"Download printable view",exact:true}).click();
  await wide.locator("#message").filter({hasText:"Printable report exceeds10 MiB"}).waitFor();assert.equal(oversizedDownloads,0);
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),payload.storage_key),null);assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Printable filtered view:103 ordered all-page rows, inert hostile text, excluded plaintext absence and explicit empty report passed offline.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
