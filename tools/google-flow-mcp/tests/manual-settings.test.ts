import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FlowAdapter } from "../src/flow-adapter.js";
import { chromium, type Page } from "playwright";
import { configureManualSettings, readCurrentManualSettings, readManualSettings } from "../src/manual-settings.js";
import { FlowError } from "../src/errors.js";

// All content is supplied as local about:blank HTML; every network request is aborted.
async function fixture(page: Page, videoDisabled = false): Promise<void> {
  await page.setContent(`
    <button role="radio">x4</button><button role="radio">21:9</button>
    <section id="settings">
      <div><button id="image" role="radio" aria-checked="true">image\n이미지</button>
      <button id="video" role="radio" aria-checked="false" ${videoDisabled ? 'aria-disabled="true"' : ''}>videocam\n동영상</button></div>
      <div id="choices"></div>
      <button id="model" aria-label="모델 제품군 선택" aria-haspopup="menu" aria-controls="models"></button>
    </section><div id="portal"></div>
    <script>(() => {
      let media = 'image';
      window.modelChoices = 0;
      const choices = document.getElementById('choices');
      const model = document.getElementById('model');
      const portal = document.getElementById('portal');
      function render() {
        document.getElementById('image').setAttribute('aria-checked', String(media === 'image'));
        document.getElementById('video').setAttribute('aria-checked', String(media === 'video'));
        choices.innerHTML = media === 'image'
          ? '<button role="radio">crop_square 1:1</button><button role="radio">crop_portrait 3:4</button><button role="radio">x1</button><button role="radio">x2</button><button role="radio" disabled>x3</button><button role="radio" aria-disabled="true">x4</button><button role="radio" style="display:none">8초</button>'
          : '<button role="radio">crop_16_9 16:9</button><button role="radio">crop_9_16 9:16</button><button role="radio" disabled>crop_square 1:1</button><button role="radio">x1</button><button role="radio">8초</button><button role="radio" aria-disabled="true">12초</button><p>Existing video 10 seconds</p>';
        model.textContent = media === 'image' ? 'Nano Banana 2 arrow_drop_down' : 'Veo 3.1 Fast arrow_drop_down';
      }
      document.getElementById('image').onclick = () => { media = 'image'; render(); };
      document.getElementById('video').onclick = () => { if (${!videoDisabled}) { media = 'video'; render(); } };
      model.onclick = () => {
        portal.innerHTML = '<div id="models" role="menu">' + (media === 'image'
          ? '<button role="menuitem">Nano Banana 2</button><button role="menuitemradio">Nano Banana Pro</button><button role="menuitem" disabled>Imagen 99</button><button role="menuitem" style="display:none">Nano Banana Hidden</button>'
          : '<button role="option">Veo 3.1 Fast</button><button role="menuitemradio">Veo 3.1 Quality</button><button role="menuitem" aria-disabled="true">Veo Disabled</button>') + '</div>';
        portal.querySelectorAll('button').forEach(button => button.onclick = () => { window.modelChoices++; });
      };
      document.addEventListener('keydown', event => { if (event.key === 'Escape') portal.innerHTML = ''; });
      render();
    })();
    </script>
  `);
}

