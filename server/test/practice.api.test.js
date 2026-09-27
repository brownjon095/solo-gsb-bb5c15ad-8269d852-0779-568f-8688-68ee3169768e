/**
 * 连续练习评判接口测试（HTTP 级）：
 * - POST /api/practice/judge/:contextId 编排 1~20 个生效目标 + 录制时间线，
 *   后端复用时序回放并以 DP 对齐实际触发流（匹配 0 / 错命令 / 漏命令 / 多触发各 1）；
 * - 同次多命令按命令 ID 升序展开；空录制按全部漏命令处理；
 * - 未生效目标、非法按键、时间倒退、目标数量越界整体 400（带目标/按键位置）；
 *   上下文不存在 404；
 * - 支持 shortcut-replay-v1 同构的 presses 载荷与 ?download=1 附件响应头；
 * - 评判为纯只读：调用前后状态指纹与数据文件内容不变。
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

  // ctx-code：cmd-10=G、cmd-11=G D、cmd-12=G D D（前缀链）
  await test('阈值内续键命中目标：成本 0，含目标/实际/对齐/回放完整结构', async () => {
    const { status, data } = await req('POST', '/api/practice/judge/ctx-code', {
      targets: ['cmd-12'],
      timeoutMs: 800,
      presses: [
        { token: 'g', timeMs: 0 },
        { token: 'd', timeMs: 100 },
        { token: 'd', timeMs: 200 },
      ],
    });
    assert.equal(status, 200);
    assert.equal(data.format, 'shortcut-practice-report-v1');
    assert.equal(data.contextId, 'ctx-code');
    assert.equal(data.contextPath, 'App / Editor / Code Editor');
    assert.equal(data.targetCount, 1);
    assert.equal(data.actualCount, 1);
    assert.equal(data.pressCount, 3);
    assert.equal(data.emptyRecording, false);
    assert.equal(data.totalCost, 0);
    assert.deepEqual(data.stats, {
      matchedCount: 1,
      wrongCount: 0,
      missedCount: 0,
      extraCount: 0,
      totalErrors: 0,
    });
    assert.equal(data.alignment.length, 1);
    assert.equal(data.alignment[0].type, 'match');
    assert.equal(data.alignment[0].target.commandId, 'cmd-12');
    assert.equal(data.alignment[0].actual.atMs, 200);
    assert.equal(data.targets[0].targetSeq, 1);
    assert.ok(data.replay && data.replay.format === 'shortcut-replay-v1');
  });

  await test('空录制：合法，全部目标按漏命令处理且不回放', async () => {
    const { status, data } = await req('POST', '/api/practice/judge/ctx-code', {
      targets: ['cmd-11', 'cmd-12'],
      presses: [],
    });
    assert.equal(status, 200);
    assert.equal(data.emptyRecording, true);
    assert.equal(data.replay, null);
    assert.equal(data.totalCost, 2);
    assert.deepEqual(data.alignment.map((r) => r.type), ['miss', 'miss']);

    const noPresses = await req('POST', '/api/practice/judge/ctx-code', { targets: ['cmd-11'] });
    assert.equal(noPresses.status, 200);
    assert.equal(noPresses.data.totalCost, 1);
    assert.equal(noPresses.data.alignment[0].type, 'miss');
  });

  await test('超时结算：单键前缀目标经 timeout 事件匹配，eventType=timeout', async () => {
    const { status, data } = await req('POST', '/api/practice/judge/ctx-code', {
      targets: ['cmd-10'],
      presses: [{ token: 'g', timeMs: 0 }],
    });
    assert.equal(status, 200);
    assert.equal(data.totalCost, 0);
    assert.equal(data.actual.length, 1);
    assert.equal(data.actual[0].commandId, 'cmd-10');
    assert.equal(data.actual[0].atMs, 800);
    assert.equal(data.actual[0].eventType, 'timeout');
  });

  await test('同次多命令按命令 ID 升序展开（Terminal 的 G H 同层重复）', async () => {
    const { status, data } = await req('POST', '/api/practice/judge/ctx-terminal', {
      targets: ['cmd-17', 'cmd-18'],
      presses: [{ token: 'g', timeMs: 0 }, { token: 'h', timeMs: 100 }],
    });
    assert.equal(status, 200);
    assert.equal(data.totalCost, 0);
    assert.deepEqual(data.actual.map((a) => [a.commandId, a.atMs]), [
      ['cmd-17', 100],
      ['cmd-18', 100],
    ]);
  });

  await test('目标可重复（20 个上限内），两次相同触发分别匹配', async () => {
    const { status, data } = await req('POST', '/api/practice/judge/ctx-code', {
      targets: ['cmd-12', 'cmd-12'],
      presses: [
        { token: 'g', timeMs: 0 }, { token: 'd', timeMs: 100 }, { token: 'd', timeMs: 200 },
        { token: 'g', timeMs: 500 }, { token: 'd', timeMs: 600 }, { token: 'd', timeMs: 700 },
      ],
    });
    assert.equal(status, 200);
    assert.equal(data.totalCost, 0);
    assert.equal(data.stats.matchedCount, 2);
  });

  await test('错命令 + 漏命令 + 多触发同时出现并计入总错误数', async () => {
    // 目标 [cmd-11(G D), cmd-12(G D D)]；实际仅在 800ms 超时触发一次 cmd-10(G)
    const { status, data } = await req('POST', '/api/practice/judge/ctx-code', {
      targets: ['cmd-11', 'cmd-12'],
      presses: [{ token: 'g', timeMs: 0 }],
    });
    assert.equal(status, 200);
    assert.equal(data.stats.wrongCount, 1);
    assert.equal(data.stats.missedCount, 1);
    assert.equal(data.totalCost, 2);
  });

  await test('未生效目标（被覆盖 shadowed）整体 400，details 带目标位置', async () => {
    const { status, data } = await req('POST', '/api/practice/judge/ctx-code', {
      targets: ['cmd-8'], // Editor 的「跳转… G」在 Code Editor 被 cmd-10 覆盖
      presses: [],
    });
    assert.equal(status, 400);
    assert.equal(data.details.targetSeq, 1);
    assert.equal(data.details.commandId, 'cmd-8');
  });

  await test('不存在的目标命令整体 400', async () => {
    const { status, data } = await req('POST', '/api/practice/judge/ctx-code', {
      targets: ['cmd-does-not-exist'],
    });
    assert.equal(status, 400);
    assert.equal(data.details.targetSeq, 1);
  });

  await test('目标数量越界（0 或 21）整体 400', async () => {
    const empty = await req('POST', '/api/practice/judge/ctx-code', { targets: [] });
    assert.equal(empty.status, 400);
    const tooMany = await req('POST', '/api/practice/judge/ctx-code', {
      targets: Array(21).fill('cmd-10'),
    });
    assert.equal(tooMany.status, 400);
    const missing = await req('POST', '/api/practice/judge/ctx-code', { presses: [] });
    assert.equal(missing.status, 400);
  });

  await test('非法按键 / 时间倒退 / 负阈值整体 400，details 带按键位置', async () => {
    const badKey = await req('POST', '/api/practice/judge/ctx-code', {
      targets: ['cmd-10'],
      presses: [{ token: 'ctrl', timeMs: 0 }], // 只有修饰键没有主键
    });
    assert.equal(badKey.status, 400);
    assert.equal(badKey.data.details.pressSeq, 1);

    const regress = await req('POST', '/api/practice/judge/ctx-code', {
      targets: ['cmd-10'],
      presses: [{ token: 'g', timeMs: 100 }, { token: 'd', timeMs: 50 }],
    });
    assert.equal(regress.status, 400);
    assert.equal(regress.data.details.pressSeq, 2);

    const negTimeout = await req('POST', '/api/practice/judge/ctx-code', {
      targets: ['cmd-10'],
      presses: [{ token: 'g', timeMs: 0, timeoutMs: -5 }],
    });
    assert.equal(negTimeout.status, 400);
    assert.equal(negTimeout.data.details.pressSeq, 1);
  });

  await test('上下文不存在返回 404', async () => {
    const { status } = await req('POST', '/api/practice/judge/no-such-context', {
      targets: ['cmd-10'],
    });
    assert.equal(status, 404);
  });

  await test('支持 ?download=1 附件响应头', async () => {
    const rep = await req('POST', '/api/practice/judge/ctx-code?download=1', {
      targets: ['cmd-12'],
      presses: [
        { token: 'g', timeMs: 0 },
        { token: 'd', timeMs: 100 },
        { token: 'd', timeMs: 200 },
      ],
    });
    assert.equal(rep.status, 200);
    assert.match(
      rep.headers.get('content-disposition') || '',
      /attachment; filename="practice-result\.json"/,
    );
  });

  await test('评判为纯只读：状态指纹与数据文件在调用前后不变', async () => {
    const diskBefore = fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8');
    const fpBefore = (await req('POST', '/api/sandbox/preview', {})).data.baselineFingerprint;
    await req('POST', '/api/practice/judge/ctx-code', {
      targets: ['cmd-12'],
      presses: [
        { token: 'g', timeMs: 0 },
        { token: 'd', timeMs: 100 },
        { token: 'd', timeMs: 200 },
      ],
    });
    await req('POST', '/api/practice/judge/ctx-terminal', {
      targets: ['cmd-17', 'cmd-18'],
      presses: [{ token: 'g', timeMs: 0 }, { token: 'h', timeMs: 100 }],
    });
    // 非法请求同样不落盘
    await req('POST', '/api/practice/judge/ctx-code', { targets: ['cmd-8'] });
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
