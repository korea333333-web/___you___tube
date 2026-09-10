#!/usr/bin/env node
// Dedicated Flow MCP serial client. Never operates a browser, reconnects, or retries generation.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOB_STATUSES = new Set(['created', 'configuring', 'submitted', 'processing', 'ready', 'upscaling', 'downloading', 'completed', 'failed', 'needs_attention']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARG_KEYS = new Set(['accountId', 'prompt', 'flowProject', 'model', 'aspectRatio', 'durationSeconds', 'outputs', 'referenceFiles', 'upscale', 'outputDirectory', 'fileName', 'download', 'timeoutSeconds', 'confirmCreditSpend']);
const now = () => new Date().toISOString();
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parseJson = value => JSON.parse(value.replace(/^\uFEFF/, ''));

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function maybeStat(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function safePath(value, base = ROOT, { mustExist = false, within = ROOT } = {}) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw Error('Expected a nonempty local path');
  const root = await realpath(ROOT);
  const limit = await realpath(within);
  const candidate = path.resolve(base, value);
  if (!inside(root, candidate) || !inside(limit, candidate)) throw Error(`Path outside authorized project/title: ${candidate}`);
  let ancestor = candidate;
  while (!(await maybeStat(ancestor))) {
    if (mustExist) throw Error(`Required file or directory is missing: ${candidate}`);
    ancestor = path.dirname(ancestor);
  }
  const resolvedAncestor = await realpath(ancestor);
  if (!inside(root, resolvedAncestor) || !inside(limit, resolvedAncestor)) throw Error('A symlink/junction resolves outside the authorized project/title');
  return path.join(resolvedAncestor, path.relative(ancestor, candidate));
}

