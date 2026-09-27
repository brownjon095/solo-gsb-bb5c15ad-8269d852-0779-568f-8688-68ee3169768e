import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { eventToToken, prettyToken } from '../keymap';

/**
 * 连续练习（只读评判页）：
 * - 选择一个上下文，从其生效命令中编排 1~20 个目标命令（可重复、可排序）；
 * - 录制带相对毫秒的按键后「结束练习」，或导入现有回放格式（shortcut-replay-v1）的 JSON；
 * - 后端复用时序回放（前缀待定 / 超时 / 重新起算）展开实际触发（同次多命令按 ID 升序），
 *   再用动态规划把实际命令流与目标序列对齐：匹配 0，错命令 / 漏命令 / 多触发各 1，
 *   总成本相同时回溯优先 匹配 > 错命令 > 漏命令 > 多触发；
 * - 未生效目标、非法按键、倒退时间由后端整体拒绝（400）；空录制按全部漏命令处理；
 * - 展示逐项目标与实际命令、触发时刻、错误类型与总错误数，结果可下载 JSON。
 */

const DEFAULT_TIMEOUT = 800;
const MAX_TARGETS = 20;

const ALIGN_META = {
  match: { text: '匹配', cls: 'match' },
  wrong: { text: '错命令', cls: 'wrong' },
  missed: { text: '漏命令', cls: 'missed' },
  extra: { text: '多触发', cls: 'extra' },
};

