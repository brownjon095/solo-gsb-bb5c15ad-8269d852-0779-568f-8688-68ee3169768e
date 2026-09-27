/**
 * 输入日志诊断接口测试（HTTP 级）：
 * - POST /api/log-diagnose 按连续相同上下文切段，每段以首键为时间原点复用时序回放；
 *   切换上下文时段末待定按超时结算，段间不共享缓冲；
 * - 报告汇总各命令触发次数与各上下文未命中次数；
 * - 非法输入（上下文不存在 / 时间递减 / 按键非法 / 空日志）返回 400 与事件位置，
 *   不生成部分报告；
 * - GET /api/log-diagnose/sample 生成合法示例日志，可直接诊断；
 * - 诊断与示例均为只读：状态指纹与数据文件在调用前后不变。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shortcut-logdiagnose-test-'));
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

// 覆盖：前缀链触发长序列、段末待定超时结算、未命中、跨上下文切换、单键触发
const SAMPLE_LOG = {
  timeoutMs: 800,
  events: [
    { contextId: 'ctx-code', key: 'g', timeMs: 0 }, // 待定（cmd-10 G）
    { contextId: 'ctx-code', key: 'd', timeMs: 200 }, // 阈值内续键，待定（cmd-11 G D）
    { contextId: 'ctx-code', key: 'd', timeMs: 400 }, // 触发 cmd-12（G D D 跳到声明）
    { contextId: 'ctx-code', key: 'g', timeMs: 1500 }, // 待定（cmd-10），随后切上下文
    { contextId: 'ctx-terminal', key: 'g', timeMs: 1800 }, // 新段首键：待定（cmd-15）
    { contextId: 'ctx-terminal', key: 'l', timeMs: 2000 }, // 触发 cmd-16（G L 清屏）
    { contextId: 'ctx-terminal', key: 'z', timeMs: 2600 }, // 未命中
    { contextId: 'ctx-app', key: 'ctrl+s', timeMs: 3000 }, // 触发 cmd-3（保存）
  ],
};

async function main() {
  ({ server } = await start(0));
  base = `http://127.0.0.1:${server.address().port}`;

  await test('诊断报告：切段、时间原点、段末待定超时结算与汇总计数', async () => {
    const { status, data } = await req('POST', '/api/log-diagnose', SAMPLE_LOG);
    assert.equal(status, 200);
    assert.equal(data.format, 'shortcut-input-log-report-v1');
    assert.equal(data.eventCount, 8);
    assert.equal(data.segmentCount, 3);
    assert.equal(data.timeoutMs, 800);

    // 段边界：连续相同上下文为一段，记录原始事件位置（1-based）
    assert.deepEqual(
      data.segments.map((s) => [s.contextId, s.eventFrom, s.eventTo, s.startMs]),
      [
        ['ctx-code', 1, 4, 0],
        ['ctx-terminal', 5, 7, 1800],
        ['ctx-app', 8, 8, 3000],
      ],
    );

    // 段一：前缀链阈值内续键触发长序列；末键待定，切上下文后按超时结算短序列
    const seg1 = data.segments[0];
    assert.equal(seg1.contextPath, 'App / Editor / Code Editor');
    assert.deepEqual(
      seg1.events.map((e) => e.status),
      ['pending', 'pending', 'triggered', 'pending', 'timeout'],
    );
    assert.deepEqual(seg1.events[2].triggered.map((c) => c.commandId), ['cmd-12']);
    const timeoutEv = seg1.events[4];
    assert.equal(timeoutEv.type, 'timeout');
    assert.equal(timeoutEv.timeMs, 2300); // 段内时刻：末键 1500 + 800
    assert.equal(timeoutEv.logTimeMs, 2300); // 段首即日志起点，两轴一致
    assert.deepEqual(timeoutEv.triggered.map((c) => c.commandId), ['cmd-10']);

    // 段二：以首键 1800ms 为时间原点；上一段的 G 前缀不串入本段
    const seg2 = data.segments[1];
    assert.equal(seg2.events[0].timeMs, 0);
    assert.equal(seg2.events[0].logTimeMs, 1800);
    assert.equal(seg2.events[0].restartFrom, false);
    assert.deepEqual(seg2.events[0].held.map((c) => c.commandId), ['cmd-15']);
    assert.deepEqual(seg2.events[1].triggered.map((c) => c.commandId), ['cmd-16']);
    assert.equal(seg2.events[2].status, 'no-match');
    assert.equal(seg2.events[2].logTimeMs, 2600);

    // 段三：单键直接触发
    const seg3 = data.segments[2];
    assert.deepEqual(seg3.events[0].triggered.map((c) => c.commandId), ['cmd-3']);

    // 汇总：各命令触发次数 / 各上下文未命中次数
    const triggers = Object.fromEntries(data.summary.commandTriggers.map((c) => [c.commandId, c.count]));
    assert.deepEqual(triggers, { 'cmd-3': 1, 'cmd-10': 1, 'cmd-12': 1, 'cmd-16': 1 });
    assert.equal(data.stats.triggeredCommandCount, 4);
    assert.equal(data.stats.timeoutEventCount, 1);
    assert.equal(data.stats.noMatchEventCount, 1);
    assert.deepEqual(data.summary.contextNoMatch, [
      { contextId: 'ctx-terminal', contextPath: 'App / Editor / Terminal', count: 1 },
    ]);
  });

  await test('非法输入：返回 400 与事件位置，不生成部分报告', async () => {
    // 上下文不存在（第 2 个事件）
    const badCtx = await req('POST', '/api/log-diagnose', {
      events: [
        { contextId: 'ctx-code', key: 'g', timeMs: 0 },
        { contextId: 'ctx-nope', key: 'g', timeMs: 100 },
      ],
    });
    assert.equal(badCtx.status, 400);
    assert.match(badCtx.data.error, /第 2 个事件.*上下文不存在/);
    assert.equal(badCtx.data.details.eventSeq, 2);
    assert.equal(badCtx.data.details.eventIndex, 1);
    assert.ok(!badCtx.data.segments, '不得生成部分报告');

    // 时间递减（第 3 个事件）
    const badTime = await req('POST', '/api/log-diagnose', {
      events: [
        { contextId: 'ctx-code', key: 'g', timeMs: 0 },
        { contextId: 'ctx-code', key: 'd', timeMs: 100 },
        { contextId: 'ctx-terminal', key: 'g', timeMs: 50 },
      ],
    });
    assert.equal(badTime.status, 400);
    assert.match(badTime.data.error, /第 3 个事件.*非递减/);
    assert.equal(badTime.data.details.eventSeq, 3);
    assert.ok(!badTime.data.segments);

    // 按键格式非法（第 1 个事件）
    const badKey = await req('POST', '/api/log-diagnose', {
      events: [{ contextId: 'ctx-code', key: 'ctrl+alt', timeMs: 0 }],
    });
    assert.equal(badKey.status, 400);
    assert.match(badKey.data.error, /第 1 个事件.*按键无效/);
    assert.ok(!badKey.data.segments);

    // 空日志与缺字段
    const empty = await req('POST', '/api/log-diagnose', { events: [] });
    assert.equal(empty.status, 400);
    const missing = await req('POST', '/api/log-diagnose', {});
    assert.equal(missing.status, 400);
    const noCtx = await req('POST', '/api/log-diagnose', { events: [{ key: 'g', timeMs: 0 }] });
    assert.equal(noCtx.status, 400);
    assert.match(noCtx.data.error, /contextId/);
  });

  await test('示例日志：结构合法、时间非递减，可直接诊断出报告', async () => {
    const { status, data: sample } = await req('GET', '/api/log-diagnose/sample');
    assert.equal(status, 200);
    assert.equal(sample.format, 'shortcut-input-log-v1');
    assert.ok(sample.events.length >= 3);
    const state = (await req('GET', '/api/state')).data;
    const ctxIds = new Set(state.contexts.map((c) => c.id));
    for (let i = 0; i < sample.events.length; i++) {
      const ev = sample.events[i];
      assert.ok(ctxIds.has(ev.contextId), `示例事件上下文必须存在：${ev.contextId}`);
      assert.ok(typeof ev.key === 'string' && ev.key.length > 0);
      if (i > 0) assert.ok(ev.timeMs >= sample.events[i - 1].timeMs, '示例时间必须非递减');
    }
    const report = await req('POST', '/api/log-diagnose', sample);
    assert.equal(report.status, 200);
    assert.ok(report.data.segmentCount >= 2);
    assert.ok(report.data.stats.triggeredCommandCount >= 2);
    assert.ok(report.data.stats.timeoutEventCount >= 1); // 段末待定超时结算
    assert.ok(report.data.stats.noMatchEventCount >= 1); // 未命中演示
  });

  await test('支持 ?download=1 附件响应头', async () => {
    const rep = await req('POST', '/api/log-diagnose?download=1', SAMPLE_LOG);
    assert.equal(rep.status, 200);
    assert.match(
      rep.headers.get('content-disposition') || '',
      /attachment; filename="input-log-report\.json"/,
    );
    const sam = await req('GET', '/api/log-diagnose/sample?download=1');
    assert.equal(sam.status, 200);
    assert.match(
      sam.headers.get('content-disposition') || '',
      /attachment; filename="input-log-sample\.json"/,
    );
  });

  await test('诊断为纯只读：状态指纹与数据文件在调用前后不变', async () => {
    const diskBefore = fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8');
    const fpBefore = (await req('POST', '/api/sandbox/preview', {})).data.baselineFingerprint;
    await req('POST', '/api/log-diagnose', SAMPLE_LOG);
    await req('GET', '/api/log-diagnose/sample');
    const fpAfter = (await req('POST', '/api/sandbox/preview', {})).data.baselineFingerprint;
    assert.equal(fpAfter, fpBefore);
    assert.equal(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'), diskBefore);
  });

  console.log(`\n日志诊断接口测试全部通过：${passed} 项`);
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
