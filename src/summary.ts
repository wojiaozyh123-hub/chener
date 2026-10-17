// 给人看的中文结果摘要（命令行打印、MCP 返回）。

import type { State } from './project.js';
import type { PendingKind } from './model/types.js';

const KIND_TITLE: Record<PendingKind, string> = {
  'fk-inferred': '按列名推断的外键（源码没声明），请确认',
  'fk-ambiguous': '像外键但没连上',
  'role-heuristic': '按规则判定的表角色（关系表 / 实体）',
  'label-default': '用了默认名的关系',
  'label-untranslated': '没有注释、用原名的',
  'no-key': '没有主键的实体',
};

export function summaryText(st: State, opts: { written?: string[]; limit?: number } = {}): string {
  const L: string[] = [];
  const lim = opts.limit ?? 8;
  const f = st.project.facts;
  const s = f.stats;
  const r = st.report;
  const cross = s && s.sqlTables ? `；SQL 表 ${s.sqlTables} 张，第二解析器核对 ${s.crossChecked} 张${s.crossUnchecked.length ? `（${s.crossUnchecked.length} 张没核对上：${s.crossUnchecked.slice(0, 5).join('、')}）` : ''}` : '';
  L.push(`来源：${f.files.length} 个文件，${f.tables.length} 张表${cross}${s?.pyTables ? `；SQLAlchemy 模型 ${s.pyTables} 张` : ''}`);
  L.push(`图：实体 ${r.stats.entities}，关系 ${r.stats.relationships}，属性 ${r.stats.attributes}`);
  L.push(`列：共 ${r.stats.columns} 列 → 画成属性 ${r.stats.columnsShown}，变成关系 ${r.stats.columnsAsRelationship}，排除 ${r.stats.columnsExcluded}`);
  const geo = r.geometry;
  const byKind = (k: string) => geo.filter((g) => g.kind === k).length;
  L.push(
    r.ok
      ? `核对：通过（交叉 0，重叠 0，线穿节点 0，标签压线 0，漏列 0）`
      : `核对：没通过，${r.errors} 处错误（交叉 ${byKind('crossing')}，重叠 ${byKind('overlap')}，线穿节点 ${byKind('line-through-node')}，标签压线 ${byKind('label-overlap')}，其他 ${r.issues.filter((i) => i.level === 'error').length}）`,
  );
  const errs = [...geo.map((g) => g.message), ...r.issues.filter((i) => i.level === 'error').map((i) => i.message)];
  for (const m of errs.slice(0, lim)) L.push(`  ✗ ${m}`);
  if (errs.length > lim) L.push(`  …… 另有 ${errs.length - lim} 处`);
  const warns = r.issues.filter((i) => i.level === 'warning');
  if (warns.length) {
    L.push(`提醒 ${warns.length} 条：`);
    for (const w of warns.slice(0, lim)) L.push(`  ! ${w.message}`);
    if (warns.length > lim) L.push(`  …… 另有 ${warns.length - lim} 条`);
  }
  const infos = r.issues.filter((i) => i.level === 'info');
  for (const i of infos.slice(0, 4)) L.push(`  · ${i.message}`);
  if (st.pending.length) {
    L.push(`待确认 ${st.pending.length} 项：`);
    const kinds = [...new Set(st.pending.map((p) => p.kind))];
    for (const k of kinds) {
      const items = st.pending.filter((p) => p.kind === k);
      L.push(`  【${KIND_TITLE[k]}】${items.length} 项`);
      for (const p of items.slice(0, lim)) L.push(`    - ${p.message}`);
      if (items.length > lim) L.push(`    …… 另有 ${items.length - lim} 项`);
    }
  }
  if (opts.written?.length) L.push(`已写入：${opts.written.join('  ')}`);
  return L.join('\n');
}
