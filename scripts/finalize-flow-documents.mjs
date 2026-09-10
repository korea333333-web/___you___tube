#!/usr/bin/env node
// Local-only document reconciliation. No MCP, generation, speech synthesis, or rendering.
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { buildAssemblyManifest } from './create-production-assembly.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['scenes.json', 'scenes.md', 'veo-prompts.md', 'generation-log.md'];
const START = '<!-- flow-document-sync:start -->';
const END = '<!-- flow-document-sync:end -->';
const runFile = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(String(bytes).replace(/^\uFEFF/, ''));
const clone = value => structuredClone(value);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.relative(path.resolve(a), path.resolve(b)) === '';
const inside = (root, file) => { const r = path.relative(root, file); return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)); };
const cell = value => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
const link = file => `[${cell(path.basename(file))}](<${file.replaceAll('\\', '/')}>)`;
const fixed = value => Number(value).toFixed(6);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const lookup = (collection, key) => collection instanceof Map ? collection.get(key) : collection[key];

async function exists(file) { try { return await lstat(file); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
async function confined(value, base = ROOT, within = ROOT, mustExist = true) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw Error('Expected a nonempty local path');
  const root = await realpath(ROOT), limit = await realpath(within), candidate = path.resolve(base, value);
  if (!inside(root, candidate) || !inside(limit, candidate)) throw Error(`Path outside authorized project/title: ${candidate}`);
  let ancestor = candidate;
  while (!(await exists(ancestor))) { if (mustExist) throw Error(`Missing required path: ${candidate}`); ancestor = path.dirname(ancestor); }
  const resolved = await realpath(ancestor);
  if (!inside(root, resolved) || !inside(limit, resolved)) throw Error('Symlink/junction resolves outside the project/title');
  return path.join(resolved, path.relative(ancestor, candidate));
}
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Replaces only our managed block. The complete original Markdown body remains verbatim. */
export function upsertCurrentState(original, block) {
  if (typeof original !== 'string' || typeof block !== 'string') throw Error('Markdown inputs must be strings');
  if (block.includes(START) || block.includes(END)) throw Error('Reserved document marker in generated content');
  const starts = original.split(START).length - 1, ends = original.split(END).length - 1;
  const managed = `${START}\n${block}\n${END}`;
  if (starts || ends) {
    if (starts !== 1 || ends !== 1 || original.indexOf(START) > original.indexOf(END)) throw Error('Malformed or duplicated managed document block; preserve file for review');
    return original.slice(0, original.indexOf(START)) + managed + original.slice(original.indexOf(END) + END.length);
  }
  const heading = original.match(/^(\uFEFF?#[^\r\n]*)(\r?\n|$)/);
  if (!heading) throw Error('Existing Markdown must begin with a title; refusing to restructure unknown content');
  const offset = heading[0].length;
  return original.slice(0, offset) + `\n${managed}\n\n## 동기화 전 본문 · 원문 보존\n\n다음 본문은 작성 당시의 계획·승인·오류 이력이다. 현재 상태는 위 검증 기록을 따른다.\n\n` + original.slice(offset);
}
function fence(text) {
  const lengths = [...text.matchAll(/\x60+/g)].map(m => m[0].length);
  const delimiter = '\x60'.repeat(Math.max(3, ...lengths.map(n => n + 1)));
  return `${delimiter}text\n${text}\n${delimiter}`;
}
function mediaProof(proof, file) {
  if (!proof || !samePath(proof.path, file) || !Number.isSafeInteger(proof.bytes) || proof.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(proof.sha256 ?? '') || !positive(proof.durationSeconds) ||
      !Number.isInteger(proof.width) || proof.width <= 0 || !Number.isInteger(proof.height) || proof.height <= 0 ||
      typeof proof.codec !== 'string' || !proof.codec) throw Error('Missing or invalid fresh local video verification');
  return clone(proof);
}
function verifyAssemblyEvidence(evidence, manifest, narration, titleDir) {
  if (!evidence) return { status: 'not_verified', reason: '최종 MP4와 assembly-result 증거를 이 동기화에서 확인하지 않음' };
  const { result, resolvedPlan: plan, sourceManifest, resultPath } = evidence;
  if (result?.status !== 'complete' || result.sourceAudioDiscarded !== true || !samePath(result.output, plan?.output) ||
      !samePath(result.workDir, path.dirname(resultPath)) || !samePath(plan.workDir, result.workDir) ||
      !inside(titleDir, path.resolve(result.output)) || !samePath(sourceManifest?.output, result.output)) throw Error('Assembly result is not a matching completed local final MP4');
  if (!Array.isArray(plan.groups) || plan.groups.length !== 8 || plan.fps !== 30 || !positive(plan.duration) || !positive(plan.narrationDuration) || path.extname(result.output).toLowerCase() !== '.mp4') throw Error('Final assembly must contain all eight narration groups at 30 fps');
  const order = sourceManifest.provenance?.shotOrder;
  if (!Array.isArray(order) || order.length !== 34) throw Error('Final manifest lacks exact 34-Job provenance');
  for (const [i, expected] of manifest.provenance.shotOrder.entries()) {
    const actual = order[i];
    if (actual.sceneNumber !== expected.sceneNumber || actual.outputSlot !== expected.outputSlot ||
        actual.jobId !== expected.jobId || !samePath(actual.video, expected.video)) throw Error('Final manifest is not in exact original scene/Job order');
  }
  for (const [i, group] of plan.groups.entries()) {
    const expected = manifest.groups[i], audio = narration.groups[i];
    if (group.id !== expected.id || !samePath(group.audio, audio.audioPath) || !positive(group.narrationDuration) || !positive(group.duration) || Math.abs(group.narrationDuration - audio.durationSeconds) > 0.05 ||
        !Array.isArray(group.shots) || group.shots.length !== expected.shots.length) throw Error('Final assembly narration/group mismatch');
    let frames = 0;
    for (const [j, shot] of group.shots.entries()) {
      if (!samePath(shot.video, expected.shots[j].video) || !Number.isInteger(shot.frames) || shot.frames < 1 || shot.frames > 300 || !positive(shot.sourceDuration) || typeof shot.startSeconds !== 'number' || !Number.isFinite(shot.startSeconds) || shot.startSeconds < 0 || shot.startSeconds + shot.frames / 30 > shot.sourceDuration + 1e-7) throw Error('Final assembly shot order or ten-second allocation mismatch');
      frames += shot.frames;
    }
    if (frames !== group.frames || frames !== Math.ceil(group.narrationDuration * 30 - 1e-8) || Math.abs(group.duration - frames / 30) > 1e-7) throw Error('Resolved assembly group frame total is inconsistent');
  }
  if (Math.abs(plan.groups.reduce((sum, g) => sum + g.duration, 0) - plan.duration) > 1e-7 || Math.abs(plan.groups.reduce((sum, g) => sum + g.narrationDuration, 0) - plan.narrationDuration) > 1e-7 || !positive(result.frameAlignedDuration) || !positive(result.narrationDuration) || Math.abs(result.frameAlignedDuration - plan.duration) > 1e-7 || Math.abs(result.narrationDuration - plan.narrationDuration) > 1e-7) throw Error('Assembly result totals differ from its resolved plan');
  const file = mediaProof(evidence.media, result.output);
  if (file.videoStreams !== 1 || file.audioStreams !== 1 || file.codec !== 'h264' || file.audioCodec !== 'aac' ||
      file.width !== plan.width || file.height !== plan.height || !positive(file.fps) || Math.abs(file.fps - plan.fps) > 0.000001 || file.pixelFormat !== 'yuv420p' ||
      !positive(file.audioDurationSeconds) || Math.abs(file.durationSeconds - plan.duration) > 0.07 ||
      Math.abs(file.audioDurationSeconds - plan.duration) > 0.07 || result.verification?.bytes !== file.bytes) throw Error('Final MP4 media does not match the completed assembly result');
  return { status: 'complete_verified', resultPath, manifestPath: plan.manifestPath, file, narrationDurationSeconds: plan.narrationDuration, frameAlignedDurationSeconds: plan.duration };
}

/** Pure planning function. Filesystem reads/probing/locking happen only in finalizeFlowDocuments. */
export function buildDocumentUpdates({ titleDir, queue, scenesDocument, narrationDocument, jobsBySlot, mediaBySlot, markdown, assemblyEvidence, verifiedAt = new Date().toISOString() }) {
  const manifest = buildAssemblyManifest({ titleDir, queue, scenesDocument, narrationDocument, jobsBySlot });
  const ordered = [...queue].sort((a, b) => a.sceneNumber - b.sceneNumber);
  for (const entry of ordered) {
    const expectedSlot = entry.sceneNumber === 1 ? 2 : entry.sceneNumber === 2 ? 1 : entry.sceneNumber;
    if (entry.outputSlot !== expectedSlot) throw Error('Original scene 1/2 folder swap must be preserved');
  }
  const current = clone(scenesDocument);
  const records = ordered.map(entry => {
    const job = lookup(jobsBySlot, entry.outputSlot), file = mediaProof(lookup(mediaBySlot, entry.outputSlot), job.downloadedFiles[0]);
    if (entry.arguments.model !== job.model || entry.arguments.durationSeconds !== 10 || entry.arguments.aspectRatio !== '16:9' ||
        entry.arguments.outputs !== 1 || entry.arguments.upscale !== 'none') throw Error('Queue request differs from approved actual Job settings');
    if (job.prompt.includes(START) || job.prompt.includes(END)) throw Error('Prompt contains reserved document markers');
    return { sceneNumber: entry.sceneNumber, outputSlot: entry.outputSlot, groupId: entry.narrationGroupId, jobId: job.id,
      model: job.model, requestedDurationSeconds: job.durationSeconds, aspectRatio: job.aspectRatio, outputs: job.outputs,
      prompt: job.prompt, createdAt: job.createdAt ?? null, updatedAt: job.updatedAt ?? null, completedAt: entry.completedAt ?? null,
      file, historicalQueueErrorPresent: Boolean(entry.error || entry.runnerError), jobRecord: path.join(job.outputDirectory, 'job.json') };
  });
  for (const group of narrationDocument.groups) {
    const planText = ordered.filter(e => e.narrationGroupId === group.id).map(e => current.scenes.find(s => s.sceneNumber === e.sceneNumber)?.narration).join('\n');
    if (planText !== group.text) throw Error('Original scene narration differs from exact audio group text');
  }
  const finalVideo = verifyAssemblyEvidence(assemblyEvidence, manifest, narrationDocument, titleDir);
  const stableDigest = digest(JSON.stringify({ records, finalVideo, voice: narrationDocument.voice, rate: narrationDocument.rate }));
  const syncAt = current.productionDocumentSync?.digest === stableDigest ? current.productionDocumentSync.verifiedAt : verifiedAt;
  for (const scene of current.scenes) {
    const record = records.find(r => r.sceneNumber === scene.sceneNumber);
    if (scene.promptEnglish !== record.prompt) {
      if (scene.promptHistory !== undefined && !Array.isArray(scene.promptHistory)) throw Error('Unknown promptHistory shape; preserve for review');
      scene.promptHistory ??= [];
      if (!scene.promptHistory.some(h => h.prompt === scene.promptEnglish)) scene.promptHistory.push({ kind: 'previous_planned_prompt', prompt: scene.promptEnglish, preservedAt: syncAt });
    }
    scene.promptEnglish = record.prompt; scene.submitted = true; scene.jobId = record.jobId;
    scene.generationStatus = 'completed'; scene.modelOptionId = record.model;
    scene.durationSeconds = record.requestedDurationSeconds; scene.aspectRatio = record.aspectRatio; scene.outputs = record.outputs;
    scene.downloadedFiles = [record.file.path];
    scene.fileVerification = { checkedAt: syncAt, valid: true, files: [record.file] };
    scene.actualDurationSeconds = record.file.durationSeconds;
    scene.productionRecord = { sourceJob: record.jobRecord, createdAt: record.createdAt, updatedAt: record.updatedAt,
      completedAt: record.completedAt, historicalQueueErrorPresent: record.historicalQueueErrorPresent, creditCost: null };
  }
  current.status = 'clips_completed_files_verified';
  current.finalVideo = finalVideo;
  // Preserve the original voice.status, including candidate_not_user_voice_approved.
  current.voiceReviewAuthorization = { status: 'agent_review_authorized', userPersonallyAuditionedVoice: false,
    note: '사용자는 전체 제작과 에이전트 검수를 위임함. 직접 목소리 품평을 마쳤다고 기록하지 않음.' };
  current.productionDocumentSync = { version: 1, digest: stableDigest, verifiedAt: syncAt, clipCount: 34,
    sourceQueue: path.join(titleDir, 'generation-queue.json'), exactCreditCost: null, finalVideoStatus: finalVideo.status,
    footageDisclosure: '설명용 AI 재현이며 실제 공사 촬영기록 또는 정확한 구조도가 아님',
    voice: { engine: narrationDocument.voice, rate: narrationDocument.rate, language: 'ko-KR', gender: 'female', localTts: true,
      sourceStatusPreserved: narrationDocument.status } };
  const common = [
    '## 현재 검증 상태',
    `- 확인 시각: ${syncAt}`,
    '- Flow 영상: 정확한 34개 Job 완료·다운로드·로컬 파일 검증 완료.',
    '- 실제 요청: omni-1-1-flash / 10초 / 16:9 / 각 1개 / 업스케일 없음. 실제 길이는 아래 기록 참조.',
    '- 정확한 Flow 크레딧 비용: 미확인. 무료 또는 추정 비용으로 기록하지 않음.',
    '- 순서: 본편 장면 1→34. 장면 1은 scene-02, 장면 2는 scene-01.',
    '- 영상은 설명용 AI 재현이며 실제 공사 촬영기록이나 정확한 구조도가 아님.',
    `- 음성: ${narrationDocument.voice} / Korean female local TTS / Rate ${narrationDocument.rate}. 에이전트 검수 위임 상태이며 사용자 직접 음성 품평 완료로 표시하지 않음.`,
    finalVideo.status === 'complete_verified' ? `- 최종 MP4: 실제 조립 증거와 파일 확인 완료. ${link(finalVideo.file.path)} (${fixed(finalVideo.file.durationSeconds)}초).` :
      '- 최종 MP4: 미완료로 유지 — 이 동기화에 검증된 assembly-result 증거가 없음.',
    '- 기존 상세 장면·대본·승인·오류 이력은 아래 원문에 보존.',
  ].join('\n');
  const table = ['| 본편 장면 | 폴더 | Job ID | 실제 길이 | 파일 크기 | 검증 파일 |',
    '|---:|---|---|---:|---:|---|', ...records.map(r => `| ${r.sceneNumber} | scene-${String(r.outputSlot).padStart(2, '0')} | ${r.jobId} | ${fixed(r.file.durationSeconds)}초 | ${r.file.bytes} bytes | ${link(r.file.path)} |`)].join('\n');
  const promptBlock = records.map(r => `### 장면 ${String(r.sceneNumber).padStart(2, '0')} · scene-${String(r.outputSlot).padStart(2, '0')}\n\n제출 완료 · Job ${r.jobId} · 실제 Job 원문\n\n${fence(r.prompt)}`).join('\n\n');
  const details = records.map(r => `### 장면 ${String(r.sceneNumber).padStart(2, '0')} · Job ${r.jobId}\n\n- Job 생성: ${r.createdAt ?? '기록 없음'} / 최종 갱신: ${r.updatedAt ?? '기록 없음'}\n- 요청 10초 / 실제 ${fixed(r.file.durationSeconds)}초 / ${r.file.width}×${r.file.height} / ${r.file.codec}\n- SHA-256: ${r.file.sha256}\n- 정확한 요청 프롬프트: veo-prompts.md의 현재 검증 기록과 scenes.json에 저장.\n- Job 근거: ${link(r.jobRecord)}\n- 과거 큐 오류 기록: ${r.historicalQueueErrorPresent ? '있음. 완료 상태와 별개로 원본 큐·아래 오류 이력 보존.' : '해당 완료 큐 항목에 없음.'}`).join('\n\n');
  const files = {
    'scenes.json': JSON.stringify(current, null, 2) + '\n',
    'scenes.md': upsertCurrentState(markdown['scenes.md'], common + '\n\n' + table),
    'veo-prompts.md': upsertCurrentState(markdown['veo-prompts.md'], common + '\n\n' + promptBlock),
    'generation-log.md': upsertCurrentState(markdown['generation-log.md'], common + '\n\n' + table + '\n\n' + details),
  };
  return { files, summary: { status: 'documents_prepared', clipCount: records.length, finalVideoStatus: finalVideo.status,
    voiceReviewStatus: 'agent_review_authorized', sourceVoiceStatusPreserved: narrationDocument.status,
    exactCreditCost: null, verifiedAt: syncAt }, records };
}

async function probeVideo(file, ffprobe = 'ffprobe') {
  const before = await stat(file);
  if (!before.isFile() || !before.size) throw Error('Downloaded media is missing or empty');
  const { stdout } = await runFile(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm',
    '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const p = json(stdout), videos = p.streams?.filter(s => s.codec_type === 'video' && !s.disposition?.attached_pic) ?? [], audios = p.streams?.filter(s => s.codec_type === 'audio') ?? [];
  const v = videos[0], a = audios[0], [n, d] = String(v?.avg_frame_rate ?? '').split('/').map(Number);
  const proof = { path: file, bytes: before.size, sha256: await fileHash(file), durationSeconds: Number(v?.duration ?? p.format?.duration),
    width: v?.width, height: v?.height, codec: v?.codec_name, pixelFormat: v?.pix_fmt, frameRate: v?.avg_frame_rate, fps: n / d,
    videoStreams: videos.length, audioStreams: audios.length, audioCodec: a?.codec_name ?? null, audioDurationSeconds: a ? Number(a.duration ?? p.format?.duration) : null };
  const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('Media changed during verification');
  mediaProof(proof, file);
  return { proof, snapshot: { file, size: after.size, mtimeMs: after.mtimeMs } };
}

export async function finalizeFlowDocuments(titlePath, { apply = false, assemblyResult, ffprobe = 'ffprobe' } = {}) {
  const titleDir = await confined(titlePath, process.cwd());
  if (!(await stat(titleDir)).isDirectory() || samePath(titleDir, ROOT)) throw Error('Expected an existing title subdirectory');
  const lockPath = await confined('.production-runner.lock', titleDir, titleDir, false);
  if (await exists(lockPath)) throw Error('Production runner lock exists; do not finalize while production is active');
  const runId = randomUUID(); let ownsLock = false; const temporary = []; const committed = [];
  const snapshots = new Map(), mediaSnapshots = [];
  const read = async file => { const safe = await confined(file, titleDir, titleDir); const bytes = await readFile(safe); snapshots.set(safe, digest(bytes)); return { file: safe, bytes, data: json(bytes) }; };
  const unchanged = async () => {
    for (const [file, hash] of snapshots) if (digest(await readFile(file)) !== hash) throw Error('Source/document changed during verification; no further writes');
    for (const s of mediaSnapshots) { const now = await stat(s.file); if (now.size !== s.size || now.mtimeMs !== s.mtimeMs) throw Error('Verified media changed'); }
  };
  try {
    if (apply) {
      const h = await open(lockPath, 'wx'); ownsLock = true;
      try { await h.writeFile(JSON.stringify({ runId, pid: process.pid, owner: 'finalize-flow-documents', startedAt: new Date().toISOString() })); await h.sync(); } finally { await h.close(); }
    }
    const queue = (await read('generation-queue.json')).data;
    if (!Array.isArray(queue) || queue.length !== 34 || queue.some(e => e.status !== 'completed')) throw Error('All 34 queue entries must be completed before finalizing documents');
    const scenes = await read('scenes.json'), narration = await read('audio/narration-groups.json');
    const jobs = new Map(), media = new Map();
    for (const e of queue) {
      const dir = await confined(e.arguments?.outputDirectory, titleDir, titleDir);
      const record = await read(path.join(dir, 'job.json')); jobs.set(e.outputSlot, record.data);
      if (record.data.id !== e.jobId || record.data.downloadedFiles?.length !== 1) throw Error('Queue and exact scene Job disagree');
      const video = await confined(record.data.downloadedFiles[0], titleDir, dir);
      const checked = await probeVideo(video, ffprobe); media.set(e.outputSlot, checked.proof); mediaSnapshots.push(checked.snapshot);
      const earlier = record.data.mediaProbe?.[0];
      if (earlier?.sha256 && earlier.sha256 !== checked.proof.sha256) throw Error('Downloaded file no longer matches Job media hash');
      if (earlier?.sizeBytes && earlier.sizeBytes !== checked.proof.bytes) throw Error('Downloaded file no longer matches Job media size');
    }
    const markdown = {}, originals = { 'scenes.json': scenes.bytes };
    for (const name of FILES.slice(1)) {
      const file = await confined(name, titleDir, titleDir), bytes = await readFile(file);
      snapshots.set(file, digest(bytes)); originals[name] = bytes; markdown[name] = bytes.toString('utf8');
    }
    let assemblyEvidence;
    if (assemblyResult) {
      const resultRecord = await read(assemblyResult), result = resultRecord.data;
      const workDir = await confined(result.workDir, titleDir, titleDir);
      if (!samePath(path.dirname(resultRecord.file), workDir)) throw Error('Assembly result lies outside its recorded work directory');
      const plan = (await read(path.join(workDir, 'resolved-plan.json'))).data;
      const sourceManifest = (await read(plan.manifestPath)).data;
      const finalPath = await confined(result.output, titleDir, titleDir);
      const checked = await probeVideo(finalPath, ffprobe); mediaSnapshots.push(checked.snapshot);
      assemblyEvidence = { result, resultPath: resultRecord.file, resolvedPlan: plan, sourceManifest, media: checked.proof };
    }
    const prepared = buildDocumentUpdates({ titleDir, queue, scenesDocument: scenes.data, narrationDocument: narration.data, jobsBySlot: jobs, mediaBySlot: media, markdown, assemblyEvidence });
    await unchanged();
    if (!ownsLock && await exists(lockPath)) throw Error('A production runner started during validation; no documents changed');
    const changes = FILES.filter(name => !originals[name].equals(Buffer.from(prepared.files[name], 'utf8')));
    if (!apply) return { ...prepared.summary, status: 'check_passed_no_writes', changes, applyRequired: true };
    if (!changes.length) return { ...prepared.summary, status: 'already_current', changes: [] };
    const backupRoot = await confined('document-sync-backups', titleDir, titleDir, false);
    if (!(await exists(backupRoot))) await mkdir(backupRoot);
    const backupDir = await confined(path.join(backupRoot, runId), titleDir, titleDir, false); await mkdir(backupDir);
    for (const name of changes) {
      const target = await confined(name, titleDir, titleDir), candidate = await confined(`.${name}.sync-${runId}.tmp`, titleDir, titleDir, false);
      await copyFile(target, path.join(backupDir, name), constants.COPYFILE_EXCL);
      const h = await open(candidate, 'wx'); temporary.push(candidate);
      try { await h.writeFile(prepared.files[name], 'utf8'); await h.sync(); } finally { await h.close(); }
    }
    await unchanged();
    for (const name of changes) {
      const target = await confined(name, titleDir, titleDir), candidate = path.join(titleDir, `.${name}.sync-${runId}.tmp`);
      if (digest(await readFile(target)) !== digest(originals[name])) throw Error('Document edited before commit; preserve backups for review');
      await rename(candidate, target); committed.push({ name, target, backupDir });
    }
    return { ...prepared.summary, status: 'documents_synchronized', changedFiles: changes.map(name => path.join(titleDir, name)), backupDirectory: backupDir };
  } catch (error) {
    if (committed.length) error.message += ` Partial document commit; original files are preserved in ${committed[0].backupDir}. Committed: ${committed.map(c => c.name).join(', ')}. Reconcile before rerunning.`;
    throw error;
  } finally {
    for (const file of temporary) if (await exists(file)) await unlink(file); // Only this run's exact temporary files.
    if (ownsLock) {
      const lock = json(await readFile(lockPath));
      if (lock.runId === runId) await unlink(lockPath);
    }
  }
}

export function runSelfTests() {
  const titleDir = path.join(ROOT, 'pure-fixture-not-created');
  const queue = [], scenes = [], jobsBySlot = new Map(), mediaBySlot = new Map();
  const counts = [3, 4, 5, 3, 4, 5, 4, 6], groups = []; let n = 0;
  for (let g = 0; g < 8; g++) {
    const id = `group-${String(g + 1).padStart(2, '0')}`, texts = [];
    for (let k = 0; k < counts[g]; k++) {
      n++; const slot = n === 1 ? 2 : n === 2 ? 1 : n, dir = path.join(titleDir, `scene-${String(slot).padStart(2, '0')}`);
      const jobId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, video = path.join(dir, `clip-${jobId}.mp4`);
      const prompt = `exact prompt ${n}\nNo speech, no music.`, narration = `원문 ${n}.`;
      const args = { prompt, outputDirectory: dir, model: 'omni-1-1-flash', durationSeconds: 10, aspectRatio: '16:9', outputs: 1, upscale: 'none' };
      queue.push({ sceneNumber: n, outputSlot: slot, narrationGroupId: id, status: 'completed', jobId, tool: 'flow_generate_video', arguments: args, error: n === 4 ? 'preserved old failure' : undefined });
      scenes.push({ sceneNumber: n, outputSlot: slot, narrationGroupId: id, narration, outputDirectory: dir, promptEnglish: `old planned prompt ${n}`, submitted: false, jobId: null });
      jobsBySlot.set(slot, { id: jobId, mediaType: 'video', status: 'completed', prompt, model: args.model, durationSeconds: 10, aspectRatio: '16:9', outputs: 1, upscale: 'none', outputDirectory: dir, downloadedFiles: [video] });
      mediaBySlot.set(slot, { path: video, bytes: 100, sha256: 'a'.repeat(64), durationSeconds: 10, width: 1280, height: 720, codec: 'h264' });
      texts.push(narration);
    }
    groups.push({ id, text: texts.join('\n'), audioPath: path.join(titleDir, 'audio', `${id}.wav`), durationSeconds: counts[g] * 9 });
  }
  const markdown = Object.fromEntries(FILES.slice(1).map(name => [name, `# ${name}\r\n\r\n승인 원문 그대로\r\n오류 이력 그대로\r\n상세 대본 그대로\r\n`]));
  const source = { titleDir, queue, scenesDocument: { scenes, voice: { status: 'local_free_voice_candidate_not_user_voice_approved' }, generationApproval: { userText: '원래 승인' } },
    narrationDocument: { voice: 'Microsoft Heami Desktop', rate: 0, status: 'local_free_voice_candidate_not_user_voice_approved', groups }, jobsBySlot, mediaBySlot, markdown, verifiedAt: '2026-09-10T00:00:00.000Z' };
  const snapshot = JSON.stringify({ queue, scenes, markdown });
  const output = buildDocumentUpdates(source), parsed = json(output.files['scenes.json']);
  assert.equal(parsed.scenes.length, 34); assert.equal(parsed.scenes[0].outputSlot, 2); assert.equal(parsed.scenes[1].outputSlot, 1);
  assert.equal(parsed.scenes[0].promptEnglish, 'exact prompt 1\nNo speech, no music.');
  assert.equal(parsed.scenes[0].promptHistory[0].prompt, 'old planned prompt 1');
  assert.equal(parsed.voice.status, source.scenesDocument.voice.status);
  assert.equal(parsed.voiceReviewAuthorization.status, 'agent_review_authorized');
  assert.equal(parsed.finalVideo.status, 'not_verified');
  for (const name of FILES.slice(1)) assert(output.files[name].endsWith(markdown[name].slice(markdown[name].indexOf('\n') + 1)));
  assert.equal(snapshot, JSON.stringify({ queue, scenes, markdown }));
  const again = buildDocumentUpdates({ ...source, scenesDocument: parsed, markdown: Object.fromEntries(FILES.slice(1).map(name => [name, output.files[name]])) });
  assert.deepEqual(again.files, output.files);
  const reject = change => { const f = clone(source); change(f); assert.throws(() => buildDocumentUpdates(f)); };
  reject(f => { f.queue[0].status = 'processing'; });
  reject(f => { f.jobsBySlot.get(2).id = f.jobsBySlot.get(1).id; });
  reject(f => { f.queue[0].arguments.prompt = 'mismatch'; });
  reject(f => { f.jobsBySlot.get(2).outputs = 2; });
  reject(f => { f.mediaBySlot.get(2).bytes = 0; });
  reject(f => { f.scenesDocument.scenes[0].narration = 'changed narration'; });
  reject(f => { f.assemblyEvidence = { result: { status: 'complete' }, resolvedPlan: {} }; });
  assert.throws(() => upsertCurrentState('# Test\n' + START, 'status'));
  const finalManifest = buildAssemblyManifest({ titleDir, queue, scenesDocument: source.scenesDocument, narrationDocument: source.narrationDocument, jobsBySlot });
  const finalGroups = finalManifest.groups.map((g, i) => ({ id: g.id, audio: g.audio, narrationDuration: groups[i].durationSeconds,
    duration: groups[i].durationSeconds, frames: groups[i].durationSeconds * 30,
    shots: g.shots.map(s => ({ video: s.video, frames: 270, sourceDuration: 10, startSeconds: 0 })) }));
  const total = finalGroups.reduce((sum, g) => sum + g.duration, 0);
  const finalEvidence = { resultPath: path.join(finalManifest.workDir, 'assembly-result.json'), sourceManifest: finalManifest,
    result: { status: 'complete', sourceAudioDiscarded: true, output: finalManifest.output, workDir: finalManifest.workDir, narrationDuration: total, frameAlignedDuration: total, verification: { bytes: 500 } },
    resolvedPlan: { output: finalManifest.output, workDir: finalManifest.workDir, manifestPath: path.join(titleDir, 'assembly.json'), groups: finalGroups, fps: 30, width: 1280, height: 720, duration: total, narrationDuration: total },
    media: { path: finalManifest.output, bytes: 500, sha256: 'b'.repeat(64), durationSeconds: total, audioDurationSeconds: total, width: 1280, height: 720, fps: 30, pixelFormat: 'yuv420p', codec: 'h264', audioCodec: 'aac', videoStreams: 1, audioStreams: 1 } };
  const final = buildDocumentUpdates({ ...source, assemblyEvidence: finalEvidence });
  assert.equal(json(final.files['scenes.json']).finalVideo.status, 'complete_verified');
  const badFinal = change => { const evidence = clone(finalEvidence); change(evidence); assert.throws(() => buildDocumentUpdates({ ...source, assemblyEvidence: evidence })); };
  badFinal(e => { delete e.resolvedPlan.duration; });
  badFinal(e => { delete e.resolvedPlan.groups[0].narrationDuration; });
  badFinal(e => { e.media.fps = NaN; });
  badFinal(e => { e.resolvedPlan.groups[0].duration += 1; });
  badFinal(e => { e.sourceManifest.provenance.shotOrder.reverse(); });
  badFinal(e => { e.result.frameAlignedDuration = total + 1; });
  return { status: 'pure_self_tests_passed', tests: 24, filesystemWrites: 0, mcpCalls: 0, synthesisCalls: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), positional = [], options = {}; let selfTest = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--self-test') selfTest = true;
      else if (args[i] === '--apply') options.apply = true;
      else if (args[i] === '--check') options.apply = false;
      else if (args[i] === '--assembly-result' || args[i] === '--ffprobe') { const key = args[i] === '--ffprobe' ? 'ffprobe' : 'assemblyResult'; const value = args[++i]; if (!value || value.startsWith('--')) throw Error('Option needs a value'); options[key] = value; }
      else if (args[i].startsWith('--')) throw Error(`Unknown option: ${args[i]}`);
      else positional.push(args[i]);
    }
    if (selfTest) { if (positional.length || Object.keys(options).length) throw Error('--self-test takes no other arguments'); console.log(JSON.stringify(runSelfTests(), null, 2)); }
    else { if (positional.length !== 1) throw Error('Usage: node scripts/finalize-flow-documents.mjs <title-directory> [--check | --apply] [--assembly-result <workDir/assembly-result.json>]'); console.log(JSON.stringify(await finalizeFlowDocuments(positional[0], options), null, 2)); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

