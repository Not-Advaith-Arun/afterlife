"use strict";
// An optional development-only Playwright install; the product has no JS dependencies.
const {chromium, firefox} = require(process.env.SHOWCASE_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const project = path.basename(root);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), project + '-showcase-browser-'));
const output = path.join(temporary, project + '.html');
const overview = path.join(temporary, 'index.html');
function generate(file, ...options) {
 execFileSync(process.env.PYTHON || 'python3', ['-m', project, 'showcase', '-o', file, ...options], {cwd:root});
}
(async () => {
 let browser;
 try {
  generate(output, '--collection-links'); generate(overview, '--overview', '--collection-links');
  browser = await (process.env.SHOWCASE_BROWSER === 'firefox' ? firefox : chromium).launch({headless:true});
  const context = await browser.newContext({offline:true, acceptDownloads:true, viewport:{width:1440,height:1000}});
  const page = await context.newPage(); const errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (/^https?:/.test(request.url())) network.push(request.url());});
  await page.goto(pathToFileURL(overview).href);
  assert.equal(await page.locator('.project-card').count(),5);
  await page.getByRole('searchbox').fill(project);
  assert.equal(await page.locator('.project-card').count(),1);
  await page.locator('.project-card a').click();
  await page.waitForURL(pathToFileURL(output).href);
  const config = await page.locator('#showcase-data').evaluate(el => JSON.parse(el.textContent));
  assert.equal(config.slug,project);
  if(project==='interlock') {
   assert.match(await page.locator('.trace-version').last().textContent(),/0 effects/);
   for(let step=0;step<4;step++) await page.getByRole('button',{name:'Next event',exact:true}).click();
   assert.match(await page.locator('.trace-version').last().textContent(),/Duplicate effect.*2 effects/);
   assert.match(await page.locator('.trace-version').nth(1).textContent(),/1 effects/);
   assert.equal(await page.getByRole('button',{name:'Next event',exact:true}).isDisabled(),true);
   await page.getByRole('button',{name:'Previous',exact:true}).click();
   assert.match(await page.locator('.trace-version').last().textContent(),/1 effects/);
  }
  for (let index=0; index<config.states.length; index++) {
   const state = config.states[index];
   await page.locator('.segments button').nth(index).click();
   assert.equal(await page.locator('.state-title').textContent(),state.title);
   assert.deepEqual(await page.locator('.metric-value').allTextContents(),state.metrics.map(m=>String(m.value)));
   assert.deepEqual(await page.locator('.data-row .status').allTextContents(),state.rows.map(row=>row.status));
   await page.locator('.data-row').last().click();
   assert.equal(await page.locator('.detail-title').textContent(),state.rows.at(-1).title);
   await page.getByRole('button',{name:'Inspect sample data'}).click();
   assert.deepEqual(JSON.parse(await page.locator('dialog pre').textContent()),state.output);
   await page.keyboard.press('Escape');
  }
  if (config.states.length>1) {
   await page.locator('.segments button').first().focus(); await page.keyboard.press('End');
   assert.equal(await page.locator('.segments button').last().getAttribute('aria-pressed'),'true');
  }
  const dataDownload = page.waitForEvent('download');
  await page.getByRole('button',{name:'Download sample data',exact:true}).click();
  const downloaded = await dataDownload; const saved = path.join(temporary,'data.json'); await downloaded.saveAs(saved);
  assert.deepEqual(JSON.parse(fs.readFileSync(saved)),config.states.at(-1).output);
  await page.getByRole('button',{name:'Toggle dark theme'}).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
  await page.getByRole('button',{name:'Open navigation'}).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:'Open navigation'}).getAttribute('aria-expanded'),'false');
  if(project==='afterlife') {
   await page.getByRole('button',{name:'Try the offline app',exact:true}).click();
   const frame = page.frameLocator('iframe');
   await frame.getByRole('heading',{name:'Fieldwork',exact:true}).waitFor();
   const appDownload = page.waitForEvent('download');
   await page.getByRole('button',{name:'Download working app',exact:true}).click();
   const app = await appDownload; const appFile = path.join(temporary,'working.html'); await app.saveAs(appFile);
   await page.goto(pathToFileURL(appFile).href);
   await page.getByRole('heading',{name:'Fieldwork',exact:true}).waitFor();
   assert.match(await page.locator('body').textContent(),/Map the fieldwork route/);
   await page.getByRole('button',{name:'New task',exact:true}).click();
   await page.getByLabel('Task *',{exact:true}).fill('A new offline record');
   await page.getByLabel('Status *',{exact:true}).selectOption('Planned');
   await page.getByRole('button',{name:'Save record',exact:true}).click();
   await page.locator('aside.editor').waitFor({state:'hidden'});
   assert.equal(await page.locator('tbody tr').count(),4);
   await page.reload();
   assert.equal(await page.locator('tbody tr').count(),4);

  }
  assert.deepEqual(network,[]); assert.deepEqual(errors,[]);
  console.log(project+': offline overview → computed sample states → inspection/download → mobile navigation passed ('+browser.browserType().name()+')');
 } finally {if(browser) await browser.close();fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
