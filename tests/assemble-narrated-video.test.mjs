import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rmdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assembleNarratedVideo, PROJECT_ROOT, validateManifest } from '../scripts/assemble-narrated-video.mjs';

function command(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${executable}: ${stderr}`)));
  });
}

async function writeManifest(directory, name, manifest) {
  const file = path.join(directory, name);
  await writeFile(file, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return file;
}

function magnitude(samples, sampleRate, frequency, startSeconds, durationSeconds) {
  let real = 0;
  let imaginary = 0;
  const start = Math.floor(startSeconds * sampleRate);
  const end = Math.min(samples.length / 4, start + Math.floor(durationSeconds * sampleRate));
  for (let index = start; index < end; index++) {
    const value = samples.readFloatLE(index * 4);
    const angle = 2 * Math.PI * frequency * index / sampleRate;
    real += value * Math.cos(angle);
    imaginary -= value * Math.sin(angle);
  }
  return Math.hypot(real, imaginary);
}

test('local assembly follows weighted shots and supplied narration, verifies output, and refuses unsafe plans', { timeout: 120_000 }, async t => {
  const validationDir = path.join(PROJECT_ROOT, 'validation');
  await mkdir(validationDir, { recursive: true });
  const fixtureDir = await mkdtemp(path.join(validationDir, 'narrated-assembly-test-'));
  t.diagnostic(`Synthetic fixture and intermediates retained for review: ${fixtureDir}`);
  const red = path.join(fixtureDir, 'red-with-unwanted-audio.mp4');
  const blue = path.join(fixtureDir, 'blue-portrait.mp4');
  const audio1 = path.join(fixtureDir, 'narration-440.wav');
  const audio2 = path.join(fixtureDir, 'narration-660.wav');
  const ff = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n'];
  await command('ffmpeg', [...ff, '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=1.2', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', red]);
  await command('ffmpeg', [...ff, '-f', 'lavfi', '-i', 'color=c=blue:s=90x160:r=30:d=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue]);
  await command('ffmpeg', [...ff, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.81', '-c:a', 'pcm_s16le', audio1]);
  await command('ffmpeg', [...ff, '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=0.61', '-c:a', 'pcm_s16le', audio2]);
  const sourceHash = createHash('sha256').update(await readFile(red)).digest('hex');
  const manifest = {
    version: 1,
    output: 'final.mp4',
    workDir: 'render-001',
    width: 320,
    height: 180,
    fps: 30,
    groups: [
      { id: 'introduction', audio: path.basename(audio1), shots: [{ video: path.basename(red), weight: 1 }, { video: path.basename(blue), weight: 2 }] },
      { id: 'second-point', audio: path.basename(audio2), shots: [{ video: path.basename(red), weight: 1, startSeconds: 0.2 }] },
    ],
  };
  const manifestPath = await writeManifest(fixtureDir, 'manifest.json', manifest);

  await t.test('validate-only reads real media durations without creating outputs or intermediates', async () => {
    const plan = await assembleNarratedVideo(manifestPath, { validateOnly: true });
    assert.equal(plan.status, 'validated');
    assert.equal(plan.renderingStarted, false);
    assert.equal(plan.groups[0].shots[0].frames, 8);
    assert.equal(plan.groups[0].shots[1].frames, 17);
    assert.ok(Math.abs(plan.narrationDuration - 1.42) < 0.00001);
    await assert.rejects(lstat(path.join(fixtureDir, manifest.output)), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(fixtureDir, manifest.workDir)), { code: 'ENOENT' });
  });

  await t.test('missing media, invalid weights, too-short sources and project escapes fail before render', async () => {
    const cases = [
      { name: 'missing', change: clone => { clone.groups[0].audio = 'missing.wav'; }, expected: /ENOENT/ },
      { name: 'zero-weight', change: clone => { clone.groups[0].shots[0].weight = 0; }, expected: /positive finite/ },
      { name: 'insufficient', change: clone => { clone.groups[0].shots[1].startSeconds = 1; }, expected: /insufficient footage/ },
      { name: 'outside-output', change: clone => { clone.output = path.join(PROJECT_ROOT, '..', 'outside-final.mp4'); }, expected: /outside project/ },
      { name: 'outside-input', change: clone => { clone.groups[0].audio = path.join(PROJECT_ROOT, '..', 'outside.wav'); }, expected: /outside project/ },
      { name: 'empty-groups', change: clone => { clone.groups = []; }, expected: /at least one/ },
      { name: 'negative-start', change: clone => { clone.groups[0].shots[0].startSeconds = -1; }, expected: /invalid startSeconds/ },
    ];
    for (const entry of cases) {
      const clone = structuredClone(manifest);
      entry.change(clone);
      const file = await writeManifest(fixtureDir, `${entry.name}.json`, clone);
      await assert.rejects(validateManifest(file), entry.expected, entry.name);
    }
    const zero = path.join(fixtureDir, 'zero.wav');
    await writeFile(zero, '', { flag: 'wx' });
    const clone = structuredClone(manifest);
    clone.groups[0].audio = 'zero.wav';
    await assert.rejects(validateManifest(await writeManifest(fixtureDir, 'empty-media.json', clone)), /empty media/);
    await assert.rejects(lstat(path.join(fixtureDir, manifest.workDir)), { code: 'ENOENT' });
  });

  await t.test('junction/symlink output traversal is rejected', async () => {
    const junction = path.join(fixtureDir, 'outside-project-link');
    await symlink(path.dirname(PROJECT_ROOT), junction, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const clone = structuredClone(manifest);
      clone.workDir = 'outside-project-link/new-work-must-not-be-created';
      await assert.rejects(validateManifest(await writeManifest(fixtureDir, 'junction.json', clone)), /resolves outside project/);
    } finally {
      // Remove only our junction entry, without recursive traversal or touching its target.
      if (process.platform === 'win32') await rmdir(junction);
      else { const { unlink } = await import('node:fs/promises'); await unlink(junction); }
    }
  });

  await t.test('render preserves shots, replaces clip audio, and writes one verified MP4 without touching sources', async () => {
    const result = await assembleNarratedVideo(manifestPath);
    assert.equal(result.status, 'complete');
    assert.equal(result.sourceAudioDiscarded, true);
    assert.equal(result.verification.videoCodec, 'h264');
    assert.equal(result.verification.audioCodec, 'aac');
    assert.equal(result.verification.width, 320);
    assert.equal(result.verification.height, 180);
    assert.equal(result.verification.fps, 30);
    assert.ok(result.verification.bytes > 1000);
    assert.ok(Math.abs(result.verification.duration - 44 / 30) < 0.07);
    assert.equal(createHash('sha256').update(await readFile(red)).digest('hex'), sourceHash);
    const pcm = await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', result.output, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
    assert.ok(magnitude(pcm, 48000, 440, 0.1, 0.5) > 20 * magnitude(pcm, 48000, 880, 0.1, 0.5), 'Narration 440 Hz must dominate discarded source 880 Hz');
    assert.ok(magnitude(pcm, 48000, 660, 0.95, 0.3) > 20 * magnitude(pcm, 48000, 880, 0.95, 0.3), 'Second group narration must be present after first group');
    const frame = await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', result.output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const center = (90 * 320 + 160) * 3;
    const edge = (90 * 320 + 5) * 3;
    assert.ok(frame[center + 2] > 180 && frame[center] < 30, 'Weighted second shot must be blue at 0.5 seconds');
    assert.ok(frame[edge] < 20 && frame[edge + 1] < 20 && frame[edge + 2] < 20, 'Portrait shot must have padding, not destructive cropping/stretching');
    const finalBytes = await readFile(result.output);
    assert.ok(finalBytes.indexOf(Buffer.from('moov')) < finalBytes.indexOf(Buffer.from('mdat')), 'MP4 must use faststart');
    const hash = createHash('sha256').update(finalBytes).digest('hex');
    await assert.rejects(assembleNarratedVideo(manifestPath), /Refusing to overwrite/);
    assert.equal(createHash('sha256').update(await readFile(result.output)).digest('hex'), hash);
  });
});
