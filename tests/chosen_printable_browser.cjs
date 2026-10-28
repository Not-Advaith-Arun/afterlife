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
  await page.locator('.chosen-records summary').click();await page.getByRole('checkbox',{name:'Choose individual records',exact:true}).check();for(const [id,next]of [['note-0',true],['note-104',true],['note-204',false]]){await page.getByRole('checkbox',{name:'Choose record '+id,exact:true}).check();if(next)await page.getByRole('button',{name:'Next page',exact:true}).click();}await page.getByRole('searchbox').fill('Excluded-private');
  const download=page.waitForEvent("download");await page.getByRole("button",{name:"Download chosen printable view",exact:true}).click();await (await download).saveAs(print);
  const raw=await fs.readFile(print,"utf8");assert.equal(raw.includes("Excluded-private"),false);assert.equal(raw.includes("<script>"),false);
  const printed=await context.newPage();monitor(printed);await printed.goto(pathToFileURL(print).href);
  assert.equal(await printed.locator("tbody tr").count(),3);assert.match(await printed.locator("p").textContent(),/3 explicitly chosen records of 205/);
  const ids=await printed.locator("tbody tr td:first-child").allTextContents();assert.deepEqual(ids,['note-0','note-104','note-204']);
  assert.equal(await printed.locator("tbody tr").first().locator("td").nth(1).textContent(),attack);assert.equal(await printed.evaluate(()=>window.printAttack),undefined);assert.equal(await printed.locator("script,img,input,button").count(),0);
  await page.locator('.column-choices summary').click();await page.getByRole('checkbox',{name:'Show Title column',exact:true}).uncheck();await page.getByLabel('Printable columns',{exact:true}).selectOption('visible');
  const projectedEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Download chosen printable view',exact:true}).click();const projected=path.join(directory,'visible-columns.html');await(await projectedEvent).saveAs(projected);const projectedRaw=await fs.readFile(projected,'utf8');assert.equal(projectedRaw.includes('printAttack'),false);assert.equal(projectedRaw.includes('Selected '),false);assert.equal(projectedRaw.includes('Excluded-private'),false);await printed.goto(pathToFileURL(projected).href);assert.equal(await printed.locator('tbody tr').count(),3);assert.deepEqual(await printed.locator('tbody tr td:first-child').allTextContents(),ids);assert.equal(await printed.locator('th').filter({hasText:'Title'}).count(),0);assert.match(await printed.locator('p').textContent(),/table fields included, plus Record ID/);assert.equal(await printed.locator('script,img,input,button').count(),0);
  // Changing the printable projection never drops fields from editable exports.
  const jsonEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Export chosen JSON',exact:true}).click();const matchingJSON=path.join(directory,'full-matching.json');await(await jsonEvent).saveAs(matchingJSON);assert.equal(JSON.parse(await fs.readFile(matchingJSON,'utf8')).records[0].title,attack);
  await page.getByRole('button',{name:'Clear chosen records',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Download chosen printable view',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),payload.storage_key),null);assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Chosen printable handoff:3-of205 explicit IDs across pages/filter in original order, inert hostile text, hidden column omission while editable JSON keeps fields, clear disabled, unchanged source/storage and no network passed.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
