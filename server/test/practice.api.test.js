/**
 * 连续练习评判接口测试（HTTP 级）：
 * - POST /api/practice/judge 复用时序回放（前缀待定 / 超时 / 重新起算）展开实际触发，
 *   同次多命令按命令 ID 升序；动态规划对齐目标序列（匹配 0，错命令 / 漏命令 / 多触发各 1，
 *   总成本相同时回溯优先 匹配 > 错命令 > 漏命令 > 多触发）；
 * - 未生效目标（shadowed / 不存在 / 链外）、目标数量越界、非法按键、倒退时间、
 *   非法阈值均整体 400，不生成部分结果；空录制按全部漏命令处理；
 * - 评判为纯只读：状态指纹与数据文件在调用前后不变。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shortcut-practice-test-'));
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

  await test('评判：前缀待定后阈值内续键触发长序列，全部匹配（成本 0）', async () => {
    // ctx-terminal：cmd-15 G（待定短序列）、cmd-16 G L
    const { status, data } = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-terminal',
      targets: ['cmd-16'],
      presses: [
        { token: 'g', timeMs: 0 },
        { token: 'l', timeMs: 150 },
      ],
    });
    assert.equal(status, 200);
    assert.equal(data.format, 'shortcut-practice-judge-v1');
    assert.equal(data.contextPath, 'App / Editor / Terminal');
    assert.equal(data.timeoutMs, 800);
    // 复用时序回放：g 进入待定，l 在阈值内补全长序列
    assert.equal(data.replay.events[0].status, 'pending');
    assert.deepEqual(
      data.actual.map((a) => [a.commandId, a.atMs, a.eventType]),
      [['cmd-16', 150, 'press']],
    );
    assert.deepEqual(
      data.alignment.map((o) => o.type),
      ['match'],
    );
    assert.equal(data.alignment[0].targetIndex, 1);
    assert.equal(data.alignment[0].target.name, '清屏');
    assert.equal(data.alignment[0].actual.commandId, 'cmd-16');
    assert.equal(data.stats.totalErrors, 0);
    assert.equal(data.stats.matchCount, 1);
    assert.equal(data.stats.targetCount, 1);
    assert.equal(data.stats.actualCount, 1);
    assert.equal(data.stats.pressCount, 2);
  });

  await test('评判：同层重复同次触发按命令 ID 升序展开；超时触发计入实际流', async () => {
    // ctx-terminal：cmd-17 / cmd-18 同层重复（G H）；cmd-15 G 为待定短序列
    const { status, data } = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-terminal',
      targets: ['cmd-17', 'cmd-18', 'cmd-15'],
      presses: [
        { token: 'g', timeMs: 0 },
        { token: 'h', timeMs: 100 }, // 触发 cmd-17 + cmd-18（同层重复）
        { token: 'g', timeMs: 300 }, // 待定，时间线结束按超时触发 cmd-15
      ],
    });
    assert.equal(status, 200);
    // 同次多命令按 ID 升序；超时触发的短序列排在最后（截止时刻 300+800）
    assert.deepEqual(
      data.actual.map((a) => [a.commandId, a.atMs, a.eventType]),
      [
        ['cmd-17', 100, 'press'],
        ['cmd-18', 100, 'press'],
        ['cmd-15', 1100, 'timeout'],
      ],
    );
    assert.deepEqual(
      data.alignment.map((o) => o.type),
      ['match', 'match', 'match'],
    );
    assert.equal(data.stats.totalErrors, 0);
    assert.equal(data.replay.events[3].type, 'timeout'); // 段末待定超时结算
  });

  await test('评判：错命令 / 漏命令 / 多触发与总错误数', async () => {
    // ctx-code：cmd-13 F2、cmd-10 G、cmd-11 G D、cmd-14 Ctrl+Alt+D
    // 错命令：目标 cmd-10，实际触发 cmd-14
    const wrong = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-10'],
      presses: [{ token: 'ctrl+alt+d', timeMs: 0 }],
    });
    assert.equal(wrong.status, 200);
    assert.deepEqual(
      wrong.data.alignment.map((o) => o.type),
      ['wrong'],
    );
    assert.equal(wrong.data.alignment[0].target.commandId, 'cmd-10');
    assert.equal(wrong.data.alignment[0].actual.commandId, 'cmd-14');
    assert.equal(wrong.data.stats.wrongCount, 1);
    assert.equal(wrong.data.stats.totalErrors, 1);

    // 漏命令：目标 [cmd-13, cmd-10]，实际只触发 cmd-13
    const missed = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-13', 'cmd-10'],
      presses: [{ token: 'f2', timeMs: 0 }],
    });
    assert.deepEqual(
      missed.data.alignment.map((o) => o.type),
      ['match', 'missed'],
    );
    assert.equal(missed.data.alignment[1].target.commandId, 'cmd-10');
    assert.equal(missed.data.stats.missedCount, 1);
    assert.equal(missed.data.stats.totalErrors, 1);

    // 多触发：目标 cmd-13，实际触发 cmd-13 与 cmd-14
    const extra = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-13'],
      presses: [
        { token: 'f2', timeMs: 0 },
        { token: 'ctrl+alt+d', timeMs: 100 },
      ],
    });
    assert.deepEqual(
      extra.data.alignment.map((o) => o.type),
      ['match', 'extra'],
    );
    assert.equal(extra.data.alignment[1].actual.commandId, 'cmd-14');
    assert.equal(extra.data.stats.extraCount, 1);
    assert.equal(extra.data.stats.totalErrors, 1);

    // 混合：匹配 + 错命令（目标 cmd-10 与实际 cmd-14 对齐）
    const mixed = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-13', 'cmd-10'],
      presses: [
        { token: 'f2', timeMs: 0 },
        { token: 'ctrl+alt+d', timeMs: 100 },
      ],
    });
    assert.deepEqual(
      mixed.data.alignment.map((o) => o.type),
      ['match', 'wrong'],
    );
    assert.equal(mixed.data.stats.matchCount, 1);
    assert.equal(mixed.data.stats.wrongCount, 1);
    assert.equal(mixed.data.stats.totalErrors, 1);
  });

  await test('评判：待定短序列被偏离续键放弃时不计入实际流（重新起算）', async () => {
    // g@0 待定（cmd-10），d@100 沿前缀链待定（cmd-11），ctrl+alt+d@200 偏离长序列：
    // 放弃待定的 cmd-11，ctrl+alt+d 重新起算独立命中 cmd-14 —— 实际流只有 cmd-14
    const { status, data } = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-11'],
      presses: [
        { token: 'g', timeMs: 0 },
        { token: 'd', timeMs: 100 },
        { token: 'ctrl+alt+d', timeMs: 200 },
      ],
    });
    assert.equal(status, 200);
    assert.deepEqual(
      data.actual.map((a) => a.commandId),
      ['cmd-14'],
    );
    assert.deepEqual(
      data.alignment.map((o) => o.type),
      ['wrong'],
    );
    assert.equal(data.alignment[0].target.commandId, 'cmd-11');
    assert.equal(data.alignment[0].actual.commandId, 'cmd-14');
    assert.equal(data.replay.events[2].restartFrom, true);
    assert.deepEqual(data.replay.events[2].droppedHeld, ['cmd-11']);
  });

  await test('评判：目标可重复；空录制按全部漏命令处理', async () => {
    const { status, data } = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-13', 'cmd-13', 'cmd-10'],
      presses: [],
    });
    assert.equal(status, 200);
    assert.equal(data.replay, null);
    assert.equal(data.stats.pressCount, 0);
    assert.equal(data.stats.actualCount, 0);
    assert.deepEqual(
      data.alignment.map((o) => o.type),
      ['missed', 'missed', 'missed'],
    );
    assert.deepEqual(
      data.alignment.map((o) => o.targetIndex),
      [1, 2, 3],
    );
    assert.equal(data.stats.missedCount, 3);
    assert.equal(data.stats.totalErrors, 3);

    // presses 整个缺省同样按空录制处理
    const r2 = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-13'],
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.data.stats.totalErrors, 1);
    assert.deepEqual(
      r2.data.alignment.map((o) => o.type),
      ['missed'],
    );
  });

  await test('未生效目标整体拒绝（400），不生成部分结果', async () => {
    // shadowed：cmd-8（Editor 的 G）在 ctx-code 被 cmd-10 覆盖
    const shadowed = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-8'],
      presses: [],
    });
    assert.equal(shadowed.status, 400);
    assert.match(shadowed.data.error, /第 1 个目标.*未在上下文.*生效/);
    assert.ok(!shadowed.data.alignment);

    // 不存在的命令（第 2 个目标）
    const unknown = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-13', 'cmd-999'],
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.data.error, /第 2 个目标.*未在上下文.*生效/);

    // 链外命令：cmd-16 定义在 ctx-terminal，不在 ctx-code 的祖先链上
    const outside = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-16'],
    });
    assert.equal(outside.status, 400);
    assert.match(outside.data.error, /未在上下文.*生效/);

    // 目标数量：0 个 / 超过 20 个 / 非数组
    const zero = await req('POST', '/api/practice/judge', { contextId: 'ctx-code', targets: [] });
    assert.equal(zero.status, 400);
    assert.match(zero.data.error, /至少需要 1 个/);
    const tooMany = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: Array(21).fill('cmd-13'),
    });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.data.error, /最多 20 个/);
    const noTargets = await req('POST', '/api/practice/judge', { contextId: 'ctx-code' });
    assert.equal(noTargets.status, 400);

    // 缺少 contextId / 上下文不存在
    const noCtx = await req('POST', '/api/practice/judge', { targets: ['cmd-13'] });
    assert.equal(noCtx.status, 400);
    const badCtx = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-nope',
      targets: ['cmd-13'],
    });
    assert.equal(badCtx.status, 404);
  });

  await test('非法按键 / 倒退时间 / 非法阈值整体拒绝（400）', async () => {
    const badKey = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-13'],
      presses: [{ token: 'ctrl+alt', timeMs: 0 }],
    });
    assert.equal(badKey.status, 400);
    assert.match(badKey.data.error, /第 1 次按键无效/);
    assert.ok(!badKey.data.alignment);

    const regress = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-13'],
      presses: [
        { token: 'f2', timeMs: 10 },
        { token: 'f2', timeMs: 5 },
      ],
    });
    assert.equal(regress.status, 400);
    assert.match(regress.data.error, /单调不减/);

    const badTimeout = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-13'],
      timeoutMs: -1,
      presses: [],
    });
    assert.equal(badTimeout.status, 400);
    assert.match(badTimeout.data.error, /超时阈值/);

    const badPressTimeout = await req('POST', '/api/practice/judge', {
      contextId: 'ctx-code',
      targets: ['cmd-13'],
      presses: [{ token: 'f2', timeMs: 0, timeoutMs: -3 }],
    });
    assert.equal(badPressTimeout.status, 400);
    assert.match(badPressTimeout.data.error, /timeoutMs/);
  });

  await test('支持 ?download=1 附件响应头', async () => {
    const rep = await req('POST', '/api/practice/judge?download=1', {
      contextId: 'ctx-code',
      targets: ['cmd-13'],
      presses: [{ token: 'f2', timeMs: 0 }],
    });
    assert.equal(rep.status, 200);
    assert.match(
      rep.headers.get('content-disposition') || '',
      /attachment; filename="practice-judge-result\.json"/,
    );
  });

  await test('评判为纯只读：状态指纹与数据文件在调用前后不变', async () => {
    const diskBefore = fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8');
    const fpBefore = (await req('POST', '/api/sandbox/preview', {})).data.baselineFingerprint;
    await req('POST', '/api/practice/judge', {
      contextId: 'ctx-terminal',
      targets: ['cmd-16', 'cmd-17', 'cmd-18'],
      presses: [
        { token: 'g', timeMs: 0 },
        { token: 'l', timeMs: 100 },
        { token: 'g', timeMs: 300 },
        { token: 'h', timeMs: 400 },
      ],
    });
    await req('POST', '/api/practice/judge', { contextId: 'ctx-code', targets: ['cmd-13'] });
    const fpAfter = (await req('POST', '/api/sandbox/preview', {})).data.baselineFingerprint;
    assert.equal(fpAfter, fpBefore);
    assert.equal(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'), diskBefore);
  });

  console.log(`\n连续练习评判接口测试全部通过：${passed} 项`);
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
