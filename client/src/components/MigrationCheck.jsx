import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * 跨平台迁移检查（只读报告页）：
 * - 提供 Ctrl→Meta 与 Meta→Ctrl 两种只读修饰键映射，供维护者在迁移快捷键前查看风险；
 * - 后端对全部叶子上下文复用最近祖先生效与 duplicate/prefix 判定，按
 *   「参与命令身份 + 冲突类型」比较映射前后，只报告迁移新增的冲突；
 * - 本页不修改任何命令，也不持久化任何数据。
 */

const DIRECTIONS = [
  { id: 'ctrl-to-meta', label: 'Ctrl → Meta', desc: '迁往 macOS（⌘）' },
  { id: 'meta-to-ctrl', label: 'Meta → Ctrl', desc: '迁回 Windows / Linux' },
];

const TYPE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'duplicate', label: '同层重复' },
  { id: 'prefix', label: '前缀冲突' },
];

const CONFLICT_META = {
  duplicate: { label: '同层重复', icon: '⛔' },
  prefix: { label: '前缀冲突', icon: '🔀' },
};

function StatCard({ value, label, tone = '' }) {
  return (
    <div className={`stat-card ${tone}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** 单条迁移新增冲突：冲突双方（原序列 → 迁移序列）+ 受影响叶子列表 */
function MigrationConflictCard({ conflict }) {
  const meta = CONFLICT_META[conflict.type] || { label: conflict.type, icon: '⚠' };
  const isPrefix = conflict.type === 'prefix';
  return (
    <div className={`conflict-card ${conflict.type}`}>
      <div className="conflict-head">
        <strong>
          {meta.icon} {meta.label}
          <span className="badge duplicate">迁移新增</span>
        </strong>
        {isPrefix ? (
          <span className="conflict-seqs" title="迁移后的冲突序列">
            <kbd>{conflict.prefixSequenceLabel}</kbd>
            <em className="dim"> ⊂ </em>
            <kbd>{conflict.extensionSequenceLabel}</kbd>
          </span>
        ) : (
          <span className="conflict-seqs" title="迁移后的冲突序列">
            <kbd>{conflict.sequenceLabel}</kbd>
          </span>
        )}
      </div>
      <ul className="conflict-parties">
        {conflict.parties.map((p) => (
          <li key={p.commandId}>
            <span className={`role-tag ${p.role || ''}`}>
              {isPrefix ? (p.role === 'prefix' ? '前缀方' : '延伸方') : '重复方'}
            </span>
            <span className="party-name">{p.name}</span>
            <span className="party-source" title="命令定义位置（上下文路径）">
              来源：{p.contextPath}
            </span>
            <span className="party-map" title="原序列 → 迁移序列">
              <kbd>{p.fromLabel}</kbd>
              <em className="map-arrow">→</em>
              <kbd className={p.remapped ? 'seq-mapped' : ''}>{p.toLabel}</kbd>
              {!p.remapped && <span className="dim small">（未变化）</span>}
            </span>
          </li>
        ))}
      </ul>
      <div className="migration-leaves">
        <span className="migration-leaves-label">受影响叶子（{conflict.leaves.length}）：</span>
        {conflict.leaves.map((l) => (
          <span key={l.contextId} className="leaf-chip" title={l.contextPath}>
            {l.contextPath}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function MigrationCheck() {
  const [direction, setDirection] = useState('ctrl-to-meta');
  const [typeFilter, setTypeFilter] = useState('all');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showJson, setShowJson] = useState(false);

  const load = useCallback(async (dir) => {
    setLoading(true);
    try {
      setData(await api.migrationCheck(dir));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(direction);
  }, [direction, load]);

  const downloadJson = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `migration-check-${data.direction}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const filtered = (data?.conflicts || []).filter(
    (c) => typeFilter === 'all' || c.type === typeFilter,
  );
  const dirMeta = DIRECTIONS.find((d) => d.id === direction);

  return (
    <div className="regression-page">
      <div className="regression-toolbar">
        <div className="regression-title">
          <h2>🧭 跨平台迁移检查</h2>
          <span className="dim small">
            只读检查：逐按键转换修饰键（主键与其他修饰键保持原值，重复修饰键合并并规范化），
            对全部叶子上下文比较映射前后的生效冲突，只报告迁移新增的冲突 · 数据时间：
            {data ? new Date(data.generatedAt).toLocaleString() : '-'}
          </span>
        </div>
        <div className="regression-actions">
          <button onClick={() => load(direction)} title="按当前数据重新检查">
            重新检查
          </button>
          <button className="primary" onClick={downloadJson} disabled={!data}>
            下载 JSON
          </button>
        </div>
      </div>

      <div className="migration-direction" role="group" aria-label="迁移方向">
        {DIRECTIONS.map((d) => (
          <button
            key={d.id}
            className={`direction-option ${direction === d.id ? 'active' : ''}`}
            onClick={() => setDirection(d.id)}
          >
            <span className="direction-label">{d.label}</span>
            <span className="direction-desc">{d.desc}</span>
          </button>
        ))}
      </div>

      {error && <p className="error">⚠ {error}</p>}
      {loading && <div className="loading">迁移检查计算中…</div>}

      {!loading && data && (
        <>
          <div className="stat-grid">
            <StatCard value={data.stats.leafCount} label="叶子上下文（逐一判定）" />
            <StatCard value={data.stats.mappedCommandCount} label={`被映射命令（${dirMeta?.label || ''}）`} />
            <StatCard
              value={data.stats.newConflictCount}
              label="迁移新增冲突"
              tone={data.stats.newConflictCount > 0 ? 'danger' : 'ok'}
            />
            <StatCard
              value={data.stats.newDuplicateCount}
              label="其中同层重复"
              tone={data.stats.newDuplicateCount > 0 ? 'warn' : ''}
            />
            <StatCard
              value={data.stats.newPrefixCount}
              label="其中前缀冲突"
              tone={data.stats.newPrefixCount > 0 ? 'warn' : ''}
            />
            <StatCard
              value={data.stats.affectedLeafCount}
              label="受影响叶子"
              tone={data.stats.affectedLeafCount > 0 ? 'danger' : ''}
            />
          </div>

          <div className="migration-filter">
            <span className="dim small">按冲突类型筛选：</span>
            {TYPE_FILTERS.map((f) => {
              const count =
                f.id === 'all'
                  ? data.conflicts.length
                  : data.conflicts.filter((c) => c.type === f.id).length;
              return (
                <button
                  key={f.id}
                  className={`filter-btn ${typeFilter === f.id ? 'active' : ''}`}
                  onClick={() => setTypeFilter(f.id)}
                >
                  {f.label}（{count}）
                </button>
              );
            })}
          </div>

          {data.conflicts.length === 0 ? (
            <div className="migration-empty">
              ✅ 按 {dirMeta?.label} 映射后，全部 {data.stats.leafCount} 个叶子上下文均未出现新增的
              同层重复或前缀冲突，可以安全迁移。
            </div>
          ) : (
            <div className="suite-cases">
              <h3>
                迁移新增冲突（{filtered.length}）
                <span className="dim small">
                  {' '}
                  同一冲突跨叶子出现时已合并，受影响叶子列于卡片底部；映射前已存在的冲突不在报告中
                </span>
              </h3>
              {filtered.length === 0 && (
                <p className="hint">当前筛选类型下没有迁移新增冲突。</p>
              )}
              {filtered.map((c) => (
                <MigrationConflictCard key={c.goalId} conflict={c} />
              ))}
            </div>
          )}

          <details className="json-details">
            <summary>映射影响范围：{data.mappedCommands.length} 条命令的序列将被改写（只读预览，不落盘）</summary>
            <table className="bind-table">
              <thead>
                <tr>
                  <th>命令</th>
                  <th>定义位置</th>
                  <th>原序列</th>
                  <th>迁移序列</th>
                </tr>
              </thead>
              <tbody>
                {data.mappedCommands.map((m) => (
                  <tr key={m.commandId}>
                    <td>{m.name}</td>
                    <td className="source">{m.contextPath}</td>
                    <td>
                      <kbd className="seq dim">{m.fromLabel}</kbd>
                    </td>
                    <td>
                      <kbd className="seq">{m.toLabel}</kbd>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <details className="json-details" onToggle={(e) => setShowJson(e.target.open)}>
            <summary>查看完整 JSON（与 GET /api/migration-check 返回内容一致）</summary>
            {showJson && <pre className="json-pre">{JSON.stringify(data, null, 2)}</pre>}
          </details>
        </>
      )}
    </div>
  );
}
