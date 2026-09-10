import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { APIResponse, Download, Locator, Page } from "playwright";
import { preferredPersistentApprovalIndex } from "./approval.js";
import { BrowserManager } from "./browser-manager.js";
import { cleanCapabilityLabel, normalizeCapabilityId, parseDurationOption, parseOutputCount, type CapabilityOption } from "./capabilities.js";
import { CookieBridge } from "./cookie-bridge.js";
import { errorText, FlowError } from "./errors.js";
import { writeMediaFile } from "./file-output.js";
import { configureManualSettings, readCurrentManualSettings, readManualSettings, type ManualSettingsRequest } from "./manual-settings.js";
import { mediaExtension, probeMedia } from "./media.js";
import {
  flattenMediaKeys,
  hasPersistentMediaIdentity,
  identitiesFor,
  resolveMediaIdentities,
  selectNewMedia,
  type MediaSnapshot,
} from "./media-selection.js";
import { dismissFlowCookieNotice, hasFlowWorkspace, isFlowSignedIn, NEW_PROJECT_NAME, PROJECT_LINKS, PROMPT_EDITOR } from "./page-access.js";
import { canonicalFlowProjectUrl, isFlowUrl } from "./navigation.js";
import { safeFileStem } from "./paths.js";
import { FlowStore } from "./store.js";
import {
  chooseUpscaleOption,
  extractUpscaleOptions,
  normalizeUpscaleId,
  type AssetMenuEntry,
} from "./upscale.js";
import {
  FLOW_URL,
  type FlowJob,
  type GenerationRequest,
  type MediaType,
  type UiCapabilities,
  type UpscaleFactor,
} from "./types.js";

const FAILURE_TEXT = /generation failed|couldn't generate|unable to generate|not enough (?:ai )?credits|blocked by policy|try again|no se (?:ha podido|pudo) generar|error al generar|puntos insuficientes|int[eé]ntalo de nuevo/i;

interface AgentSettingsCapabilities {
  models: { image: CapabilityOption[]; video: CapabilityOption[] };
  ratios: { image: string[]; video: string[] };
  outputs: { image: number[]; video: number[] };
  durationSeconds: number[];
}

interface PageAccessState {
  signedIn: boolean;
  workspaceAvailable: boolean;
  pageKind: "workspace" | "signed_out" | "landing_or_unavailable";
}

export function classifyPageAccess(signedIn: boolean, workspaceAvailable: boolean): PageAccessState {
  if (workspaceAvailable) return { signedIn: true, workspaceAvailable: true, pageKind: "workspace" };
  return {
    signedIn,
    workspaceAvailable: false,
    pageKind: signedIn ? "landing_or_unavailable" : "signed_out",
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

async function firstVisible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 20); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function lastVisible(locator: Locator): Promise<Locator | null> {
  const count = await locator.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function visibleText(locator: Locator): Promise<string[]> {
  const values: string[] = [];
  const count = Math.min(await locator.count().catch(() => 0), 100);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      const text = (await candidate.innerText().catch(() => "")).trim();
      if (text) values.push(text);
    }
  }
  return unique(values);
}

