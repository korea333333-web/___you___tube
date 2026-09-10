import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Browser } from "playwright";
import test from "node:test";
import { closeManagedBrowser } from "../src/browser-lifecycle.js";

function fixture(graceful: boolean) {
  const child = Object.assign(new EventEmitter(), {exitCode: null as number|null, signalCode: null as string|null, killed: false,
    kill() { this.killed=true; this.signalCode="SIGTERM"; this.emit("exit"); return true; }
  });
  const calls:string[]=[];
  const browser={newBrowserCDPSession:async()=>({send:async(command:string)=>{
    calls.push(command);
    if(graceful)setTimeout(()=>{child.exitCode=0;child.emit("exit");},10);
  }}),close:async()=>{calls.push("disconnect");}};
  return {child,browser,calls};
}

test("owned CDP browser exits normally before transport disconnect, without kill",async()=>{
  const {child,browser,calls}=fixture(true);
  await closeManagedBrowser(browser as unknown as Browser,child as unknown as ChildProcess,1000);
  assert.equal(child.exitCode,0);
  assert.equal(child.killed,false);
  assert.deepEqual(calls,["Browser.close","disconnect"]);
  assert.equal(child.listenerCount("exit"),0);
});

test("hung owned browser receives force termination only after graceful deadline",async()=>{
  const {child,browser,calls}=fixture(false);
  await closeManagedBrowser(browser as unknown as Browser,child as unknown as ChildProcess,20);
  assert.equal(child.killed,true);
  assert.deepEqual(calls,["Browser.close","disconnect"]);
  assert.equal(child.listenerCount("exit"),0);
});
