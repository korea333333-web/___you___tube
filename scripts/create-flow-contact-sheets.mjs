#!/usr/bin/env node
// Local QA images only: no Flow calls, media generation, or source-file edits.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TILE_WIDTH = 384;
const TILE_HEIGHT = 216;
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function existing(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function safePath(value, base = ROOT, { mustExist = false, within = ROOT } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw Error('Expected a nonempty local path');
  const root = await realpath(ROOT);
  const limit = await realpath(within);
  const candidate = path.resolve(base, value);
  if (!inside(root, candidate) || !inside(limit, candidate)) throw Error('Path is outside the authorized project/title/scene');
  let ancestor = candidate;
  while (!(await existing(ancestor))) {
    if (mustExist) throw Error(`Required path is missing: ${candidate}`);
    ancestor = path.dirname(ancestor);
  }
  const resolved = await realpath(ancestor);
  if (!inside(root, resolved) || !inside(limit, resolved)) throw Error('A symlink/junction resolves outside the authorized project/title/scene');
  return path.join(resolved, path.relative(ancestor, candidate));
}
function command(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12_000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(Error(`${executable} exited ${code}: ${stderr}`)));
  });
}
async function probe(file, formats) {
  return JSON.parse(await command('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats, '-show_streams', '-show_format', '-of', 'json', file]));
}
function durationOf(stream) {
  const duration = Number(stream.duration);
  if (Number.isFinite(duration) && duration > 0) return duration;
  const [n, d] = String(stream.time_base ?? '').split('/').map(Number);
  const measured = Number(stream.duration_ts) * n / d;
  if (Number.isFinite(measured) && measured > 0) return measured;
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(stream.tags?.DURATION ?? '');
  if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  throw Error('Video has no positive verified duration');
}
async function writeNewJson(file, value) {
  const handle = await open(file, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}
async function verifySheet(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size <= 0) throw Error('Existing or newly rendered contact sheet is empty');
  const metadata = await probe(file, 'image2,jpeg_pipe');
  const image = metadata.streams?.find(stream => stream.codec_type === 'video');
  if (!image || image.codec_name !== 'mjpeg' || image.width !== TILE_WIDTH * 5 || image.height !== TILE_HEIGHT) throw Error('Contact sheet must be a JPEG with five 384x216 tiles');
  return { bytes: info.size, width: image.width, height: image.height };
}

export async function createFlowContactSheets(titlePath, { startSlot = 1, limit = 34 } = {}) {
  if (!Number.isInteger(startSlot) || startSlot < 1 || startSlot > 34 || !Number.isInteger(limit) || limit < 1 || limit > 34) throw Error('start-slot and limit must be integers from 1 through 34');
  const titleDir = await safePath(titlePath, process.cwd(), { mustExist: true });
  const queuePath = await safePath('generation-queue.json', titleDir, { mustExist: true, within: titleDir });
  const queue = JSON.parse((await readFile(queuePath, 'utf8')).replace(/^\uFEFF/, ''));
  if (!Array.isArray(queue) || queue.length > 34 || queue.some(entry => !Number.isInteger(entry.outputSlot)) || new Set(queue.map(entry => entry.outputSlot)).size !== queue.length) throw Error('Queue must contain at most 34 unique integer output slots');
  const selected = queue.filter(entry => entry.outputSlot >= startSlot && entry.outputSlot < startSlot + limit).sort((a, b) => a.outputSlot - b.outputSlot);
  if (!selected.length) throw Error('No output slots were selected');
  const run = { version: 1, createdAt: new Date().toISOString(), queuePath, startSlot, limit, layout: { columns: 5, rows: 1, tileWidth: TILE_WIDTH, tileHeight: TILE_HEIGHT }, samples: ['first', '25%', '50%', '75%', 'near_end'], entries: [] };
  for (const entry of selected) {
    const basic = { outputSlot: entry.outputSlot, sceneNumber: entry.sceneNumber, jobId: entry.jobId ?? null };
    if (entry.status !== 'completed') {
      run.entries.push({ ...basic, status: 'skipped_not_completed', queueStatus: entry.status });
      continue;
    }
    if (!UUID.test(entry.jobId ?? '') || !Number.isInteger(entry.sceneNumber) || entry.sceneNumber < 1 || entry.sceneNumber > 34) throw Error('Completed entry must have a valid exact Job ID and original sceneNumber');
    const directory = await safePath(entry.arguments?.outputDirectory, titleDir, { mustExist: true, within: titleDir });
    if (!(await stat(directory)).isDirectory() || path.basename(directory) !== `scene-${String(entry.outputSlot).padStart(2, '0')}`) throw Error('Completed entry output directory does not match its output slot');
    const jobFile = await safePath('job.json', directory, { mustExist: true, within: directory });
    const job = JSON.parse((await readFile(jobFile, 'utf8')).replace(/^\uFEFF/, ''));
    if (job.id !== entry.jobId || job.status !== 'completed' || job.mediaType !== 'video' || job.outputs !== 1 || job.error || job.prompt !== entry.arguments.prompt) throw Error('scene/job.json is not the exact matching completed single-video Job');
    const jobDirectory = await safePath(job.outputDirectory, titleDir, { mustExist: true, within: titleDir });
    if (jobDirectory !== directory) throw Error('Job and queue output directories disagree');
    if (!Array.isArray(job.downloadedFiles) || job.downloadedFiles.length !== 1 || !path.isAbsolute(job.downloadedFiles[0])) throw Error('Job must expose exactly one absolute downloadedFiles path');
    const source = await safePath(job.downloadedFiles[0], directory, { mustExist: true, within: directory });
    if (path.dirname(source) !== directory) throw Error('Downloaded source parent is not the exact scene directory');
    const sourceInfo = await stat(source);
    if (!sourceInfo.isFile() || sourceInfo.size <= 0) throw Error('Downloaded source is empty or not a file');
    const metadata = await probe(source, 'mov,matroska,webm');
    const stream = metadata.streams?.find(item => item.codec_type === 'video' && !item.disposition?.attached_pic);
    if (!stream || !(stream.width > 0) || !(stream.height > 0)) throw Error('Downloaded source has no valid video stream');
    const durationSeconds = durationOf(stream);
    const [n, d] = String(stream.avg_frame_rate ?? '').split('/').map(Number);
    const fps = n / d;
    const endMargin = Number.isFinite(fps) && fps > 0 ? Math.max(0.1, 2 / fps) : 0.1;
    const sampleTimesSeconds = [0, durationSeconds * 0.25, durationSeconds * 0.5, durationSeconds * 0.75, Math.max(0, durationSeconds - endMargin)];
    const target = await safePath(`contact-sheet-${job.id}.jpg`, directory, { within: directory });
    let status = 'skipped_existing';
    if (!(await existing(target))) {
      const candidate = await safePath(`.contact-sheet-${job.id}-${randomUUID()}.jpg`, directory, { within: directory });
      try {
        const filters = [`[0:${stream.index}]split=5[v0][v1][v2][v3][v4]`];
        for (const [index, seconds] of sampleTimesSeconds.entries()) filters.push(`[v${index}]trim=start=${seconds.toFixed(9)},trim=end_frame=1,setpts=PTS-STARTPTS,scale=${TILE_WIDTH}:${TILE_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TILE_WIDTH}:${TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuvj420p[s${index}]`);
        filters.push('[s0][s1][s2][s3][s4]hstack=inputs=5[sheet]');
        await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-i', source, '-filter_complex', filters.join(';'), '-map', '[sheet]', '-an', '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2', '-update', '1', candidate]);
        await verifySheet(candidate);
        if ((await stat(source)).size !== sourceInfo.size || (await stat(source)).mtimeMs !== sourceInfo.mtimeMs) throw Error('Source changed during contact-sheet creation');
        if (await safePath(target, directory, { within: directory }) !== target) throw Error('Contact sheet target path changed');
        try { await copyFile(candidate, target, constants.COPYFILE_EXCL); status = 'created'; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      } finally {
        if (await existing(candidate)) await unlink(candidate); // Only this run's unique temporary JPEG.
      }
    }
    const verification = await verifySheet(target);
    const result = { ...basic, status, jobFile, source, sourceBytes: sourceInfo.size, durationSeconds, sourceWidth: stream.width, sourceHeight: stream.height, contactSheet: target, frames: sampleTimesSeconds.map((seconds, index) => ({ position: index + 1, sample: run.samples[index], requestedTimeSeconds: seconds })), verification };
    run.entries.push(result);
    process.stdout.write(JSON.stringify({ event: 'contact_sheet', ...result }) + '\n');
  }
  const qaDirectory = await safePath('qa', titleDir, { within: titleDir });
  if (!(await existing(qaDirectory))) await mkdir(qaDirectory);
  const manifest = await safePath(`contact-sheets-${randomUUID()}.json`, qaDirectory, { within: titleDir });
  await writeNewJson(manifest, run);
  return { status: 'complete', manifest, created: run.entries.filter(entry => entry.status === 'created').length, skippedExisting: run.entries.filter(entry => entry.status === 'skipped_existing').length, skippedNotCompleted: run.entries.filter(entry => entry.status === 'skipped_not_completed').length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); const positional = []; const options = {};
    for (let index = 0; index < args.length; index++) {
      const [key, inline] = args[index].split(/=(.*)/s, 2);
      if (key === '--start-slot' || key === '--limit') {
        const value = inline ?? args[++index];
        if (!value || value.startsWith('--')) throw Error(`${key} needs a value`);
        options[key === '--start-slot' ? 'startSlot' : 'limit'] = Number(value);
      } else if (key.startsWith('--')) throw Error(`Unknown option: ${key}`);
      else positional.push(args[index]);
    }
    if (positional.length !== 1) throw Error('Usage: node scripts/create-flow-contact-sheets.mjs <title-directory> [--start-slot 1 --limit 34]');
    console.log(JSON.stringify(await createFlowContactSheets(positional[0], options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