async function visibleCount(locator: Locator): Promise<number> {
  let visible = 0;
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

export class FlowAdapter {
  constructor(
    private readonly store: FlowStore,
    private readonly browsers: BrowserManager,
    private readonly cookieBridge: CookieBridge,
  ) {}

  async connectAccount(
    accountId?: string,
    label?: string,
    options: {
      browserMode?: "extension" | "attach_cdp";
      cdpUrl?: string;
      chooseGoogleAccount?: boolean;
      waitForBridgeSeconds?: number;
      waitForAccountSelectionSeconds?: number;
    } = {},
  ): Promise<string> {
    const attached = options.browserMode === "attach_cdp";
    const bridgeWaitSeconds = options.waitForBridgeSeconds ?? 15;
    const selectionWaitSeconds = options.waitForAccountSelectionSeconds ?? 300;
    const transferred = attached ? undefined : await this.cookieBridge.waitForSession(bridgeWaitSeconds);
    const id = accountId ?? await this.store.availableAccountId(transferred?.profile || "flow-account");
    const accountAlreadyExisted = (await this.store.listAccounts()).accounts.some((item) => item.id === id);
    const account = await this.store.ensureAccount(id, label ?? transferred?.profile, {
      browserMode: attached ? "attach_cdp" : "extension",
      ...(options.cdpUrl ? { cdpUrl: options.cdpUrl } : {}),
    });
    if (!attached) await this.store.setHeadlessAfterLogin(account.id, false);
    let connectionPage: Page | undefined;
    try {
      return await this.browsers.runExclusive(account.id, async () => {
      await this.browsers.reset(account.id);
      const page = transferred
        ? await this.browsers.importCookies(account.id, transferred.cookies)
        : await this.browsers.pageFor(account.id);
      connectionPage = page;
      const startUrl = options.chooseGoogleAccount
        // Google rejects labs.google as a direct AccountChooser continuation
        // with HTTP 400. Use the supported Google Account destination, then
        // navigate to Flow after the user selects an existing account.
        ? `https://accounts.google.com/AccountChooser?continue=${encodeURIComponent("https://myaccount.google.com/")}`
        : FLOW_URL;
      await page.goto(startUrl, { waitUntil: "domcontentloaded" });
      await this.store.touchAccount(account.id);
      const deadline = Date.now() + selectionWaitSeconds * 1_000;
      let chooserCompleted = !options.chooseGoogleAccount;
      let access = chooserCompleted
        ? await this.pageAccessState(page)
        : { signedIn: false, workspaceAvailable: false, pageKind: "signed_out" as const };
      let noWorkspaceSince: number | undefined;
      let unrecognizedFlowSince: number | undefined;
      while (!access.workspaceAvailable && Date.now() < deadline) {
        await page.waitForTimeout(1_000);
        if (!chooserCompleted && /^https:\/\/myaccount\.google\.com(?:\/|$)/i.test(page.url())) {
          chooserCompleted = true;
          await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
        }
        access = await this.pageAccessState(page);
        if (isFlowUrl(page.url()) && !access.workspaceAvailable && !access.signedIn) {
          unrecognizedFlowSince ??= Date.now();
          if (Date.now() - unrecognizedFlowSince >= 15_000) break;
        } else { unrecognizedFlowSince = undefined; }
        if (chooserCompleted && access.signedIn && !access.workspaceAvailable) {
          noWorkspaceSince ??= Date.now();
          if (Date.now() - noWorkspaceSince >= 5_000) break;
        } else {
          noWorkspaceSince = undefined;
        }
      }
      if (!access.workspaceAvailable && access.signedIn) {
        const diagnostics = await this.connectionDiagnostics(page, account.id);
        const message = `Google account '${account.id}' is signed in, but Flow opened its public landing page instead of the generation workspace.`;
        await this.store.markAccountAccessUnavailable(account.id, message);
        if (!attached) await this.browsers.reset(account.id);
        throw new FlowError(
          "flow_access_unavailable",
          message,
          [
            ...diagnostics,
            "Restart with flow_begin_account_connection, wait for the user's extension click, then call flow_complete_account_connection for an account that has Flow access.",
            "Do not open, scroll, or automate the landing page with generic browser/computer-use tools.",
          ],
        );
      }
      if (!access.workspaceAvailable && selectionWaitSeconds > 0) {
        const diagnostics = await this.connectionDiagnostics(page, account.id);
        const flowPageUnrecognized = isFlowUrl(page.url());
        const message = flowPageUnrecognized
          ? "Flow opened, but its workspace controls could not be recognized. Review the saved diagnostic before repeating login."
          : `The Google account selection did not reach a verified Flow workspace within ${selectionWaitSeconds} seconds.`;
        await this.store.markAccountNeedsReconnect(account.id, message);
        if (!attached) await this.browsers.reset(account.id);
        throw new FlowError(
          flowPageUnrecognized ? "ui_changed" : "login_required",
          message,
          diagnostics,
        );
      }
      const currentUrl = page.url();
      if (access.workspaceAvailable) {
        // Workspace access is already proven. Editor/settings checks belong to inspect/generate.
        await this.store.markAccountConnected(account.id);
      }
      if (access.workspaceAvailable && !attached) {
        await this.store.setHeadlessAfterLogin(account.id, true);
        await this.browsers.reset(account.id);
      }
      return [
        `${access.workspaceAvailable ? "Connected" : "Opened"} Google Flow account '${account.id}' (${account.label}).`,
        account.browserMode === "attach_cdp"
          ? `Attached to Chromium CDP: ${account.cdpUrl}`
          : `Connected through Flow Login Bridge (${transferred?.cookies.length ?? 0} Google session cookies transferred locally).`,
        `Current URL: ${currentUrl}`,
        access.workspaceAvailable
          ? attached
            ? "The session is signed in and ready. The attached browser remains open."
            : "The session is signed in and ready. The temporary login window was closed; future automation runs invisibly."
          : "The account chooser contains the accounts already signed into the normal browser; no credentials need to be entered.",
      ].join("\n");
      });
    } catch (error) {
      if (connectionPage && !connectionPage.isClosed()) {
        const diagnostics = await this.connectionDiagnostics(connectionPage, account.id);
        if (error instanceof FlowError) error.suggestions.push(...diagnostics);
        if (!attached) await this.browsers.reset(account.id).catch(() => undefined);
      }
      if (!accountAlreadyExisted) await this.store.removeAccountRecord(account.id);
      throw error;
    }
  }

  async inspect(accountId?: string): Promise<UiCapabilities> {
    const account = await this.store.requireAccount(accountId);
    return this.browsers.runExclusive(account.id, async () => {
      const page = await this.readyPage(account.id, false);
      const access = await this.waitForAccessState(page, 8_000);
      if (access.workspaceAvailable) await this.store.markAccountConnected(account.id, false);
      else if (access.signedIn) {
        await this.store.markAccountAccessUnavailable(account.id, "Flow opened its public landing page instead of the generation workspace.");
      } else {
        await this.store.markAccountNeedsReconnect(account.id, "The saved Flow session is signed out.");
      }
      const body = await page.locator("body").innerText().catch(() => "");
      if (!access.workspaceAvailable) {
        const screenshot = this.store.diagnosticPath(`inspect-${account.id}`);
        await page.screenshot({ path: screenshot, fullPage: false });
        return {
          url: page.url(),
          signedIn: access.signedIn,
          workspaceAvailable: false,
          pageKind: access.pageKind,
          agentInstruction: access.signedIn
            ? "Stop. This Google account does not expose the Flow generation workspace. Restart the begin/complete account connection workflow for another account; never browse or scroll the public Flow page."
            : "Stop. Restart the begin/complete account connection workflow; never use generic browser automation to log in or operate Flow.",
          language: await page.locator("html").getAttribute("lang").then((value) => value || "unknown").catch(() => "unknown"),
          visibleModels: [],
          visibleAspectRatios: [],
          visibleDurations: [],
          availableUpscales: [],
          unavailableUpscales: [],
          upscaleOptions: [],
          mediaDiagnostics: await this.inspectMediaStructure(page),
          pageTextExcerpt: body.slice(0, 2_000),
          screenshot,
        };
      }
      await this.openProject(page);
      const mediaDiagnostics = await this.inspectMediaStructure(page);
      const durationHints: number[] = []; // Only selectable controls can advertise durations.
      let agentCapabilities: AgentSettingsCapabilities | undefined;
      let controlText: string[] = [];
      let settingsDiagnostics: UiCapabilities["settingsDiagnostics"];
      const manualTrigger = await firstVisible([page.getByRole("button", {name:/^(?:설정 트리거|settings trigger)$/i})]);
      if (!manualTrigger && await this.openAgentSettings(page)) {
        agentCapabilities = await this.readAgentSettings(page);
        controlText = [
          ...agentCapabilities.models.image.map((option) => option.label),
          ...agentCapabilities.models.video.map((option) => option.label),
          ...agentCapabilities.ratios.image,
          ...agentCapabilities.ratios.video,
        ];
        const back = await lastVisible(page.locator("button").filter({ has: page.locator("i", { hasText: /^arrow_back$/ }) }));
        if (back) await back.click().catch(() => undefined);
      } else {
        const settings = manualTrigger ?? await firstVisible([
          page.getByRole("button", { name: /settings|options|generation settings|설정|옵션/i }).last(),
          page.getByRole("button", { name: /nano banana|veo|omni/i }).last(),
          page.locator("button").filter({hasText: /nano banana|veo|omni/i}).last(),
        ]);
        if (manualTrigger) await this.openManualSettingsPanel(page, manualTrigger);
        else if (settings) {
          await settings.click();
          await page.waitForTimeout(500);
        }
        try {
          agentCapabilities = await readManualSettings(page);
          const controls = page.locator('button, [role="button"], [role="radio"], [role="option"], [role="menuitem"], [role="tab"]');
          controlText = await visibleText(controls);
          const settingsShot = this.store.diagnosticPath('settings-' + account.id);
          await page.screenshot({path:settingsShot,fullPage:false});
          const structure: NonNullable<UiCapabilities["settingsDiagnostics"]>["controls"] = [];
          for(let i=0;i<Math.min(await controls.count(),100);i++) {
            const item=controls.nth(i);
            if(!await item.isVisible().catch(()=>false))continue;
            const role=await item.getAttribute('role') || 'button';
            const ariaLabel=await item.getAttribute('aria-label') || '';
            const label=await item.innerText().catch(()=> '');
            if(!/^(radio|tab|option|menuitem|menuitemradio)$/.test(role) && !/설정 트리거|모델 제품군 선택|model family/i.test(ariaLabel) && !/banana|veo|omni|imagen/i.test(label)) continue;
            structure.push({role:await item.getAttribute('role') || 'button',label:(await item.innerText().catch(()=>'' )).slice(0,200),ariaLabel:await item.getAttribute('aria-label'),hasPopup:await item.getAttribute('aria-haspopup'),disabled:!await item.isEnabled().catch(()=>false)});
          }
          // A visible trigger alone does not prove that its settings panel opened.
          const opened = await this.manualModelDropdown(page).first().isVisible().catch(()=>false)
            || Boolean(agentCapabilities)
            || Boolean(await firstVisible([page.getByRole("dialog"), page.getByRole("menu")]));
          settingsDiagnostics={opened,controls:structure,screenshot:settingsShot};
        } finally {
          if (manualTrigger) await this.closeManualSettingsPanel(page);
          else await page.keyboard.press("Escape").catch(() => undefined);
        }
      }

      const videos = page.locator("video");
      const upscaleOptions = (await videos.count()) > 0
        ? await this.readVideoDownloadOptions(page, videos.last()).catch(() => [])
        : [];
      await page.keyboard.press("Escape").catch(() => undefined);
      const screenshot = this.store.diagnosticPath(`inspect-${account.id}`);
      await page.screenshot({ path: screenshot, fullPage: false });
      return {
        url: page.url(),
        signedIn: true,
        workspaceAvailable: true,
        pageKind: "workspace",
        agentInstruction: "Use only the returned live options with flow_generate_video or flow_generate_image. Do not operate Flow through generic browser/computer-use tools.",
        language: await page.locator("html").getAttribute("lang").then((value) => value || "unknown").catch(() => "unknown"),
        ...(agentCapabilities ? {
          models: agentCapabilities.models,
          aspectRatiosByMedia: agentCapabilities.ratios,
          outputCountsByMedia: agentCapabilities.outputs,
        } : {}),
        visibleModels: unique(agentCapabilities
          ? [...agentCapabilities.models.image, ...agentCapabilities.models.video].map((option) => option.label)
          : controlText.filter((text) => /veo|omni|nano banana|imagen/i.test(text))),
        visibleAspectRatios: unique(agentCapabilities
          ? [...agentCapabilities.ratios.image, ...agentCapabilities.ratios.video]
          : controlText.flatMap((text) => text.match(/\b(?:16:9|9:16|1:1|4:3|3:4)\b/g) ?? [])),
        visibleDurations: agentCapabilities?.durationSeconds ?? durationHints,
        mediaDiagnostics,
        availableUpscales: upscaleOptions
          .filter((option) => option.kind === "upscale" && option.available)
          .map((option) => option.id),
        unavailableUpscales: upscaleOptions
          .filter((option) => option.kind === "upscale" && !option.available)
          .map((option) => option.id),
        upscaleOptions,
        ...(settingsDiagnostics ? {settingsDiagnostics} : {}),
        pageTextExcerpt: (await page.locator("body").innerText().catch(()=> "")).slice(0, 2_000),
        screenshot,
      };
    });
  }

  async validateGenerationSettings(request: ManualSettingsRequest & {accountId?: string; flowProjectUrl?: string}): Promise<unknown> {
    const account = await this.store.requireConnectedAccount(request.accountId);
    if (request.flowProjectUrl && (!isFlowUrl(request.flowProjectUrl) || !new URL(request.flowProjectUrl).pathname.includes("/project/"))) {
      throw new FlowError("unsupported_option", "Settings validation requires an observed Flow project URL.");
    }
    return this.browsers.runExclusive(account.id, async () => {
      const page = await this.readyPage(account.id, true, request.flowProjectUrl);
      await this.openProject(page);
      const trigger = await firstVisible([page.getByRole("button", {name:/^(?:설정 트리거|settings trigger)$/i})]);
      if (!trigger) throw new FlowError("ui_changed", "The manual settings trigger is unavailable; no settings were changed.");
      const closePanel = () => this.closeManualSettingsPanel(page);
      await this.openManualSettingsPanel(page, trigger);
      let original = await readCurrentManualSettings(page);
      const snapshotDeadline = Date.now() + 3_000;
      while(!original && Date.now() < snapshotDeadline) {
        await page.waitForTimeout(200);
        original = await readCurrentManualSettings(page);
      }
      if (!original) {
        const diagnostic = this.store.diagnosticPath('settings-snapshot-' + account.id);
        await page.screenshot({path:diagnostic,fullPage:false});
        const states = await page.locator('[role="radio"], [role="tab"], button[aria-label="설정 트리거"], button[aria-label="모델 제품군 선택"]').evaluateAll(elements => elements.filter(e=>(e as HTMLElement).getClientRects().length).map(e=>({role:e.getAttribute('role'),text:(e.textContent||'').trim().slice(0,160),checked:e.getAttribute('aria-checked'),selected:e.getAttribute('aria-selected'),state:e.getAttribute('data-state'),disabled:e.getAttribute('aria-disabled')})));
        await closePanel();
        throw new FlowError("ui_changed", "Could not capture the original settings; validation stopped before changing them.", ["Diagnostic screenshot: " + diagnostic, "Visible setting state: " + JSON.stringify(states)]);
      }
      let targetOriginal: ManualSettingsRequest | undefined;
      let verified: ManualSettingsRequest | undefined;
      let screenshot: string | undefined;
      try {
        if (original.mediaType !== request.mediaType) {
          const mode = await firstVisible([page.getByRole("radio", {name:request.mediaType === "video" ? /^(?:videocam\s+)?(?:동영상|비디오|video)$/i : /^(?:image\s+)?(?:이미지|image)$/i})]);
          if (!mode || !await mode.isEnabled()) throw new FlowError("unsupported_option", "The requested media type is unavailable.");
          await mode.click();
          await page.waitForTimeout(300);
        }
        targetOriginal = await readCurrentManualSettings(page);
        if (!targetOriginal || targetOriginal.mediaType !== request.mediaType) throw new FlowError("ui_changed", "Could not capture the target media settings before validation.");
        if (!await configureManualSettings(page, request)) throw new FlowError("ui_changed", "The manual settings controls disappeared.");
        verified = await readCurrentManualSettings(page);
        if (!verified) throw new FlowError("ui_changed", "The configured settings could not be read back.");
        screenshot = this.store.diagnosticPath('validated-settings-' + account.id);
        await page.screenshot({path:screenshot,fullPage:false});
      } finally {
        try {
          try {
            if (targetOriginal && !await configureManualSettings(page, targetOriginal)) throw new FlowError("ui_changed", "Could not restore target media settings.");
          } finally {
            if (!await configureManualSettings(page, original)) throw new FlowError("ui_changed", "Could not restore original settings.");
          }
        } finally { await closePanel(); }
      }
      return {status:"settings_verified",generationSubmitted:false,jobCreated:false,originalSettingsRestored:true,selected:verified,flowProjectUrl:page.url(),screenshot};
    });
  }

  async generate(request: GenerationRequest): Promise<FlowJob> {
    const account = await this.store.requireConnectedAccount(request.accountId);
    const job = await this.store.createJob({ ...request, accountId: account.id });
    return this.browsers.runExclusive(account.id, async () => {
      let page: Page | undefined;
      try {
        page = await this.readyPage(account.id, true);
        await this.store.updateJob(job, "configuring", { flowProjectUrl: page.url() });
        await this.openProject(page, request.flowProject);
        const creditConfirmationMode = await this.configureGeneration(page, request);
        await this.store.updateJob(job, "configuring", creditConfirmationMode ? {creditConfirmationMode} : {});
        await this.attachReferences(page, request.referenceFiles);
        await this.fillPrompt(
          page,
          `${request.mediaType === "video"
            ? request.outputs === 1 ? "Create exactly one video" : `Create exactly ${request.outputs} videos`
            : request.outputs === 1 ? "Create exactly one image" : `Create exactly ${request.outputs} images`}: ${request.prompt}`,
        );

        const baselineSnapshots = await this.stableMediaBaseline(page, request.mediaType);
        const baseline = baselineSnapshots.length;
        const baselineMediaKeys = flattenMediaKeys(baselineSnapshots);
        await this.store.updateJob(job, "submitted", {
          baselineMediaCount: baseline,
          baselineMediaKeys,
          flowProjectUrl: page.url(),
        });
        await this.clickGenerate(page, request.mediaType, baseline);
        await this.store.updateJob(job, "processing");

        const generated = await this.waitForNewMedia(
          page,
          request.mediaType,
          baselineMediaKeys,
          request.outputs,
          Math.min(request.timeoutSeconds, 20),
        );
        if (!generated) return job;
        await this.store.updateJob(job, "ready", { generatedAssets: identitiesFor(generated) });
        return await this.finalizeReadyJob(page, job, Math.min(request.timeoutSeconds, 20));
      } catch (error) {
        const screenshot = page ? await this.captureDiagnostic(page, `job-${job.id}`) : undefined;
        const message = errorText(error);
        // Submission may already have consumed credits. Preserve the job and do not suggest resubmission.
        const status = ["submitted", "processing", "ready", "upscaling", "downloading"].includes(job.status) ||
          (error instanceof FlowError && ["login_required", "flow_access_unavailable"].includes(error.code))
          ? "needs_attention" : "failed";
        await this.store.updateJob(job, status, {
          error: message,
          ...(screenshot ? { diagnosticScreenshot: screenshot } : {}),
        });
        return job;
      }
    });
  }

  async refreshJob(jobId: string, timeoutSeconds = 15): Promise<FlowJob> {
    const job = await this.store.getJob(jobId);
    if (["completed", "failed", "needs_attention"].includes(job.status)) return job;
    return this.browsers.runExclusive(job.accountId, async () => {
      const page = await this.readyPage(job.accountId, true, job.flowProjectUrl);
      if (job.status === "ready" && job.generatedAssets?.length) {
        return await this.finalizeReadyJob(page, job, timeoutSeconds);
      }
      if (job.upscaleSubmitted && job.upscaleBaselineMediaKeys?.length) {
        const upscaled = await this.waitForNewMedia(page, "video", job.upscaleBaselineMediaKeys, 1, timeoutSeconds);
        if (upscaled) {
          await this.store.updateJob(job, "ready", { generatedAssets: identitiesFor(upscaled) });
          return await this.finalizeReadyJob(page, job, timeoutSeconds);
        }
        return job;
      }
      if (!job.baselineMediaKeys) {
        throw new FlowError("job_asset_identity_missing", "This job predates exact asset tracking and cannot be refreshed safely. Generate it again with the current MCP version.");
      }
      const generated = await this.waitForNewMedia(page, job.mediaType, job.baselineMediaKeys, job.outputs, timeoutSeconds);
      if (generated && job.status === "processing") {
        await this.store.updateJob(job, "ready", { generatedAssets: identitiesFor(generated) });
        return await this.finalizeReadyJob(page, job, timeoutSeconds);
      }
      return job;
    });
  }

  async upscaleJob(jobId: string, factor: Exclude<UpscaleFactor, "none">, timeoutSeconds: number): Promise<FlowJob> {
    const job = await this.store.getJob(jobId);
    if (job.mediaType !== "video") throw new FlowError("validation_error", "Only video jobs can be upscaled.");
    return this.browsers.runExclusive(job.accountId, async () => {
      const page = await this.readyPage(job.accountId, true, job.flowProjectUrl);
      await this.store.updateJob(job, "upscaling", { upscale: factor });
      const ready = await this.upscaleLatest(page, job, factor, timeoutSeconds);
      if (ready && job.status !== "completed") await this.store.updateJob(job, "ready");
      return job;
    });
  }

  async downloadJob(jobId: string): Promise<FlowJob> {
    const job = await this.store.getJob(jobId);
    return this.browsers.runExclusive(job.accountId, async () => {
      const page = await this.readyPage(job.accountId, true, job.flowProjectUrl);
      await this.store.updateJob(job, "downloading");
      await this.downloadTracked(page, job);
      return job;
    });
  }

  private async finalizeReadyJob(page: Page, job: FlowJob, timeoutSeconds: number): Promise<FlowJob> {
    if (job.mediaType === "video" && job.upscale !== "none" && !job.chosenUpscale) {
      await this.store.updateJob(job, "upscaling");
      const upscaled = await this.upscaleLatest(page, job, job.upscale, timeoutSeconds);
      if (!upscaled || job.status === "completed") return job;
    }
    if (job.downloadRequested) {
      await this.store.updateJob(job, "downloading");
      await this.downloadTracked(page, job);
    } else {
      await this.store.updateJob(job, "completed");
    }
    return job;
  }

  private async readyPage(accountId: string, requireLogin: boolean, url?: string): Promise<Page> {
    const page = await this.browsers.pageFor(accountId);
    if (!isFlowUrl(page.url())) {
      await page.goto(url || FLOW_URL, { waitUntil: "domcontentloaded" });
    } else if (url && page.url() !== url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    await page.waitForTimeout(1_000);
    if (requireLogin) {
      const access = await this.waitForAccessState(page, 8_000);
      if (!access.signedIn) {
        await this.store.markAccountNeedsReconnect(accountId, "The saved Flow session is signed out.");
        throw new FlowError(
          "login_required",
          `Google Flow account '${accountId}' is not signed in.`,
          [
            `Call flow_begin_account_connection, tell the user to click Connect Flow in the extension, then call flow_complete_account_connection with accountId '${accountId}'.`,
            "Never substitute generic browser/computer-use automation for the MCP login or generation tools.",
          ],
        );
      }
      if (!access.workspaceAvailable) {
        const message = `Google account '${accountId}' is signed in, but Flow opened its public landing page instead of the generation workspace.`;
        await this.store.markAccountAccessUnavailable(accountId, message);
        throw new FlowError(
          "flow_access_unavailable",
          message,
          [
            "Restart the flow_begin_account_connection and flow_complete_account_connection workflow and select an account that has Flow access.",
            "Do not open, scroll, click, or automate the public Flow page with browser/computer-use tools.",
          ],
        );
      }
      await this.store.markAccountConnected(accountId, false);
    }
    return page;
  }

  private async pageAccessState(page: Page): Promise<PageAccessState> {
    const workspaceAvailable = await this.hasWorkspace(page);
    const signedIn = await this.isSignedIn(page);
    return classifyPageAccess(signedIn, workspaceAvailable);
  }

  private async waitForAccessState(page: Page, timeoutMs: number): Promise<PageAccessState> {
    const deadline = Date.now() + timeoutMs;
    let state = await this.pageAccessState(page);
    while (!state.workspaceAvailable && Date.now() < deadline) {
      await page.waitForTimeout(500);
      state = await this.pageAccessState(page);
    }
    return state;
  }

  private async hasWorkspace(page: Page): Promise<boolean> {
    return hasFlowWorkspace(page);
  }

  private async isSignedIn(page: Page): Promise<boolean> {
    return isFlowSignedIn(page);
  }

  private promptLocator(page: Page): Locator {
    return page.locator(PROMPT_EDITOR);
  }

  private async openProject(page: Page, projectName?: string): Promise<void> {
    await dismissFlowCookieNotice(page);
    const projectWorkspaceUrl = canonicalFlowProjectUrl(page.url());
    if (projectWorkspaceUrl !== page.url()) {
      await page.goto(projectWorkspaceUrl, { waitUntil: "domcontentloaded" });
      // DOMContentLoaded does not mean the Flow project composer has rendered.
      // Stay in the observed project while its prompt loads; do not mistake its
      // loading state for a dashboard or create another project.
      if (!projectName && await this.waitForPrompt(page)) return;
    }
    if (!projectName && await firstVisible([this.promptLocator(page)])) return;

    await Promise.race([
      page.getByRole("button", { name: NEW_PROJECT_NAME }).first().waitFor({ state: "visible", timeout: 8_000 }),
      page.locator(PROJECT_LINKS).first().waitFor({ state: "visible", timeout: 8_000 }),
      page.locator("button").filter({ has: page.locator("i", { hasText: /^add_2$/ }) }).last()
        .waitFor({ state: "visible", timeout: 8_000 }),
    ]).catch(() => undefined);

    // The composer can appear while dashboard controls are being awaited.
    if (!projectName && await firstVisible([this.promptLocator(page)])) return;

    if (projectName) {
      const project = await firstVisible([
        page.getByRole("link", { name: new RegExp(this.escapeRegex(projectName), "i") }),
        page.getByRole("button", { name: new RegExp(this.escapeRegex(projectName), "i") }),
        page.getByText(projectName, { exact: false }),
      ]);
      if (project) {
        await project.click();
        if (await this.waitForPrompt(page)) return;
      }
      throw new FlowError("ui_changed", `Requested Flow project '${projectName}' was not found or did not expose a prompt editor.`);
    }

    const recentProject = await firstVisible([
      page.locator(PROJECT_LINKS).last(),
    ]);
    if (recentProject) {
      await recentProject.click();
      if (await this.waitForPrompt(page)) return;
    }

    const create = await firstVisible([
      page.getByRole("button", { name: NEW_PROJECT_NAME }),
      page.getByRole("button", { name: /nuevo proyecto|crear proyecto/i }),
      page.locator("button").filter({ has: page.locator("i", { hasText: /^add_2$/ }) }).last(),
      page.getByText(/\+\s*new project|new project/i),
    ]);
    if (!create) {
      throw new FlowError(
        "ui_changed",
        "Could not find a Flow project or the New project control.",
        ["Reconnect with flow_begin_account_connection and flow_complete_account_connection, then retry."],
      );
    }
    await create.click();
    if (!(await this.waitForPrompt(page))) {
      throw new FlowError("ui_changed", "A Flow project opened, but the prompt editor could not be located.");
    }
  }

  private async waitForPrompt(page: Page, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await firstVisible([this.promptLocator(page)])) return true;
      await page.waitForTimeout(500);
    }
    return false;
  }

  private manualModelDropdown(page: Page): Locator {
    return page.getByRole("button", {name:/^(?:모델 제품군 선택|모델 선택|select model family|model family selector|select model)$/i});
  }

  private async openManualSettingsPanel(page: Page, trigger: Locator): Promise<void> {
    const dropdown = this.manualModelDropdown(page).first();
    if (await dropdown.isVisible().catch(()=>false)) return;
    // Observe the completed UI state: a trigger may dismiss a stale popover first.
    for (let attempt=0;attempt<2;attempt++) {
      await trigger.click();
      if (await dropdown.waitFor({state:"visible",timeout:2000}).then(()=>true).catch(()=>false)) return;
    }
    throw new FlowError("ui_changed", "The manual settings panel did not open after its normal trigger was clicked.");
  }

  private async closeManualSettingsPanel(page: Page): Promise<void> {
    const dropdown = this.manualModelDropdown(page).first();
    await page.keyboard.press("Escape").catch(()=>undefined);
    if (await dropdown.waitFor({state:"hidden",timeout:1000}).then(()=>true).catch(()=>false)) return;
    const trigger = await firstVisible([page.getByRole("button", {name:/^(?:설정 트리거|settings trigger)$/i})]);
    if (!trigger) throw new FlowError("ui_changed", "The manual settings panel could not be closed.");
    await trigger.click();
    await dropdown.waitFor({state:"hidden",timeout:2000});
  }

  private async configureGeneration(page: Page, request: GenerationRequest): Promise<"auto_approve" | "direct_submit"> {
    const manualTrigger = await firstVisible([page.getByRole("button", {name:/^(?:설정 트리거|settings trigger)$/i})]);
    if (manualTrigger) {
      await this.openManualSettingsPanel(page, manualTrigger);
      try {
        if (await configureManualSettings(page, request)) return "direct_submit";
      } finally { await this.closeManualSettingsPanel(page); }
    }
    // Agent-only approval settings do not exist in the verified manual composer.
    // Both paths still require the MCP tool's explicit confirmCreditSpend=true.
    await this.ensureAgentAutoApprove(page);
    if (await this.openAgentSettings(page)) {
      await this.configureAgentGeneration(page, request);
      return "auto_approve";
    }

    const settings = await firstVisible([
      page.getByRole("button", { name: /settings|options|generation settings|설정|옵션/i }).last(),
      page.getByRole("button", { name: /nano banana|veo|omni|image|video/i }).last(),
    ]);
    if (!settings) {
      throw new FlowError("ui_changed", "Could not find Flow's generation settings/model control.");
    }
    await settings.click();
    await page.waitForTimeout(300);

    await this.clickChoice(page, request.mediaType === "video" ? /^video$/i : /^image$/i, "media type");
    if (request.model && request.model !== "ui-default") {
      await this.openAndChoose(page, /model/i, new RegExp(this.escapeRegex(request.model), "i"), "model");
    }
    if (request.aspectRatio && request.aspectRatio !== "ui-default") {
      await this.openAndChoose(
        page,
        /aspect ratio|orientation/i,
        new RegExp(`^${this.escapeRegex(request.aspectRatio)}$`, "i"),
        "aspect ratio",
      );
    }
    if (request.mediaType === "video" && request.durationSeconds) {
      await this.openAndChoose(
        page,
        /duration|length/i,
        new RegExp(`^${request.durationSeconds}\\s*(?:s|sec|seconds?)$`, "i"),
        "duration",
      );
    }
    await this.openAndChoose(
      page,
      /outputs?|variations?/i,
      new RegExp(`^${request.outputs}(?:\\s+outputs?)?$`, "i"),
      "output count",
    );
    await page.keyboard.press("Escape").catch(() => undefined);
    return "auto_approve";
  }

  private async openAgentSettings(page: Page): Promise<boolean> {
    const tune = await firstVisible([
      page.locator("button").filter({ has: page.locator("i", { hasText: /^tune$/ }) }),
      page.locator("button").filter({ has: page.locator("i", { hasText: /^settings_2$/ }) }),
    ]);
    if (!tune) return false;
    await tune.click();
    await page.waitForTimeout(400);
    return (await page.locator('[role="tablist"]').count()) >= 2;
  }

  private async readAgentSettings(page: Page): Promise<AgentSettingsCapabilities> {
    const ratioGroups: string[][] = [];
    const outputGroups: number[][] = [];
    const selectableDurations: number[] = [];
    const tablists = page.locator('[role="tablist"]');
    const tablistCount = await tablists.count();
    for (let index = 0; index < tablistCount; index += 1) {
      const list = tablists.nth(index);
      if (!(await list.isVisible().catch(() => false))) continue;
      const labels = await visibleText(list.locator('[role="tab"]'));
      const durations = labels.map(parseDurationOption);
      if (durations.length && durations.every((value) => value !== undefined)) {
        selectableDurations.push(...durations as number[]);
      }
      const ratios = unique(labels.flatMap((label) => label.match(/\b(?:16:9|9:16|1:1|4:3|3:4)\b/g) ?? []));
      if (ratios.length) ratioGroups.push(ratios);
      const outputs = uniqueNumbers(labels.map(parseOutputCount).filter((value): value is number => value !== undefined));
      if (outputs.length && outputs.every((value) => value >= 1 && value <= 4)) outputGroups.push(outputs);
    }

    const modelGroups: CapabilityOption[][] = [];
    const dropdowns = page.locator('button[aria-haspopup="menu"]');
    const dropdownCount = await dropdowns.count();
    for (let index = 0; index < dropdownCount; index += 1) {
      const dropdown = dropdowns.nth(index);
      if (!(await dropdown.isVisible().catch(() => false))) continue;
      const selectedLabel = cleanCapabilityLabel(await dropdown.innerText().catch(() => ""));
      if (!/(?:banana|omni|veo|imagen)/i.test(selectedLabel)) continue;
      await dropdown.click();
      await page.waitForTimeout(200);
      const labels = await visibleText(page.locator('[role="menuitem"]'));
      const options = labels
        .map(cleanCapabilityLabel)
        .filter((label) => /(?:banana|omni|veo|imagen)/i.test(label))
        .map((label) => ({
          id: normalizeCapabilityId(label),
          label,
          selected: normalizeCapabilityId(label) === normalizeCapabilityId(selectedLabel),
        }));
      if (options.length) modelGroups.push(options);
      await page.keyboard.press("Escape").catch(() => undefined);
    }

    return {
      models: {
        image: modelGroups[0] ?? [],
        video: modelGroups.at(-1) ?? [],
      },
      ratios: {
        image: ratioGroups[0] ?? [],
        video: ratioGroups.at(-1) ?? [],
      },
      outputs: {
        image: outputGroups[0] ?? [],
        video: outputGroups.at(-1) ?? [],
      },
      durationSeconds: uniqueNumbers(selectableDurations),
    };
  }

  private async configureAgentGeneration(
    page: Page,
    request: GenerationRequest,
  ): Promise<void> {
    const capabilities = await this.readAgentSettings(page);
    const media = request.mediaType;
    const modelOptions = capabilities.models[media];
    if (request.model && request.model !== "ui-default") {
      const requestedId = normalizeCapabilityId(request.model);
      const requested = modelOptions.find((option) => option.id === requestedId);
      if (!requested) {
        throw new FlowError(
          "unsupported_option",
          `Model '${request.model}' is not offered for ${media} generation.`,
          modelOptions.map((option) => `${option.id} (${option.label})`),
        );
      }
      if (!requested.selected) {
        const modelButtons = page.locator('button[aria-haspopup="menu"]').filter({ hasText: /banana|omni|veo|imagen/i });
        const target = media === "image" ? await firstVisible([modelButtons.first()]) : await firstVisible([modelButtons.last()]);
        if (!target) throw new FlowError("ui_changed", `Could not find the ${media} model dropdown.`);
        await target.click();
        await page.waitForTimeout(200);
        const items = page.locator('[role="menuitem"]');
        let choice: Locator | null = null;
        const count = await items.count();
        for (let index = 0; index < count; index += 1) {
          const item = items.nth(index);
          if (!await item.isVisible().catch(() => false)) continue;
          if (normalizeCapabilityId(await item.innerText().catch(() => "")) === requestedId) {
            choice = item;
            break;
          }
        }
        if (!choice) throw new FlowError("ui_changed", `Flow listed '${requested.label}', but its menu item disappeared.`);
        await choice.click();
      }
    }

    if (request.aspectRatio && request.aspectRatio !== "ui-default") {
      await this.chooseAgentTab(page, request.aspectRatio, media, "aspect ratio", (label) => label.includes(":"));
    }
    await this.chooseAgentTab(
      page,
      String(request.outputs),
      media,
      "output count",
      (label) => label.split(/\s+/).some((part) => parseOutputCount(part) !== undefined),
      (label) => parseOutputCount(label) === request.outputs,
    );

    if (request.mediaType === "video" && request.durationSeconds) {
      if (!capabilities.durationSeconds.length) {
        throw new FlowError(
          "unsupported_option",
          "The current Flow Agent UI does not expose a selectable video duration. Omit durationSeconds to use the selected model's Flow default.",
        );
      }
      if (!capabilities.durationSeconds.includes(request.durationSeconds)) {
        throw new FlowError(
          "unsupported_option",
          `The current video configuration offers ${capabilities.durationSeconds.join(", ")} seconds, not ${request.durationSeconds} seconds.`,
        );
      }
      await this.chooseAgentTab(page, String(request.durationSeconds), "video", "duration",
        (label) => /\d+\s*(?:s|sec|seconds?|초)(?:\s|$)/i.test(label),
        (label) => parseDurationOption(label) === request.durationSeconds);
    }

    const save = await lastVisible(page.locator("button"));
    if (!save) throw new FlowError("ui_changed", "Could not find the agent-settings save control.");
    await save.click();
    await page.waitForTimeout(500);
  }

  private async chooseAgentTab(
    page: Page,
    requested: string,
    media: MediaType,
    label: string,
    groupPredicate: (text: string) => boolean,
    choicePredicate: (text: string) => boolean = (text) => cleanCapabilityLabel(text) === requested,
  ): Promise<void> {
    const groups: Locator[] = [];
    const tablists = page.locator('[role="tablist"]');
    const count = await tablists.count();
    for (let index = 0; index < count; index += 1) {
      const list = tablists.nth(index);
      if (!await list.isVisible().catch(() => false)) continue;
      const text = (await list.innerText().catch(() => "")).replace(/\s+/g, " ");
      if (groupPredicate(text)) groups.push(list);
    }
    const group = media === "image" ? groups[0] : groups.at(-1);
    if (!group) throw new FlowError("unsupported_option", `Flow did not expose a ${media} ${label} control.`);
    const tabs = group.locator('[role="tab"]');
    const tabCount = await tabs.count();
    for (let index = 0; index < tabCount; index += 1) {
      const tab = tabs.nth(index);
      if (choicePredicate(await tab.innerText().catch(() => ""))) {
        await tab.click();
        return;
      }
    }
    throw new FlowError("unsupported_option", `The requested ${label} '${requested}' is not offered for ${media}.`);
  }

  private async openAndChoose(page: Page, controlName: RegExp, choice: RegExp, label: string): Promise<void> {
    let selected = await this.tryClickChoice(page, choice);
    if (selected) return;
    const control = await firstVisible([
      page.getByRole("button", { name: controlName }),
      page.getByText(controlName),
    ]);
    if (control) {
      await control.click();
      await page.waitForTimeout(250);
      selected = await this.tryClickChoice(page, choice);
    }
    if (!selected) {
      throw new FlowError(
        "unsupported_option",
        `The requested ${label} was not offered by the current Flow UI for this account or generation mode.`,
        ["Call flow_inspect_account to see visible controls, or use ui-default where supported."],
      );
    }
  }

  private async clickChoice(page: Page, choice: RegExp, label: string): Promise<void> {
    if (!(await this.tryClickChoice(page, choice))) {
      throw new FlowError("ui_changed", `Could not select Flow ${label}.`);
    }
  }

  private async tryClickChoice(page: Page, choice: RegExp): Promise<boolean> {
    const candidate = await firstVisible([
      page.getByRole("option", { name: choice }),
      page.getByRole("menuitem", { name: choice }),
      page.getByRole("button", { name: choice }),
      page.getByText(choice, { exact: true }),
    ]);
    if (!candidate) return false;
    await candidate.click();
    await page.waitForTimeout(200);
    return true;
  }

  private async attachReferences(page: Page, files: string[]): Promise<void> {
    if (!files.length) return;
    for (const file of files) await access(file);
    let input = page.locator('input[type="file"]');
    if ((await input.count()) === 0) {
      const add = await firstVisible([
        page.getByRole("button", { name: /add.*(?:image|media|ingredient|reference|frame)|upload/i }),
        page.getByText(/add.*(?:image|media|ingredient|reference|frame)|upload/i),
      ]);
      if (add) await add.click();
      input = page.locator('input[type="file"]');
    }
    if ((await input.count()) === 0) {
      throw new FlowError("ui_changed", "Reference files were supplied, but Flow's file input could not be found.");
    }
    await input.last().setInputFiles(files);
    await page.waitForTimeout(1_000);
  }

  private async fillPrompt(page: Page, prompt: string): Promise<void> {
    const editor = await firstVisible([this.promptLocator(page)]);
    if (!editor) throw new FlowError("ui_changed", "Could not locate Flow's prompt editor.");
    const tag = await editor.evaluate((element) => element.tagName.toLowerCase());
    if (tag === "textarea" || tag === "input") await editor.fill(prompt);
    else {
      await editor.click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText(prompt);
    }
  }

  private async ensureAgentAutoApprove(page: Page): Promise<void> {
    await page.keyboard.press("Escape").catch(() => undefined);
    const openSettings = async (): Promise<Locator> => {
      const alreadyOpen = await firstVisible([page.locator('[role="radio"][value="AUTO_APPROVE"]')]);
      if (alreadyOpen) return alreadyOpen;
      const settings = await firstVisible([
        page.locator("button").filter({ has: page.locator("i", { hasText: /^tune$/ }) }).last(),
      ]);
      if (!settings) {
        throw new FlowError("ui_changed", "Flow Agent settings could not be opened to disable repeated credit confirmations.");
      }
      await settings.click();
      await page.waitForTimeout(300);
      const radio = await firstVisible([page.locator('[role="radio"][value="AUTO_APPROVE"]')]);
      if (!radio) {
        throw new FlowError("ui_changed", "Flow Agent settings did not expose the language-independent AUTO_APPROVE option.");
      }
      return radio;
    };
    const closeSettings = async (): Promise<void> => {
      const close = await firstVisible([
        page.locator("button").filter({ has: page.locator("i", { hasText: /^close$/ }) }).last(),
      ]);
      if (close) await close.click();
      else await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(200);
    };

    let autoApprove = await openSettings();
    if (await autoApprove.getAttribute("aria-checked") !== "true") {
      await autoApprove.click();
      const save = await lastVisible(page.locator("button:not([role])").filter({ hasNot: page.locator("i") }));
      if (!save) {
        throw new FlowError("ui_changed", "Flow Agent settings did not expose its Save control.");
      }
      await save.click();
      await page.waitForTimeout(500);
      if (await autoApprove.isVisible().catch(() => false)) await closeSettings();

      autoApprove = await openSettings();
      if (await autoApprove.getAttribute("aria-checked") !== "true") {
        throw new FlowError("generation_failed", "Flow did not persist its AUTO_APPROVE credit-confirmation setting after Save.");
      }
    }
    await closeSettings();
  }

  private async clickGenerate(page: Page, mediaType: MediaType, mediaBaseline: number): Promise<void> {
    const agentUi = Boolean(await firstVisible([
      page.locator("button").filter({ has: page.locator("i", { hasText: /^tune$/ }) }),
    ]));
    const checkIcons = page.locator("i.google-symbols").filter({ hasText: /^check$/ });
    const approvalBaseline = await visibleCount(checkIcons);
    const button = await firstVisible([
      page.locator("button").filter({ has: page.locator("i", { hasText: /^arrow_forward$/ }) }).last(),
      page.getByRole("button", { name: /^(?:generate(?: image| video)?|생성 시작)$/i }).last(),
      page.getByRole("button", { name: /^(?:crear|generar)$/i }).last(),
      page.getByText(/^generate(?: image| video)?$/i),
    ]);
    if (!button) throw new FlowError("ui_changed", "Could not find Flow's Generate control.");
    if (!(await button.isEnabled().catch(() => true))) {
      throw new FlowError("generation_failed", "Flow's Generate control is disabled after configuring the request.");
    }
    await button.click();
    await page.waitForTimeout(500);
    if (agentUi) {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const checks = await visibleCount(checkIcons);
        const preferredApproval = preferredPersistentApprovalIndex(approvalBaseline, checks);
        if (preferredApproval !== null) {
          const persistentCheck = await lastVisible(checkIcons);
          if (!persistentCheck) continue;
          const approve = persistentCheck.locator("xpath=ancestor::button[1]");
          await approve.click();
          await page.waitForTimeout(500);
          return;
        }
        if (await this.mediaLocator(page, mediaType).count() > mediaBaseline) return;
        const body = (await page.locator("body").innerText().catch(() => "")).slice(-8_000);
        if (FAILURE_TEXT.test(body)) throw new FlowError("generation_failed", "Flow reported that generation could not start.");
        await page.waitForTimeout(1_000);
      }
      throw new FlowError("ui_changed", "Flow Agent did not expose a credit confirmation or begin generation within 120 seconds.");
    }
    const dialog = await firstVisible([page.locator('[role="dialog"]')]);
    if (dialog) {
      const confirm = await lastVisible(dialog.locator("button"));
      if (confirm && await confirm.isEnabled().catch(() => false)) {
        const icon = await confirm.locator("i").innerText().catch(() => "");
        if (!/^close$/i.test(icon.trim())) await confirm.click();
      }
    }
  }

  private async inspectMediaStructure(page: Page): Promise<NonNullable<UiCapabilities["mediaDiagnostics"]>> {
    // Inspect only the rendered media surface. Never click, load, fetch or expose signed URL query values.
    return page.evaluate(() => {
      const sanitizeUrl = (raw: string): string => {
        if (!raw || raw.startsWith("blob:")) return raw;
        if (raw.startsWith("data:")) return raw.slice(0, raw.indexOf(",") + 1) + "<omitted>";
        try {
          const url = new URL(raw, location.href);
          for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "<redacted>");
          url.hash = "";
          return url.href;
        } catch { return raw.slice(0, 500); }
      };
      const attributes = (node: Element): Record<string, string> => {
        const result: Record<string, string> = {};
        for (const name of ["data-asset-id", "data-generation-id", "data-media-id", "data-id", "data-testid", "class", "role", "aria-expanded", "aria-controls", "aria-haspopup", "tabindex", "type", "href", "src", "data-src", "poster", "aria-label"]) {
          const value = node.getAttribute(name);
          if (value !== null) result[name] = /^(?:href|src|data-src|poster)$/.test(name) ? sanitizeUrl(value) : value.slice(0, 200);
        }
        return result;
      };
      const candidates = [...document.querySelectorAll('video, source, img, a[href], button, [role="button"]')];
      const selected = candidates.filter(node => {
        for (let parent: Element | null=node; parent; parent=parent.parentElement) {
          if (/Google\s*(?:계정|account)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i.test(parent.getAttribute("aria-label") ?? "")) return false;
          const href=parent.getAttribute("href") ?? "";
          if (/^https:\/\/accounts\.google\.com(?:[/:]|$)/i.test(href)) return false;
        }
        if (/^(VIDEO|SOURCE|A)$/.test(node.tagName)) return true;
        if (node instanceof HTMLImageElement) return node.width >= 128 || node.height >= 128 || node.naturalWidth >= 256;
        return /play_arrow|play_circle|\bplay\b|재생/i.test((node.getAttribute("aria-label") ?? "") + " " + (node.textContent ?? ""));
      }).slice(0, 60);
      return {
        flowCustomTags: [...new Set([...document.querySelectorAll("*")].map(node=>node.tagName).filter(tag=>tag.startsWith("FLOW-")))],
        editorControls: [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"]')]
          .filter(node => (node as HTMLElement).getClientRects().length && !/Google\s*(?:계정|account)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i.test((node.getAttribute("aria-label") ?? "")+" "+(node.textContent??"")))
          .slice(0,80).map(node=>({tag:node.tagName,role:node.getAttribute("role"),label:(node.textContent??"").trim().slice(0,200),attributes:attributes(node)})),
        playerSurfaces: [...document.querySelectorAll("video")].slice(0,5).map((video,index)=>{
          let surface:Element=video;
          for(let depth=0;depth<3;depth++){
            const parent=surface.parentElement;
            if(!parent || /^(BODY|HTML|MAIN)$/.test(parent.tagName) || parent.querySelector('a[href*="accounts.google.com"]'))break;
            surface=parent;
          }
          const copy=surface.cloneNode(true) as Element;
          for(const node of [copy,...copy.querySelectorAll("*")]){
            if(/^(SCRIPT|STYLE)$/.test(node.tagName)){node.remove();continue;}
            for(const attribute of [...node.attributes]){
              if(!/^(?:class|role|aria-[a-z-]+|tabindex|type|disabled|src|href|poster|data-testid|data-asset-id|data-generation-id|data-media-id)$/.test(attribute.name))node.removeAttribute(attribute.name);
              else if(/^(?:src|href|poster)$/.test(attribute.name))node.setAttribute(attribute.name,sanitizeUrl(attribute.value));
              else if(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(attribute.value))node.removeAttribute(attribute.name);
            }
          }
          return {index,html:copy.outerHTML.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,"<email omitted>").slice(0,25000)};
        }),
        videoCount: document.querySelectorAll("video").length,
        imageCount: document.querySelectorAll("img").length,
        videoTiles: [...document.querySelectorAll("flow-video-tile")].slice(0,3).map((tile,index) => {
          const copy=tile.cloneNode(true) as Element;
          for(const node of [copy,...copy.querySelectorAll("*")]) {
            if(/^(SCRIPT|STYLE)$/.test(node.tagName)){node.remove();continue;}
            for(const attribute of [...node.attributes]) {
              if(!/^(?:class|role|aria-[a-z-]+|tabindex|type|disabled|src|href|poster|data-testid|data-asset-id|data-generation-id|data-media-id)$/.test(attribute.name)) node.removeAttribute(attribute.name);
              else if(/^(?:src|href|poster)$/.test(attribute.name)) node.setAttribute(attribute.name,sanitizeUrl(attribute.value));
              else if(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(attribute.value)) node.removeAttribute(attribute.name);
            }
          }
          return {index,html:copy.outerHTML.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,"<email omitted>").slice(0,30000)};
        }),
        overlayControls: [...document.querySelectorAll('.cdk-overlay-container button, .cdk-overlay-container [role], .cdk-overlay-container i, .cdk-overlay-container mat-icon')]
          .filter(node => (node as HTMLElement).getClientRects().length && !/Google\s*(?:계정|account)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i.test(node.getAttribute("aria-label") ?? ""))
          .slice(0,60).map(node=>({tag:node.tagName,role:node.getAttribute("role"),label:(node.textContent??"").trim().replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,"<email omitted>").slice(0,200),attributes:attributes(node)})),
        elements: selected.map(node => {
          const ancestors: Array<{ tag: string; attributes: Record<string, string> }> = [];
          let ancestor = node.parentElement;
          for (let depth=0; ancestor && depth<6; depth++, ancestor=ancestor.parentElement) {
            ancestors.push({tag:ancestor.tagName,attributes:attributes(ancestor)});
          }
          return {
            tag: node.tagName, role: node.getAttribute("role"),
            label: /^(BUTTON|A)$/.test(node.tagName) || node.getAttribute("role") === "button" ? (node.textContent ?? "").trim().slice(0, 200) : "",
            visible: Boolean((node as HTMLElement).getClientRects().length),
            attributes: attributes(node), ancestors,
            ...(node instanceof HTMLVideoElement ? {video:{
              currentSrc:sanitizeUrl(node.currentSrc), src:sanitizeUrl(node.getAttribute("src") ?? ""),
              poster:sanitizeUrl(node.poster),readyState:node.readyState,networkState:node.networkState,
              duration:Number.isFinite(node.duration) ? node.duration : null,
            }} : {}),
          };
        }),
      };
    });
  }

  private mediaLocator(page: Page, type: MediaType): Locator {
    if (type === "video") {
      const mainVideo = "flow-editor-page flow-video-editor .main-video-container .video-wrapper > video.main-video:visible";
      // The detail view's selected history thumbnail represents this same main
      // video; counting it separately would fabricate a second generated output.
      return page.locator(mainVideo + ", body:not(:has(" + mainVideo + ")) :is(video, flow-video-tile:not(:has(video)))");
    }
    return page.locator('img[src^="blob:"], img[src*="googleusercontent"], img[src*="ggpht"]');
  }

  private async mediaSnapshots(page: Page, type: MediaType): Promise<MediaSnapshot[]> {
    return this.mediaLocator(page, type).evaluateAll((elements) => elements.map((element, index) => {
      const keys: string[] = [];
      let sourceUrl: string | undefined;
      const addUrl = (raw: string | null | undefined, playableSource = true) => {
        if (!raw) return;
        try {
          if (playableSource) sourceUrl ??= new URL(raw, window.location.href).href;
        } catch {
          // Identity fallback below still applies.
        }
        keys.push(`url:${raw}`);
        if (!raw.startsWith("blob:")) {
          try {
            const parsed = new URL(raw, window.location.href);
            const originalParameterCount = [...parsed.searchParams].length;
            for (const name of [...parsed.searchParams.keys()]) {
              if (/^(?:x-goog-|signature$|sig$|expire$|expires$|token$|key-pair-id$)/i.test(name)) {
                parsed.searchParams.delete(name);
              }
            }
            parsed.hash = "";
            parsed.searchParams.sort();
            if (parsed.searchParams.size > 0 || originalParameterCount === 0) {
              keys.push(`url-stable:${parsed.toString()}`);
            }
          } catch {
            // The exact value above remains a usable identity.
          }
        }
      };

      let videoSourceKeys: string[] = [];
      if (element instanceof HTMLVideoElement) {
        addUrl(element.currentSrc);
        addUrl(element.getAttribute("src"));
        for (const source of element.querySelectorAll("source")) addUrl(source.src || source.getAttribute("src"));
        videoSourceKeys = [...keys];
        addUrl(element.poster, false);
      } else if (element instanceof HTMLImageElement) {
        addUrl(element.currentSrc);
        addUrl(element.getAttribute("src"));
      }

      const videoTile = element.closest("flow-video-tile");
      if (videoTile) {
        const footer = videoTile.querySelector('flow-tile-hover-footer [role="button"]');
        const promptText = (footer?.textContent ?? "").replace(/^(?:play_circle|play_arrow)\s*/, "").replace(/\s+/g, " ").trim();
        if (promptText) keys.push("flow-prompt:" + promptText);
        // A lazy tile's thumbnail identifies the asset, but is never a video source.
        // Keep that identity on the same activated video only; a replacement video
        // or changed source cannot inherit a previous asset's cached thumbnail.
        type TileIdentity = { urls: string[]; owner?: Element; sourceKeys?: string[] };
        const state = window as unknown as { __flowMcpTileIdentities?: WeakMap<Element, TileIdentity> };
        const cache = state.__flowMcpTileIdentities ??= new WeakMap<Element, TileIdentity>();
        const sourceKeys = videoSourceKeys;
        const thumbnails = [...videoTile.querySelectorAll("img")]
          .flatMap(image => [image.currentSrc, image.getAttribute("src") ?? ""]).filter(Boolean);
        let cached = cache.get(videoTile);
        if (thumbnails.length) {
          cached = {urls:[...new Set(thumbnails)], ...(element instanceof HTMLVideoElement && sourceUrl ? {owner:element,sourceKeys} : {})};
          cache.set(videoTile, cached);
        }
        if (cached && (!cached.owner || cached.owner === element && cached.sourceKeys?.some(key => sourceKeys.includes(key)))) {
          for (const thumbnail of cached.urls) addUrl(thumbnail, false);
          if (element instanceof HTMLVideoElement && sourceUrl && !cached.owner) {
            cached.owner = element;
            cached.sourceKeys = sourceKeys;
          }
        }
      }

      if (element instanceof HTMLVideoElement && element.matches("flow-video-editor .main-video-container .video-wrapper > video.main-video")) {
        const editor = element.closest("flow-editor-page");
        const histories = editor?.querySelectorAll("flow-editor-history-step-video flow-tile-container.selected.high-emphasis");
        const prompts = editor?.querySelectorAll("flow-expandable-prompt");
        const thumbnails = histories?.length === 1 ? histories[0]!.querySelectorAll("flow-video-tile img.thumbnail") : undefined;
        if (thumbnails?.length === 1 && prompts?.length === 1) {
          const promptCopy = prompts[0]!.cloneNode(true) as Element;
          for (const control of promptCopy.querySelectorAll('button, [role="button"], mat-icon, i')) control.remove();
          const prompt = (promptCopy.textContent ?? "").replace(/\s+/g," ").trim();
          if (prompt) {
            const thumbnail = thumbnails[0] as HTMLImageElement;
            addUrl(thumbnail.currentSrc, false);
            addUrl(thumbnail.getAttribute("src"), false);
            keys.push("flow-prompt:" + prompt);
            if (location.hostname === "flow.google.com" && /^\/project\/[0-9a-f-]+\/edit\/[0-9a-f-]+\/?$/i.test(location.pathname)) keys.push("flow-edit-route:" + location.pathname);
          }
        }
      }

      let current: Element | null = element;
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        for (const attribute of ["data-asset-id", "data-generation-id", "data-media-id"]) {
          const value = current.getAttribute(attribute);
          if (value) keys.push(`${attribute}:${value}`);
        }
      }

      if (!keys.length) {
        const html = element as HTMLElement;
        html.dataset.flowMcpAssetKey ||= `dom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        keys.push(html.dataset.flowMcpAssetKey);
      }

      const ready = element instanceof HTMLVideoElement
        ? element.readyState >= 1 && Number.isFinite(element.duration) && element.duration > 0
        : element instanceof HTMLImageElement && element.complete && element.naturalWidth >= 256;
      return { index, keys: [...new Set(keys)], ready, ...(element.tagName === "FLOW-VIDEO-TILE" ? {lazyVideo:true} : {}), ...(sourceUrl ? { sourceUrl } : {}) };
    }));
  }

  private async stableMediaBaseline(page: Page, type: MediaType): Promise<MediaSnapshot[]> {
    const deadline = Date.now() + 3_000;
    let previous = "";
    let stableRounds = 0;
    let snapshots: MediaSnapshot[] = [];
    while (Date.now() < deadline && stableRounds < 2) {
      snapshots = await this.mediaSnapshots(page, type);
      const signature = JSON.stringify(snapshots.map((snapshot) => snapshot.keys).sort());
      stableRounds = signature === previous ? stableRounds + 1 : 0;
      previous = signature;
      if (stableRounds < 2) await page.waitForTimeout(400);
    }
    return snapshots;
  }

  private async activateLazyVideo(page: Page, identity: MediaSnapshot): Promise<void> {
    if (!hasPersistentMediaIdentity(identity)) return;
    const matched = resolveMediaIdentities(await this.mediaSnapshots(page, "video"), identitiesFor([identity]));
    if (!matched?.[0]) throw new FlowError("generated_asset_not_found", "The lazy video card no longer has a unique identity; no other gallery item was opened.");
    if (!matched[0].lazyVideo) return;
    const tile = this.mediaLocator(page, "video").nth(matched[0].index).locator("xpath=ancestor-or-self::flow-video-tile[1]");
    await tile.scrollIntoViewIfNeeded();
    await tile.hover();
    if (await tile.locator("video").first().waitFor({state:"attached",timeout:1200}).then(()=>true).catch(()=>false)) return;
    // The mobile badge is a visual marker; its thumbnail is the observed pointer target.
    const badges = tile.locator(".mobile-play-badge").filter({hasText:/^\s*play_arrow\s*$/});
    const visibleBadges: Locator[] = [];
    for(let index=0;index<await badges.count();index++) {
      const badge=badges.nth(index);
      if(await badge.isVisible() && await badge.isEnabled()) visibleBadges.push(badge);
    }
    if(visibleBadges.length>1) throw new FlowError("ui_changed", "The tracked video card has multiple mobile playback badges; none was clicked.");
    if(visibleBadges.length===1) {
      const thumbnails = tile.locator(".container.mobile > img.thumbnail");
      const visibleThumbnails: Locator[] = [];
      for(let index=0;index<await thumbnails.count();index++) {
        const thumbnail=thumbnails.nth(index);
        if(await thumbnail.isVisible() && await thumbnail.isEnabled()) visibleThumbnails.push(thumbnail);
      }
      if(visibleThumbnails.length!==1) throw new FlowError("ui_changed", "The tracked mobile video card has no unique visible thumbnail click surface.");
      await visibleThumbnails[0]!.click();
      await tile.locator("video").first().waitFor({state:"attached",timeout:2000}).catch(()=>undefined);
    }

  }

  private async captureMediaIdentityDiagnostics(page: Page, details: unknown): Promise<string[]> {
    const paths:string[]=[];
    const screenshot=await this.captureDiagnostic(page,"media-identity");
    if(screenshot)paths.push("Media identity screenshot: "+screenshot);
    try{
      const file=this.store.diagnosticPath("media-identity","json");
      const payload={url:page.url(),details,structure:await this.inspectMediaStructure(page)};
      const sanitized=JSON.stringify(payload,(_key,value:unknown)=>{
        if(typeof value!=="string")return value;
        return value.replace(/https?:\/\/[^\s"<>]+/g,raw=>{
          try{const url=new URL(raw);for(const key of [...url.searchParams.keys()])url.searchParams.set(key,"<redacted>");return url.href;}catch{return raw;}
        });
      },2);
      await writeFile(file,sanitized+"\n","utf8");
      paths.push("Media identity structure: "+file);
    }catch{/* Diagnostic failure must preserve the original identity error. */}
    return paths;
  }

  private async waitForNewMedia(
    page: Page,
    type: MediaType,
    baselineKeys: string[],
    expectedCount: number,
    timeoutSeconds: number,
  ): Promise<MediaSnapshot[] | null> {
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      const body = (await page.locator("body").innerText().catch(() => "")).slice(-10_000);
      if (FAILURE_TEXT.test(body)) {
        throw new FlowError("generation_failed", "Flow reported that the generation failed or requires attention.");
      }
      const media = this.mediaLocator(page, type);
      await media.evaluateAll((elements) => {
        for (const element of elements) {
          if (element instanceof HTMLVideoElement && element.readyState < 1 && (element.networkState === 0 || element.networkState === 3)) {
            element.preload = "metadata";
            element.load();
          }
        }
      }).catch(() => undefined);
      // Wait for a persistent identity before interacting with a generation placeholder.
      let candidates = selectNewMedia(await this.mediaSnapshots(page, type), baselineKeys)
        .filter(candidate=>!candidate.lazyVideo || hasPersistentMediaIdentity(candidate));
      if (candidates.length > expectedCount) throw new FlowError("generated_asset_not_found", "Flow exposes more new assets than this job requested; refusing to choose another gallery item.", await this.captureMediaIdentityDiagnostics(page,{stage:"before-activation",expectedCount,baselineKeys,candidates}));
      if (type === "video") {
        const beforeActivation=candidates;
        for (const candidate of candidates) if (candidate.lazyVideo) await this.activateLazyVideo(page, candidate);
        const afterActivation = await this.mediaSnapshots(page, type);
        if (beforeActivation.some(candidate=>candidate.lazyVideo)) {
          const handoff = resolveMediaIdentities(afterActivation, identitiesFor(beforeActivation));
          if (!handoff) throw new FlowError("generated_asset_not_found", "The opened player could not be uniquely linked to the tracked video card.", await this.captureMediaIdentityDiagnostics(page,{stage:"player-handoff",expectedCount,baselineKeys,beforeActivation,candidates:afterActivation}));
          candidates = selectNewMedia(handoff, baselineKeys);
        } else candidates = selectNewMedia(afterActivation, baselineKeys)
          .filter(candidate=>!candidate.lazyVideo || hasPersistentMediaIdentity(candidate));
        if (candidates.length > expectedCount) throw new FlowError("generated_asset_not_found", "New asset identities changed while opening the tracked video card.", await this.captureMediaIdentityDiagnostics(page,{stage:"after-activation",expectedCount,baselineKeys,beforeActivation,candidates}));
      }
      const readiness = await Promise.all(candidates.map(async (candidate) => ({
        candidate,
        ready: candidate.ready || await this.isMediaSourceReady(page, candidate, type),
      })));
      const ready = readiness.filter((entry) => entry.ready).map((entry) => entry.candidate);
      if (ready.length >= expectedCount) {
        return ready.slice(0, expectedCount);
      }
      await page.waitForTimeout(2_000);
    }
    return null;
  }

  private async isMediaSourceReady(page: Page, candidate: MediaSnapshot, type: MediaType): Promise<boolean> {
    if (!candidate.sourceUrl || candidate.sourceUrl.startsWith("blob:")) return false;
    try {
      const response = await page.context().request.head(candidate.sourceUrl, { timeout: 8_000 });
      const contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
      const ready = response.ok() && contentType.startsWith(`${type}/`);
      await response.dispose();
      return ready;
    } catch {
      return false;
    }
  }

  private async openAssetMenu(page: Page, media: Locator): Promise<void> {
    await page.keyboard.press("Escape").catch(() => undefined);
    let surface = media;
    if (!await surface.isVisible().catch(() => false)) {
      const parentButton = media.locator("xpath=ancestor::button[1]");
      if (await parentButton.isVisible().catch(() => false)) surface = parentButton;
    }
    if (!await surface.isVisible().catch(() => false)) {
      throw new FlowError("ui_changed", "The generated asset exists, but Flow did not expose a visible asset card.");
    }
    await surface.scrollIntoViewIfNeeded();
    await surface.dispatchEvent("contextmenu", { button: 2 });
    await page.waitForTimeout(300);
    const menuVisible = await firstVisible([
      page.locator('[role="menuitem"]').filter({ has: page.locator("i.google-symbols", { hasText: /^download$/ }) }),
      page.locator('[role="menu"]'),
    ]);
    if (menuVisible) return;

    await page.keyboard.press("Escape").catch(() => undefined);
    await surface.hover();
    const more = await firstVisible([
      surface.locator("xpath=ancestor-or-self::*[position() <= 4]//button").filter({ has: page.locator("i.google-symbols", { hasText: /^more_vert$/ }) }).last(),
      page.getByRole("button", { name: /more|menu|options/i }).last(),
      page.locator('button[aria-label*="more" i], button[aria-label*="menu" i]').last(),
    ]);
    if (!more) throw new FlowError("ui_changed", "Could not open the generated asset's context menu.");
    await more.click();
    await page.waitForTimeout(300);
  }

  private async readVideoDownloadOptions(page: Page, media: Locator): Promise<import("./types.js").UpscaleOption[]> {
    await media.evaluate((element) => {
      if (!(element instanceof HTMLVideoElement)) return;
      if (element.readyState < 1) {
        element.preload = "metadata";
        element.load();
      }
    }).catch(() => undefined);
    await page.waitForTimeout(500);
    const originalHeight = await media.evaluate((element) => element instanceof HTMLVideoElement ? element.videoHeight : 0)
      .catch(() => 0);
    await this.openAssetMenu(page, media);
    const download = await firstVisible([
      page.locator('[role="menuitem"]').filter({ has: page.locator("i.google-symbols", { hasText: /^download$/ }) }),
    ]);
    if (download) {
      if (await download.getAttribute("aria-haspopup")) await download.hover({ force: true });
      else await download.click().catch(() => undefined);
      await page.waitForTimeout(400);
    }
    const entries: AssetMenuEntry[] = [];
    const items = page.locator('[role="menuitem"], [role="option"]');
    const itemCount = await items.count();
    for (let index = 0; index < itemCount; index += 1) {
      const item = items.nth(index);
      if (!await item.isVisible().catch(() => false)) continue;
      const text = await item.innerText().catch(() => "");
      if (!text.trim()) continue;
      const disabled = await item.evaluate((element) =>
        element.getAttribute("aria-disabled") === "true"
          || element.hasAttribute("data-disabled")
          || (element instanceof HTMLButtonElement && element.disabled),
      ).catch(() => false);
      entries.push({ text, disabled });
    }
    return extractUpscaleOptions(entries, originalHeight || undefined);
  }

  private async findVisibleMenuOption(page: Page, id: string): Promise<Locator | null> {
    const items = page.locator('[role="menuitem"], [role="option"]');
    const itemCount = await items.count();
    for (let index = 0; index < itemCount; index += 1) {
      const item = items.nth(index);
      if (!await item.isVisible().catch(() => false)) continue;
      if (normalizeUpscaleId(await item.innerText().catch(() => "")) === normalizeUpscaleId(id)) return item;
    }
    return null;
  }

  private async upscaleLatest(
    page: Page,
    job: FlowJob,
    requested: Exclude<UpscaleFactor, "none">,
    timeoutSeconds: number,
  ): Promise<boolean> {
    const media = this.mediaLocator(page, "video");
    const before = await this.mediaSnapshots(page, "video");
    const tracked = this.resolveTrackedMedia(before, job);
    const targetSnapshot = tracked.at(-1);
    if (!targetSnapshot) throw new FlowError("unsupported_option", "No generated video is visible to upscale.");
    const target = media.nth(targetSnapshot.index);
    const discovered = await this.readVideoDownloadOptions(page, target);
    const options = discovered
      .filter((option) => option.kind === "upscale" && option.available)
      .map((option) => option.id);

    const chosen = chooseUpscaleOption(options, requested);
    await this.store.updateJob(job, "upscaling", {
      availableUpscales: options,
      chosenUpscale: chosen,
      upscaleSubmitted: true,
      upscaleBaselineMediaKeys: flattenMediaKeys(before),
    });
    const choice = await this.findVisibleMenuOption(page, chosen);
    if (!choice) throw new FlowError("ui_changed", `Flow offered '${chosen}', but its control disappeared before selection.`);
    const downloadWait = page.waitForEvent("download", { timeout: timeoutSeconds * 1_000 })
      .then((download) => ({ kind: "download" as const, download }))
      .catch(() => ({ kind: "download_timeout" as const }));
    const mediaWait = this.waitForNewMedia(page, "video", flattenMediaKeys(before), 1, timeoutSeconds)
      .then((generated) => ({ kind: "media" as const, generated }));
    await choice.click();
    const result = await Promise.race([downloadWait, mediaWait]);
    if (result.kind === "download") {
      await this.saveCapturedDownload(job, result.download, chosen);
      return true;
    }
    const generated = result.kind === "media" ? result.generated : (await mediaWait).generated;
    if (!generated) {
      await this.store.updateJob(job, "processing");
      return false;
    }
    await this.store.updateJob(job, "ready", { generatedAssets: identitiesFor(generated) });
    return true;
  }

  private resolveTrackedMedia(snapshots: MediaSnapshot[], job: FlowJob): MediaSnapshot[] {
    if (!job.generatedAssets?.length) {
      throw new FlowError(
        "job_asset_identity_missing",
        "This job has no exact generated-asset identity. Refusing to guess from gallery order; generate it again with the current MCP version.",
      );
    }
    const resolved = resolveMediaIdentities(snapshots, job.generatedAssets);
    if (!resolved) {
      throw new FlowError(
        "generated_asset_not_found",
        "Flow no longer exposes a unique match for this job's generated asset. Refusing to download a different gallery item.",
      );
    }
    return resolved;
  }

  private async downloadTracked(page: Page, job: FlowJob): Promise<void> {
    await mkdir(job.outputDirectory, { recursive: true });
    let tracked = this.resolveTrackedMedia(await this.mediaSnapshots(page, job.mediaType), job);
    if (job.mediaType === "video") {
      for (const candidate of tracked) if (candidate.lazyVideo) await this.activateLazyVideo(page, candidate);
      tracked = this.resolveTrackedMedia(await this.mediaSnapshots(page, job.mediaType), job);
    }
    const assetCount = tracked.length;
    const downloaded: string[] = [];

    for (let offset = 0; offset < assetCount; offset += 1) {
      const targetSnapshot = tracked[offset]!;
      if (!targetSnapshot.sourceUrl) {
        throw new FlowError("download_failed", "The tracked Flow asset has no downloadable source URL.");
      }
      let response: APIResponse | undefined;
      try {
        let contentType: string;
        let body: Buffer;
        if (targetSnapshot.sourceUrl.startsWith("blob:")) {
          const captured = await page.evaluate(async (url) => {
            const result = await fetch(url);
            if (!result.ok) throw new Error(`HTTP ${result.status}`);
            const bytes = new Uint8Array(await result.arrayBuffer());
            let binary = "";
            for (let index = 0; index < bytes.length; index += 32_768) {
              binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
            }
            return { base64: btoa(binary), contentType: result.headers.get("content-type") ?? "" };
          }, targetSnapshot.sourceUrl);
          contentType = captured.contentType.toLowerCase();
          body = Buffer.from(captured.base64, "base64");
        } else {
          response = await page.context().request.get(targetSnapshot.sourceUrl, { timeout: 120_000 });
          contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
          if (!response.ok()) {
            throw new FlowError("download_failed", `Flow returned HTTP ${response.status()} for the tracked asset.`);
          }
          body = await response.body();
        }
        if (!contentType.startsWith(`${job.mediaType}/`)) {
          throw new FlowError("download_failed", `Flow returned ${contentType || "an unknown content type"} for the tracked asset.`);
        }
        const extension = mediaExtension(contentType, job.mediaType);
        const stem = safeFileStem(job.fileName || job.prompt.slice(0, 60));
        const suffix = assetCount > 1 ? `-${offset + 1}` : "";
        const destination = path.join(job.outputDirectory, `${stem}-${job.id}${suffix}${extension}`);
        await writeMediaFile(destination, body);
        downloaded.push(destination);
      } catch (error) {
        if (error instanceof FlowError) throw error;
        throw new FlowError("download_failed", `Could not download the tracked Flow asset: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await response?.dispose().catch(() => undefined);
      }
    }

    const probes = await Promise.all(downloaded.map((file) => probeMedia(file)));
    const completed = await this.store.updateJob(job, "completed", {
      downloadedFiles: downloaded,
      mediaProbe: probes,
    });
    await this.writeManifest(completed);
  }

  private async saveCapturedDownload(job: FlowJob, download: Download, suffix: string): Promise<void> {
    await mkdir(job.outputDirectory, { recursive: true });
    const suggested = download.suggestedFilename();
    const extension = path.extname(suggested) || ".mp4";
    const stem = safeFileStem(job.fileName || job.prompt.slice(0, 60));
    const normalizedSuffix = safeFileStem(normalizeUpscaleId(suffix));
    const destination = path.join(
      job.outputDirectory,
      `${stem}-${job.id}-${normalizedSuffix}${extension}`,
    );
    await writeMediaFile(destination, await readFile(await download.path()));
    const probe = await probeMedia(destination);
    const completed = await this.store.updateJob(job, "completed", {
      downloadedFiles: [...(job.downloadedFiles ?? []), destination],
      mediaProbe: [...(job.mediaProbe ?? []), probe],
    });
    await this.writeManifest(completed);
  }

  private async writeManifest(job: FlowJob): Promise<void> {
    if (!job.downloadedFiles?.length) return;
    const first = job.downloadedFiles[0]!;
    const manifest = `${first.slice(0, first.length - path.extname(first).length)}.flow.json`;
    await writeFile(manifest, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  }

  private async connectionDiagnostics(page: Page, accountId: string): Promise<string[]> {
    const result: string[] = [];
    const screenshot = await this.captureDiagnostic(page, `connect-${accountId}`);
    if (screenshot) result.push(`Diagnostic screenshot: ${screenshot}`);
    try {
      const url = new URL(page.url());
      const file = this.store.diagnosticPath(`connect-${accountId}`, "json");
      await writeFile(file, JSON.stringify({
        origin: url.origin,
        route: url.pathname.replace(/(project|edit)\/[^/]+/g, "$1/<id>"),
        language: await page.locator("html").getAttribute("lang"),
        access: await this.pageAccessState(page),
        projectLinks: await page.locator(PROJECT_LINKS).count(),
        namedProjectControls: await page.getByRole("button", { name: NEW_PROJECT_NAME }).count(),
        promptEditors: await this.promptLocator(page).count(),
        editorStructure: await page.locator('input, textarea, [contenteditable], [role="textbox"]').evaluateAll(nodes => nodes.slice(0,30).map(node => ({
          tag: node.tagName, role: node.getAttribute("role"), editable: node.getAttribute("contenteditable"),
          placeholder: node.getAttribute("placeholder") ?? node.getAttribute("data-placeholder"),
          ariaLabel: node.getAttribute("aria-label"),
        }))),
      }, null, 2), "utf8");
      result.push(`Structural diagnostic (no cookies or account names): ${file}`);
    } catch { /* Diagnostics must not replace the original connection error. */ }
    return result;
  }

  private async captureDiagnostic(page: Page, prefix: string): Promise<string | undefined> {
    try {
      const file = this.store.diagnosticPath(prefix);
      await page.screenshot({ path: file, fullPage: false });
      return file;
    } catch {
      return undefined;
    }
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
