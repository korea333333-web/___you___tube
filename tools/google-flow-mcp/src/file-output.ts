import { readFile, writeFile } from "node:fs/promises";
import { FlowError } from "./errors.js";

/** Repeating the same download is safe; a different existing file is never replaced. */
export async function writeMediaFile(destination: string, body: Buffer): Promise<void> {
  if (!body.length) throw new FlowError("download_failed", "Flow returned an empty media file.");
  try {
    await writeFile(destination, body, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(destination);
    if (!existing.equals(body)) {
      throw new FlowError("download_failed", "A different file already exists at the requested destination; it was preserved.");
    }
  }
}
