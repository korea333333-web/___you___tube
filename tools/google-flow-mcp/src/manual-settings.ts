import type { Locator, Page } from "playwright";
import { cleanCapabilityLabel, normalizeCapabilityId, parseDurationOption, parseOutputCount, type CapabilityOption } from "./capabilities.js";

import { FlowError } from "./errors.js";
import type { GenerationRequest } from "./types.js";

type Media = "image" | "video";

export interface ManualSettingsCapabilities {
  models: { image: CapabilityOption[]; video: CapabilityOption[] };
  ratios: { image: string[]; video: string[] };
  outputs: { image: number[]; video: number[] };
  durationSeconds: number[];
  modelMenuDiagnostics?: Array<{
    media: Media;
    selectedLabel: string;
    options: Array<{ role: string; label: string; available: boolean }>;
  }>;
}

const MEDIA_NAMES: Record<Media, RegExp> = {
  image: /^(?:image\s+)?(?:이미지|image)$/i,
  video: /^(?:videocam\s+)?(?:동영상|비디오|video)$/i,
};
const MODEL_NAMES = /nano\s*banana|\b(?:veo|imagen|omni)\b/i;
const MODEL_SELECTOR_NAMES = /^(?:모델 제품군 선택|모델 선택|select model family|model family selector|select model)$/i;
const OPTION_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="option"]';

async function available(locator: Locator): Promise<boolean> {
  if (!await locator.isVisible().catch(() => false) || !await locator.isEnabled().catch(() => false)) return false;
  if (await locator.getAttribute("aria-disabled") === "true" || await locator.getAttribute("disabled") !== null) return false;
  const dataDisabled = await locator.getAttribute("data-disabled");
  return dataDisabled === null || dataDisabled === "false";
}

async function firstAvailable(locator: Locator): Promise<Locator | undefined> {
  const count = Math.min(await locator.count(), 40);
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    if (await available(candidate)) return candidate;
  }
  return undefined;
}

async function mediaRadio(page: Page, media: Media): Promise<Locator | undefined> {
  return firstAvailable(page.getByRole("radio", { name: MEDIA_NAMES[media] }));
}

async function checked(locator: Locator): Promise<boolean> {
  const ariaChecked = await locator.getAttribute("aria-checked");
  if (ariaChecked !== null) return ariaChecked === "true";
  if (!/^(?:radio|checkbox)$/i.test(await locator.getAttribute("type") ?? "")) return false;
  return locator.isChecked().catch(() => false);
}

function modelLabel(raw: string): string | undefined {
  return raw.split(/\r?\n/).map(cleanCapabilityLabel).find(label => MODEL_NAMES.test(label))?.slice(0, 200);
}

async function settingsScope(page: Page, radio: Locator): Promise<Locator> {
  // Use the nearest common ancestor of a media radio and the observed model
  // selector; this avoids collecting radios elsewhere in the project UI.
  const labelled = radio.locator('xpath=ancestor::*[.//button[@aria-label="모델 제품군 선택" or @aria-label="모델 선택" or @aria-label="select model family" or @aria-label="model family selector" or @aria-label="select model"]][1]');
  if (await labelled.count() && await labelled.isVisible()) return labelled;
  const popup = radio.locator('xpath=ancestor::*[@role="dialog" or @role="menu" or @data-radix-popper-content-wrapper][1]');
  if (await popup.count() && await popup.isVisible()) return popup;
  // Unknown panel boundaries must not cause page-wide capability inference.
  return radio.locator("xpath=..");
}

