import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeMediaFile } from "../src/file-output.js";
import { isFlowUrl, canonicalFlowProjectUrl } from "../src/navigation.js";
import { parseDurationOption } from "../src/capabilities.js";
import { FlowStore } from "../src/store.js";
import { FlowAdapter } from "../src/flow-adapter.js";
import { FlowError } from "../src/errors.js";
import type { GenerationRequest } from "../src/types.js";

test("new and legacy Flow hosts are accepted, misleading hosts are rejected", () => {
  for (const url of ["https://flow.google.com/", "https://flow.google.com/project/p1", "https://labs.google/fx/ko/tools/flow"]) assert.equal(isFlowUrl(url), true);
  for (const url of ["https://evil.test/project/p1", "https://flow.google.com.evil.test/", "https://labs.google/other", "http://flow.google.com/", "https://flow.google.com@evil.test/", "https://flow.google.com:8443/"]) assert.equal(isFlowUrl(url), false);
  assert.equal(canonicalFlowProjectUrl("https://flow.google.com/project/p1/edit/a1?view=full"), "https://flow.google.com/project/p1");
  assert.equal(canonicalFlowProjectUrl("https://evil.test/project/p1/edit/a1"), "https://evil.test/project/p1/edit/a1");
});

test("selectable duration labels do not invent options from prose or metadata", () => {
  assert.equal(parseDurationOption("8초"), 8);
  assert.equal(parseDurationOption("12 seconds"), 12);
  for (const value of ["A video lasting 8 seconds", "Video · 8s", "00:08", "0s", "999s", "8.5s"]) assert.equal(parseDurationOption(value), undefined);
});

test("media retries reuse identical bytes and preserve different files", async context => {
  const dir=await mkdtemp(path.join(os.tmpdir(), "flow-output-test-"));
  context.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,"scene.mp4");
  await writeMediaFile(file,Buffer.from("first exact asset"));
  await writeMediaFile(file,Buffer.from("first exact asset"));
  await assert.rejects(writeMediaFile(file,Buffer.from("other gallery asset")),/preserved/);
  assert.equal(await readFile(file,"utf8"),"first exact asset");
  await assert.rejects(writeMediaFile(path.join(dir,"empty.mp4"),Buffer.alloc(0)),/empty/);
});

for (const afterSubmission of [false,true]) test(`generation error preserves Job ID (after submission: ${afterSubmission})`,async context=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"flow-job-recovery-"));
  context.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new FlowStore(dir);
  await store.ensureAccount("test"); await store.markAccountConnected("test");
  const browsers={runExclusive:async (_id:string,fn:()=>Promise<unknown>)=>fn()};
  const adapter=new FlowAdapter(store,browsers as never,{} as never);
  const hooks=adapter as unknown as Record<string,unknown>;
  let submissions=0;
  hooks.readyPage=async()=>{if(!afterSubmission)throw new FlowError("ui_changed","Unknown settings");return {url:()=>"https://flow.google.com/project/test"};};
  for(const key of ["openProject","ensureAgentAutoApprove","configureGeneration","attachReferences","fillPrompt"]) hooks[key]=async()=>{};
  hooks.stableMediaBaseline=async()=>[];
  hooks.clickGenerate=async()=>{submissions++;throw new FlowError("ui_changed","Submission response lost");};
  hooks.captureDiagnostic=async()=>undefined;
  const request:GenerationRequest={accountId:"test",mediaType:"video",prompt:"Offline test only",outputs:1,referenceFiles:[],upscale:"none",outputDirectory:dir,download:false,timeoutSeconds:15};
  const job=await adapter.generate(request);
  assert.match(job.id,/^[0-9a-f-]{36}$/);
  assert.equal(job.status,afterSubmission?"needs_attention":"failed");
  assert.equal(submissions,afterSubmission?1:0);
  assert.equal((await store.getJob(job.id)).error,job.error);
});

test("verified login does not create projects or change generation approval settings",async context=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"flow-login-separation-"));
  context.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new FlowStore(dir);
  const page={goto:async()=>{},url:()=>"https://flow.google.com/",isClosed:()=>false};
  const browsers={runExclusive:async(_id:string,fn:()=>Promise<unknown>)=>fn(),reset:async()=>{},importCookies:async()=>page};
  const bridge={waitForSession:async()=>({profile:"fixture",cookies:[],receivedAt:new Date().toISOString()})};
  const adapter=new FlowAdapter(store,browsers as never,bridge as never);
  const hooks=adapter as unknown as Record<string,unknown>;
  hooks.pageAccessState=async()=>({signedIn:true,workspaceAvailable:true,pageKind:"workspace"});
  hooks.openProject=async()=>{throw Error("Login must not create a project");};
  hooks.ensureAgentAutoApprove=async()=>{throw Error("Login must not alter generation settings");};
  const result=await adapter.connectAccount(undefined,undefined,{chooseGoogleAccount:false});
  assert.match(result,/Connected Google Flow account/);
  const accounts=await store.listAccounts();
  assert.equal(accounts.accounts[0]?.connectionStatus,"connected");
  assert.equal(accounts.defaultAccountId,accounts.accounts[0]?.id);
});