test("manual settings are read separately per media and restore the original selection", {
  skip: !process.env.FLOW_TEST_BROWSER_EXECUTABLE,
}, async context => {
  const browser = await chromium.launch({ executablePath: process.env.FLOW_TEST_BROWSER_EXECUTABLE!, headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", route => route.abort());
  await fixture(page);
  const result = await readManualSettings(page);
  assert(result);
  assert.deepEqual(result.models.image.map(model => model.id), ["nano-banana-2", "nano-banana-pro"]);
  assert.deepEqual(result.models.video.map(model => model.id), ["veo-3-1-fast", "veo-3-1-quality"]);
  assert.equal(result.models.image[0]?.selected, true);
  assert.equal(result.models.video[0]?.selected, true);
  assert.deepEqual(result.ratios, { image: ["1:1", "3:4"], video: ["16:9", "9:16"] });
  assert.deepEqual(result.outputs, { image: [1, 2], video: [1] });
  assert.deepEqual(result.durationSeconds, [8]);
  assert.equal(await page.locator("#image").getAttribute("aria-checked"), "true");
  assert.equal(await page.locator("#models").count(), 0);
  assert.equal(await page.evaluate(() => (window as unknown as { modelChoices: number }).modelChoices), 0);
  assert(result.modelMenuDiagnostics?.some(item => item.options.some(option => option.label === "Veo Disabled" && !option.available)));

  await fixture(page, true);
  const oneMedia = await readManualSettings(page);
  assert(oneMedia);
  assert.deepEqual(oneMedia.models.video, []);
  assert.deepEqual(oneMedia.ratios.video, []);
  assert.deepEqual(oneMedia.outputs.video, []);
  assert.deepEqual(oneMedia.durationSeconds, []);
  assert.equal(oneMedia.models.image.length, 2);

  await page.setContent('<button role="radio" disabled aria-checked="true">image 이미지</button><button role="radio" aria-disabled="true">videocam 동영상</button>');
  assert.equal(await readManualSettings(page), undefined);
  await page.setContent('<button role="radio">image 이미지</button><button role="radio">videocam 동영상</button>');
  const unidentified = await readManualSettings(page);
  assert(unidentified);
  assert.deepEqual(unidentified.models, { image: [], video: [] });
});

type ConfigureFault = "none" | "model-reset" | "media-reset";
async function configureFixture(page: Page, fault: ConfigureFault = "none", keepSettingsOpenOnEscape = false, escapeCloseDelayMs = 0): Promise<void> {
  await page.setContent('<textarea id="prompt">Unchanged fixture prompt</textarea><button id="submit">생성</button><button id="approve">AUTO_APPROVE</button><section id="settings"><div><button id="image" role="radio">image 이미지</button><button id="video" role="radio">videocam 동영상</button></div><div id="ratios"></div><div id="outputs"></div><div id="durations"></div><button id="model" aria-label="모델 제품군 선택" aria-haspopup="menu" aria-controls="config-models"></button></section><div id="portal"></div>');
  // tsx preserves local function names using __name; provide its identity helper only in this blank fixture.
  await page.evaluate("globalThis.__name = (target) => target");
  await page.evaluate(({ faultMode, keepSettingsOpenOnEscape, escapeCloseDelayMs }) => {
    const state = {
      media: "image" as "image" | "video",
      models: { image: "Nano Banana 2", video: "Omni 1.1 Flash" },
      ratio: "1:1", output: 2, duration: 4,
      submissions: 0, approvals: 0, modelChoices: 0,
    };
    (window as unknown as { configState: typeof state }).configState = state;
    const settings = document.getElementById("settings")!;
    const portal = document.getElementById("portal")!;
    const model = document.getElementById("model")!;
    const groups = {
      ratio: document.getElementById("ratios")!,
      output: document.getElementById("outputs")!,
      duration: document.getElementById("durations")!,
    };
    function addChoice(group: HTMLElement, role: string, label: string, isSelected: boolean, action: () => void, disabled = false) {
      const button = document.createElement("button");
      button.setAttribute("role", role);
      button.setAttribute(role === "tab" ? "aria-selected" : "aria-checked", String(isSelected));
      button.textContent = label;
      if (disabled) button.setAttribute("aria-disabled", "true");
      button.onclick = () => { if (!disabled) { action(); render(); } };
      group.append(button);
    }
    function render() {
      document.getElementById("image")!.setAttribute("aria-checked", String(state.media === "image"));
      document.getElementById("video")!.setAttribute("aria-checked", String(state.media === "video"));
      model.textContent = state.models[state.media] + " arrow_drop_down";
      Object.values(groups).forEach(group => group.replaceChildren());
      const ratios = state.media === "video" ? ["16:9", "9:16", "4:3"] : ["1:1", "3:4"];
      ratios.forEach(ratio => addChoice(groups.ratio, "radio", "crop_square " + ratio, state.ratio === ratio, () => { state.ratio = ratio; }, ratio === "4:3"));
      [1, 2, 4].forEach(output => addChoice(groups.output, "radio", "x" + output, state.output === output, () => {
        state.output = output;
        if (faultMode === "model-reset") state.models.video = "Omni 1.1 Flash";
        if (faultMode === "media-reset") state.media = "image";
      }, output === 4));
      // These are synthetic model-dependent choices, not claims about real Flow.
      if (state.media === "video" && state.models.video === "Omni 1.1 Flash") {
        [4, 6, 8, 10].forEach(duration => addChoice(groups.duration, "tab", duration + "초", state.duration === duration, () => { state.duration = duration; }, duration === 6));
      }
    }
    document.getElementById("image")!.onclick = () => { state.media = "image"; state.ratio = "1:1"; render(); };
    document.getElementById("video")!.onclick = () => { state.media = "video"; state.ratio = "16:9"; render(); };
    model.onclick = () => {
      const menu = document.createElement("div");
      menu.id = "config-models"; menu.setAttribute("role", "menu");
      const labels = state.media === "image" ? ["Nano Banana 2", "Nano Banana Pro"] : ["Omni 1.1 Flash", "Veo 3.1 Fast", "Veo Disabled"];
      labels.forEach((label, index) => {
        const button = document.createElement("button");
        button.setAttribute("role", index % 2 ? "menuitemradio" : "option");
        button.textContent = label;
        if (label === "Veo Disabled") button.setAttribute("aria-disabled", "true");
        button.onclick = () => {
          if (label === "Veo Disabled") return;
          state.models[state.media] = label; state.modelChoices++;
          portal.replaceChildren(); render();
        };
        menu.append(button);
      });
      portal.replaceChildren(menu);
    };
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      if (portal.childElementCount) portal.replaceChildren();
      else if (!keepSettingsOpenOnEscape) {
        if (escapeCloseDelayMs) setTimeout(() => { settings.hidden = true; }, escapeCloseDelayMs);
        else settings.hidden = true;
      }
    });
    document.getElementById("submit")!.onclick = () => { state.submissions++; };
    document.getElementById("approve")!.onclick = () => { state.approvals++; };
    render();
  }, { faultMode: fault, keepSettingsOpenOnEscape, escapeCloseDelayMs });
}

