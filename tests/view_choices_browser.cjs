'use strict';
const {launch,offlineContext}=require('./browser_support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
(async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'afterlife-view-choices-'));let browser;
 try {
  const root=path.resolve(__dirname,'..'),app=path.join(tmp,'app.html'),source=path.join(tmp,'records.json');
  const records=Array.from({length:205},(_,i)=>({id:'row-'+i,title:'Title '+i,status:'Planned',notes:'PRIVATE '+i,hours:i,important:i%2===0}));
  fs.writeFileSync(source,JSON.stringify({records}));execFileSync('python3',['-m','afterlife','examples/task-tracker/app.json',source,'-o',app],{cwd:root});const original=fs.readFileSync(app);
  browser=await launch();const context=await offlineContext(browser,{acceptDownloads:true,viewport:{width:390,height:844}}),p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.goto(pathToFileURL(app).href);await p.locator('.chosen-records summary').click();
  const download=async name=>{const event=p.waitForEvent('download');await p.getByRole('button',{name,exact:true}).click();const file=path.join(tmp,'download-'+Date.now()+'.json');await(await event).saveAs(file);return JSON.parse(fs.readFileSync(file));};
  const chosen=async()=>new Set((await download('Export chosen JSON')).records.map(r=>r.id));
  const count=async n=>p.getByText(`${n} records chosen across all filters/pages. Unsaved editor inputs are excluded.`,{exact:true}).waitFor();
  assert.equal(await p.getByRole('button',{name:'Apply view choices',exact:true}).isDisabled(),true);
  await p.getByRole('checkbox',{name:'Choose individual records',exact:true}).check();await p.getByRole('button',{name:'Last page',exact:true}).click();await p.getByRole('checkbox',{name:'Choose record row-204',exact:true}).check();await p.getByRole('button',{name:'Previous page',exact:true}).click();
  await p.getByLabel('Record choice scope',{exact:true}).selectOption('page');const preview=await download('Preview view choices');assert.equal(preview.scoped_records,100);assert.deepEqual(preview.changed_ids,records.slice(100,200).map(r=>r.id));assert.equal(JSON.stringify(preview).includes('PRIVATE'),false);await count(1);
  p.once('dialog',d=>d.dismiss());await p.getByRole('button',{name:'Apply view choices',exact:true}).click();await count(1);p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'Apply view choices',exact:true}).click();let expected=new Set(['row-204',...records.slice(100,200).map(r=>r.id)]);await count(expected.size);assert.equal(await p.getByRole('button',{name:'Apply view choices',exact:true}).isDisabled(),true);
  await p.getByRole('searchbox').fill('Title 10');await count(expected.size);await p.getByLabel('Record choice scope',{exact:true}).selectOption('matching');await p.getByLabel('Record choice action',{exact:true}).selectOption('remove');const removal=await download('Preview view choices');assert.equal(removal.scoped_records,11);assert.equal(removal.changed_ids.length,10);p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'Apply view choices',exact:true}).click();for(let i=100;i<=109;i++)expected.delete('row-'+i);await count(expected.size);
  await p.getByLabel('Record choice action',{exact:true}).selectOption('add');p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'Apply view choices',exact:true}).click();for(const row of records.filter(r=>r.title.includes('Title 10')))expected.add(row.id);await count(expected.size);
  await p.getByLabel('Record choice action',{exact:true}).selectOption('remove');await download('Preview view choices');await p.getByRole('searchbox').fill('Title 204');p.once('dialog',async d=>{assert.match(d.message(),/Remove 1 choices/);await d.accept();});await p.getByRole('button',{name:'Apply view choices',exact:true}).click();expected.delete('row-204');assert.deepEqual(await chosen(),expected);
  await p.getByRole('searchbox').fill('no match');assert.equal(await p.getByRole('button',{name:'Apply view choices',exact:true}).isDisabled(),true);assert.deepEqual((await download('Export JSON')).records,records);assert.deepEqual(fs.readFileSync(app),original);assert.equal(await p.evaluate(()=>localStorage.length),0);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  await p.reload();await p.locator('.chosen-records summary').click();assert.equal(await p.getByRole('button',{name:'Export chosen JSON',exact:true}).isDisabled(),true);
  console.log('Explicit view choices:205 records, current-page/all-matching add/remove, off-page choices preserved, preview/cancel/no-op/empty, recompute after filter change, no record/storage writes, reload/mobile passed');
 } finally {if(browser)await browser.close();fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
