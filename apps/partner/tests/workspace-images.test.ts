import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAX_WORKSPACE_IMAGE_BYTES, readWorkspaceImage } from '../runtime/workspace-images.ts';

export async function imageFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-image-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#cc8844' } }).png().toBuffer();
  return { directory, workspace, png, close: () => rm(directory, { recursive: true, force: true }) };
}

test('workspace reader returns current image bytes, literal paths and supported formats', async () => {
  const f = await imageFixture();
  try {
    for (const format of ['png', 'jpeg', 'webp', 'gif'] as const) {
      const bytes = await sharp(f.png).toFormat(format).toBuffer();
      const name = `图片 space %20.${format}`;
      await writeFile(join(f.workspace, name), bytes);
      for (const path of [name, `./${name}`, join(f.workspace, name)]) {
        assert.deepEqual(await readWorkspaceImage(f.workspace, path), { bytes, mediaType: `image/${format}` });
      }
    }
    await writeFile(join(f.workspace, 'change.png'), f.png);
    assert.ok(await readWorkspaceImage(f.workspace, 'change.png'));
    await writeFile(join(f.workspace, 'change.png'), 'no longer an image');
    assert.equal(await readWorkspaceImage(f.workspace, 'change.png'), null);
    const workspaceAlias = join(f.directory, 'workspace-alias');
    await symlink(f.workspace, workspaceAlias);
    assert.deepEqual((await readWorkspaceImage(workspaceAlias, join(workspaceAlias, '图片 space %20.png')))?.bytes, f.png);
    await symlink(join(f.workspace, '图片 space %20.png'), join(f.workspace, 'internal.png'));
    assert.deepEqual((await readWorkspaceImage(f.workspace, 'internal.png'))?.bytes, f.png);
  } finally { await f.close(); }
});

test('workspace reader denies invalid paths, escapes, invalid bytes, special files and oversize', async () => {
  const f = await imageFixture();
  try {
    await writeFile(join(f.directory, 'outside.png'), f.png);
    await symlink(join(f.directory, 'outside.png'), join(f.workspace, 'escape.png'));
    await symlink(f.directory, join(f.workspace, 'escape-dir'));
    await mkdir(join(f.workspace, 'directory.png'));
    await promisify(execFile)('mkfifo', [join(f.workspace, 'pipe.png')]);
    await writeFile(join(f.workspace, 'text.png'), 'private non-image contents');
    await writeFile(join(f.workspace, 'truncated.png'), f.png.subarray(0, 40));
    await writeFile(join(f.workspace, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    await writeFile(join(f.workspace, 'disguised.png'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    const boundary = Buffer.alloc(MAX_WORKSPACE_IMAGE_BYTES);
    f.png.copy(boundary);
    await writeFile(join(f.workspace, 'boundary.png'), boundary);
    assert.ok(await readWorkspaceImage(f.workspace, 'boundary.png'));
    const huge = await open(join(f.workspace, 'huge.png'), 'w');
    try { await huge.truncate(MAX_WORKSPACE_IMAGE_BYTES + 1); } finally { await huge.close(); }
    for (const path of [null, '', '../outside.png', 'a/../x.png', join(f.directory, 'outside.png'), 'escape.png', 'escape-dir/outside.png',
      'directory.png', 'pipe.png', 'text.png', 'truncated.png', 'vector.svg', 'disguised.png', 'huge.png', 'missing.png', 'file:/x.png',
      'https://example.org/x.png', '//host/x.png', 'a\\b.png', 'x\0.png', 'x\n.png', 'x\u007f.png', ' bad.png', 'bad.png ', 'x\uFFFD.png']) {
      assert.equal(await readWorkspaceImage(f.workspace, path), null, String(path));
    }
  } finally { await f.close(); }
});

// Exercise actual filesystem replacement; every response must be workspace bytes
// or unavailable, even if canonicalization and opening overlap the replacement.
test('replacing a canonical parent with an escaping symlink never returns outside bytes', async () => {
  const f = await imageFixture();
  let stopping = false;
  await mkdir(join(f.workspace, 'images'));
  await writeFile(join(f.workspace, 'images', 'image.png'), f.png);
  const outside = await sharp(f.png).negate().png().toBuffer();
  await mkdir(join(f.directory, 'outside'));
  await writeFile(join(f.directory, 'outside', 'image.png'), outside);
  const moving = (async () => {
    while (!stopping) {
      await rename(join(f.workspace, 'images'), join(f.workspace, 'held'));
      await symlink(join(f.directory, 'outside'), join(f.workspace, 'images'));
      await rm(join(f.workspace, 'images'));
      await rename(join(f.workspace, 'held'), join(f.workspace, 'images'));
    }
  })();
  try {
    for (let n = 0; n < 100; n++) {
      const image = await readWorkspaceImage(f.workspace, 'images/image.png');
      if (image) assert.deepEqual(image.bytes, f.png);
    }
  } finally { stopping = true; await moving; await f.close(); }
});