function jsonPayloads(response) {
  const values = [];
  if (response?.structuredContent && typeof response.structuredContent === 'object') values.push(response.structuredContent);
  for (const block of response?.content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    try { values.push(parseJson(block.text)); } catch { /* Tool error prose is not JSON. */ }
  }
  if (!('content' in (response ?? {})) && response && typeof response === 'object') values.push(response);
  return values;
}
function walkObjects(value, visit, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return;
  visit(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') walkObjects(child, visit, depth + 1);
}
export function parseFlowJob(response) {
  const found = new Map();
  for (const payload of jsonPayloads(response)) walkObjects(payload, value => {
    if (UUID.test(value.id ?? '') && JOB_STATUSES.has(value.status) && value.mediaType === 'video' && typeof value.outputDirectory === 'string') found.set(value.id, value);
  });
  if (found.size !== 1) {
    const detail = found.size === 0 && response?.isError ? ': ' + responseText(response) : '';
    throw Error('Expected exactly one returned FlowJob, found ' + found.size + detail);
  }
  return [...found.values()][0];
}
function plainPayload(response) {
  if (response?.isError) throw Error(responseText(response));
  const values = jsonPayloads(response);
  if (values.length !== 1) throw Error('Expected one JSON tool response');
  return values[0];
}
function responseText(response) {
  return (response?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 12_000) || 'Tool returned an error without text';
}

export function validateApproval(approval) {
  if (!approval || !Number.isFinite(Date.parse(approval.approvedAt)) || typeof approval.userStatement !== 'string' || !approval.userStatement.trim()) throw Error('Explicit dated user approval is missing');
  if (approval.maxGenerationRequests !== 34 || approval.outputsPerRequest !== 1 || approval.upscale !== 'none' || approval.regenerateAmbiguousSubmission !== false) throw Error('Approval must cap 34 generation requests, one output, no upscale, and no ambiguous resubmission');
  if (approval.exactCreditCost == null && approval.exactCostWasDisclosedAsUnavailable !== true) throw Error('Unknown credit cost must have been disclosed');
  if (typeof approval.scope !== 'string' || !/Omni\s+1\.1\s+Flash/i.test(approval.scope) || !/10\s+seconds/i.test(approval.scope) || !approval.scope.includes('16:9')) throw Error('Approval does not explicitly identify Omni 1.1 Flash, 10 seconds, 16:9');
  return approval;
}

function observedProjectUrl(value) {
  if (typeof value !== 'string') return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'flow.google.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/project\/[0-9a-f-]{36}$/i.test(url.pathname)) throw Error('Expected an observed, exact flow.google.com/project/UUID URL');
  return url.href;
}

export async function validateProductionQueue(queueFile, approvalFile, { startSlot = 1, limit = 34 } = {}) {
  if (!Number.isInteger(startSlot) || startSlot < 1 || startSlot > 34 || !Number.isInteger(limit) || limit < 1 || limit > 34) throw Error('start-slot and limit must be integers between 1 and 34');
  const queuePath = await safePath(queueFile, process.cwd(), { mustExist: true });
  const titleDir = path.dirname(queuePath);
  const approvalPath = await safePath(approvalFile ?? path.join(titleDir, 'approval.json'), process.cwd(), { mustExist: true, within: titleDir });
  if (!(await stat(queuePath)).isFile() || !(await stat(approvalPath)).isFile()) throw Error('Queue and approval must be files');
  const approval = validateApproval(parseJson(await readFile(approvalPath, 'utf8')));
  const queue = parseJson(await readFile(queuePath, 'utf8'));
  if (!Array.isArray(queue) || queue.length < 1 || queue.length > 34) throw Error('Queue must contain between 1 and 34 requests');
  const ids = new Set();
  const directories = new Set();
  for (const [index, entry] of queue.entries()) {
    if (entry.outputSlot !== index + 1 || entry.tool !== 'flow_generate_video') throw Error('Queue must be ordered by contiguous outputSlot, using only flow_generate_video');
    const args = entry.arguments;
    if (!args || Object.keys(args).some(key => !ARG_KEYS.has(key))) throw Error(`Slot ${entry.outputSlot}: unsupported generation arguments`);
    if (args.model !== 'omni-1-1-flash' || args.durationSeconds !== 10 || args.aspectRatio !== '16:9' || args.outputs !== 1 || args.upscale !== 'none' || args.download !== true || args.confirmCreditSpend !== true) throw Error(`Slot ${entry.outputSlot}: arguments exceed or differ from approval`);
    if (typeof args.prompt !== 'string' || args.prompt.length < 3 || args.prompt.length > 20_000) throw Error('Invalid prompt');
    if (!Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 15 || args.timeoutSeconds > 900) throw Error('Invalid generation timeout');
    if (!Array.isArray(args.referenceFiles)) throw Error('referenceFiles must be an explicit array');
    for (const reference of args.referenceFiles) await safePath(reference, titleDir, { mustExist: true });
    if (!path.isAbsolute(args.outputDirectory)) throw Error('outputDirectory must be absolute');
    const outputDirectory = await safePath(args.outputDirectory, titleDir, { mustExist: true, within: titleDir });
    if (!(await stat(outputDirectory)).isDirectory() || path.basename(outputDirectory) !== `scene-${String(entry.outputSlot).padStart(2, '0')}`) throw Error('Output directory must be the existing corresponding scene-NN directory');
    if (directories.has(outputDirectory)) throw Error('Output directories must be unique');
    directories.add(outputDirectory);
    if (entry.jobId != null) {
      if (!UUID.test(entry.jobId) || ids.has(entry.jobId)) throw Error('Job IDs must be valid and unique');
      ids.add(entry.jobId);
    }
    if (entry.status === 'planned' && entry.jobId != null) throw Error('A planned entry already has a Job ID; reconcile it without resubmitting');
    if (typeof entry.status !== 'string') throw Error('Every entry needs an explicit status');
  }
  const selected = queue.filter(entry => entry.outputSlot >= startSlot && entry.outputSlot < startSlot + limit);
  if (!selected.length) throw Error('No slots are selected');
  return { queuePath, approvalPath, titleDir, approval, queue, selected, startSlot, limit, approvalFingerprint: fingerprint(approval) };
}

async function atomicJson(file, value) {
  const target = await safePath(file);
  const temp = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, target);
}
async function updateEntry(plan, slot, mutate) {
  // Merge into the newest queue, preserving root's updates to other slots.
  // A production lock prevents a second runner; any external edit is checked before rename.
  for (let attempt = 0; attempt < 5; attempt++) {
    const originalText = await readFile(plan.queuePath, 'utf8');
    const queue = parseJson(originalText);
    const entry = queue.find(item => item.outputSlot === slot);
    const expected = plan.queue.find(item => item.outputSlot === slot);
    if (!entry || fingerprint(entry.arguments) !== fingerprint(expected.arguments)) throw Error(`Slot ${slot}: generation arguments changed while running`);
    mutate(entry);
    if ((await readFile(plan.queuePath, 'utf8')) !== originalText) continue;
    await atomicJson(plan.queuePath, queue);
    return entry;
  }
  throw Error('Queue is being edited concurrently; stopped without another generation');
}
async function saveJob(plan, slot, job) {
  const entry = await updateEntry(plan, slot, current => {
    if (current.jobId && current.jobId !== job.id) throw Error('Returned job differs from the exact recorded Job ID');
    current.jobId = job.id;
    current.status = job.status;
    current.jobStatus = job.status;
    current.jobUpdatedAt = job.updatedAt ?? now();
    current.lastObservedAt = now();
    if (job.error) current.error = job.error;
  });
  const file = await safePath(path.join(entry.arguments.outputDirectory, 'job.json'), plan.titleDir, { within: plan.titleDir });
  if (await maybeStat(file)) {
    const previous = parseJson(await readFile(file, 'utf8'));
    if (previous.id !== job.id) throw Error('scene/job.json belongs to a different Job ID; preserving it');
  }
  await atomicJson(file, job);
  return entry;
}
async function validateReturnedJob(job, entry, accountId) {
  if (job.id !== entry.jobId || job.accountId !== accountId || job.mediaType !== 'video' || job.model !== entry.arguments.model || job.aspectRatio !== '16:9' || job.durationSeconds !== 10 || job.outputs !== 1 || job.upscale !== 'none' || job.upscaleSubmitted || (job.chosenUpscale && job.chosenUpscale !== 'none') || job.prompt !== entry.arguments.prompt) throw Error('Returned FlowJob identity/settings do not match the authorized request; no further work submitted');
  const actual = await safePath(job.outputDirectory, ROOT, { mustExist: true });
  const expected = await safePath(entry.arguments.outputDirectory, ROOT, { mustExist: true });
  if (actual !== expected) throw Error('Returned FlowJob outputDirectory differs from the authorized scene directory');
}
async function ffprobe(file) {
  return new Promise((resolve, reject) => {
    const process = spawn('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-show_streams', '-show_format', '-of', 'json', file], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    process.stdout.on('data', chunk => { stdout += chunk; });
    process.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    process.on('error', reject);
    process.on('close', code => { if (code !== 0) reject(Error(`ffprobe failed: ${stderr}`)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
  });
}
async function verifyDownloadedFiles(job, entry) {
  if (!Array.isArray(job.downloadedFiles) || job.downloadedFiles.length !== 1) throw Error('Completed Job must contain exactly one explicit downloadedFiles path');
  const files = [];
  for (const returnedPath of job.downloadedFiles) {
    if (!path.isAbsolute(returnedPath)) throw Error('Downloaded path must be the absolute path returned by the Job');
    const file = await safePath(returnedPath, ROOT, { mustExist: true, within: entry.arguments.outputDirectory });
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size <= 0) throw Error('Downloaded video is empty or not a file');
    const probe = await ffprobe(file);
    const video = probe.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const duration = Number(video?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0 || !(video.width > 0) || !(video.height > 0)) throw Error('Downloaded file lacks a valid video stream with a positive verified duration');
    files.push({ path: file, bytes: metadata.size, durationSeconds: duration, requestedDurationSeconds: 10, durationDifferenceSeconds: duration - 10, width: video.width, height: video.height, codec: video.codec_name, frameRate: video.avg_frame_rate });
  }
  return { checkedAt: now(), valid: true, files };
}

export async function runFlowProduction(queueFile, approvalFile, options = {}) {
  let plan = await validateProductionQueue(queueFile, approvalFile, options);
  if (options.dryRun) return { status: 'dry_run_validated', mcpConnected: false, generationSubmitted: false, queue: plan.queuePath, approval: plan.approvalPath, slots: plan.selected.map(entry => ({ outputSlot: entry.outputSlot, status: entry.status, jobId: entry.jobId })), maximumRequests: 34 };
  const maxWaitSeconds = options.maxWaitSeconds ?? 1800;
  if (!Number.isInteger(maxWaitSeconds) || maxWaitSeconds < 60 || maxWaitSeconds > 43_200) throw Error('max-wait-seconds must be between 60 and 43200');
  const lockPath = await safePath(path.join(plan.titleDir, '.production-runner.lock'), ROOT, { within: plan.titleDir });
  const runId = randomUUID();
  const lock = await open(lockPath, 'wx').catch(error => { throw Error(`Cannot reserve production runner lock; another runner or unfinished run needs review: ${error.message}`); });
  await lock.writeFile(JSON.stringify({ runId, pid: process.pid, startedAt: now() })); await lock.sync(); await lock.close();
  let session; let eventFile; let currentSlot; let lastToolResponseFile;
  const emit = async (event, detail = {}) => {
    const row = { time: now(), event, runId, ...detail };
    process.stdout.write(JSON.stringify(row) + '\n');
    if (eventFile) await appendFile(eventFile, JSON.stringify(row) + '\n', 'utf8');
  };
  try {
    plan = await validateProductionQueue(queueFile, approvalFile, options);
    const earlier = plan.queue.filter(entry => entry.outputSlot < plan.startSlot);
    if (earlier.some(entry => entry.status !== 'completed' || !entry.jobId)) throw Error('Earlier slots must be completed before starting later slots');
    const logsDir = await safePath(path.join(plan.titleDir, 'production-runs'), ROOT, { within: plan.titleDir });
    if (!(await maybeStat(logsDir))) await mkdir(logsDir);
    eventFile = await safePath(path.join(logsDir, `${runId}.jsonl`), ROOT, { within: plan.titleDir });
    const log = await open(eventFile, 'wx'); await log.close();
    await emit('run_started', { startSlot: plan.startSlot, limit: plan.limit, eventFile });
    const { startFlowProductionSession } = await import('./flow-production-session.mjs');
    session = await startFlowProductionSession();
    const originalCall = session.call;
    let callNumber = 0;
    session.call = async (tool, args = {}) => {
      if (!/^flow_[a-z_]+$/.test(tool)) throw Error('Invalid tool name for a local response artifact');
      const sequence = String(++callNumber).padStart(3, '0');
      const artifact = await safePath(path.join(logsDir, runId + '-call' + sequence + '-' + tool + '.json'), ROOT, { within: plan.titleDir });
      // Reserve storage before a paid call; preserve the complete response before any parsing.
      const handle = await open(artifact, 'wx');
      const startedAt = now();
      lastToolResponseFile = artifact;
      try {
        let result;
        try { result = await originalCall(tool, args); }
        catch (error) {
          await handle.writeFile(JSON.stringify({ tool, arguments: args, startedAt, receivedAt: now(), transportError: { name: error.name, message: error.message } }, null, 2) + '\n', 'utf8');
          await handle.sync();
          throw error;
        }
        await handle.writeFile(JSON.stringify({ tool, arguments: args, startedAt, receivedAt: now(), result }, null, 2) + '\n', 'utf8');
        await handle.sync();
        return result;
      } finally { await handle.close(); }
    };
    const accounts = plainPayload(await session.call('flow_list_accounts', {}));
    const accountId = accounts.defaultAccountId;
    if (accounts.readyForGeneration !== true || !accounts.accounts?.some(account => account.id === accountId && account.connectionStatus === 'connected')) throw Error('Default Flow account is not connected. Runner stopped; no reconnect was attempted');
    const capabilities = plainPayload(await session.call('flow_inspect_account', { accountId }));
    if (!capabilities.workspaceAvailable || !capabilities.signedIn || !capabilities.models?.video?.some(model => model.id === 'omni-1-1-flash') || !capabilities.aspectRatiosByMedia?.video?.includes('16:9') || !capabilities.outputCountsByMedia?.video?.includes(1)) throw Error('Live Flow inspection did not verify the authorized model/ratio/single output; stopped before generation');
    let projectUrl = options.projectUrl ? observedProjectUrl(options.projectUrl) : undefined;
    if (!projectUrl) for (const prior of [...earlier].reverse()) {
      const priorFile = await safePath(path.join(prior.arguments.outputDirectory, 'job.json'), ROOT, { within: plan.titleDir });
      if (await maybeStat(priorFile)) {
        const priorJob = parseJson(await readFile(priorFile, 'utf8'));
        if (priorJob.id !== prior.jobId) throw Error('Prior scene job.json does not match its recorded Job ID');
        if (priorJob.flowProjectUrl) { projectUrl = observedProjectUrl(priorJob.flowProjectUrl); break; }
      }
    }
    if (!projectUrl) projectUrl = observedProjectUrl(capabilities.url);
    if (!projectUrl) throw Error('No observed existing Flow project URL is available; stopped before generation');
    const settings = plainPayload(await session.call('flow_validate_generation_settings', { accountId, flowProjectUrl: projectUrl, mediaType: 'video', model: 'omni-1-1-flash', aspectRatio: '16:9', durationSeconds: 10, outputs: 1 }));
    if (settings.status !== 'settings_verified' || settings.generationSubmitted !== false || settings.jobCreated !== false || settings.originalSettingsRestored !== true || settings.selected?.model !== 'omni-1-1-flash' || settings.selected?.durationSeconds !== 10 || settings.selected?.aspectRatio !== '16:9' || settings.selected?.outputs !== 1) throw Error('Exact authorized settings were not verified in the existing Flow project');
    await emit('account_and_settings_verified', { accountId, model: 'omni-1-1-flash', durationSeconds: 10, aspectRatio: '16:9', outputs: 1 });
    for (const selected of plan.selected) {
      currentSlot = selected.outputSlot;
      const latest = parseJson(await readFile(plan.queuePath, 'utf8'));
      let entry = latest.find(item => item.outputSlot === currentSlot);
      if (fingerprint(entry.arguments) !== fingerprint(selected.arguments)) throw Error('Queue arguments changed during run');
      if (entry.arguments.accountId && entry.arguments.accountId !== accountId) throw Error('Queue targets a different account than the connected default');
      if (fingerprint(validateApproval(parseJson(await readFile(plan.approvalPath, 'utf8')))) !== plan.approvalFingerprint) throw Error('Approval changed during run; stopped for review');
      let job;
      if (entry.status === 'completed') {
        if (!entry.jobId) throw Error('Completed queue entry lacks a Job ID');
        const response = await session.call('flow_job_status', { jobId: entry.jobId, waitSeconds: 0 });
        job = parseFlowJob(response);
        if (job.id !== entry.jobId) throw Error('Status tool returned another Job ID');
        entry = await saveJob(plan, currentSlot, job);
        if (response.isError) throw Error(responseText(response));
      } else if (entry.status === 'planned') {
        if (entry.jobId) throw Error('A planned entry already has a Job ID; refusing generation');
        const sceneJob = path.join(entry.arguments.outputDirectory, 'job.json');
        if (await maybeStat(sceneJob)) throw Error('Scene already contains job.json; reconcile that existing Job without resubmission');
        entry = await updateEntry(plan, currentSlot, current => {
          if (current.status !== 'planned' || current.jobId) throw Error('Entry changed before submission; refusing duplicate generation');
          current.status = 'generation_call_started'; current.generationCallStartedAt = now(); current.productionRunId = runId;
        });
        await emit('generation_call_started', { outputSlot: currentSlot });
        let response;
        try {
          response = await session.call('flow_generate_video', entry.arguments);
          job = parseFlowJob(response);
        } catch (error) {
          const detail = response ? `${error.message}\n${responseText(response)}` : error.message;
          await updateEntry(plan, currentSlot, current => { current.status = 'unknown_submission'; current.error = detail; current.stoppedAt = now(); });
          throw Error(`Generation submission is uncertain for slot ${currentSlot}; automatic resubmission is forbidden. ${detail}`);
        }
        entry = await saveJob(plan, currentSlot, job); // Persist the returned ID before any further tool call.
        await emit('job_recorded', { outputSlot: currentSlot, jobId: job.id, status: job.status });
        if (response.isError) throw Error(responseText(response));
      } else if (['submitted', 'processing', 'ready', 'downloading'].includes(entry.status) && entry.jobId) {
        const response = await session.call('flow_job_status', { jobId: entry.jobId, waitSeconds: 20 });
        job = parseFlowJob(response);
        if (job.id !== entry.jobId) throw Error('Status tool returned another Job ID');
        entry = await saveJob(plan, currentSlot, job);
        if (response.isError) throw Error(responseText(response));
      } else {
        if (entry.status === 'generation_call_started' && !entry.jobId) await updateEntry(plan, currentSlot, current => { current.status = 'unknown_submission'; });
        throw Error(`Slot ${currentSlot} has status ${entry.status}; requires review and will not be regenerated`);
      }
      await validateReturnedJob(job, entry, accountId);
      const deadline = Date.now() + maxWaitSeconds * 1000;
      let lastEventTime = Date.now(); let lastStatus = job.status; let explicitDownloadCalled = false;
      while (job.status !== 'completed') {
        if (job.error || ['failed', 'needs_attention', 'created', 'configuring', 'upscaling'].includes(job.status)) throw Error(`Job ${job.id} stopped with ${job.status}: ${job.error ?? 'Manual review required'}`);
        if (Date.now() >= deadline) throw Error(`Polling time limit reached for ${job.id}; exact Job ID retained, no regeneration`);
        const exactId = job.id;
        let response = await session.call('flow_job_status', { jobId: exactId, waitSeconds: 20 });
        job = parseFlowJob(response);
        if (job.id !== exactId) throw Error('Status tool returned another Job ID');
        entry = await saveJob(plan, currentSlot, job);
        await validateReturnedJob(job, entry, accountId);
        if (response.isError) throw Error(responseText(response));
        if (job.status === 'ready' && !job.error && !explicitDownloadCalled) {
          explicitDownloadCalled = true;
          response = await session.call('flow_download_job', { jobId: exactId });
          job = parseFlowJob(response);
          if (job.id !== exactId) throw Error('Download tool returned another Job ID');
          entry = await saveJob(plan, currentSlot, job);
          await validateReturnedJob(job, entry, accountId);
          if (response.isError) throw Error(responseText(response));
        }
        if (job.status !== lastStatus || Date.now() - lastEventTime >= 60_000) {
          await emit('job_status', { outputSlot: currentSlot, jobId: job.id, status: job.status });
          lastStatus = job.status; lastEventTime = Date.now();
        }
      }
      if (job.error) throw Error(`Completed job includes an error: ${job.error}`);
      let verification;
      try { verification = await verifyDownloadedFiles(job, entry); }
      catch (error) {
        await updateEntry(plan, currentSlot, current => { current.status = 'verification_failed'; current.error = error.message; });
        throw error;
      }
      await updateEntry(plan, currentSlot, current => { current.status = 'completed'; current.fileVerification = verification; current.downloadedFiles = [...job.downloadedFiles]; current.completedAt = now(); });
      await emit('clip_completed', { outputSlot: currentSlot, jobId: job.id, verification });
    }
    await emit('run_completed', { outputSlots: plan.selected.map(entry => entry.outputSlot) });
    return { status: 'completed', eventFile, outputSlots: plan.selected.map(entry => entry.outputSlot) };
  } catch (error) {
    if (currentSlot) await updateEntry(plan, currentSlot, entry => { entry.runnerStoppedAt = now(); entry.runnerError = error.message; }).catch(() => undefined);
    await emit('run_stopped', { outputSlot: currentSlot, message: error.message, lastToolResponseFile }).catch(() => undefined);
    throw error;
  } finally {
    if (session) await session.close().catch(() => undefined);
    const currentLock = parseJson(await readFile(lockPath, 'utf8'));
    if (currentLock.runId === runId) await unlink(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const positional = []; const options = {}; let approvalFile;
  try {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--dry-run') options.dryRun = true;
      else if (arg === '--approval') approvalFile = args[++index];
      else if (arg === '--project-url') options.projectUrl = observedProjectUrl(args[++index]);
      else if (['--start-slot', '--limit', '--max-wait-seconds'].includes(arg)) {
        const name = { '--start-slot': 'startSlot', '--limit': 'limit', '--max-wait-seconds': 'maxWaitSeconds' }[arg];
        options[name] = Number(args[++index]);
      } else if (arg.startsWith('--')) throw Error(`Unknown option: ${arg}`);
      else positional.push(arg);
    }
    if (positional.length !== 1) throw Error('Usage: node scripts/run-flow-production.mjs <generation-queue.json> [--approval approval.json] [--start-slot 2 --limit 33] [--dry-run]');
    const result = await runFlowProduction(positional[0], approvalFile, options);
    process.stdout.write(JSON.stringify({ time: now(), event: 'result', ...result }) + '\n');
  } catch (error) { console.error(JSON.stringify({ time: now(), event: 'fatal', message: error.message })); process.exitCode = 1; }
}
