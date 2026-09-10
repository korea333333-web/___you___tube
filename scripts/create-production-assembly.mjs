#!/usr/bin/env node
// Local-only manifest preparation from completed, exact Flow jobs and existing narration.
// This never calls Flow, synthesizes speech, edits source records, or renders media.
import { constants } from 'node:fs';
import { copyFile, lstat, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, validateManifest } from './assemble-narrated-video.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPECTED_CLIPS = 34;
const EXPECTED_GROUPS = 8;
const FPS = 30;
const digest = value => createHash('sha256').update(value).digest('hex');
function samePath(a, b) { return path.relative(path.resolve(a), path.resolve(b)) === ''; }
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function existing(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function projectPath(value, base = PROJECT_ROOT, { mustExist = false, within = PROJECT_ROOT } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw Error('Expected a nonempty local path');
  const root = await realpath(PROJECT_ROOT);
  const limit = await realpath(within);
  const candidate = path.resolve(base, value);
  if (!inside(root, candidate) || !inside(limit, candidate)) throw Error(`Path outside authorized project/title: ${candidate}`);
  let ancestor = candidate;
  while (!(await existing(ancestor))) {
    if (mustExist) throw Error(`Required path is missing: ${candidate}`);
    ancestor = path.dirname(ancestor);
  }
  const resolved = await realpath(ancestor);
  if (!inside(root, resolved) || !inside(limit, resolved)) throw Error('Symlink/junction resolves outside authorized project/title');
  return path.join(resolved, path.relative(ancestor, candidate));
}
function requireUniqueNumbers(rows, field, count, description) {
  if (!Array.isArray(rows) || rows.length !== count) throw Error(`${description}: expected exactly ${count} entries`);
  const values = new Set(rows.map(row => row[field]));
  if (values.size !== count || [...values].some(number => !Number.isInteger(number) || number < 1 || number > count)) throw Error(`${description}: ${field} must cover 1 through ${count} exactly once`);
}
function positive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw Error(`${label} must be positive and finite`);
  return value;
}