async function readModelMenu(page: Page, scope: Locator, media: Media, result: ManualSettingsCapabilities): Promise<void> {
  let dropdown = await firstAvailable(scope.getByRole("button", { name: MODEL_SELECTOR_NAMES }));
  if (!dropdown) dropdown = await firstAvailable(scope.locator('button[aria-haspopup="menu"]').filter({ hasText: MODEL_NAMES }));
  if (!dropdown) return;
  const selectedLabel = modelLabel(await dropdown.innerText()) ?? "";
  const diagnostics: NonNullable<ManualSettingsCapabilities["modelMenuDiagnostics"]>[number] = { media, selectedLabel, options: [] };
  result.modelMenuDiagnostics?.push(diagnostics);
  await dropdown.click();
  try {
    await page.waitForTimeout(200);
    const controlledId = (await dropdown.getAttribute("aria-controls"))?.trim();
    const controlled = controlledId ? page.locator(`[id=${JSON.stringify(controlledId)}]`) : undefined;
    const options = controlled && await controlled.count() && await controlled.isVisible()
      ? controlled.locator(OPTION_SELECTOR)
      : page.locator(OPTION_SELECTOR);
    const count = Math.min(await options.count(), 80);
    const seen = new Set<string>();
    for (let index = 0; index < count; index++) {
      const option = options.nth(index);
      if (!await option.isVisible().catch(() => false)) continue;
      const label = modelLabel(await option.innerText());
      if (!label) continue;
      const enabled = await available(option);
      if (diagnostics.options.length < 20) diagnostics.options.push({ role: await option.getAttribute("role") ?? "", label, available: enabled });
      if (!enabled) continue;
      const id = normalizeCapabilityId(label);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.models[media].push({ id, label, selected: id === normalizeCapabilityId(selectedLabel) });
    }
  } finally {
    await page.keyboard.press("Escape");
  }
}

/** Read an already-open manual settings panel. Never select a model or submit media. */
export async function readManualSettings(page: Page): Promise<ManualSettingsCapabilities | undefined> {
  const radios = {
    image: await mediaRadio(page, "image"),
    video: await mediaRadio(page, "video"),
  };
  if (!radios.image && !radios.video) return undefined;
  const result: ManualSettingsCapabilities = {
    models: { image: [], video: [] }, ratios: { image: [], video: [] },
    outputs: { image: [], video: [] }, durationSeconds: [], modelMenuDiagnostics: [],
  };
  const original = radios.image && await checked(radios.image) ? "image"
    : radios.video && await checked(radios.video) ? "video" : undefined;
  // Without a known original selection, changing modes cannot be reliably undone.
  if (!original) return result;
  let changed = false;
  try {
    for (const media of ["image", "video"] as const) {
      const radio = await mediaRadio(page, media);
      if (!radio) continue;
      if (!await checked(radio)) {
        changed = true;
        await radio.click();
        await page.waitForTimeout(200);
        if (!await checked(radio)) throw new Error(`Flow did not select the ${media} settings radio.`);
      }
      const scope = await settingsScope(page, radio);
      const choices = scope.locator('[role="radio"], [role="tab"]');
      const count = Math.min(await choices.count(), 80);
      for (let index = 0; index < count; index++) {
        const choice = choices.nth(index);
        if (!await available(choice)) continue;
        const label = cleanCapabilityLabel(await choice.innerText());
        if (/^\d+:\d+$/.test(label) && !result.ratios[media].includes(label)) result.ratios[media].push(label);
        const output = parseOutputCount(label);
        if (output !== undefined && output >= 1 && output <= 4 && !result.outputs[media].includes(output)) result.outputs[media].push(output);
        const duration = media === "video" ? parseDurationOption(label) : undefined;
        if (duration !== undefined && !result.durationSeconds.includes(duration)) result.durationSeconds.push(duration);
      }
      await readModelMenu(page, scope, media, result);
    }
  } finally {
    if (changed) {
      const restore = await mediaRadio(page, original);
      if (!restore) throw new Error("Could not restore the original Flow media settings: its radio is unavailable.");
      if (!await checked(restore)) {
        await restore.click();
        await page.waitForTimeout(200);
        if (!await checked(restore)) throw new Error("Flow did not restore the original media settings.");
      }
    }
  }
  return result;
}

export type ManualSettingsRequest = Pick<GenerationRequest, "mediaType" | "model" | "aspectRatio" | "durationSeconds" | "outputs">;

async function selected(locator: Locator): Promise<boolean> {
  const ariaSelected = await locator.getAttribute("aria-selected");
  return ariaSelected !== null ? ariaSelected === "true" : checked(locator);
}

