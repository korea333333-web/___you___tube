import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { FlowAdapter } from "../src/flow-adapter.js";

// Synthetic about:blank HTML only; no user profile or live website is accessed.
test("readonly inspection opens the real manual panel, restores media and closes it on repeated calls", {
  skip: !process.env.FLOW_TEST_BROWSER_EXECUTABLE,
}, async () => {
  const tempParent = path.resolve(os.tmpdir());
  const temp = await mkdtemp(path.join(tempParent, "flow-readonly-inspect-test-"));
  const browser = await chromium.launch({ executablePath: process.env.FLOW_TEST_BROWSER_EXECUTABLE!, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    // tsx name preservation helper is fixture-only; compiled production code does not need it.
    await page.evaluate("globalThis.__name = (target) => target");
    await page.setContent(`
      <html lang="ko"><body>
      <textarea id="prompt">Do not change this prompt</textarea>
      <button id="submit">생성 시작</button><button id="approve">AUTO_APPROVE</button>
      <button id="trigger" aria-label="설정 트리거"><i>tune</i>Omni 1.1 Flash</button>
      <section id="panel" hidden>
        <button id="image" role="radio">image 이미지</button>
        <button id="video" role="radio">videocam 동영상</button>
        <div id="choices"></div>
        <button id="model" aria-label="모델 제품군 선택" aria-haspopup="menu" aria-controls="models"></button>
      </section><div id="portal"></div>
      <script>(() => {
        const panel = document.getElementById('panel');
        const portal = document.getElementById('portal');
        const model = document.getElementById('model');
        let media = 'video';
        window.audit = { submissions: 0, approvals: 0, modelChanges: 0, triggerClicks: 0 };
        function render() {
          document.getElementById('image').setAttribute('aria-checked', String(media === 'image'));
          document.getElementById('video').setAttribute('aria-checked', String(media === 'video'));
          model.textContent = media === 'image' ? 'Nano Banana 2' : 'Omni 1.1 Flash';
          document.getElementById('choices').innerHTML = media === 'image'
            ? '<button role="radio">crop_square 1:1</button><button role="radio">x1</button>'
            : '<button role="radio">crop_16_9 16:9</button><button role="radio">x1</button><button role="tab">10초</button>';
        }
        document.getElementById('trigger').onclick = () => {
          window.audit.triggerClicks++;
          // The first normal click only dismisses a stale popover.
          if (window.audit.triggerClicks === 1) return;
          panel.hidden = !panel.hidden;
        };
        document.getElementById('image').onclick = () => { media = 'image'; render(); };
        document.getElementById('video').onclick = () => { media = 'video'; render(); };
        model.onclick = () => {
          portal.innerHTML = '<div role="menu" id="models"><button role="menuitem">' + model.textContent + '</button></div>';
          portal.querySelector('button').onclick = () => { window.audit.modelChanges++; };
        };
        // Escape closes model menus; the main panel requires its normal trigger.
        document.addEventListener('keydown', event => { if (event.key === 'Escape') portal.innerHTML = ''; });
        document.getElementById('submit').onclick = () => { window.audit.submissions++; };
        document.getElementById('approve').onclick = () => { window.audit.approvals++; };
        render();
      })();</script></body></html>
    `);
    let jobs = 0;
    const adapter = new FlowAdapter({
      requireAccount: async () => ({ id: "fixture" }),
      markAccountConnected: async () => undefined,
      diagnosticPath: (prefix: string) => path.join(temp, prefix + ".png"),
      createJob: async () => { jobs++; throw new Error("Inspection cannot create a Job"); },
    } as never, {
      runExclusive: async (_account: string, operation: () => Promise<unknown>) => operation(),
    } as never, {} as never);
    Object.assign(adapter, {
      readyPage: async () => page,
      waitForAccessState: async () => ({ signedIn: true, workspaceAvailable: true, pageKind: "workspace" }),
      openProject: async () => undefined,
    });
    for (let call = 0; call < 2; call++) {
      const result = await adapter.inspect();
      assert.equal(result.settingsDiagnostics?.opened, true);
      assert.deepEqual(result.models?.image.map(option => option.id), ["nano-banana-2"]);
      assert.deepEqual(result.models?.video.map(option => option.id), ["omni-1-1-flash"]);
      assert.deepEqual(result.aspectRatiosByMedia, { image: ["1:1"], video: ["16:9"] });
      assert.deepEqual(result.outputCountsByMedia, { image: [1], video: [1] });
      assert.deepEqual(result.visibleDurations, [10]);
      assert.equal(await page.locator("#panel").isVisible(), false);
      assert.equal(await page.locator("#video").getAttribute("aria-checked"), "true");
      assert.equal(await page.locator("#models").count(), 0);
      assert.equal(await page.locator("#prompt").inputValue(), "Do not change this prompt");
      assert.deepEqual(await page.evaluate(() => {
        const audit = (window as unknown as { audit: { submissions: number; approvals: number; modelChanges: number } }).audit;
        return [audit.submissions, audit.approvals, audit.modelChanges];
      }), [0, 0, 0]);
    }
    assert.equal(jobs, 0);
    // A generic settings button that does nothing must not report an open panel.
    await page.setContent('<textarea>Unchanged</textarea><button>Settings</button>');
    const closed = await adapter.inspect();
    assert.equal(closed.settingsDiagnostics?.opened, false);
    assert.deepEqual(closed.visibleModels, []);
    await page.setContent('<div data-asset-id="fixture-asset"><button>play_arrow</button><video poster="https://example.invalid/poster.jpg?sig=private-token"><source src="https://example.invalid/clip.mp4?token=private-token"></video><a href="/asset/fixture-asset">Open</a></div>');
    const beforeDiagnostics = await page.content();
    const diagnosticAdapter = adapter as unknown as { inspectMediaStructure(page: Page): Promise<NonNullable<Awaited<ReturnType<typeof adapter.inspect>>["mediaDiagnostics"]>> };
    const media = await diagnosticAdapter.inspectMediaStructure(page);
    assert.equal(media.videoCount, 1);
    const video = media.elements.find(element => element.tag === "VIDEO");
    assert(video?.video);
    assert.equal(video.video.src, "");
    assert.match(video.video.poster, /poster\.jpg/);
    assert(video.ancestors.some(ancestor => ancestor.attributes["data-asset-id"] === "fixture-asset"));
    assert(media.elements.some(element => element.tag === "SOURCE" && /clip\.mp4/.test(element.attributes.src ?? "")));
    assert(media.elements.some(element => element.tag === "BUTTON" && element.label === "play_arrow"));
    assert(!JSON.stringify(media).includes("private-token"), "Signed query values are redacted from diagnostics");
    assert.equal(await page.content(), beforeDiagnostics, "Media inspection never mutates the DOM");

  } finally {
    await browser.close();
    const resolvedTemp = path.resolve(temp);
    const relativeTemp = path.relative(tempParent, resolvedTemp);
    assert(relativeTemp && !path.isAbsolute(relativeTemp) && relativeTemp !== ".." && !relativeTemp.startsWith(".." + path.sep));
    assert(path.basename(resolvedTemp).startsWith("flow-readonly-inspect-test-"));
    await rm(resolvedTemp, { recursive: true, force: true });
  }
});