/** Pure provenance/order validation. Path containment and actual media probing happen below. */
export function buildAssemblyManifest({ titleDir, queue, scenesDocument, narrationDocument, jobsBySlot, weightsDocument, sourceRecords = {} }) {
  requireUniqueNumbers(queue, 'outputSlot', EXPECTED_CLIPS, 'Generation queue');
  requireUniqueNumbers(queue, 'sceneNumber', EXPECTED_CLIPS, 'Generation queue');
  const scenes = scenesDocument.scenes;
  requireUniqueNumbers(scenes, 'sceneNumber', EXPECTED_CLIPS, 'Scene plan');
  const sceneMap = new Map(scenes.map(scene => [scene.sceneNumber, scene]));
  if (!Array.isArray(narrationDocument.groups) || narrationDocument.groups.length !== EXPECTED_GROUPS) throw Error('Exactly eight existing narration groups are required');
  if (typeof narrationDocument.voice !== 'string' || !narrationDocument.voice.trim()) throw Error('Narration voice metadata is missing');
  const groupMap = new Map();
  for (const [index, group] of narrationDocument.groups.entries()) {
    if (group.id !== `group-${String(index + 1).padStart(2, '0')}` || groupMap.has(group.id)) throw Error('Narration groups must be ordered group-01 through group-08');
    positive(group.durationSeconds, `Narration ${group.id} metadata duration`);
    if (!path.isAbsolute(group.audioPath ?? '')) throw Error('Narration audioPath must be an exact absolute source path');
    if (group.voice && group.voice !== narrationDocument.voice) throw Error('Narration groups identify different voices');
    groupMap.set(group.id, group);
  }
  const weights = new Map();
  if (weightsDocument) {
    if (weightsDocument.version !== 1 || (weightsDocument.fps !== undefined && weightsDocument.fps !== FPS) || !Array.isArray(weightsDocument.groups) || weightsDocument.groups.length !== EXPECTED_GROUPS) throw Error('Weights must be version 1, 30 fps, with all eight groups');
    for (const group of weightsDocument.groups) {
      if (!groupMap.has(group.id) || weights.has(group.id) || !Array.isArray(group.shots) || !group.shots.length) throw Error('Weights have an unknown, duplicate, or empty group');
      const mapped = new Map();
      for (const shot of group.shots) {
        if (!Number.isInteger(shot.sceneNumber) || mapped.has(shot.sceneNumber)) throw Error('Weights contain invalid/duplicate sceneNumber');
        positive(shot.weight, `Scene ${shot.sceneNumber} weight`);
        if (shot.recommendedFrames !== undefined && (!Number.isInteger(shot.recommendedFrames) || shot.recommendedFrames < 1 || shot.recommendedFrames > 300 || shot.weight !== shot.recommendedFrames)) throw Error('recommendedFrames must be 1..300 and equal weight to preserve its exact timing');
        mapped.set(shot.sceneNumber, shot);
      }
      weights.set(group.id, mapped);
    }
  }
  const jobs = new Set(); const files = new Set(); const entries = [];
  for (const entry of [...queue].sort((a, b) => a.sceneNumber - b.sceneNumber)) {
    if (entry.status !== 'completed' || !UUID.test(entry.jobId ?? '')) throw Error(`Scene ${entry.sceneNumber}: all 34 queue entries must be completed with exact Job IDs`);
    if (jobs.has(entry.jobId)) throw Error('One Flow Job ID is used for multiple scenes');
    jobs.add(entry.jobId);
    const job = jobsBySlot instanceof Map ? jobsBySlot.get(entry.outputSlot) : jobsBySlot[entry.outputSlot];
    if (!job || job.id !== entry.jobId || job.status !== 'completed' || job.mediaType !== 'video' || job.error) throw Error(`Scene ${entry.sceneNumber}: scene/job.json is not the matching completed video Job`);
    if (job.outputs !== 1 || job.model !== 'omni-1-1-flash' || job.durationSeconds !== 10 || job.aspectRatio !== '16:9' || job.upscale !== 'none' || job.upscaleSubmitted) throw Error('Completed Job differs from the approved single-output Omni settings');
    const args = entry.arguments;
    if (!args || entry.tool !== 'flow_generate_video' || args.prompt !== job.prompt || !samePath(args.outputDirectory, job.outputDirectory)) throw Error('Job prompt/output path does not match its generation queue entry');
    if (path.basename(path.resolve(args.outputDirectory)) !== `scene-${String(entry.outputSlot).padStart(2, '0')}`) throw Error('Output slot does not match its scene folder');
    const scene = sceneMap.get(entry.sceneNumber);
    if (scene.outputSlot !== entry.outputSlot || scene.narrationGroupId !== entry.narrationGroupId || !samePath(scene.outputDirectory, args.outputDirectory) || !groupMap.has(entry.narrationGroupId)) throw Error('Scene plan and completed queue disagree on scene/folder/narration mapping');
    if (scene.jobId && scene.jobId !== job.id) throw Error('Scene plan explicitly records a different Job ID');
    if (!Array.isArray(job.downloadedFiles) || job.downloadedFiles.length !== 1 || !path.isAbsolute(job.downloadedFiles[0])) throw Error('Job must return exactly one absolute downloadedFiles path');
    const video = job.downloadedFiles[0];
    if (!inside(path.resolve(job.outputDirectory), path.resolve(video))) throw Error('Job downloaded file lies outside its output directory');
    const fileKey = path.resolve(video).toLocaleLowerCase('en-US');
    if (files.has(fileKey)) throw Error('One downloaded video is reused for multiple scenes');
    files.add(fileKey);
    if (entry.downloadedFiles && (entry.downloadedFiles.length !== 1 || !samePath(entry.downloadedFiles[0], video))) throw Error('Queue download path differs from exact scene Job path');
    const chosenWeight = weights.get(entry.narrationGroupId)?.get(entry.sceneNumber);
    if (weightsDocument && !chosenWeight) throw Error(`Weights omit scene ${entry.sceneNumber}`);
    const startSeconds = chosenWeight?.startSeconds ?? scene.suggestedTimeline?.sourceInSeconds ?? 0;
    if (typeof startSeconds !== 'number' || !Number.isFinite(startSeconds) || startSeconds < 0) throw Error('Shot startSeconds must be nonnegative and finite');
    entries.push({ sceneNumber: entry.sceneNumber, outputSlot: entry.outputSlot, groupId: entry.narrationGroupId, jobId: job.id, video, weight: chosenWeight?.weight ?? 1, startSeconds, recommendedFrames: chosenWeight?.recommendedFrames });
  }
  let previousGroupIndex = -1;
  for (const entry of entries) {
    const index = Number(entry.groupId.slice(-2)) - 1;
    if (index < previousGroupIndex) throw Error('Scene order interleaves narration groups; automatic reordering is not allowed');
    previousGroupIndex = index;
  }
  const groups = [...groupMap.values()].map(group => {
    const shots = entries.filter(entry => entry.groupId === group.id);
    if (!shots.length) throw Error(`Narration ${group.id} has no completed video shots`);
    const weightedGroup = weights.get(group.id);
    if (weightedGroup && weightedGroup.size !== shots.length) throw Error('Weights include extra scenes that are not in their narration group');
    if (shots.every(shot => shot.recommendedFrames !== undefined)) {
      const sum = shots.reduce((total, shot) => total + shot.recommendedFrames, 0);
      if (sum !== Math.ceil(group.durationSeconds * FPS - 1e-8)) throw Error('Recommended frames do not cover the measured narration group');
    }
    return { id: group.id, audio: group.audioPath, shots: shots.map(shot => ({ video: shot.video, weight: shot.weight, startSeconds: shot.startSeconds })) };
  });
  return {
    version: 1,
    output: path.join(titleDir, '555m-롯데월드타워-완성본.mp4'),
    workDir: path.join(titleDir, 'assembly-final-001'),
    width: 1280,
    height: 720,
    fps: FPS,
    groups,
    provenance: {
      createdAt: new Date().toISOString(),
      sourceRecords,
      voice: { name: narrationDocument.voice, rate: narrationDocument.rate, sourceStatus: narrationDocument.status },
      sourceClipAudioDiscarded: true,
      music: false,
      subtitles: false,
      frameAlignment: 'Each continuous narration group receives less than one frame of ending silence; footage is never repeated, frozen, or slowed.',
      shotOrder: entries.map(({ sceneNumber, outputSlot, groupId, jobId, video, recommendedFrames }) => ({ sceneNumber, outputSlot, groupId, jobId, video, ...(recommendedFrames !== undefined ? { recommendedFrames } : {}) })),
    },
  };
}

