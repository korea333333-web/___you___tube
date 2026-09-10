import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { closeManagedBrowser } from "../src/browser-lifecycle.js";

interface OwnedFixture {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  child: ChildProcess;
  forceKillCalls: () => number;
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function openFixture(executable: string, profile: string, origin: string): Promise<OwnedFixture> {
  const port = await reservePort();
  // Existing MCP launch arguments only; start blank instead of any live website.
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "--headless=new",
    "--app=about:blank",
  ], { stdio: "ignore", windowsHide: true });
  let forceKills = 0;
  const originalKill = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals | number) => {
    forceKills += 1;
    return originalKill(signal);
  }) as ChildProcess["kill"];
  let spawnError: Error | undefined;
  child.once("error", error => { spawnError = error; });
  let browser: Browser | undefined;
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, "The isolated fixture browser exited before CDP was ready");
      try {
        ready = (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1_000) })).ok;
      } catch { /* Browser is starting. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, "The isolated fixture browser did not expose its existing CDP endpoint");
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    assert(context, "The isolated browser must expose its default persistent context");
    // Only our exact loopback fixture may receive page requests. No user data or Google is used.
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      return url.origin === origin ? route.continue() : route.abort();
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(origin, { waitUntil: "load" });
    return { browser, context, page, child, forceKillCalls: () => forceKills };
  } catch (error) {
    if (browser) await closeManagedBrowser(browser, child);
    else if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  }
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("owned browser graceful exit preserves synthetic persistent storage across restart", {
  skip: !process.env.FLOW_TEST_BROWSER_EXECUTABLE,
  timeout: 120_000,
}, async () => {
  const tempParent = path.resolve(os.tmpdir());
  const profile = await mkdtemp(path.join(tempParent, "flow-persistence-fixture-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end("<!doctype html><title>Offline persistence fixture</title><p>Synthetic local data only.</p>");
  });
  let owned: OwnedFixture | undefined;
  let serverListening = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    serverListening = true;
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    owned = await openFixture(process.env.FLOW_TEST_BROWSER_EXECUTABLE!, profile, origin);
    await owned.page.evaluate(() => {
      document.cookie = "flow_fixture_persistent=synthetic-only; Path=/; Max-Age=3600; SameSite=Lax";
      localStorage.setItem("flow_fixture_storage", "synthetic-only");
    });
    const stored = (await owned.context.cookies(origin)).find(cookie => cookie.name === "flow_fixture_persistent");
    assert(stored && stored.expires > Date.now() / 1_000, "Fixture cookie must be persistent, not a session cookie");
    await closeManagedBrowser(owned.browser, owned.child);
    assert.equal(owned.forceKillCalls(), 0, "A successful shutdown must not force-kill the browser");
    assert.equal(owned.child.exitCode, 0, "Graceful shutdown must await the actual browser process exit");
    assert.equal(owned.child.signalCode, null);
    owned = undefined;

    owned = await openFixture(process.env.FLOW_TEST_BROWSER_EXECUTABLE!, profile, origin);
    assert.equal(await owned.page.evaluate(() => localStorage.getItem("flow_fixture_storage")), "synthetic-only");
    const restored = (await owned.context.cookies(origin)).find(cookie => cookie.name === "flow_fixture_persistent");
    assert.equal(restored?.value, "synthetic-only");
    assert(restored && restored.expires > Date.now() / 1_000);
    await closeManagedBrowser(owned.browser, owned.child);
    assert.equal(owned.forceKillCalls(), 0, "Reopened browser must also close without force-kill");
    assert.equal(owned.child.exitCode, 0);
    assert.equal(owned.child.signalCode, null);
    owned = undefined;
  } finally {
    if (owned) await closeManagedBrowser(owned.browser, owned.child);
    if (serverListening) await closeServer(server);
    const resolvedProfile = path.resolve(profile);
    const relativeProfile = path.relative(tempParent, resolvedProfile);
    assert(relativeProfile && !path.isAbsolute(relativeProfile) && !relativeProfile.startsWith(`..${path.sep}`) && relativeProfile !== "..", "Cleanup must stay within the verified temporary parent");
    assert(path.basename(resolvedProfile).startsWith("flow-persistence-fixture-"));
    await rm(resolvedProfile, { recursive: true, force: true });
  }
});