const REPLAY_STATUS_META = {
  idle: { text: '空闲', cls: 'idle' },
  pending: { text: '待定（等续键/超时）', cls: 'pending' },
  waiting: { text: '等待后续按键', cls: 'waiting' },
  triggered: { text: '命令已触发', cls: 'triggered' },
  timeout: { text: '超时触发短序列', cls: 'timeout' },
  'no-match': { text: '无匹配，重新起算', cls: 'nomatch' },
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

export default function Practice({ state }) {
  const [contextId, setContextId] = useState('');
  const [review, setReview] = useState(null);
  const [targets, setTargets] = useState([]); // [{ commandId, name, sequenceLabel, contextPath }]
  const [timeoutMs, setTimeoutMs] = useState(DEFAULT_TIMEOUT);
  const [presses, setPresses] = useState([]); // [{ token, timeMs, timeoutMs }]
  const [recording, setRecording] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [showReplay, setShowReplay] = useState(false);
  const recorderRef = useRef(null);
  const recordStartRef = useRef(0);
  const fileRef = useRef(null);

  // ---- 上下文选项（按路径排序） ----
  const ctxById = useMemo(() => new Map(state.contexts.map((c) => [c.id, c])), [state.contexts]);
  const pathOf = (id) => {
    const parts = [];
    const guard = new Set();
    let cur = ctxById.get(id);
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parentId ? ctxById.get(cur.parentId) : null;
    }
    return parts.join(' / ');
  };
  const contextOptions = useMemo(
    () =>
      state.contexts
        .map((c) => ({ id: c.id, path: pathOf(c.id) }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    [state.contexts],
  );

  // 默认选中第一个上下文
  useEffect(() => {
    if (!contextId && contextOptions.length > 0) setContextId(contextOptions[0].id);
  }, [contextOptions, contextId]);

  // 切换上下文：加载生效命令并重置练习
  useEffect(() => {
    if (!contextId) return undefined;
    let cancelled = false;
    setReview(null);
    setTargets([]);
    setPresses([]);
    setResult(null);
    setError('');
    setRecording(false);
    api
      .review(contextId)
      .then((r) => {
        if (!cancelled) setReview(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [contextId]);

  // 生效命令（shadowed 不可选，与后端「未生效目标整体拒绝」口径一致）
  const effectiveCommands = useMemo(
    () => (review ? review.entries.filter((e) => e.state !== 'shadowed') : []),
    [review],
  );

  // ---- 目标编排（1~20，可重复） ----
  const addTarget = (entry) => {
    if (targets.length >= MAX_TARGETS) return;
    setTargets((prev) => [
      ...prev,
      {
        commandId: entry.commandId,
        name: entry.name,
        sequenceLabel: entry.sequenceLabel,
        contextPath: entry.contextPath,
      },
    ]);
    setResult(null);
  };
  const removeTarget = (idx) => {
    setTargets((prev) => prev.filter((_, i) => i !== idx));
    setResult(null);
  };
  const moveTarget = (idx, dir) => {
    setTargets((prev) => {
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
    setResult(null);
  };

  // ---- 录制（带相对毫秒；Esc 结束，Backspace 删末键） ----
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
    recordStartRef.current = performance.now();
    setRecording(true);
    setTimeout(() => recorderRef.current?.focus(), 0);
  };

  const updatePress = (idx, patch) => {
    setPresses((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
    setResult(null);
  };

  // ---- 导入现有回放格式 JSON（shortcut-replay-v1：{ timeoutMs, presses: [{token,timeMs,timeoutMs}] }） ----
  const importJson = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const list = Array.isArray(data?.presses) ? data.presses : null;
        if (!list) throw new Error('文件中没有 presses 按键数组（需为 shortcut-replay-v1 回放格式）');
        const next = list.map((p, i) => {
          const token = typeof p === 'string' ? p : p.token || p.press;
          const timeMs = Number(typeof p === 'object' ? p.timeMs : NaN);
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
        if (data.contextId && data.contextId !== contextId) {
          setError(
            `提示：文件录制于上下文「${data.contextPath || data.contextId}」，已按当前上下文「${pathOf(contextId)}」评判`,
          );
        } else {
          setError('');
        }
        if (Number.isFinite(Number(data.timeoutMs))) setTimeoutMs(Number(data.timeoutMs));
        setPresses(next);
        setResult(null);
      } catch (err) {
        setError(`导入失败：${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  // ---- 结束练习并评判 ----
  const judge = async () => {
    setBusy(true);
    try {
      const r = await api.practiceJudge({
        contextId,
        timeoutMs: Number(timeoutMs),
        targets: targets.map((t) => t.commandId),
        presses: presses.map((p) => ({ token: p.token, timeMs: p.timeMs, timeoutMs: p.timeoutMs })),
      });
      setResult(r);
      setError('');
    } catch (err) {
      setResult(null); // 整体拒绝：不保留任何旧结果
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const canJudge = !!contextId && targets.length >= 1 && !recording && !busy;

  return (
    <div className="regression-page">
      <div className="regression-toolbar">
        <div className="regression-title">
          <h2>🎯 连续练习</h2>
          <span className="dim small">
            只读评判：编排 1~{MAX_TARGETS} 个目标命令（可重复），录制或导入按键时间线后结束练习；
            后端复用时序回放展开实际触发，动态规划对齐目标序列（匹配 0 / 错命令 / 漏命令 / 多触发各
            1）· 评判时间：{result ? new Date(result.generatedAt).toLocaleString() : '-'}
          </span>
        </div>
        <div className="regression-actions">
          <button
            className="primary"
            onClick={() => result && downloadJson(result, 'practice-judge-result.json')}
            disabled={!result}
          >
            下载结果 JSON
          </button>
        </div>
      </div>

      {/* 练习配置：上下文 + 超时阈值 */}
      <div className="log-input-panel">
        <div className="log-input-head">
          <label className="replay-timeout">
            练习上下文
            <select value={contextId} onChange={(e) => setContextId(e.target.value)}>
              {contextOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.path}
                </option>
              ))}
            </select>
          </label>
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
            短序列命中且为长序列前缀时进入待定：阈值内续键走长序列，超时触发短序列；无匹配从当前按键重新起算
          </span>
        </div>
      </div>

      {/* 目标编排：生效命令池 + 目标序列 */}
      <div className="practice-grid">
        <div className="practice-panel">
          <h3>生效命令（{effectiveCommands.length}）· 点击 ＋ 加入目标</h3>
          {effectiveCommands.length === 0 ? (
            <p className="hint">该上下文没有生效命令。</p>
          ) : (
            <div className="practice-cmd-list">
              {effectiveCommands.map((e) => (
                <div key={e.commandId} className="practice-cmd">
                  <span className="practice-cmd-name" title={e.contextPath}>
                    {e.name}
                  </span>
                  <kbd className="seq">{e.sequenceLabel}</kbd>
                  {e.duplicate && <span className="badge duplicate">同层重复</span>}
                  <button
                    className="practice-add"
                    onClick={() => addTarget(e)}
                    disabled={targets.length >= MAX_TARGETS}
                    title="加入目标序列末尾"
                  >
                    ＋
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="practice-panel">
          <h3>
            目标序列（{targets.length}/{MAX_TARGETS}）
            {targets.length > 0 && (
              <button
                className="link-danger"
                onClick={() => {
                  setTargets([]);
                  setResult(null);
                }}
              >
                清空
              </button>
            )}
          </h3>
          {targets.length === 0 ? (
            <p className="hint">从左侧生效命令中加入 1~{MAX_TARGETS} 个目标（可重复选择同一命令）。</p>
          ) : (
            <div className="practice-cmd-list">
              {targets.map((t, i) => (
                <div key={`${t.commandId}-${i}`} className="practice-cmd target">
                  <span className="practice-target-index">#{i + 1}</span>
                  <span className="practice-cmd-name" title={t.contextPath}>
                    {t.name}
                  </span>
                  <kbd className="seq">{t.sequenceLabel}</kbd>
                  <span className="practice-target-ops">
                    <button onClick={() => moveTarget(i, -1)} disabled={i === 0} title="上移">
                      ↑
                    </button>
                    <button
                      onClick={() => moveTarget(i, 1)}
                      disabled={i === targets.length - 1}
                      title="下移"
                    >
                      ↓
                    </button>
                    <button className="link-danger" onClick={() => removeTarget(i)} title="移除">
                      ✕
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 录制区 */}
      <div className="log-input-panel">
        <div ref={recorderRef} tabIndex={0} className={`recorder replay-recorder ${recording ? 'armed' : ''}`}>
          {recording ? (
            <>
              <div className="buffer">
                <span className="buffer-empty">
                  ● 录制中… 已录 {presses.length} 键 · Esc 结束 · Backspace 删除末键
                </span>
              </div>
              <p className="hint small">每次按键自动记录相对首键的毫秒与当前阈值</p>
            </>
          ) : (
            <div className="buffer">
              <span className="buffer-empty">
                点击「开始录制」后在此按键；也可导入回放 JSON。录制完成后点「结束练习并评判」
              </span>
            </div>
          )}
        </div>
        <div className="replay-actions">
          {!recording ? (
            <button className="primary" onClick={startRecording} disabled={!contextId}>
              ● 开始录制
            </button>
          ) : (
            <button className="danger" onClick={() => setRecording(false)}>
              ■ 结束录制
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
            }}
            disabled={presses.length === 0 && !result}
          >
            清空录制
          </button>
          <button
            className="primary"
            onClick={judge}
            disabled={!canJudge}
            title={
              targets.length === 0
                ? '请先编排至少 1 个目标命令'
                : presses.length === 0
                  ? '空录制：全部目标按漏命令处理'
                  : '提交评判'
            }
          >
            🏁 结束练习并评判
          </button>
          {presses.length === 0 && targets.length > 0 && (
            <span className="hint small">当前为空录制：评判时全部目标按漏命令处理</span>
          )}
        </div>
      </div>

      {error && <p className="error">⚠ {error}</p>}

      {/* 录制的按键时间线 */}
      {presses.length > 0 && (
        <div className="practice-panel">
          <h3>按键时间线（{presses.length} 键）</h3>
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
                <tr key={i}>
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
                    <button
                      className="link-danger"
                      onClick={() => {
                        setPresses((prev) => prev.filter((_, j) => j !== i));
                        setResult(null);
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 评判结果 */}
      {result && (
        <>
          <div className="stat-grid">
            <StatCard value={result.stats.targetCount} label="目标命令" />
            <StatCard value={result.stats.actualCount} label="实际触发" />
            <StatCard
              value={result.stats.matchCount}
              label="匹配"
              tone={result.stats.matchCount > 0 ? 'ok' : ''}
            />
            <StatCard
              value={result.stats.wrongCount}
              label="错命令"
              tone={result.stats.wrongCount > 0 ? 'danger' : ''}
            />
            <StatCard
              value={result.stats.missedCount}
              label="漏命令"
              tone={result.stats.missedCount > 0 ? 'warn' : ''}
            />
            <StatCard
              value={result.stats.extraCount}
              label="多触发"
              tone={result.stats.extraCount > 0 ? 'danger' : ''}
            />
            <StatCard
              value={result.stats.totalErrors}
              label="总错误数"
              tone={result.stats.totalErrors > 0 ? 'danger' : 'ok'}
            />
          </div>

          {/* 逐项对齐明细 */}
          <div className="practice-panel">
            <h3>
              逐项对齐（{result.alignment.length} 项）· 上下文：{result.contextPath}
              <span className="dim small"> 目标 vs 实际命令、触发时刻与错误类型</span>
            </h3>
            <table className="replay-table align-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>目标命令</th>
                  <th>实际命令</th>
                  <th>触发时刻</th>
                  <th>判定</th>
                </tr>
              </thead>
              <tbody>
                {result.alignment.map((row) => {
                  const meta = ALIGN_META[row.type];
                  return (
                    <tr key={row.seq} className={`align-row row-align-${meta.cls}`}>
                      <td>{row.seq}</td>
                      <td>
                        {row.target ? (
                          <span className="align-cmd">
                            <em className="align-index">目标 #{row.targetIndex}</em>
                            <strong>{row.target.name}</strong>
                            <kbd className="seq">{row.target.sequenceLabel}</kbd>
                          </span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td>
                        {row.actual ? (
                          <span className="align-cmd">
                            <strong>{row.actual.name}</strong>
                            <kbd className="seq">{row.actual.sequenceLabel}</kbd>
                            {row.actual.duplicate && <span className="badge duplicate">同层重复</span>}
                          </span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td className="num">
                        {row.actual ? (
                          <span className="fired-at">
                            @{row.actual.atMs}ms{row.actual.eventType === 'timeout' ? '（超时）' : ''}
                          </span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td>
                        <span className={`evt-badge align-${meta.cls}`}>{meta.text}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 实际触发流（按时间展开，同次多命令按 ID 升序） */}
          <div className="practice-panel">
            <h3>实际触发流（{result.actual.length}）· 按时间展开，同次多命令按 ID 升序</h3>
            {result.actual.length === 0 ? (
              <p className="hint">整条时间线没有触发任何命令。</p>
            ) : (
              <table className="replay-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>命令</th>
                    <th>序列</th>
                    <th>触发时刻</th>
                    <th>方式</th>
                  </tr>
                </thead>
                <tbody>
                  {result.actual.map((a) => (
                    <tr key={a.seq}>
                      <td>{a.seq}</td>
                      <td>
                        <strong>{a.name}</strong>
                        {a.duplicate && <span className="badge duplicate">同层重复</span>}
                      </td>
                      <td>
                        <kbd className="seq">{a.sequenceLabel}</kbd>
                      </td>
                      <td className="num">
                        <span className="fired-at">@{a.atMs}ms</span>
                      </td>
                      <td>{a.eventType === 'timeout' ? '超时触发' : '按键触发'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 时序回放明细（前缀待定 / 超时 / 重新起算） */}
          {result.replay && (
            <details className="json-details" onToggle={(e) => setShowReplay(e.target.open)}>
              <summary>
                逐事件回放明细（{result.replay.events.length} 个事件 · 含前缀待定 / 超时 / 重新起算）
              </summary>
              {showReplay && (
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
                      const meta = REPLAY_STATUS_META[ev.status] || REPLAY_STATUS_META.idle;
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
                            {ev.held.length > 0 && ev.status === 'pending' && (
                              <span className="held-cmds">待定：{ev.held.map((c) => c.name).join('、')}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </details>
          )}

          <details className="json-details" onToggle={(e) => setShowJson(e.target.open)}>
            <summary>查看完整 JSON（与 POST /api/practice/judge 返回内容一致）</summary>
            {showJson && <pre className="json-pre">{JSON.stringify(result, null, 2)}</pre>}
          </details>
        </>
      )}
    </div>
  );
}
