import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { FlowAdapter } from "../src/flow-adapter.js";
import { flattenMediaKeys, identitiesFor, resolveMediaIdentities, selectNewMedia, type MediaSnapshot } from "../src/media-selection.js";
import type { UiCapabilities } from "../src/types.js";

test("lazy Flow video cards preserve baseline identity and expose only real video sources", {
  skip: !process.env.FLOW_TEST_BROWSER_EXECUTABLE,
}, async context => {
  const tempParent=path.resolve(os.tmpdir());
  const temp=await mkdtemp(path.join(tempParent,"flow-media-identity-test-"));
  context.after(async()=>{
    const relative=path.relative(tempParent,path.resolve(temp));
    assert(relative && !path.isAbsolute(relative) && relative!==".." && !relative.startsWith(".."+path.sep));
    assert(path.basename(temp).startsWith("flow-media-identity-test-"));
    await rm(temp,{recursive:true,force:true});
  });
  const browser = await chromium.launch({executablePath:process.env.FLOW_TEST_BROWSER_EXECUTABLE!,headless:true});
  context.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route("**/*",route=>route.abort());
  await page.evaluate("globalThis.__name = (target) => target");
  const adapter = new FlowAdapter({diagnosticPath:(prefix:string,extension="png")=>path.join(temp,prefix+"."+extension)} as never, {} as never, {} as never) as unknown as {
    mediaSnapshots(page:Page,type:"video"):Promise<MediaSnapshot[]>;
    waitForNewMedia(page:Page,type:"video",baseline:string[],count:number,timeout:number):Promise<MediaSnapshot[]|null>;
    activateLazyVideo(page:Page,identity:MediaSnapshot):Promise<void>;
    isMediaSourceReady(page:Page,candidate:MediaSnapshot,type:"video"):Promise<boolean>;
    inspectMediaStructure(page:Page):Promise<NonNullable<UiCapabilities["mediaDiagnostics"]>>;
  };
  await page.setContent('<style>flow-video-tile{display:block;width:300px;height:190px;margin:8px}img,video{width:280px;height:150px}.container.mobile{position:relative}.mobile-play-badge{pointer-events:none;position:absolute;top:0;left:0}</style><main id="gallery"></main>');
  await page.evaluate(() => {
    const state = {hovered:[] as string[], played:[] as string[], metadataClicks:0, submissions:0};
    (window as unknown as {audit:typeof state}).audit=state;
    (window as unknown as {addTile:(id:string,prompt:string,clickOnly?:boolean)=>void}).addTile = (id,prompt,clickOnly=false) => {
      const tile=document.createElement('flow-video-tile'); tile.id=id;
      tile.innerHTML='<div class="container mobile"><img class="thumbnail" src="https://media.invalid/'+id+'-thumb.jpg"><div class="pre-hover-overlay"><div class="mobile-play-badge"><mat-icon role="img" aria-hidden="true">play_arrow</mat-icon></div></div><flow-tile-hover-footer><div role="button">play_circle'+prompt+'</div></flow-tile-hover-footer></div>';
      const activate=()=>{
        if(tile.querySelector('video'))return;
        tile.querySelector('img')?.remove();
        const video=document.createElement('video');
        video.poster='https://media.invalid/'+id+'-poster.jpg';
        video.innerHTML='<source src="https://media.invalid/'+id+'.mp4?sig=first">';
        Object.defineProperties(video,{readyState:{value:1},networkState:{value:1},duration:{value:10}});
        tile.prepend(video);
      };
      tile.onmouseenter=()=>{state.hovered.push(id);if(!clickOnly)activate();};
      (tile.querySelector('[role="button"]') as HTMLElement).onclick=()=>{state.metadataClicks++;};
      (tile.querySelector('img.thumbnail') as HTMLElement).onclick=()=>{state.played.push(id);activate();};
      document.getElementById('gallery')!.append(tile);
    };
    (window as unknown as {addTile:(id:string,prompt:string)=>void}).addTile('old','Old unique prompt');
  });
  const baselineSnapshots=await adapter.mediaSnapshots(page,"video");
  assert.equal(baselineSnapshots.length,1);
  assert.equal(baselineSnapshots[0]!.lazyVideo,true);
  assert.equal(baselineSnapshots[0]!.ready,false);
  assert.equal(baselineSnapshots[0]!.sourceUrl,undefined,"A lazy thumbnail is never a download source");
  const baseline=flattenMediaKeys(baselineSnapshots);
  await page.evaluate(()=> (window as unknown as {addTile:(id:string,prompt:string)=>void}).addTile('new','New unique prompt'));
  const generated=await adapter.waitForNewMedia(page,"video",baseline,1,5);
  assert.equal(generated?.length,1);
  const asset=generated![0]!;
  assert.equal(asset.sourceUrl,'https://media.invalid/new.mp4?sig=first');
  assert(asset.keys.includes('url:https://media.invalid/new-thumb.jpg'),"The thumbnail identity survives its removal during playback");
  assert(asset.keys.includes('flow-prompt:New unique prompt'));
  assert(!asset.lazyVideo);
  const firstAudit = await page.evaluate(()=> (window as unknown as {audit:{hovered:string[];played:string[];submissions:number}}).audit);
  assert.deepEqual([...new Set(firstAudit.hovered)],['new'], 'Only the newly tracked tile was hovered');
  assert.deepEqual(firstAudit.played,[]);
  assert.equal(firstAudit.submissions,0);
  // Once an old card materializes, it must still overlap the old lazy baseline.
  await adapter.activateLazyVideo(page,baselineSnapshots[0]!);
  assert.equal(selectNewMedia(await adapter.mediaSnapshots(page,"video"),baseline).length,1);
  // Reordering and refreshed URLs continue to resolve only the tracked prompt.
  await page.evaluate(()=>{
    const tile=document.getElementById('new')!;
    document.getElementById('gallery')!.prepend(tile);
    tile.querySelector('source')!.src='https://media.invalid/new.mp4?sig=renewed';
  });
  const resolved=resolveMediaIdentities(await adapter.mediaSnapshots(page,"video"),identitiesFor(generated!));
  assert.equal(resolved?.length,1);
  assert.match(resolved![0]!.sourceUrl ?? '', /^https:\/\/media\.invalid\/new\.mp4/);
  // The mobile badge has no pointer events; only its thumbnail activates playback.
  const secondBaseline=flattenMediaKeys(await adapter.mediaSnapshots(page,"video"));
  await page.evaluate(()=> (window as unknown as {addTile:(id:string,prompt:string,clickOnly:boolean)=>void}).addTile('click-only','Click unique prompt',true));
  const clicked=await adapter.waitForNewMedia(page,"video",secondBaseline,1,6);
  assert.equal(clicked?.[0]?.sourceUrl,'https://media.invalid/click-only.mp4?sig=first');
  assert.deepEqual(await page.evaluate(()=> (window as unknown as {audit:{played:string[]}}).audit.played),['click-only']);
  assert.equal(await page.evaluate(()=> (window as unknown as {audit:{metadataClicks:number}}).audit.metadataClicks),0);
  // Equal prompt identities must not be resolved by card order.
  await page.evaluate(()=> (window as unknown as {addTile:(id:string,prompt:string)=>void}).addTile('duplicate','New unique prompt'));
  assert.equal(resolveMediaIdentities(await adapter.mediaSnapshots(page,"video"),identitiesFor(generated!)),null);
  await assert.rejects(adapter.waitForNewMedia(page,"video",[],1,1),/more new assets/);
  const identityDiagnostic=JSON.parse(await readFile(path.join(temp,"media-identity.json"),"utf8"));
  assert.equal(identityDiagnostic.details.stage,"before-activation");
  assert.equal(identityDiagnostic.details.expectedCount,1);
  assert(identityDiagnostic.details.candidates.length>1);
  assert(identityDiagnostic.structure.flowCustomTags.includes("FLOW-VIDEO-TILE"));
  assert(identityDiagnostic.structure.playerSurfaces.length>0);
  assert((await stat(path.join(temp,"media-identity.png"))).size>0);

  // A reloaded lazy card's /asb thumbnail can renew; its full unique prompt still resolves.
  await page.setContent('<flow-video-tile><img src="https://flow.google.com/asb/renewed-thumbnail"><flow-tile-hover-footer><div role="button">play_circleNew unique prompt</div></flow-tile-hover-footer></flow-video-tile>');
  const renewedLazy = resolveMediaIdentities(await adapter.mediaSnapshots(page,"video"),identitiesFor(generated!));
  assert.equal(renewedLazy?.length,1);
  assert.equal(renewedLazy![0]!.lazyVideo,true);
  // Clicking the exact mobile tile opens a detail player plus a selected history
  // thumbnail. They are one output and must retain the original full prompt.
  await page.setContent('<style>flow-video-tile{display:block;width:300px;height:190px}.container.mobile{position:relative}img.thumbnail{width:280px;height:150px}.mobile-play-badge{pointer-events:none;position:absolute;top:0;left:0}</style><flow-video-tile><div class="container mobile"><img class="thumbnail" src="https://media.invalid/detail-thumb.jpg"><div class="mobile-play-badge">play_arrow</div><flow-tile-hover-footer><div role="button">play_circleExact detail prompt</div></flow-tile-hover-footer></div></flow-video-tile>');
  await page.evaluate(()=>{
    (document.querySelector('img.thumbnail') as HTMLElement).onclick=()=>{
      document.body.innerHTML='<flow-editor-page><flow-video-editor><div class="main-video-container"><div class="video-wrapper"><video class="main-video" aria-label="AI 생성 동영상" src="https://media.invalid/detail.mp4" style="width:300px;height:180px"></video></div></div></flow-video-editor><flow-editor-history-step-video><flow-tile-container class="selected high-emphasis"><flow-video-tile><img class="thumbnail" src="https://media.invalid/detail-thumb-renewed.jpg"></flow-video-tile></flow-tile-container></flow-editor-history-step-video><flow-editor-history-step-video><flow-tile-container><flow-video-tile><img class="thumbnail" src="https://media.invalid/unselected-thumb.jpg"></flow-video-tile></flow-tile-container></flow-editor-history-step-video><flow-expandable-prompt><div>Exact detail prompt</div><button>keyboard_return</button><button>keyboard_arrow_down</button></flow-expandable-prompt></flow-editor-page>';
      Object.defineProperties(document.querySelector('video')!,{readyState:{value:4},networkState:{value:1},duration:{value:10.005}});
    };
  });
  const detailResult=await adapter.waitForNewMedia(page,"video",[],1,6);
  assert.equal(detailResult?.length,1);
  assert.equal(detailResult![0]!.sourceUrl,'https://media.invalid/detail.mp4');
  assert(detailResult![0]!.keys.includes('flow-prompt:Exact detail prompt'));
  assert(detailResult![0]!.keys.includes('url:https://media.invalid/detail-thumb-renewed.jpg'));
  assert(!detailResult![0]!.keys.some(key=>key.includes('unselected-thumb')));
  assert.equal((await adapter.mediaSnapshots(page,"video")).length,1,"The selected history thumbnail is not a second output");
  // A generation placeholder must remain untouched until its thumbnail/prompt
  // arrives. Its temporary DOM identity cannot be handed off to the player.
  await page.mouse.move(900,600);
  await page.setContent('<style>flow-video-tile{display:block;width:300px;height:190px}img,video{width:280px;height:150px}</style><flow-video-tile id="pending"></flow-video-tile>');
  await page.evaluate(()=>{
    const state={loaded:false,premature:0,hovered:0};
    (window as unknown as {placeholderAudit:typeof state}).placeholderAudit=state;
    const tile=document.getElementById('pending')!;
    tile.onmouseenter=()=>{
      if(!state.loaded){state.premature++;return;}
      state.hovered++;
      if(tile.querySelector('video'))return;
      const video=document.createElement('video');video.src='https://media.invalid/pending-ready.mp4';
      Object.defineProperties(video,{readyState:{value:4},networkState:{value:1},duration:{value:10}});
      tile.querySelector('img')?.remove();tile.prepend(video);
    };
    setTimeout(()=>{
      tile.innerHTML='<img src="https://media.invalid/pending-ready-thumb.jpg"><flow-tile-hover-footer><div role="button">play_circleLoaded persistent prompt</div></flow-tile-hover-footer>';
      state.loaded=true;
    },800);
  });
  const placeholder=(await adapter.mediaSnapshots(page,"video"))[0]!;
  assert(placeholder.keys.every(key=>key.startsWith('dom:')));
  const loaded=await adapter.waitForNewMedia(page,"video",[],1,6);
  assert.equal(loaded?.[0]?.sourceUrl,'https://media.invalid/pending-ready.mp4');
  const placeholderAudit=await page.evaluate(()=> (window as unknown as {placeholderAudit:{loaded:boolean;premature:number;hovered:number}}).placeholderAudit);
  assert.equal(placeholderAudit.premature,0);
  assert(placeholderAudit.hovered>0);
  await page.setContent('<video poster="https://media.invalid/poster-only.jpg"></video>');
  const posterOnly=(await adapter.mediaSnapshots(page,"video"))[0]!;
  assert.equal(posterOnly.sourceUrl,undefined);
  assert.equal(posterOnly.ready,false);
  assert.equal(await adapter.isMediaSourceReady(page,posterOnly,"video"),false);
  await page.setContent('<a href="https://accounts.google.com/SignOutOptions" aria-label="Google account: private@example.invalid"><img width="256" src="https://example.invalid/avatar.jpg"></a><flow-video-tile><img width="256" src="https://example.invalid/clip-thumb.jpg"></flow-video-tile>');
  const diagnostic=await adapter.inspectMediaStructure(page);
  assert(!JSON.stringify(diagnostic).includes('private@example.invalid'));
  assert(!JSON.stringify(diagnostic).includes('avatar.jpg'));
  assert(diagnostic.elements.some(element=>element.attributes.src?.includes('clip-thumb.jpg')));
  assert.equal(diagnostic.videoTiles.length,1);
  assert(diagnostic.videoTiles[0]!.html.includes('clip-thumb.jpg'));
  assert(!diagnostic.videoTiles[0]!.html.includes('avatar.jpg'));
});
