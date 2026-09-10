import type { Locator, Page } from "playwright";
import { FlowError } from "./errors.js";
import { isFlowUrl } from "./navigation.js";

// A profile avatar alone never proves workspace access.
export const NEW_PROJECT_NAME = /^(?:\+\s*)?(?:new project|create project|start a project|nuevo proyecto|crear proyecto|새\s*프로젝트|프로젝트\s*(?:만들기|생성))$/i;
export const PROJECT_LINKS = 'a[href*="/tools/flow/project/"], a[href^="/project/"], a[href^="https://flow.google.com/project/"]';
export const PROMPT_EDITOR = 'textarea[placeholder*="prompt" i], textarea[placeholder*="describe" i], [contenteditable="true"], [contenteditable="plaintext-only"], textarea';

export async function anyVisible(locator: Locator): Promise<boolean> {
  const count = Math.min(await locator.count().catch(() => 0), 100);
  for (let index = 0; index < count; index++) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function hasVisibleSignInControl(page: Page): Promise<boolean> {
  const name = /^(?:sign in|log in|로그인|iniciar sesi[oó]n)$/i;
  return await anyVisible(page.getByRole("button", { name })) ||
    await anyVisible(page.getByRole("link", { name }));
}

function isObservedVideoDetailRoute(rawUrl: string): boolean {
  if (!isFlowUrl(rawUrl)) return false;
  const url = new URL(rawUrl);
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  return url.hostname === "flow.google.com" && new RegExp("^/project/" + uuid + "/edit/" + uuid + "/?$", "i").test(url.pathname);
}

/** Observed authenticated video detail UI, without a dashboard avatar or prompt editor. */
async function hasObservedVideoDetailWorkspace(page: Page): Promise<boolean> {
  if (!isObservedVideoDetailRoute(page.url()) || await hasVisibleSignInControl(page)) return false;
  const editor = page.locator("flow-editor-dispatcher flow-editor-page");
  const header = editor.locator("flow-editor-header");
  if (!await header.locator("flow-navigation-header").count().catch(() => 0)) return false;
  for (const name of ["이전 페이지로 이동하는 뒤로 버튼", "애셋 정보 표시", "옵션 더보기", "기록 표시/숨기기", "수정 완료"]) {
    if (!await anyVisible(header.getByRole("button", { name, exact: true }))) return false;
  }
  const videos = editor.locator('flow-video-editor .main-video-container .video-wrapper > video.main-video[aria-label="AI 생성 동영상"]');
  const count = Math.min(await videos.count().catch(() => 0), 10);
  for (let index = 0; index < count; index++) {
    const video = videos.nth(index);
    if (!await video.isVisible().catch(() => false)) continue;
    const hasObservedSource = await video.evaluate(element => {
      if (!(element instanceof HTMLVideoElement)) return false;
      try {
        const source = new URL(element.currentSrc || element.getAttribute("src") || "");
        return source.protocol === "https:" && source.hostname === "flow-content.google" && !source.port && !source.username && !source.password &&
          /^\/video\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source.pathname);
      } catch { return false; }
    }).catch(() => false);
    if (hasObservedSource) return true;
  }
  return false;
}

export async function hasFlowWorkspace(page: Page): Promise<boolean> {
  if (!isFlowUrl(page.url())) return false;
  // A detail-page self-link is keyboard navigation, not project-list evidence.
  if (isObservedVideoDetailRoute(page.url())) return hasObservedVideoDetailWorkspace(page);
  if (await anyVisible(page.locator(PROMPT_EDITOR))) return true;
  if (await anyVisible(page.locator(PROJECT_LINKS))) return true;
  if (await anyVisible(page.getByRole("button", { name: NEW_PROJECT_NAME }))) return true;
  return anyVisible(page.locator("button").filter({ has: page.locator("i", { hasText: /^add_2$/ }) }));
}

export async function isFlowSignedIn(page: Page): Promise<boolean> {
  if (!isFlowUrl(page.url())) return false;
  if (await hasVisibleSignInControl(page)) return false;
  if (await hasObservedVideoDetailWorkspace(page)) return true;
  return anyVisible(page.locator([
    'button[aria-label*="Google Account" i], a[aria-label*="Google Account" i]',
    'button[aria-label*="Google 계정"], a[aria-label*="Google 계정"]',
    'button[aria-label*="프로필"], a[aria-label*="프로필"]',
    'img[alt*="profile" i], img[alt*="account" i], img[alt*="프로필"], img[alt*="계정"]',
    'button img[src*="googleusercontent.com/a/"], a img[src*="googleusercontent.com/a/"]',
  ].join(", ")));
}

/** Dismiss only the observed cookie notice using its non-consenting action. */
export async function dismissFlowCookieNotice(page: Page): Promise<void> {
  if (!isFlowUrl(page.url())) return;
  const notice = page.locator('[role="region"][id^="glue-cookie-notification-bar-"]').first();
  if (!await notice.isVisible().catch(() => false)) return;
  const decline = /^(?:나중에|모두 거부|거부|later|not now|reject all|reject|rechazar todo|más tarde)$/i;
  for (const choices of [notice.getByRole("button", { name: decline }), notice.getByRole("link", { name: decline })]) {
    const count = await choices.count();
    for (let index=0; index<count; index++) {
      const choice=choices.nth(index);
      if (!await choice.isVisible().catch(() => false)) continue;
      await choice.click();
      await notice.waitFor({state:"hidden",timeout:5000});
      return;
    }
  }
  throw new FlowError("ui_changed", "The cookie notice blocks Flow, but no recognized Later/Reject action was found. No consent was given.");
}
