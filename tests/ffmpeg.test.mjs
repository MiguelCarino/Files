// js/lib/ffmpeg.js: the command is safe to paste into a POSIX shell, and the
// quality value fits the chosen encoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { lib, need } from './load.mjs';

test('a hostile file name is one quoted, inert word', need('buildFfmpegCommand', 'shQuote'), () => {
  const name = "my clip $(touch pwned) `id` it's.mkv";
  const { cmd } = lib.buildFfmpegCommand({ input: name });
  assert.ok(cmd.includes(lib.shQuote(name)), cmd);
  assert.equal(lib.shQuote("it's"), "'it'\\''s'");
  // What a shell makes of the quoted words: printf echoes them back exactly,
  // with nothing run.
  const words = execFileSync('sh', ['-c', 'printf "%s\\n" ' + lib.shQuote(name) + ' ' + lib.shQuote("my clip $(touch pwned) `id` it's_encoded.mp4")], { encoding: 'utf8', cwd: tmpdir() });
  assert.equal(words, name + '\n' + "my clip $(touch pwned) `id` it's_encoded.mp4\n");
  assert.match(cmd, / 'my clip \$\(touch pwned\) `id` it'\\''s_encoded\.mp4'$/);
});

test('hardware encoders cap the quality at 51', need('buildFfmpegCommand', 'ffmpegQualityMax'), () => {
  for (const gpu of ['nvidia', 'intel', 'amd']) {
    for (const codec of ['h264', 'hevc', 'av1']) {
      assert.equal(lib.ffmpegQualityMax(codec, gpu), 51, codec + ' ' + gpu);
      const { cmd } = lib.buildFfmpegCommand({ codec, gpu, q: 63 });
      const q = Number((cmd.match(/(?:-cq|-global_quality|-qp_p) (\d+)/) || [])[1]);
      assert.ok(q > 0 && q <= 51, codec + ' ' + gpu + ': ' + cmd);
    }
  }
  assert.equal(lib.ffmpegQualityMax('vp9', 'none'), 63);
  assert.equal(lib.ffmpegQualityMax('av1', 'none'), 63);
  assert.equal(lib.ffmpegQualityMax('h264', 'none'), 51);
  // No VP9 encoder on NVIDIA: software fallback, software range.
  assert.equal(lib.ffmpegQualityMax('vp9', 'nvidia'), 63);
  assert.match(lib.buildFfmpegCommand({ codec: 'vp9', gpu: 'nvidia', q: 40 }).cmd, /-c:v libvpx-vp9 .*-crf 40/);
});

test('plain build snapshot', need('buildFfmpegCommand'), () => {
  const { cmd, explain } = lib.buildFfmpegCommand({ input: 'movie.mkv', codec: 'hevc', gpu: 'none', q: 24, res: '720', audio: 'aac', subs: 'copy' });
  assert.equal(cmd, "ffmpeg -y -i 'movie.mkv' -map 0:v:0 -map 0:a? -map 0:s? -c:v libx265 -vf scale=-2:720 -crf 24 -preset slow -c:a aac -b:a 192k -c:s copy 'movie_encoded.mkv'");
  assert.ok(explain.length >= 8);
  for (const [flag, why] of explain) assert.ok(flag && why, JSON.stringify([flag, why]));
});

test('defaults, two-pass and the WebM rules', need('buildFfmpegCommand'), () => {
  assert.equal(lib.buildFfmpegCommand({}).cmd,
    "ffmpeg -y -i 'input.mkv' -map 0:v:0 -map 0:a? -map 0:s? -c:v libx264 -crf 23 -preset slow -c:a copy -c:s mov_text 'input_encoded.mp4'");
  const two = lib.buildFfmpegCommand({ input: 'a.mov', codec: 'vp9', twopass: true }).cmd;
  assert.match(two, /-pass 1 -an -f null \/dev\/null && \\\nffmpeg .* -pass 2 'a_encoded\.webm'$/);
  assert.match(two, /-c:a libopus/);
  assert.match(two, /-c:s webvtt/);
  assert.doesNotMatch(lib.buildFfmpegCommand({ codec: 'h264', twopass: true }).cmd, /-pass/);
  assert.match(lib.buildFfmpegCommand({ audio: 'none', subs: 'none' }).cmd, /-c:v libx264 .* -an -sn '/);
});