export async function createProductionAssembly(titlePath, { outputManifest = 'assembly.json', weights: weightsPath } = {}) {
  const titleDir = await projectPath(titlePath, process.cwd(), { mustExist: true });
  if (!(await stat(titleDir)).isDirectory()) throw Error('Title path must be an existing directory');
  const target = await projectPath(outputManifest, titleDir, { within: titleDir });
  if (path.extname(target).toLowerCase() !== '.json') throw Error('Output manifest must have a .json extension');
  if (await existing(target)) throw Error(`Refusing to overwrite existing manifest: ${target}`);
  if (!(await stat(path.dirname(target))).isDirectory()) throw Error('Output manifest parent must already exist');
  const snapshots = [];
  const readRecord = async (value, base = titleDir, within = titleDir) => {
    const file = await projectPath(value, base, { mustExist: true, within });
    if (!(await stat(file)).isFile()) throw Error('Expected a JSON source file');
    const bytes = await readFile(file);
    snapshots.push({ file, sha256: digest(bytes) });
    return { file, data: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) };
  };
  const queueRecord = await readRecord('generation-queue.json');
  requireUniqueNumbers(queueRecord.data, 'outputSlot', EXPECTED_CLIPS, 'Generation queue');
  if (queueRecord.data.some(entry => entry.status !== 'completed')) throw Error('All 34 video Jobs must be completed before an assembly manifest can be created');
  const scenesRecord = await readRecord('scenes.json');
  const narrationRecord = await readRecord('audio/narration-groups.json');
  const weightsRecord = weightsPath ? await readRecord(weightsPath, process.cwd(), PROJECT_ROOT) : undefined;
  const jobsBySlot = new Map();
  for (const entry of queueRecord.data) {
    const directory = await projectPath(entry.arguments?.outputDirectory, titleDir, { mustExist: true, within: titleDir });
    const record = await readRecord(path.join(directory, 'job.json'));
    jobsBySlot.set(entry.outputSlot, record.data);
  }
  const manifest = buildAssemblyManifest({ titleDir, queue: queueRecord.data, scenesDocument: scenesRecord.data, narrationDocument: narrationRecord.data, jobsBySlot, weightsDocument: weightsRecord?.data, sourceRecords: { queue: queueRecord.file, scenes: scenesRecord.file, narration: narrationRecord.file, ...(weightsRecord ? { weights: weightsRecord.file } : {}) } });
  for (const group of manifest.groups) {
    const audio = await projectPath(group.audio, titleDir, { mustExist: true, within: titleDir });
    const info = await stat(audio);
    if (!info.isFile() || !info.size) throw Error('Narration input is missing or empty');
    for (const shot of group.shots) {
      const video = await projectPath(shot.video, titleDir, { mustExist: true, within: titleDir });
      const info = await stat(video);
      if (!info.isFile() || !info.size) throw Error('Completed Job video is missing or empty');
    }
  }
  const candidate = await projectPath(path.join(path.dirname(target), `.assembly-candidate-${randomUUID()}.json`), titleDir, { within: titleDir });
  let created = false;
  try {
    const handle = await open(candidate, 'wx'); created = true;
    try { await handle.writeFile(JSON.stringify(manifest, null, 2) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    // Reuse the renderer's real ffprobe duration/coverage/path checks without rendering.
    const plan = await validateManifest(candidate);
    for (const group of plan.groups) {
      const declared = narrationRecord.data.groups.find(item => item.id === group.id);
      if (Math.abs(group.narrationDuration - declared.durationSeconds) > 0.05) throw Error(`Narration ${group.id} differs from its measured source metadata; timing requires review`);
      const order = manifest.provenance.shotOrder.filter(item => item.groupId === group.id);
      for (const [index, shot] of group.shots.entries()) {
        if (shot.frames > FPS * 10) throw Error('One shot exceeds the approved ten-second edit allocation');
        if (order[index].recommendedFrames !== undefined && shot.frames !== order[index].recommendedFrames) throw Error('Actual narration duration changes the proposed frame allocation; timing requires review');
      }
    }
    for (const source of snapshots) if (digest(await readFile(source.file)) !== source.sha256) throw Error('Source records changed during validation; manifest not committed');
    if (await projectPath(target, titleDir, { within: titleDir }) !== target) throw Error('Output manifest path changed during validation');
    await copyFile(candidate, target, constants.COPYFILE_EXCL);
    return { status: 'manifest_created', manifest: target, renderingStarted: false, clipCount: EXPECTED_CLIPS, narrationGroups: EXPECTED_GROUPS, narrationDurationSeconds: plan.narrationDuration, frameAlignedDurationSeconds: plan.duration, output: manifest.output, workDir: manifest.workDir, width: manifest.width, height: manifest.height, fps: manifest.fps };
  } finally {
    if (created) await unlink(candidate); // Only our unique temporary file; no recursive cleanup.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); const positional = []; const options = {};
    for (let index = 0; index < args.length; index++) {
      const [key, inline] = args[index].split(/=(.*)/s, 2);
      if (key === '--output-manifest' || key === '--weights') {
        const value = inline ?? args[++index];
        if (!value || value.startsWith('--')) throw Error(`${key} needs a value`);
        options[key === '--weights' ? 'weights' : 'outputManifest'] = value;
      } else if (key.startsWith('--')) throw Error(`Unknown option: ${key}`);
      else positional.push(args[index]);
    }
    if (positional.length !== 1) throw Error('Usage: node scripts/create-production-assembly.mjs <title-directory> [--weights <weights.json>] [--output-manifest=assembly.json]');
    console.log(JSON.stringify(await createProductionAssembly(positional[0], options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
