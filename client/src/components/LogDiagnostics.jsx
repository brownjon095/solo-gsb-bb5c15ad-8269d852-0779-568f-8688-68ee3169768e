import React, { useRef, useState } from 'react';
import { api } from '../api';
import { prettyToken } from '../keymap';

/**
 * 输入日志诊断（只读报告页）：
 * - 导入/粘贴一份按时间排序的按键事件日志（每事件：上下文 ID + 按键 + 相对毫秒）；
 * - 后端先全量校验（上下文存在 / 按键格式 / 时间非递减），任一事件非法即整体拒绝
 *   并返回事件位置，不生成部分报告；
 * - 按连续相同上下文切段，每段以首键为时间原点复用时序回放规则（待定 / 超时 /
 *   重新起算）；切换上下文即结束上一段待定状态，段间不共享缓冲；
 * - 页面按原始事件顺序展示各段的触发命令、超时与未命中事件，并汇总各命令触发
 *   次数与各上下文未命中次数；示例日志与结果均可下载 JSON。
 */

const STATUS_META = {
  idle: { text: '空闲', cls: 'idle' },
  pending: { text: '待定（等续键/超时）', cls: 'pending' },
  waiting: { text: '等待后续按键', cls: 'waiting' },
  triggered: { text: '命令已触发', cls: 'triggered' },
  timeout: { text: '超时触发短序列', cls: 'timeout' },
  'no-match': { text: '无匹配，重新起算', cls: 'nomatch' },
};

const SEG_STATUS_META = {
  idle: '空闲',
  waiting: '等待续键',
  pending: '待定未决',
  'no-match': '末尾未命中',
};