test("manual configuration verifies model-dependent choices without submission and keeps its panel open", {
  skip: !process.env.FLOW_TEST_BROWSER_EXECUTABLE,
}, async context => {
  const browser = await chromium.launch({ executablePath: process.env.FLOW_TEST_BROWSER_EXECUTABLE!, headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", route => route.abort());
  const request = { mediaType: "video" as const, model: "veo-3-1-fast", aspectRatio: "16:9", outputs: 1 };
  const unsupported = (error: unknown) => error instanceof FlowError && error.code === "unsupported_option";
  const changed = (error: unknown) => error instanceof FlowError && error.code === "ui_changed";
  const noSubmission = async () => {
    assert.deepEqual(await page.evaluate(() => {
      const state = (window as unknown as { configState: { submissions: number; approvals: number } }).configState;
      return [state.submissions, state.approvals];
    }), [0, 0]);
    assert.equal(await page.locator("#prompt").inputValue(), "Unchanged fixture prompt");
  };

  await configureFixture(page);
  const before = await readCurrentManualSettings(page);
  assert.deepEqual(before, { mediaType: "image", model: "nano-banana-2", aspectRatio: "1:1", outputs: 2 });
  assert.equal(await configureManualSettings(page, request), true);
  assert.deepEqual(await readCurrentManualSettings(page), request);
  assert.equal(await page.locator("#settings").isVisible(), true);
  assert.equal(await page.locator("#config-models").count(), 0);
  await noSubmission();
  assert.equal(await configureManualSettings(page, before!), true);
  assert.deepEqual(await readCurrentManualSettings(page), before);

  await configureFixture(page);
  const omni = { mediaType: "video" as const, model: "omni-1-1-flash", aspectRatio: "9:16", durationSeconds: 10, outputs: 1 };
  assert.equal(await configureManualSettings(page, omni), true);
  assert.deepEqual(await readCurrentManualSettings(page), omni);
  await noSubmission();

  await configureFixture(page);
  await assert.rejects(configureManualSettings(page, { ...request, durationSeconds: 8 }), unsupported);
  assert.match(await page.locator("#model").innerText(), /Veo 3.1 Fast/);
  assert.equal(await page.locator("#durations [role=tab]").count(), 0);
  await noSubmission();

  for (const invalid of [
    { ...request, model: "veo-disabled" },
    { ...request, model: "veo-unknown" },
    { ...request, aspectRatio: "4:3" },
    { ...request, aspectRatio: "21:9" },
    { ...request, outputs: 4 },
    { ...request, outputs: 3 },
    { ...omni, durationSeconds: 6 },
  ]) {
    await configureFixture(page);
    await assert.rejects(configureManualSettings(page, invalid), unsupported);
    assert.equal(await page.locator("#settings").isVisible(), true);
    await noSubmission();
  }

  for (const fault of ["model-reset", "media-reset"] as const) {
    await configureFixture(page, fault);
    await assert.rejects(configureManualSettings(page, request), changed);
    await noSubmission();
  }

  await configureFixture(page);
  await page.locator("#video").evaluate(element => element.setAttribute("aria-disabled", "true"));
  await assert.rejects(configureManualSettings(page, request), unsupported);

  // A snapshot must be sufficient to restore, not just identify the media/model.
  await configureFixture(page);
  await page.locator('#outputs [aria-checked="true"]').evaluate(element => element.setAttribute("aria-checked", "false"));
  assert.equal(await readCurrentManualSettings(page), undefined);
  await configureFixture(page);
  await page.locator("#video").click();
  await page.locator('#durations [aria-selected="true"]').evaluate(element => element.setAttribute("aria-selected", "false"));
  assert.equal(await readCurrentManualSettings(page), undefined);
  await page.setContent('<button>Unknown settings</button>');
  assert.equal(await configureManualSettings(page, request), false);
  assert.equal(await readCurrentManualSettings(page), undefined);
});

test("adapter settings-only preview restores original and target settings on success and failure", {
  skip: !process.env.FLOW_TEST_BROWSER_EXECUTABLE,
}, async () => {
  const tempParent = path.resolve(os.tmpdir());
  const temp = await mkdtemp(path.join(tempParent, "flow-settings-preview-test-"));
  const browser = await chromium.launch({ executablePath: process.env.FLOW_TEST_BROWSER_EXECUTABLE!, headless: true });
  let jobsCreated = 0;
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    const adapter = new FlowAdapter({
      requireConnectedAccount: async () => ({ id: "fixture", connectionStatus: "connected" }),
      diagnosticPath: (prefix: string) => path.join(temp, prefix + ".png"),
      createJob: async () => { jobsCreated++; throw new Error("Settings preview must not create a Job"); },
    } as never, {
      runExclusive: async (_account: string, operation: () => Promise<unknown>) => operation(),
    } as never, {} as never);
    Object.assign(adapter, { readyPage: async () => page, openProject: async () => undefined });
    const request = { mediaType: "video" as const, model: "veo-3-1-fast", aspectRatio: "16:9", outputs: 1 };
    for (const shouldFail of [false, true]) {
      await configureFixture(page);
      await page.evaluate(() => {
        const trigger = document.createElement("button");
        trigger.setAttribute("aria-label", "설정 트리거");
        trigger.textContent = "Settings fixture";
        document.body.prepend(trigger);
      });
      const original = await readCurrentManualSettings(page);
      assert(original);
      await page.locator("#video").click();
      const targetOriginal = await readCurrentManualSettings(page);
      assert(targetOriginal);
      await configureManualSettings(page, original);
      if (shouldFail) {
        await assert.rejects(adapter.validateGenerationSettings({ ...request, durationSeconds: 8 }),
          (error: unknown) => error instanceof FlowError && error.code === "unsupported_option");
      } else {
        const result = await adapter.validateGenerationSettings(request) as {
          status: string; generationSubmitted: boolean; jobCreated: boolean;
          originalSettingsRestored: boolean; selected: unknown;
        };
        assert.equal(result.status, "settings_verified");
        assert.equal(result.generationSubmitted, false);
        assert.equal(result.jobCreated, false);
        assert.equal(result.originalSettingsRestored, true);
        assert.deepEqual(result.selected, request);
      }
      assert.equal(await page.locator("#settings").isVisible(), false, "Preview closes the restored settings panel");
      await page.locator("#settings").evaluate(element => { (element as HTMLElement).hidden = false; });
      assert.deepEqual(await readCurrentManualSettings(page), original);
      await page.locator("#video").click();
      assert.deepEqual(await readCurrentManualSettings(page), targetOriginal);
      assert.deepEqual(await page.evaluate(() => {
        const state = (window as unknown as { configState: { submissions: number; approvals: number } }).configState;
        return [state.submissions, state.approvals];
      }), [0, 0]);
      assert.equal(await page.locator("#prompt").inputValue(), "Unchanged fixture prompt");
    }

    // Reproduce the real panel behavior: Escape closes model menus but leaves
    // the settings panel open, so its trigger must close and later reopen it.
    await configureFixture(page, "none", true);
    await page.evaluate(() => {
      const trigger = document.createElement("button");
      trigger.setAttribute("aria-label", "설정 트리거");
      trigger.textContent = "Toggle settings fixture";
      trigger.onclick = () => {
        const settings = document.getElementById("settings")!;
        settings.hidden = !settings.hidden;
      };
      document.body.prepend(trigger);
    });
    const consecutiveRequests = [
      { mediaType: "image" as const, model: "nano-banana-pro", aspectRatio: "3:4", outputs: 1 },
      request,
    ];
    for (const consecutiveRequest of consecutiveRequests) {
      const result = await adapter.validateGenerationSettings(consecutiveRequest) as {
        status: string; generationSubmitted: boolean; jobCreated: boolean;
        originalSettingsRestored: boolean; selected: unknown;
      };
      assert.equal(result.status, "settings_verified");
      assert.equal(result.originalSettingsRestored, true);
      assert.equal(result.generationSubmitted, false);
      assert.equal(result.jobCreated, false);
      assert.deepEqual(result.selected, consecutiveRequest);
      assert.equal(await page.locator("#settings").isVisible(), false);
      assert.equal(await page.locator("#config-models").count(), 0);
      assert.deepEqual(await page.evaluate(() => {
        const state = (window as unknown as { configState: {
          media: string; models: { image: string; video: string }; ratio: string;
          output: number; duration: number; submissions: number; approvals: number;
        } }).configState;
        return {
          media: state.media, models: state.models, ratio: state.ratio,
          output: state.output, duration: state.duration,
          submissions: state.submissions, approvals: state.approvals,
        };
      }), {
        media: "image", models: { image: "Nano Banana 2", video: "Omni 1.1 Flash" },
        ratio: "1:1", output: 2, duration: 4, submissions: 0, approvals: 0,
      });
      assert.equal(await page.locator("#prompt").inputValue(), "Unchanged fixture prompt");
    }

    // A closing animation must finish before considering a fallback trigger:
    // toggling while Escape is already closing can reopen the panel.
    await configureFixture(page, "none", false, 100);
    await page.evaluate(() => {
      (window as unknown as { fixtureTriggerClicks: number }).fixtureTriggerClicks = 0;
      const trigger = document.createElement("button");
      trigger.setAttribute("aria-label", "설정 트리거");
      trigger.onclick = () => {
        (window as unknown as { fixtureTriggerClicks: number }).fixtureTriggerClicks++;
        const settings = document.getElementById("settings")!;
        settings.hidden = !settings.hidden;
      };
      document.body.prepend(trigger);
    });
    const delayedResult = await adapter.validateGenerationSettings(consecutiveRequests[0]!) as {
      status: string; originalSettingsRestored: boolean; generationSubmitted: boolean; jobCreated: boolean;
    };
    assert.equal(delayedResult.status, "settings_verified");
    assert.equal(delayedResult.originalSettingsRestored, true);
    assert.equal(delayedResult.generationSubmitted, false);
    assert.equal(delayedResult.jobCreated, false);
    assert.equal(await page.locator("#settings").isVisible(), false);
    assert.equal(await page.evaluate(() => (window as unknown as { fixtureTriggerClicks: number }).fixtureTriggerClicks), 0);
    assert.equal(jobsCreated, 0);
  } finally {
    await browser.close();
    const resolvedTemp = path.resolve(temp);
    const relativeTemp = path.relative(tempParent, resolvedTemp);
    assert(relativeTemp && !path.isAbsolute(relativeTemp) && relativeTemp !== ".." && !relativeTemp.startsWith(".." + path.sep));
    assert(path.basename(resolvedTemp).startsWith("flow-settings-preview-test-"));
    await rm(resolvedTemp, { recursive: true, force: true });
  }
});
