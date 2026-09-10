import type { ChildProcess } from "node:child_process";
import type { Browser } from "playwright";

// connectOverCDP().close() only disconnects Playwright. Ask our own browser
// to close normally and wait for process exit so profile writes can finish.
export async function closeManagedBrowser(browser: Browser, child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const isRunning = () => child.exitCode === null && child.signalCode === null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExit: () => void = () => undefined;
  const exited = new Promise<void>(resolve => { onExit = resolve; child.once("exit", onExit); });
  try {
    if (isRunning()) {
      const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); });
      // Reuse the MCP-owned connection; do not add browser launch flags.
      void browser.newBrowserCDPSession().then(session => session.send("Browser.close")).catch(() => undefined);
      await Promise.race([exited, deadline]);
      if (isRunning() && !child.killed) {
        child.kill();
        if (timer) clearTimeout(timer);
        await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]);
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    child.off("exit", onExit);
    await browser.close().catch(() => undefined);
  }
}
