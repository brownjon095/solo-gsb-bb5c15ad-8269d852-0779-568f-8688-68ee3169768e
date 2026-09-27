import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { eventToToken, prettyToken } from '../keymap';

/**
 * 连续练习（只读评判页）：
 * - 选择一个上下文，从其生效命令（非 shadowed）中编排 1~20 个目标命令，可重复；
 * - 录制带相对毫秒的按键并结束练习，也可导入现有时序回放 JSON（shortcut-replay-v1）；
 * - 后端复用时序回放（前缀待定 / 超时 / 无匹配重新起算），把实际触发按时间展开
 *   （同刻多命令按命令 id 升序），用动态规划与目标序列对齐：匹配 0，错命令 /
 *   漏命令 / 多触发各 1，平局回溯优先 匹配/错命令 → 漏命令 → 多触发；
 * - 逐行展示目标与实际命令、触发时刻、错误类型及总错误数，可下载结果 JSON；
 * - 未生效目标、非法按键、时间倒退由后端整体拒绝（400）；空录制按全部漏命令处理。
 */

const DEFAULT_TIMEOUT = 800;
const MAX_TARGETS = 20;

const ERROR_META = {
  match: { text: '✓ 正确', cls: 'triggered' },
  wrong: { text: '✗ 错命令', cls: 'nomatch' },
  miss: { text: '漏命令', cls: 'timeout' },
  extra: { text: '多触发', cls: 'pending' },
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

/** 上下文树选项：缩进展示路径 */
function contextOptions(contexts) {
  const byId = new Map(contexts.map((c) => [c.id, { ...c }]));
  for (const c of byId.values()) {
    const parent = c.parentId ? byId.get(c.parentId) : null;
    c.path = parent ? `${parent.path} / ${c.name}` : c.name;
  }
  return [...byId.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export default function Practice({ state }) {
  const options = useMemo(() => contextOptions(state.contexts || []), [state.contexts]);
  const [contextId, setContextId] = useState(options[0]?.id || '');
  const [review, setReview] = useState(null);
  const [reviewError, setReviewError] = useState('');

  const [targetIds, setTargetIds] = useState([]); // [commandId, ...]（可重复）
  const [timeoutMs, setTimeoutMs] = useState(DEFAULT_TIMEOUT);
  const [presses, setPresses] = useState([]); // [{ token, timeMs, timeoutMs }]
  const [recording, setRecording] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [errorLoc, setErrorLoc] = useState(null); // { kind: 'target'|'press', seq }
  const [busy, setBusy] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const recorderRef = useRef(null);
  const recordStartRef = useRef(0);
  const fileRef = useRef(null);

  // 首次加载：默认选第一个上下文
  useEffect(() => {
    if (!contextId && options.length > 0) setContextId(options[0].id);
  }, [options, contextId]);

  // 切换上下文：重新拉取生效绑定并清空编排 / 录制 / 结果
  useEffect(() => {
    let cancelled = false;
    if (!contextId) {
      setReview(null);
      return undefined;
    }
    api
      .review(contextId)
      .then((r) => {
        if (!cancelled) {
          setReview(r);
          setReviewError('');
        }
      })
      .catch((err) => {
        if (!cancelled) setReviewError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [contextId, state]);

  useEffect(() => {
    setTargetIds([]);
    setPresses([]);
    setResult(null);
    setError('');
    setErrorLoc(null);
    setRecording(false);
  }, [contextId]);

  // 当前上下文中的生效命令（非 shadowed），按序列展示；同层重复各自保留
  const effectiveCommands = useMemo(() => {
    if (!review) return [];
    return review.entries
      .filter((e) => e.state !== 'shadowed')
      .slice()
      .sort(
        (a, b) =>
          a.sequenceLabel.localeCompare(b.sequenceLabel) ||
          (a.commandId < b.commandId ? -1 : 1),
      );
  }, [review]);

  const commandById = useMemo(() => new Map(effectiveCommands.map((c) => [c.commandId, c])), [effectiveCommands]);

  // ---------- 录制 ----------
  useEffect(() => {
    if (!recording) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setRecording(false);
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        setPresses((prev) => prev.slice(0, -1));
        return;
      }
      e.preventDefault();
      const token = eventToToken(e);
      if (!token) return;
      const at = Math.max(0, Math.round(performance.now() - recordStartRef.current));
      setPresses((prev) => {
        // 防止 timeMs 倒退（浏览器事件时间戳抖动）
        const lastT = prev.length ? prev[prev.length - 1].timeMs : 0;
        return [...prev, { token, timeMs: Math.max(at, lastT), timeoutMs: Number(timeoutMs) }];
      });
    };
    const node = recorderRef.current;
    node?.addEventListener('keydown', onKeyDown);
    return () => node?.removeEventListener('keydown', onKeyDown);
  });

  const startRecording = () => {
    setPresses([]);
    setResult(null);
    setError('');
    setErrorLoc(null);
    recordStartRef.current = performance.now();
    setRecording(true);
    setTimeout(() => recorderRef.current?.focus(), 0);
  };

  const updatePress = (idx, patch) => {
    setPresses((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  // ---------- 目标编排 ----------
  const addTarget = (commandIdToAdd) => {
    if (!commandIdToAdd) return;
    if (targetIds.length >= MAX_TARGETS) {
      setError(`最多编排 ${MAX_TARGETS} 个目标命令`);
      return;
    }
    setTargetIds((prev) => [...prev, commandIdToAdd]);
    setResult(null);
  };

  const removeTarget = (idx) => {
    setTargetIds((prev) => prev.filter((_, i) => i !== idx));
    setResult(null);
  };

  const moveTarget = (idx, delta) => {
    setTargetIds((prev) => {
      const next = prev.slice();
      const j = idx + delta;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
    setResult(null);
  };

  // ---------- 评判 ----------
  const runJudge = async () => {
    if (!contextId || targetIds.length === 0) {
      setError('请先选择上下文并编排至少 1 个目标命令');
      return;
    }
    const payload = {
      targets: targetIds,
      timeoutMs: Number(timeoutMs),
      presses: presses.map((p) => ({ token: p.token, timeMs: p.timeMs, timeoutMs: p.timeoutMs })),
    };
    setBusy(true);
    try {
      const r = await api.practiceJudge(contextId, payload);
      setResult(r);
      setError('');
      setErrorLoc(null);
    } catch (err) {
      setResult(null); // 非法输入整体拒绝，不保留部分结果
      setError(err.message);
      const d = err.details || {};
      if (d.targetSeq !== undefined) setErrorLoc({ kind: 'target', seq: d.targetSeq });
      else if (d.pressSeq !== undefined) setErrorLoc({ kind: 'press', seq: d.pressSeq });
      else setErrorLoc(null);
    } finally {
      setBusy(false);
    }
  };

  // ---------- 导入现有时序回放 JSON（shortcut-replay-v1，与 /api/replay 相同格式） ----------
  const importJson = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const list = Array.isArray(data?.presses) ? data.presses : null;
        if (!list) throw new Error('文件中没有 presses 按键数组（请选择时序回放导出的 JSON）');
        const next = list.map((p, i) => {
          const token = typeof p === 'string' ? p : p.token || p.press;
          const timeMs = Number(typeof p === 'object' ? p.timeMs : i * DEFAULT_TIMEOUT);
          const perTimeout =
            typeof p === 'object' && Number.isFinite(Number(p.timeoutMs))
              ? Number(p.timeoutMs)
              : Number.isFinite(Number(data.timeoutMs))
                ? Number(data.timeoutMs)
                : DEFAULT_TIMEOUT;
          if (!token || typeof token !== 'string') throw new Error(`第 ${i + 1} 次按键缺少 token`);
          if (!Number.isFinite(timeMs) || timeMs < 0) throw new Error(`第 ${i + 1} 次按键 timeMs 非法`);
          return { token: token.toLowerCase(), timeMs, timeoutMs: perTimeout };
        });
        for (let i = 1; i < next.length; i++) {
          if (next[i].timeMs < next[i - 1].timeMs) throw new Error(`第 ${i + 1} 次按键时间早于上一次`);
        }
        if (Number.isFinite(Number(data.timeoutMs))) setTimeoutMs(Number(data.timeoutMs));
        setPresses(next);
        setResult(null);
        setError(
          data.contextId && data.contextId !== contextId
            ? `提示：文件录制于上下文「${data.contextPath || data.contextId}」，已按当前上下文评判`
            : '',
        );
        setErrorLoc(null);
      } catch (err) {
        setResult(null);
        setError(`导入失败：${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const resetAll = () => {
    setTargetIds([]);
    setPresses([]);
    setResult(null);
    setError('');
    setErrorLoc(null);
    setRecording(false);
  };

  const targetCount = targetIds.length;

  return (
    <div className="regression-page practice-page">
      <div className="regression-toolbar">
        <div className="regression-title">
          <h2>🎯 连续练习</h2>
          <span className="dim small">
            只读评判：编排 1~20 个生效命令作为目标（可重复），录制带相对毫秒的按键并结束练习，
            后端复用时序回放（前缀待定 / 超时 / 重新起算）并把实际触发与目标做动态规划对齐 ·
            评判时间：{result ? new Date(result.generatedAt).toLocaleString() : '-'}
          </span>
        </div>
        <div className="regression-actions">
          <button
            className="primary"
            onClick={() => result && downloadJson(result, 'practice-result.json')}
            disabled={!result}
            title="下载评判结果 JSON（与 POST /api/practice/judge/:contextId 返回一致）"
          >
            下载结果 JSON
          </button>
        </div>
      </div>

      {/* 第 1 步：选择上下文 */}
      <div className="suite-case practice-step">
        <div className="suite-case-head">
          <span className="suite-index">① 选择上下文</span>
          <select className="practice-context-select" value={contextId} onChange={(e) => setContextId(e.target.value)}>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.path || c.name}
              </option>
            ))}
          </select>
          {review && (
            <span className="dim small">
              {effectiveCommands.length} 个生效命令可作为目标（同层重复命令各自独立、可分别编排）
            </span>
          )}
        </div>
        {reviewError && <p className="error">⚠ {reviewError}</p>}
      </div>

      {/* 第 2 步：编排目标 */}
      <div className="suite-case practice-step">
        <div className="suite-case-head">
          <span className="suite-index">② 编排目标命令（{targetCount}/{MAX_TARGETS}，可重复）</span>
          <select
            className="practice-cmd-select"
            value=""
            disabled={targetCount >= MAX_TARGETS}
            onChange={(e) => addTarget(e.target.value)}
          >
            <option value="">— 添加一个生效命令为目标 —</option>
            {effectiveCommands.map((c) => (
              <option key={c.commandId} value={c.commandId}>
                {c.sequenceLabel}　{c.name}
                {c.duplicate ? '（同层重复）' : ''}
              </option>
            ))}
          </select>
        </div>
        {targetCount === 0 ? (
          <p className="hint practice-hint">尚未编排目标：从上方下拉选择命令；同一命令可多次添加。</p>
        ) : (
          <ol className="practice-target-list">
            {targetIds.map((id, i) => {
              const cmd = commandById.get(id);
              const invalid = !cmd;
              return (
                <li key={`${id}-${i}`} className={errorLoc?.kind === 'target' && errorLoc.seq === i + 1 ? 'target-row bad' : 'target-row'}>
                  <span className="target-seq">#{i + 1}</span>
                  <kbd className="seq">{cmd ? cmd.sequenceLabel : '?'}</kbd>
                  <strong>{cmd ? cmd.name : `（不生效：${id}）`}</strong>
                  {cmd?.duplicate && <span className="badge duplicate">同层重复</span>}
                  {cmd && <span className="dim small" title={cmd.contextPath}>来源：{cmd.contextPath}</span>}
                  {invalid && <span className="badge duplicate">提交后将被整体拒绝</span>}
                  <span className="target-ops">
                    <button className="link" onClick={() => moveTarget(i, -1)} disabled={i === 0} title="上移">
                      ↑
                    </button>
                    <button
                      className="link"
                      onClick={() => moveTarget(i, 1)}
                      disabled={i === targetIds.length - 1}
                      title="下移"
                    >
                      ↓
                    </button>
                    <button className="link-danger" onClick={() => removeTarget(i)}>
                      删除
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* 第 3 步：录制 / 导入 */}
      <div className="suite-case practice-step">
        <div className="suite-case-head">
          <span className="suite-index">③ 录制按键（相对毫秒）或导入回放 JSON</span>
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
        </div>

        <div
          ref={recorderRef}
          tabIndex={0}
          className={`recorder replay-recorder practice-recorder ${recording ? 'armed' : ''}`}
        >
          {recording ? (
            <>
              <div className="buffer">
                <span className="buffer-empty">
                  ● 录制中… 已录 {presses.length} 键 · Esc 结束练习 · Backspace 删末键
                </span>
              </div>
              <p className="hint small">每次按键自动记录相对毫秒与当前阈值</p>
            </>
          ) : (
            <div className="buffer">
              <span className="buffer-empty">点击「开始录制」后在此按键；空录制提交将按全部漏命令处理</span>
            </div>
          )}
        </div>

        <div className="replay-actions">
          {!recording ? (
            <button className="primary" onClick={startRecording} disabled={targetCount === 0}>
              ● 开始录制
            </button>
          ) : (
            <button className="danger" onClick={() => setRecording(false)}>
              ■ 结束练习
            </button>
          )}
          <button onClick={() => fileRef.current?.click()}>⇧ 导入回放 JSON</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importJson(f);
              e.target.value = '';
            }}
          />
          <button
            className="danger"
            onClick={() => {
              setPresses([]);
              setResult(null);
              setError('');
              setErrorLoc(null);
            }}
            disabled={presses.length === 0}
          >
            清空录制
          </button>
        </div>

        {presses.length > 0 && (
          <table className="replay-table">
            <thead>
              <tr>
                <th>#</th>
                <th>按键</th>
                <th>相对时间 (ms)</th>
                <th>该键阈值 (ms)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {presses.map((p, i) => (
                <tr key={i} className={errorLoc?.kind === 'press' && errorLoc.seq === i + 1 ? 'press-row bad' : ''}>
                  <td>{i + 1}</td>
                  <td>
                    <kbd className="press">{prettyToken(p.token)}</kbd>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      value={p.timeMs}
                      onChange={(e) => updatePress(i, { timeMs: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      value={p.timeoutMs}
                      onChange={(e) => updatePress(i, { timeoutMs: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  </td>
                  <td>
                    <button className="link-danger" onClick={() => setPresses((prev) => prev.filter((_, j) => j !== i))}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 第 4 步：评判 */}
      <div className="practice-judge-bar">
        <button className="primary big" onClick={runJudge} disabled={busy || targetCount === 0}>
          ▶ 评判练习
        </button>
        <button onClick={resetAll} disabled={busy || (targetCount === 0 && presses.length === 0)}>
          重置全部
        </button>
        <span className="hint small">
          未生效目标、非法按键或倒退时间会被后端整体拒绝（不生成部分结果）；空录制 = 全部漏命令。
        </span>
      </div>

      {error && (
        <p className="error">
          ⚠ {error}
          {errorLoc && (
            <span className="badge duplicate">
              位置：{errorLoc.kind === 'target' ? `第 ${errorLoc.seq} 个目标` : `第 ${errorLoc.seq} 次按键`}
            </span>
          )}
        </p>
      )}

      {result && (
        <>
          <div className="stat-grid">
            <StatCard value={result.totalCost} label="总错误数（DP 总成本）" tone={result.totalCost > 0 ? 'danger' : 'ok'} />
            <StatCard value={result.stats.matchedCount} label="正确匹配" tone="ok" />
            <StatCard value={result.stats.wrongCount} label="错命令" tone={result.stats.wrongCount > 0 ? 'danger' : ''} />
            <StatCard value={result.stats.missedCount} label="漏命令" tone={result.stats.missedCount > 0 ? 'warn' : ''} />
            <StatCard value={result.stats.extraCount} label="多触发" tone={result.stats.extraCount > 0 ? 'warn' : ''} />
            <StatCard value={result.targetCount} label="目标命令" />
            <StatCard value={result.actualCount} label="实际触发（次）" />
            <StatCard value={result.pressCount} label="录制按键" />
            <StatCard value={`${result.durationMs}ms`} label="回放时长" />
          </div>

          {result.emptyRecording && (
            <div className="unreachable-panel">
              <h3>空录制</h3>
              <p className="hint small">本次没有提交任何按键，{result.targetCount} 个目标全部按漏命令处理。</p>
            </div>
          )}

          {/* 逐行对齐结果 */}
          <div className="suite-case">
            <div className="suite-case-head">
              <span className="suite-index">对齐明细（{result.alignment.length} 行）</span>
              <span className="dim small">
                动态规划对齐：匹配成本 0，错命令 / 漏命令 / 多触发各 1；总成本相同时回溯优先
                匹配/错命令 → 漏命令 → 多触发
              </span>
            </div>
            <table className="replay-table practice-align-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>错误类型</th>
                  <th>目标命令</th>
                  <th>实际命令</th>
                  <th>触发时刻</th>
                  <th>触发方式</th>
                  <th>成本</th>
                </tr>
              </thead>
              <tbody>
                {result.alignment.map((row) => {
                  const meta = ERROR_META[row.type] || ERROR_META.match;
                  return (
                    <tr key={row.seq} className={`align-row row-${row.type}`}>
                      <td className="num">{row.seq}</td>
                      <td>
                        <span className={`evt-badge ${meta.cls}`}>{meta.text}</span>
                      </td>
                      <td>
                        {row.target ? (
                          <span className="align-cmd">
                            <kbd className="seq">{row.target.sequenceLabel}</kbd>
                            <strong>{row.target.name}</strong>
                            {row.target.duplicate && <em className="dim small">（同层重复）</em>}
                            <span className="dim small" title={row.target.contextPath}>
                              来源：{row.target.contextPath}
                            </span>
                          </span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td>
                        {row.actual ? (
                          <span className="align-cmd">
                            <kbd className="seq">{row.actual.sequenceLabel}</kbd>
                            <strong>{row.actual.name}</strong>
                            {row.actual.duplicate && <em className="dim small">（同层重复）</em>}
                            <span className="dim small" title={row.actual.contextPath}>
                              来源：{row.actual.contextPath}
                            </span>
                          </span>
                        ) : (
                          <span className="dim">—（未触发）</span>
                        )}
                      </td>
                      <td className="num">{row.actual ? `${row.actual.atMs}ms` : '—'}</td>
                      <td>
                        {row.actual
                          ? row.actual.eventType === 'timeout'
                            ? '⏰ 超时触发'
                            : '⌨ 按键触发'
                          : '—'}
                      </td>
                      <td className="num">{row.cost}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 实际触发流（按时间展开，同刻按命令 id 升序） */}
          <div className="suite-case">
            <div className="suite-case-head">
              <span className="suite-index">实际触发命令流（{result.actual.length}）</span>
              <span className="dim small">按触发时刻展开，同一时刻多条命令按命令 ID 升序</span>
            </div>
            {result.actual.length === 0 ? (
              <p className="hint practice-hint">回放没有触发任何命令。</p>
            ) : (
              <table className="replay-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>时刻</th>
                    <th>方式</th>
                    <th>命令</th>
                    <th>序列</th>
                    <th>来源上下文</th>
                  </tr>
                </thead>
                <tbody>
                  {result.actual.map((a) => (
                    <tr key={a.triggerIndex}>
                      <td className="num">{a.triggerIndex}</td>
                      <td className="num">{a.atMs}ms</td>
                      <td>{a.eventType === 'timeout' ? '⏰ 超时触发' : '⌨ 按键触发'}</td>
                      <td>
                        <strong>{a.name}</strong>
                        {a.duplicate && <span className="badge duplicate">同层重复</span>}
                      </td>
                      <td>
                        <kbd className="seq">{a.sequenceLabel}</kbd>
                      </td>
                      <td className="source">{a.contextPath}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 回放明细：复用时序回放的完整逐事件状态 */}
          {result.replay && (
            <details className="json-details">
              <summary>
                查看时序回放逐事件（{result.replay.events.length} 个事件，规则与「时序回放」页完全一致）
              </summary>
              <table className="replay-table timeline-table">
                <thead>
                  <tr>
                    <th>事件</th>
                    <th>时刻</th>
                    <th>间隔</th>
                    <th>输入/缓冲</th>
                    <th>状态</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {result.replay.events.map((ev) => {
                    const meta = {
                      idle: { text: '空闲', cls: 'idle' },
                      pending: { text: '待定', cls: 'pending' },
                      waiting: { text: '等待', cls: 'waiting' },
                      triggered: { text: '已触发', cls: 'triggered' },
                      timeout: { text: '超时触发', cls: 'timeout' },
                      'no-match': { text: '无匹配', cls: 'nomatch' },
                    }[ev.status] || { text: ev.status, cls: 'idle' };
                    return (
                      <tr key={ev.seq} className={`timeline-row row-${ev.status}`}>
                        <td>#{ev.seq}</td>
                        <td className="num">{ev.timeMs}ms</td>
                        <td className="num">{ev.deltaMs}ms</td>
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
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
          )}

          <details className="json-details" onToggle={(e) => setShowJson(e.target.open)}>
            <summary>查看完整结果 JSON（与 POST /api/practice/judge/:contextId 返回内容一致）</summary>
            {showJson && <pre className="json-pre">{JSON.stringify(result, null, 2)}</pre>}
          </details>
        </>
      )}
    </div>
  );
}
