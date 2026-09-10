// Local-only narrated video assembly. No generation, network services, or source edits.
// Paths are relative to the manifest, and must resolve inside this project.
// See tests/assemble-narrated-video.test.mjs for a complete runnable example.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Reject playlist/manifest demuxers that can refer to additional unvalidated files.
const LOCAL_MEDIA_FORMATS = 'mov,matroska,webm,wav,mp3,flac,ogg,aac,nut';

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-24_000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)));
  });
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function exists(candidate) {
  try { return await lstat(candidate); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function projectPath(value, base, root, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label}: expected a nonempty local path`);
  const candidate = path.resolve(base, value);
  if (!inside(root, candidate)) throw new Error(`${label}: path is outside project`);
  // Resolve the nearest existing ancestor, including junctions/symlinks in output paths.
  let ancestor = candidate;
  while (!(await exists(ancestor))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`${label}: no existing parent`);
    ancestor = parent;
  }
  const resolved = await realpath(ancestor);
  if (!inside(root, resolved)) throw new Error(`${label}: symlink/junction resolves outside project`);
  return path.join(resolved, path.relative(ancestor, candidate));
}

function positive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${label}: expected a positive finite number`);
  return value;
}

function streamDuration(stream) {
  const duration = Number(stream.duration);
  if (Number.isFinite(duration) && duration > 0) return duration;
  const [numerator, denominator] = String(stream.time_base ?? '').split('/').map(Number);
  const ticks = Number(stream.duration_ts);
  const fromTicks = ticks * numerator / denominator;
  if (Number.isFinite(fromTicks) && fromTicks > 0) return fromTicks;
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(stream.tags?.DURATION ?? '');
  if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  throw new Error('Media stream has no reliable positive duration; inspect or remux it before assembly');
}

