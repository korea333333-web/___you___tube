export function isFlowUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
    return url.hostname === "flow.google.com" ||
      (url.hostname === "labs.google" && /^\/fx(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/tools\/flow(?:\/|$)/i.test(url.pathname));
  } catch { return false; }
}

export function canonicalFlowProjectUrl(rawUrl: string): string {
  if (!isFlowUrl(rawUrl)) return rawUrl;
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/^(\/(?:.*\/tools\/flow\/)?project\/[^/]+)\/edit\/[^/]+\/?$/i);
    if (!match) return rawUrl;
    url.pathname = match[1]!;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return rawUrl;
  }
}
