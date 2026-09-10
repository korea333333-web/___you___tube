import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { FlowAdapter } from "../src/flow-adapter.js";

test("project navigation waits for a delayed composer and rechecks it before dashboard actions", {
  skip: !process.env.FLOW_TEST_BROWSER_EXECUTABLE,
}, async context => {
  const browser=await chromium.launch({executablePath:process.env.FLOW_TEST_BROWSER_EXECUTABLE!,headless:true});
  context.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route("**/*",route=>route.abort());
  await page.evaluate("globalThis.__name = (target) => target");
  const projectUrl="https://flow.google.com/project/11111111-1111-4111-8111-111111111111";
  let reportedUrl=projectUrl+"/edit/22222222-2222-4222-8222-222222222222";
  let navigations=0;
  const fixture=new Proxy(page, {get(target,key){
    if(key==="url")return ()=>reportedUrl;
    if(key==="goto")return async(url:string)=>{
      navigations++;reportedUrl=url;
      // A dashboard-looking control may exist before this project's delayed composer.
      await page.setContent('<body data-created="0"><button onclick="document.body.dataset.created=String(Number(document.body.dataset.created)+1)">새 프로젝트</button><script>setTimeout(()=>{const prompt=document.createElement("textarea");prompt.placeholder="무엇을 만들고 싶으신가요?";document.body.append(prompt);},1500);</script></body>');
      return null;
    };
    const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
  }}) as Page;
  const adapter=new FlowAdapter({} as never,{} as never,{} as never) as unknown as {openProject(page:Page):Promise<void>};
  await page.setContent('<div>Local detail fixture</div>');
  await adapter.openProject(fixture);
  assert.equal(navigations,1);
  assert.equal(reportedUrl,projectUrl);
  assert.equal(await page.locator('textarea').count(),1);
  assert.equal(await page.locator('body').getAttribute('data-created'),'0');

  // No navigation: the composer appears while the old dashboard race is waiting.
  await page.setContent('<body data-created="0"><button id="new-project" hidden onclick="document.body.dataset.created=String(Number(document.body.dataset.created)+1)">새 프로젝트</button><script>setTimeout(()=>{const prompt=document.createElement("textarea");prompt.placeholder="무엇을 만들고 싶으신가요?";document.body.append(prompt);},800);setTimeout(()=>{document.getElementById("new-project").hidden=false;},1200);</script></body>');
  await adapter.openProject(fixture);
  assert.equal(navigations,1);
  assert.equal(await page.locator('textarea').count(),1);
  assert.equal(await page.locator('body').getAttribute('data-created'),'0');
});