function StatCard({ value, label, tone = '' }) {
  return (
    <div className={`stat-card ${tone}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 单段报告：段头（上下文 / 时间原点 / 事件范围 / 统计）+ 逐事件表 */
function SegmentCard({ segment }) {
  return (
    <div className="suite-case log-segment">
      <div className="suite-case-head">
        <span className="suite-index">段 #{segment.index + 1}</span>
        <strong className="suite-path" title={segment.contextPath}>
          {segment.contextPath}
        </strong>
        <span className="dim small">
          事件 #{segment.eventFrom}–#{segment.eventTo} · 时间原点 {segment.startMs}ms ·{' '}
          {segment.pressCount} 键 · 结束态：{SEG_STATUS_META[segment.status] || segment.status}
        </span>
        <span className="log-seg-chips">
          <span className="conflict-chip ok">触发 {segment.firedCount}</span>
          {segment.timeoutCount > 0 && (
            <span className="conflict-chip warn">超时 {segment.timeoutCount}</span>
          )}
          {segment.noMatchCount > 0 && (
            <span className="conflict-chip dup">未命中 {segment.noMatchCount}</span>
          )}
        </span>
      </div>

      <table className="replay-table timeline-table">
        <thead>
          <tr>
            <th>事件</th>
            <th>日志时刻</th>
            <th>段内时刻</th>
            <th>输入/缓冲</th>
            <th>状态</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {segment.events.map((ev) => {
            const meta = STATUS_META[ev.status] || STATUS_META.idle;
            return (
              <tr key={ev.seq} className={`timeline-row row-${ev.status}`}>
                <td>#{ev.seq}</td>
                <td className="num">{ev.logTimeMs}ms</td>
                <td className="num">{ev.timeMs}ms</td>
                <td>
                  {ev.type === 'timeout' ? (
                    <span className="timeout-tag">⏰ 超时</span>
                  ) : (
                    <kbd className="press">{ev.pretty || prettyToken(ev.token)}</kbd>
                  )}
                  {ev.bufferLabel && (
                    <span className="buffer-label">
                      缓冲 <kbd>{ev.bufferLabel}</kbd>
                    </span>
                  )}
                  {ev.restartFrom && <span className="restart-tag">↻ 重新起算</span>}
                </td>
                <td>
                  <span className={`evt-badge ${meta.cls}`}>{meta.text}</span>
                </td>
                <td className="note-cell">
                  {ev.note}
                  {ev.triggered.length > 0 && (
                    <span className="fired-cmds">
                      {ev.triggered.map((c) => (
                        <span key={c.commandId} className="fired-cmd" title={c.contextPath}>
                          ⚡{c.name}
                          {c.duplicate && <em>（同层重复）</em>}
                        </span>
                      ))}
                    </span>
                  )}
                  {ev.held.length > 0 && ev.status === 'pending' && (
                    <span className="held-cmds">待定：{ev.held.map((c) => c.name).join('、')}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function LogDiagnostics() {
  const [logText, setLogText] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(800);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [errorSeq, setErrorSeq] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const fileRef = useRef(null);

  const runDiagnose = async (text) => {
    const source = text === undefined ? logText : text;
    let payload;
    try {
      payload = JSON.parse(source);
    } catch (err) {
      setResult(null);
      setError(`日志 JSON 解析失败：${err.message}`);
      setErrorSeq(null);
      return;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      setResult(null);
      setError('日志必须是一个 JSON 对象（含 events 数组）');
      setErrorSeq(null);
      return;
    }
    if (payload.timeoutMs === undefined || payload.timeoutMs === null) {
      payload.timeoutMs = Number(timeoutMs);
    }
    setBusy(true);
    try {
      const r = await api.logDiagnose(payload);
      setResult(r);
      setError('');
      setErrorSeq(null);
    } catch (err) {
      setResult(null); // 非法输入：不保留任何旧报告，绝不展示部分结果
      setError(err.message);
      setErrorSeq(err.details?.eventSeq ?? null);
    } finally {
      setBusy(false);
    }
  };

  const loadSample = async () => {
    setBusy(true);
    try {
      const sample = await api.logSample();
      const text = JSON.stringify(sample, null, 2);
      setLogText(text);
      if (Number.isFinite(Number(sample.timeoutMs))) setTimeoutMs(Number(sample.timeoutMs));
      await runDiagnose(text);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const downloadSample = async () => {
    try {
      const sample = await api.logSample();
      downloadJson(sample, 'input-log-sample.json');
    } catch (err) {
      setError(err.message);
    }
  };

  const importFile = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      setLogText(String(reader.result));
      setResult(null);
      setError('');
      setErrorSeq(null);
    };
    reader.readAsText(file);
  };

  return (
    <div className="regression-page">
      <div className="regression-toolbar">
        <div className="regression-title">
          <h2>📄 输入日志诊断</h2>
          <span className="dim small">
            只读诊断：按连续相同上下文切段，每段以首键为时间原点复用时序回放规则（待定 / 超时 /
            重新起算），切换上下文即结束上一段待定状态 · 报告时间：
            {result ? new Date(result.generatedAt).toLocaleString() : '-'}
          </span>
        </div>
        <div className="regression-actions">
          <button onClick={loadSample} disabled={busy} title="生成一份基于当前数据的示例日志并立即诊断">
            载入示例并诊断
          </button>
          <button onClick={downloadSample} title="下载示例日志 JSON（GET /api/log-diagnose/sample）">
            下载示例日志
          </button>
          <button
            className="primary"
            onClick={() => result && downloadJson(result, 'input-log-report.json')}
            disabled={!result}
          >
            下载结果 JSON
          </button>
        </div>
      </div>

      {/* 日志输入区 */}
      <div className="log-input-panel">
        <div className="log-input-head">
          <label className="replay-timeout">
            默认超时阈值
            <input
              type="number"
              min="0"
              step="50"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Math.max(0, Number(e.target.value) || 0))}
            />
            ms
          </label>
          <span className="hint small">
            日志 JSON 需含 events 数组：每个事件给出 contextId（上下文 ID）、key（按键，如
            &quot;g&quot; / &quot;ctrl+shift+p&quot;）、timeMs（相对毫秒，按时间非递减排序）；
            可选 timeoutMs 逐事件覆盖阈值。日志自带 timeoutMs 时以日志为准。
          </span>
        </div>
        <textarea
          className="log-textarea"
          spellCheck={false}
          placeholder='{"timeoutMs": 800, "events": [{"contextId": "ctx-code", "key": "g", "timeMs": 0}, …]}'
          value={logText}
          onChange={(e) => setLogText(e.target.value)}
        />
        <div className="replay-actions">
          <button className="primary" onClick={() => runDiagnose()} disabled={busy || !logText.trim()}>
            ▶ 开始诊断
          </button>
          <button onClick={() => fileRef.current?.click()}>⇧ 导入日志 JSON</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = '';
            }}
          />
          <button
            className="danger"
            onClick={() => {
              setLogText('');
              setResult(null);
              setError('');
              setErrorSeq(null);
            }}
            disabled={!logText && !result}
          >
            清空
          </button>
        </div>
      </div>

      {error && (
        <p className="error">
          ⚠ {error}
          {errorSeq !== null && <span className="badge duplicate">事件位置：第 {errorSeq} 个</span>}
        </p>
      )}

      {result && (
        <>
          <div className="stat-grid">
            <StatCard value={result.eventCount} label="日志事件" />
            <StatCard value={result.segmentCount} label="上下文分段" />
            <StatCard
              value={result.stats.triggeredCommandCount}
              label="触发命令（次）"
              tone={result.stats.triggeredCommandCount > 0 ? 'ok' : ''}
            />
            <StatCard
              value={result.stats.timeoutEventCount}
              label="超时事件"
              tone={result.stats.timeoutEventCount > 0 ? 'warn' : ''}
            />
            <StatCard
              value={result.stats.noMatchEventCount}
              label="未命中事件"
              tone={result.stats.noMatchEventCount > 0 ? 'danger' : ''}
            />
            <StatCard value={`${result.durationMs}ms`} label="日志时长" />
          </div>

          {/* 汇总：各命令触发次数 + 各上下文未命中次数 */}
          <div className="log-summary-grid">
            <div className="log-summary-panel">
              <h3>⚡ 各命令触发次数（{result.summary.commandTriggers.length}）</h3>
              {result.summary.commandTriggers.length === 0 ? (
                <p className="hint">整份日志没有触发任何命令。</p>
              ) : (
                <table className="bind-table">
                  <thead>
                    <tr>
                      <th>命令</th>
                      <th>序列</th>
                      <th>来源上下文</th>
                      <th>触发次数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.summary.commandTriggers.map((c) => (
                      <tr key={c.commandId}>
                        <td>{c.name}</td>
                        <td>
                          <kbd className="seq">{c.sequenceLabel}</kbd>
                        </td>
                        <td className="source">{c.contextPath}</td>
                        <td className="num">{c.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="log-summary-panel">
              <h3>❌ 各上下文未命中次数（{result.summary.contextNoMatch.length}）</h3>
              {result.summary.contextNoMatch.length === 0 ? (
                <p className="hint">整份日志没有未命中事件。</p>
              ) : (
                <table className="bind-table">
                  <thead>
                    <tr>
                      <th>上下文</th>
                      <th>未命中次数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.summary.contextNoMatch.map((c) => (
                      <tr key={c.contextId}>
                        <td className="source">{c.contextPath}</td>
                        <td className="num">{c.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* 分段明细：按原始事件顺序 */}
          <div className="suite-cases">
            <h3>
              分段回放明细（{result.segments.length} 段）
              <span className="dim small">
                {' '}
                按原始事件顺序；每段以首键为时间原点，切换上下文时上一段的待定状态已按超时结算
              </span>
            </h3>
            {result.segments.map((seg) => (
              <SegmentCard key={seg.index} segment={seg} />
            ))}
          </div>

          <details className="json-details" onToggle={(e) => setShowJson(e.target.open)}>
            <summary>查看完整 JSON（与 POST /api/log-diagnose 返回内容一致）</summary>
            {showJson && <pre className="json-pre">{JSON.stringify(result, null, 2)}</pre>}
          </details>
        </>
      )}
    </div>
  );
}