async function waitForSelection(page: Page, locator: Locator, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  do {
    if (await selected(locator)) return;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new FlowError("ui_changed", `Flow did not retain the selected ${label}.`);
}

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = Math.min(await locator.count(), 80);
  for (let index = 0; index < count; index++) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function modelDropdown(scope: Locator): Promise<Locator | undefined> {
  return await firstAvailable(scope.getByRole("button", { name: MODEL_SELECTOR_NAMES }))
    ?? await firstAvailable(scope.locator('button[aria-haspopup="menu"]').filter({ hasText: MODEL_NAMES }));
}

async function chooseModel(page: Page, scope: Locator, requested: string, media: Media): Promise<void> {
  const requestedId = normalizeCapabilityId(requested);
  const dropdown = await modelDropdown(scope);
  if (!dropdown) throw new FlowError("unsupported_option", `Flow did not expose a selectable ${media} model control.`);
  await dropdown.click();
  await page.waitForTimeout(200);
  const controlledId = (await dropdown.getAttribute("aria-controls"))?.trim();
  const controlled = controlledId ? page.locator(`[id=${JSON.stringify(controlledId)}]`) : undefined;
  const options = controlled && await controlled.count() && await controlled.isVisible()
    ? controlled.locator(OPTION_SELECTOR)
    : page.locator(OPTION_SELECTOR);
  try {
    let choice: Locator | undefined;
    const count = Math.min(await options.count(), 80);
    for (let index = 0; index < count; index++) {
      const option = options.nth(index);
      if (!await available(option)) continue;
      const label = modelLabel(await option.innerText());
      if (label && normalizeCapabilityId(label) === requestedId) { choice = option; break; }
    }
    if (!choice) throw new FlowError("unsupported_option", `Model '${requested}' is missing or disabled for ${media} generation.`);
    await choice.click();
    const deadline = Date.now() + 3_000;
    do {
      const current = await modelDropdown(scope);
      if (current && normalizeCapabilityId(modelLabel(await current.innerText()) ?? "") === requestedId) return;
      await page.waitForTimeout(100);
    } while (Date.now() < deadline);
    throw new FlowError("ui_changed", `Flow did not retain the selected model '${requested}'.`);
  } finally {
    // Selection normally closes its own menu. Escape only a still-visible model
    // menu, so we do not close the settings panel that the caller still needs.
    if (await anyVisible(options.filter({ hasText: MODEL_NAMES }))) await page.keyboard.press("Escape");
  }
}

interface RequestedChoice {
  label: string;
  matches: (value: string) => boolean;
}

async function findChoice(scope: Locator, request: RequestedChoice): Promise<Locator | undefined> {
  const choices = scope.locator('[role="radio"], [role="tab"]');
  const count = Math.min(await choices.count(), 80);
  for (let index = 0; index < count; index++) {
    const choice = choices.nth(index);
    if (await available(choice) && request.matches(cleanCapabilityLabel(await choice.innerText()))) return choice;
  }
  return undefined;
}

/** Configure an already-open manual panel only. No prompt, submission, or Agent approval changes. */
export async function configureManualSettings(page: Page, request: ManualSettingsRequest): Promise<boolean> {
  const hasManualControls = await anyVisible(page.getByRole("radio", { name: MEDIA_NAMES.image }))
    || await anyVisible(page.getByRole("radio", { name: MEDIA_NAMES.video }));
  if (!hasManualControls) return false;
  let radio = await mediaRadio(page, request.mediaType);
  if (!radio) throw new FlowError("unsupported_option", `Flow's ${request.mediaType} media option is missing or disabled.`);
  if (!await checked(radio)) await radio.click();
  await waitForSelection(page, radio, `${request.mediaType} media option`);
  let scope = await settingsScope(page, radio);
  if (request.model && request.model !== "ui-default") await chooseModel(page, scope, request.model, request.mediaType);
  const initialModelControl = await modelDropdown(scope);
  const expectedModelId = initialModelControl
    ? normalizeCapabilityId(modelLabel(await initialModelControl.innerText()) ?? "") : undefined;

  const requested: RequestedChoice[] = [];
  if (request.aspectRatio && request.aspectRatio !== "ui-default") {
    requested.push({ label: `aspect ratio '${request.aspectRatio}'`, matches: value => value === request.aspectRatio });
  }
  if (request.durationSeconds !== undefined) {
    if (request.mediaType !== "video") throw new FlowError("unsupported_option", "A selectable duration is only supported for video requests.");
    requested.push({ label: `duration '${request.durationSeconds} seconds'`, matches: value => parseDurationOption(value) === request.durationSeconds });
  }
  requested.push({ label: `output count '${request.outputs}'`, matches: value => parseOutputCount(value) === request.outputs });

  // Every lookup occurs after selecting the actual requested model. Never reuse
  // a duration or ratio list obtained for a different model during inspection.
  for (const choiceRequest of requested) {
    radio = await mediaRadio(page, request.mediaType);
    if (!radio) throw new FlowError("ui_changed", "The selected media controls disappeared while configuring Flow.");
    scope = await settingsScope(page, radio);
    const choice = await findChoice(scope, choiceRequest);
    if (!choice) throw new FlowError("unsupported_option", `The selected ${request.mediaType} model does not expose an enabled ${choiceRequest.label}.`);
    if (!await selected(choice)) await choice.click();
    await waitForSelection(page, choice, choiceRequest.label);
  }
  // Later controls can alter earlier settings; verify the final whole selection.
  radio = await mediaRadio(page, request.mediaType);
  if (!radio || !await checked(radio)) throw new FlowError("ui_changed", "Flow changed the requested media while configuring other options.");
  scope = await settingsScope(page, radio);
  if (expectedModelId) {
    const finalModel = await modelDropdown(scope);
    if (!finalModel || normalizeCapabilityId(modelLabel(await finalModel.innerText()) ?? "") !== expectedModelId) {
      throw new FlowError("ui_changed", "Flow changed the requested model while configuring other options.");
    }
  }
  for (const choiceRequest of requested) {
    const choice = await findChoice(scope, choiceRequest);
    if (!choice || !await selected(choice)) throw new FlowError("ui_changed", `Flow changed the requested ${choiceRequest.label} while configuring other options.`);
  }
  return true;
}

/** Capture only a complete, restorable current manual selection without clicking. */
export async function readCurrentManualSettings(page: Page): Promise<ManualSettingsRequest | undefined> {
  const enabledRadios = {
    image: await mediaRadio(page, "image"),
    video: await mediaRadio(page, "video"),
  };
  const selectedMedia: Media[] = [];
  for (const media of ["image", "video"] as const) {
    const radio = enabledRadios[media];
    if (radio && await checked(radio)) selectedMedia.push(media);
  }
  if (selectedMedia.length !== 1) return undefined;
  const mediaType = selectedMedia[0]!;
  const radio = enabledRadios[mediaType]!;
  const scope = await settingsScope(page, radio);
  const dropdown = await modelDropdown(scope);
  if (!dropdown) return undefined;
  const label = modelLabel(await dropdown.innerText());
  const model = label ? normalizeCapabilityId(label) : undefined;
  if (!model) return undefined;
  const ratios = new Set<string>();
  const outputs = new Set<number>();
  const durations = new Set<number>();
  let visibleDurations = false;
  const controls = scope.locator('[role="radio"], [role="tab"]');
  const count = Math.min(await controls.count(), 80);
  for (let index = 0; index < count; index++) {
    const control = controls.nth(index);
    if (!await control.isVisible().catch(() => false)) continue;
    const text = cleanCapabilityLabel(await control.innerText());
    const duration = parseDurationOption(text);
    if (duration !== undefined) visibleDurations = true;
    if (!await available(control) || !await selected(control)) continue;
    if (/^\d+:\d+$/.test(text)) ratios.add(text);
    const output = parseOutputCount(text);
    if (output !== undefined && output >= 1 && output <= 4) outputs.add(output);
    if (duration !== undefined) durations.add(duration);
  }
  if (ratios.size !== 1 || outputs.size !== 1) return undefined;
  if (visibleDurations && (mediaType !== "video" || durations.size !== 1)) return undefined;
  const aspectRatio = [...ratios][0]!;
  const outputCount = [...outputs][0]!;
  const durationSeconds = [...durations][0];
  return {
    mediaType, model, aspectRatio, outputs: outputCount,
    ...(visibleDurations && durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}
