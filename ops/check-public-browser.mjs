import {chromium} from 'playwright';
import {appendFile} from 'node:fs/promises';

// Public page only: no authentication, personal data, or MTA requests.
const browser=await chromium.launch();
const results=[];
try {
 for(const [name,viewport] of [['mobile',{width:390,height:844}],['desktop',{width:1440,height:1000}]]) {
  const context=await browser.newContext({viewport});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',()=>errors.push('Page JavaScript error'));
  const result={viewport:name,ok:false};
  try {
   await page.goto('https://mxduan.github.io/rail-reliability/',{waitUntil:'domcontentloaded',timeout:30000});
   await page.locator('#arrival-age-card[data-fresh="true"]').waitFor({timeout:15000});
   const station=page.locator('#rider-station');
   const directionControl=page.locator('#rider-direction');
   if(!await station.isVisible() || !await station.isEnabled() || !await directionControl.isVisible() || !await directionControl.isEnabled())throw new Error('Station/direction selector unavailable');
   const values=await station.locator('option').evaluateAll(options=>options.map(o=>o.value).filter(Boolean));
   if(!values.length || values.length>100)throw new Error('Station list unavailable');
   // Verify a real selectable forecast, without requiring service at a fixed stop.
   let selected=false;
   for(const direction of ['S','N']) {
    await directionControl.selectOption(direction);
    for(const value of values) {
     await station.selectOption(value);
     const rows=page.locator('#arrival-list .arrival-row');
     for(const row of await rows.all()) {
      if(await row.isVisible() && (await row.innerText()).trim()) {selected=true;break;}
     }
     if(selected)break;
    }
    if(selected)break;
   }
   if(!selected)throw new Error('No rendered future forecast');
   if(await page.locator('#arrival-age-card').getAttribute('data-fresh')!=='true')throw new Error('Forecast expired during check');
   if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Horizontal page overflow');
   if(errors.length)throw new Error(errors[0]);
   await page.locator('#arrival-list').scrollIntoViewIfNeeded();
   result.ok=true;
  } catch(error) {result.reason=error.message.split('\n')[0];}
  await page.screenshot({path:`service-health-${name}.png`,fullPage:false});
  results.push(result);
  await context.close();
 }
} finally {await browser.close();}
console.log(JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));
if(process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
 '\n### Rendered arrival availability\n\n'+results.map(r=>`- ${r.viewport}: ${r.ok?'station selection and future arrivals passed':'FAILED — '+r.reason}`).join('\n')+'\n');
process.exitCode=results.every(r=>r.ok)?0:1;