export async function probeMedia(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty media file: ${file}`);
  return JSON.parse(await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', LOCAL_MEDIA_FORMATS, '-show_streams', '-show_format', '-of', 'json', file]));
}

function allocateFrames(shots, totalFrames) {
  const weightSum = shots.reduce((sum, shot) => sum + shot.weight, 0);
  if (!Number.isFinite(weightSum)) throw new Error('Shot weights overflow');
  const allocations = shots.map((shot, index) => {
    const exact = totalFrames * (shot.weight / weightSum);
    return { index, frames: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = totalFrames - allocations.reduce((sum, item) => sum + item.frames, 0);
  const sorted = [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const item of sorted) { if (remaining-- <= 0) break; item.frames++; }
  if (allocations.some(item => item.frames < 1)) throw new Error('A shot receives less than one frame; increase its weight or use fewer shots');
  return allocations.map(item => item.frames);
}

/** Schema: {version:1, output, workDir, width?:1920, height?:1080, fps?:30,
 * groups:[{id?, audio, shots:[{video, weight?:1, startSeconds?:0}]}]}
 * Audio and video paths are local. Video source audio is always discarded.
 * Each group's narration is padded by <1 frame to keep frame-aligned joins.
 * Footage is never looped, frozen, slowed down, or fabricated to cover shortfalls.
 */
export async function validateManifest(manifestFile) {
  const root = await realpath(PROJECT_ROOT);
  const manifestPath = await projectPath(manifestFile, process.cwd(), root, 'manifest');
  const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  if (manifest.version !== 1) throw new Error('Manifest version must be 1');
  const base = path.dirname(manifestPath);
  const output = await projectPath(manifest.output, base, root, 'output');
  const workDir = await projectPath(manifest.workDir, base, root, 'workDir');
  if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('Output must have an .mp4 extension');
  if (await exists(output)) throw new Error(`Refusing to overwrite existing output: ${output}`);
  if (await exists(workDir)) throw new Error(`workDir must be a new, unique directory: ${workDir}`);
  if (inside(workDir, output)) throw new Error('Final output must be outside the intermediate workDir');
  for (const [label, candidate] of [['output', output], ['workDir', workDir]]) {
    const parentInfo = await stat(path.dirname(candidate));
    if (!parentInfo.isDirectory()) throw new Error(`${label}: parent must already be a directory`);
  }
  const width = manifest.width ?? 1920;
  const height = manifest.height ?? 1080;
  const fps = manifest.fps ?? 30;
  if (![width, height].every(value => Number.isInteger(value) && value >= 16 && value <= 7680 && value % 2 === 0)) throw new Error('Width and height must be even integers from 16 to 7680');
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error('fps must be an integer from 1 to 120');
  if (!Array.isArray(manifest.groups) || !manifest.groups.length) throw new Error('Manifest needs at least one narrative group');
  const groups = [];
  for (const [groupIndex, group] of manifest.groups.entries()) {
    const label = `group ${groupIndex + 1}`;
    const audio = await projectPath(group.audio, base, root, `${label} audio`);
    const audioProbe = await probeMedia(audio);
    const audioStream = audioProbe.streams.find(stream => stream.codec_type === 'audio');
    if (!audioStream) throw new Error(`${label}: narration file has no audio stream`);
    const narrationDuration = positive(streamDuration(audioStream), `${label} narration duration`);
    const frames = Math.ceil(narrationDuration * fps - 1e-8);
    const duration = frames / fps;
    if (!Array.isArray(group.shots) || !group.shots.length) throw new Error(`${label}: at least one explicit video shot is required`);
    const shots = [];
    for (const [shotIndex, shot] of group.shots.entries()) {
      const video = await projectPath(shot.video, base, root, `${label} shot ${shotIndex + 1}`);
      const videoProbe = await probeMedia(video);
      const videoStream = videoProbe.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
      if (!videoStream) throw new Error(`${label}: shot has no video stream`);
      const sourceDuration = positive(streamDuration(videoStream), `${label} shot duration`);
      const startSeconds = shot.startSeconds ?? 0;
      if (typeof startSeconds !== 'number' || !Number.isFinite(startSeconds) || startSeconds < 0) throw new Error(`${label}: invalid startSeconds`);
      shots.push({ video, weight: positive(shot.weight ?? 1, `${label} shot weight`), startSeconds, sourceDuration, videoStreamIndex: videoStream.index });
    }
    const allocated = allocateFrames(shots, frames);
    for (const [index, shot] of shots.entries()) {
      shot.frames = allocated[index];
      shot.duration = shot.frames / fps;
      const available = shot.sourceDuration - shot.startSeconds;
      if (available + 1e-7 < shot.duration) throw new Error(`${label} shot ${index + 1}: insufficient footage; needs ${shot.duration.toFixed(6)}s, has ${Math.max(0, available).toFixed(6)}s. Supply more footage or change explicit weights; no automatic repeat.`);
    }
    groups.push({ id: group.id ?? String(groupIndex + 1), audio, audioStreamIndex: audioStream.index, narrationDuration, duration, frames, shots });
  }
  return { manifestPath, root, output, workDir, width, height, fps, groups, duration: groups.reduce((sum, group) => sum + group.duration, 0), narrationDuration: groups.reduce((sum, group) => sum + group.narrationDuration, 0) };
}

function decimal(value) { return value.toFixed(9); }

async function verifyOutput(file, plan) {
  const probe = await probeMedia(file);
  const videos = probe.streams.filter(stream => stream.codec_type === 'video');
  const audios = probe.streams.filter(stream => stream.codec_type === 'audio');
  if (videos.length !== 1 || audios.length !== 1 || videos[0].codec_name !== 'h264' || audios[0].codec_name !== 'aac') throw new Error('Output must contain exactly one H.264 video and one AAC narration stream');
  if (videos[0].width !== plan.width || videos[0].height !== plan.height || videos[0].pix_fmt !== 'yuv420p') throw new Error('Output dimensions or pixel format do not match the manifest');
  const [rateN, rateD] = videos[0].avg_frame_rate.split('/').map(Number);
  if (Math.abs(rateN / rateD - plan.fps) > 1e-6) throw new Error('Output frame rate does not match the manifest');
  const tolerance = Math.max(0.06, 2 / plan.fps);
  for (const stream of [...videos, ...audios]) {
    if (Math.abs(streamDuration(stream) - plan.duration) > tolerance) throw new Error(`Output ${stream.codec_type} duration does not match narration plan`);
  }
  return { bytes: (await stat(file)).size, duration: Number(probe.format.duration), videoDuration: streamDuration(videos[0]), audioDuration: streamDuration(audios[0]), videoCodec: videos[0].codec_name, audioCodec: audios[0].codec_name, width: videos[0].width, height: videos[0].height, fps: rateN / rateD };
}

export async function assembleNarratedVideo(manifestFile, { validateOnly = false } = {}) {
  const plan = await validateManifest(manifestFile);
  if (validateOnly) return { status: 'validated', renderingStarted: false, ...plan };
  // mkdir without recursive/exist_ok is an exclusive reservation of a fresh work area.
  await mkdir(plan.workDir);
  await writeFile(path.join(plan.workDir, 'resolved-plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  const files = [];
  for (const [groupIndex, group] of plan.groups.entries()) {
    // NUT retains the exact frame/audio time bases across intermediate joins.
    const name = `group-${String(groupIndex + 1).padStart(3, '0')}.nut`;
    const file = path.join(plan.workDir, name);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n'];
    for (const shot of group.shots) args.push('-protocol_whitelist', 'file,pipe', '-format_whitelist', LOCAL_MEDIA_FORMATS, '-i', shot.video);
    args.push('-protocol_whitelist', 'file,pipe', '-format_whitelist', LOCAL_MEDIA_FORMATS, '-i', group.audio);
    const filters = group.shots.map((shot, index) => `[${index}:${shot.videoStreamIndex}]trim=start=${decimal(shot.startSeconds)}:duration=${decimal(shot.duration)},setpts=PTS-STARTPTS,fps=${plan.fps},scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,trim=end_frame=${shot.frames},setpts=N/(${plan.fps}*TB)[v${index}]`);
    filters.push(group.shots.map((_, index) => `[v${index}]`).join('') + `concat=n=${group.shots.length}:v=1:a=0[v]`);
    filters.push(`[${group.shots.length}:${group.audioStreamIndex}]atrim=duration=${decimal(group.narrationDuration)},asetpts=PTS-STARTPTS,aresample=48000,apad=whole_dur=${decimal(group.duration)},atrim=duration=${decimal(group.duration)}[a]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(plan.fps), '-fps_mode', 'cfr', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-t', decimal(group.duration), file);
    await run('ffmpeg', args);
    files.push(name);
  }
  const concatFile = path.join(plan.workDir, 'groups.ffconcat');
  await writeFile(concatFile, 'ffconcat version 1.0\n' + files.map((name, index) => `file '${name}'\nduration ${decimal(plan.groups[index].duration)}`).join('\n') + '\n', { flag: 'wx' });
  const candidate = path.join(plan.workDir, 'assembled-candidate.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', concatFile, '-map', '0:v:0', '-map', '0:a:0', '-map_metadata', '-1', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', decimal(plan.duration), '-movflags', '+faststart', candidate]);
  const verification = await verifyOutput(candidate, plan);
  // Revalidate output ancestry, then atomically refuse an output created since validation.
  const currentOutput = await projectPath(plan.output, plan.root, plan.root, 'output');
  if (currentOutput !== plan.output) throw new Error('Output directory changed during rendering');
  await copyFile(candidate, plan.output, constants.COPYFILE_EXCL);
  const result = { status: 'complete', output: plan.output, workDir: plan.workDir, sourceAudioDiscarded: true, narrationDuration: plan.narrationDuration, frameAlignedDuration: plan.duration, verification };
  await writeFile(path.join(plan.workDir, 'assembly-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const validateOnly = args.includes('--validate-only') || args.includes('--dry-run');
  const paths = args.filter(arg => arg !== '--validate-only' && arg !== '--dry-run');
  if (paths.length !== 1 || paths[0].startsWith('--')) {
    console.error('Usage: node scripts/assemble-narrated-video.mjs <manifest.json> [--validate-only]');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await assembleNarratedVideo(paths[0], { validateOnly }), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
