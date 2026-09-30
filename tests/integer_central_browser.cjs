"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url"),{launch,offlineContext}=require("./browser_support.cjs");
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afterlife-integer-summary-")),root=path.resolve(__dirname,".."),browser=await launch();
 try{
  const records=Array.from({length:205},(_,i)=>({id:`n-${i}`,title:i%2?"Other":"Keep",pages:i%3===0?9007199254740991:i%3===1?-9007199254740991:i,rating:i%2?null:-9007199254740991,archived:false}));
  const data=path.join(directory,"data.json"),artifact=path.join(directory,"app.html");await fs.writeFile(data,JSON.stringify({records}));execFileSync(process.env.PYTHON||"python3",["-m","afterlife","from-python","examples/python-notebook/model.py",data,"-o",artifact],{cwd:root});
  const original=await fs.readFile(artifact),context=await offlineContext(browser),page=await context.newPage(),errors=[],network=[];
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await page.goto(pathToFileURL(artifact).href);
  const field=page.getByRole("combobox",{name:"Integer summary field",exact:true}),summary=page.locator(".integer-summary");
  const expected=JSON.parse(execFileSync('python3',['-c','import json,sys,statistics;from fractions import Fraction;v=[r["pages"]for r in json.load(open(sys.argv[1]))["records"]];s=sorted(v);n=len(v);print(json.dumps({"mean":str(Fraction(sum(v),n)),"median":str(Fraction(s[(n-1)//2]+s[n//2],2)),"sum":str(sum(v))}))',data],{encoding:'utf8'}));
  await field.selectOption("pages");assert.match(await summary.textContent(),new RegExp('mean '+expected.mean+'; median '+expected.median));assert.match(await summary.textContent(),new RegExp('sum '+expected.sum));
  await page.getByRole("button",{name:"Last page",exact:true}).click();assert.equal(await page.locator("tbody tr").count(),5);assert.match(await summary.textContent(),new RegExp('mean '+expected.mean+'; median '+expected.median));
  await field.selectOption("rating");assert.match(await summary.textContent(),/103 integer values; 102 empty; sum -927741523238322073/);
  await page.locator("#search-field").selectOption("title");await page.getByRole("searchbox").fill("Other");assert.match(await summary.textContent(),/0 integer values; 102 empty; sum 0; min none; max none/);
  await field.selectOption('pages');const even=JSON.parse(execFileSync('python3',['-c','import json,sys;from fractions import Fraction;v=sorted(r["pages"]for r in json.load(open(sys.argv[1]))["records"]if r["title"]=="Other");n=len(v);print(json.dumps({"mean":str(Fraction(sum(v),n)),"median":str(Fraction(v[(n-1)//2]+v[n//2],2))}))',data],{encoding:'utf8'}));assert.match(await summary.textContent(),new RegExp('mean '+even.mean+'; median '+even.median));await page.getByRole('searchbox').fill('');
  // Text filters exercise even-sized central values without affecting other stored records.
  await page.locator('#search-field').selectOption('id');await page.getByRole('combobox',{name:'Search match',exact:true}).selectOption('exact');await page.getByRole('searchbox').fill('n-0');assert.match(await summary.textContent(),/mean 9007199254740991; median 9007199254740991/);
  await page.getByRole("button",{name:"Reset view",exact:true}).click();assert.equal(await field.inputValue(),"");assert.equal(await summary.isVisible(),false);
  assert.equal(await page.evaluate(()=>localStorage.length),0);assert.deepEqual(await fs.readFile(artifact),original);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);await context.close();console.log("Exact mean/median: independent Python Fraction reference over205 mixed extreme integers/all pages, nullable/empty/one-value filters and source/storage preservation passed.");
 }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
