/**
 * 跨平台迁移检查接口测试（HTTP 级）：
 * - GET /api/migration-check 返回两种方向的只读报告（结构 + 统计 + 合并叶子）；
 * - 缺省方向为 ctrl-to-meta，未知方向返回 400；
 * - 检查不修改任何数据：调用前后状态指纹一致，数据文件内容不变。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shortcut-migration-test-'));
process.env.DATA_DIR = DATA_DIR;

const { start } = require('../src/index');

let server;
let base;
let passed = 0;

const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const req = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
};

async function main() {
  ({ server } = await start(0));
  base = `http://127.0.0.1:${server.address().port}`;

  await test('Ctrl→Meta 报告：结构完整，演示数据中的迁移新增冲突被检出并合并叶子', async () => {
    const { status, data } = await req('GET', '/api/migration-check?direction=ctrl-to-meta');
    assert.equal(status, 200);
    assert.equal(data.format, 'shortcut-migration-check-v1');
    assert.equal(data.direction, 'ctrl-to-meta');
    assert.deepEqual(data.mapping, { from: 'ctrl', to: 'meta', label: 'Ctrl → Meta' });
    assert.equal(data.stats.leafCount, 2); // Code Editor / Terminal
    assert.ok(data.stats.mappedCommandCount > 0);

    // 演示数据：cmd-5 撤销 Ctrl+Z → Meta+Z，与 cmd-20 禅模式切换 Meta+Z 同层重复
    const dup = data.conflicts.find((c) => c.type === 'duplicate');
    assert.ok(dup, '应检出迁移新增的同层重复');
    assert.equal(dup.sequenceLabel, 'Meta+Z');
    assert.deepEqual(
      dup.parties.map((p) => p.commandId).sort(),
      ['cmd-20', 'cmd-5'],
    );
    const fromCtrl = dup.parties.find((p) => p.commandId === 'cmd-5');
    assert.equal(fromCtrl.fromLabel, 'Ctrl+Z');
    assert.equal(fromCtrl.toLabel, 'Meta+Z');
    assert.equal(fromCtrl.remapped, true);
    assert.equal(dup.leaves.length, 2); // 同一冲突跨叶子合并展示
    assert.ok(dup.leaves.every((l) => l.contextPath.startsWith('App / Editor / ')));

    // 演示数据：cmd-4 聚焦下一个面板 Ctrl+J → Meta+J，成为 cmd-21 Meta+J K 的前缀
    const pre = data.conflicts.find((c) => c.type === 'prefix');
    assert.ok(pre, '应检出迁移新增的前缀冲突');
    assert.equal(pre.prefixSequenceLabel, 'Meta+J');
    assert.equal(pre.extensionSequenceLabel, 'Meta+J K');
    const roles = Object.fromEntries(pre.parties.map((p) => [p.commandId, p.role]));
    assert.equal(roles['cmd-4'], 'prefix');
    assert.equal(roles['cmd-21'], 'extension');

    // 映射前已存在的冲突（G H 同层重复、G⊂G L 等）不得混入报告
    assert.ok(!data.conflicts.some((c) => c.goalId === 'dup:cmd-17,cmd-18'));
    assert.ok(!data.conflicts.some((c) => c.goalId.startsWith('pre:cmd-15')));
    assert.equal(data.stats.newConflictCount, data.conflicts.length);
  });

  await test('Meta→Ctrl 反向报告对称检出风险', async () => {
    const { status, data } = await req('GET', '/api/migration-check?direction=meta-to-ctrl');
    assert.equal(status, 200);
    assert.equal(data.direction, 'meta-to-ctrl');
    const dup = data.conflicts.find((c) => c.type === 'duplicate');
    assert.ok(dup);
    assert.equal(dup.sequenceLabel, 'Ctrl+Z'); // cmd-20 Meta+Z 迁为 Ctrl+Z 后与 cmd-5 重复
    const pre = data.conflicts.find((c) => c.type === 'prefix');
    assert.ok(pre);
    assert.equal(pre.prefixSequenceLabel, 'Ctrl+J');
    assert.equal(pre.extensionSequenceLabel, 'Ctrl+J K');
  });

  await test('缺省方向为 ctrl-to-meta；未知方向返回 400', async () => {
    const def = await req('GET', '/api/migration-check');
    assert.equal(def.status, 200);
    assert.equal(def.data.direction, 'ctrl-to-meta');
    const bad = await req('GET', '/api/migration-check?direction=ctrl-to-alt');
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /未知的迁移方向/);
  });

  await test('支持 ?download=1 附件响应头', async () => {
    const { status, headers } = await req('GET', '/api/migration-check?download=1');
    assert.equal(status, 200);
    assert.match(headers.get('content-disposition') || '', /attachment; filename="migration-check\.json"/);
  });

  await test('检查为纯只读：状态指纹与数据文件在调用前后不变', async () => {
    const diskBefore = fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8');
    const fpBefore = (await req('POST', '/api/sandbox/preview', {})).data.baselineFingerprint;
    await req('GET', '/api/migration-check?direction=ctrl-to-meta');
    await req('GET', '/api/migration-check?direction=meta-to-ctrl');
    const fpAfter = (await req('POST', '/api/sandbox/preview', {})).data.baselineFingerprint;
    assert.equal(fpAfter, fpBefore);
    assert.equal(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'), diskBefore);
  });

  console.log(`\n迁移检查接口测试全部通过：${passed} 项`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) server.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });
