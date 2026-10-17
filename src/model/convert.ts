// 源码事实 + 决定 → Chen 模型。规则全部确定、可复现；每一列都要在清单里落到且只落到一处。
//
// 规则（照教材和示例图）：
// - 外键列不画成属性，变成关系：被引用表一侧 1，引用表一侧 N；外键列唯一（或就是主键）时 1:1。
// - 只连两张表、自身列很少、又没有别的表引用它的表，是 M:N 关系（菱形），剩下的列挂在菱形上。
// - 没声明外键时按列名推断（user_id → user），推断结果标出来等确认。
// - 复合主键里含外键、另有自己的列 → 弱实体（双矩形）+ 标识关系（双菱形），其余主键列是部分键。
// - 中文名取注释；没有注释用列名/表名，并标“待命名”。

import type { FactSet, FkFact, Issue, TableFact } from '../facts/types.js';
import { lower } from '../facts/types.js';
import type { Attribute, ConvertResult, Decisions, Entity, LabelFrom, Ledger, Pending, RelEnd, Relationship } from './types.js';

const CJK = /[㐀-鿿]/;

interface LinkGroup {
  cols: string[];
  target: string; // 目标表真实名字
  origin: 'fk' | 'fk-inferred' | 'decision';
  fk?: FkFact;
  note?: string;
}

const TABLE_PREFIXES = ['t_', 'tb_', 'tbl_', 'sys_', 'app_', 'biz_', 'bus_', 'm_', 's_'];
const ROLE_WORDS = ['creator', 'create_by', 'created_by', 'update_by', 'updated_by', 'author', 'owner', 'publisher', 'operator', 'uploader', 'sender', 'receiver', 'reviewer', 'auditor', 'approver', 'modifier', 'handler'];
const NOT_ID_TYPES = /date|time|text|bool|blob|json|float|double|decimal|numeric|real|money|bit/i;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function singular(s: string): string {
  if (/ies$/.test(s)) return s.replace(/ies$/, 'y');
  if (/(ses|xes|zes|ches|shes)$/.test(s)) return s.replace(/es$/, '');
  if (/s$/.test(s) && !/ss$/.test(s)) return s.replace(/s$/, '');
  return s;
}

function commonPrefix(names: string[]): string | null {
  // 多数表共用的前缀（如 music_），按下划线截
  const counts = new Map<string, number>();
  for (const n of names) {
    const m = /^([a-z0-9]+_)/i.exec(n);
    if (m) counts.set(m[1].toLowerCase(), (counts.get(m[1].toLowerCase()) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [p, c] of counts) if (c >= Math.max(3, names.length * 0.6) && (!best || c > counts.get(best)!)) best = p;
  return best;
}

function tableVariants(name: string, prefix: string | null): string[] {
  const l = name.toLowerCase();
  const out = new Set<string>([l]);
  for (const p of [...TABLE_PREFIXES, ...(prefix ? [prefix] : [])]) if (l.startsWith(p) && l.length > p.length + 1) out.add(l.slice(p.length));
  for (const v of [...out]) out.add(singular(v));
  return [...out].map(norm).filter((x) => x.length >= 2);
}

function fkBase(col: string): string | null {
  const m = /^(.*[A-Za-z0-9])_?(?:id|Id|ID)$/.exec(col);
  if (!m) return null;
  const base = m[1].replace(/_$/, '');
  return base.length >= 2 ? base : null;
}

/** 列名推断外键目标。精确匹配优先，其次“角色_表名”这种后缀匹配。 */
function inferTarget(t: TableFact, colName: string, all: TableFact[], prefix: string | null): { target?: string; ambiguous?: string[]; suspicious?: boolean } {
  const base = fkBase(colName);
  if (!base) return {};
  const nb = norm(base);
  const nbs = norm(singular(base.toLowerCase()));
  if (nb === 'parent' || nb === 'p' || nb === 'pid' || nb === 'super' || nb === 'superior') return { target: t.name };
  const exact: string[] = [];
  const suffix: string[] = [];
  for (const u of all) {
    const vs = tableVariants(u.name, prefix);
    if (vs.some((v) => v === nb || v === nbs)) exact.push(u.name);
    else if (vs.some((v) => v.length >= 3 && (nb.endsWith(v) || nbs.endsWith(v)) && nb.length > v.length)) suffix.push(u.name);
  }
  const pick = exact.length ? exact : suffix;
  if (pick.length === 1) return { target: pick[0] }; // 可能是自己（自引用，如 category.parent_category_id）
  if (pick.length > 1) return { ambiguous: pick };
  return { suspicious: true };
}

/**
 * 注释 → 字段名。注释常把取值说明写在后面：“状态：0禁用 1启用”“性别 0女 1男”“是否过期Y已过期N未过期”“父分类ID=0时代表一级”，
 * 只取说明前面的名字。整条注释本身就是取值说明（“1-成功 2-失败”）时返回空，调用方退回用列名。
 */
function cutLabel(s: string): string {
  let x = s.trim().replace(/\s+/g, ' ');
  const m = /^(.+?)[\n，,；;。（(：:【\[=＝|｜]/.exec(x);
  if (m && m[1].trim()) x = m[1].trim();
  if (CJK.test(x)) {
    const sp = /^(\S+)\s/.exec(x);
    if (sp && CJK.test(sp[1])) x = sp[1];
  }
  // 名字后面紧跟单个字母/数字再跟汉字，是取值枚举：是否过期Y已过期 → 是否过期，状态1正常 → 状态
  const en = /^([\u3400-\u9fff]{2,}?)(?:[0-9]+|[A-Za-z])[-、.．]?[\u3400-\u9fff]/.exec(x);
  if (en) x = en[1];
  x = x.replace(/[。.]$/, '').trim();
  // 以数字开头的是取值说明本身（1库存已锁定、1-成功）
  if (/^[0-9]+\s*[-、.．:：]?\s*[\u3400-\u9fff]/.test(x)) return '';
  return x;
}

const GENERIC_PK = /^(主键|主键id|主键ID|id|ID|自增主键|主键自增|自增id|自增ID|唯一标识|主键编号|编号id)$/;

function tableLabel(t: TableFact): { label: string; from: LabelFrom } {
  if (t.comment && t.comment.trim()) {
    let x = cutLabel(t.comment);
    if (x.length > 1) x = x.replace(/(信息)?表$/, (m, g) => (g ? '信息' : ''));
    if (x) return { label: x, from: t.commentFrom === 'docstring' ? 'docstring' : 'comment' };
  }
  return { label: t.name, from: 'name' };
}

function columnLabel(c: TableFact['columns'][number]): { label: string; from: LabelFrom } {
  if (c.comment && c.comment.trim()) {
    const x = cutLabel(c.comment);
    if (c.pk && GENERIC_PK.test(x)) return { label: c.name, from: 'name' };
    if (x) return { label: x, from: c.commentFrom === 'line-comment' ? 'line-comment' : c.commentFrom === 'docstring' ? 'docstring' : 'comment' };
  }
  return { label: c.name, from: 'name' };
}

function stripAll(s: string, parts: string[]): string {
  let x = s;
  for (const p of parts.filter(Boolean).sort((a, b) => b.length - a.length)) x = x.split(p).join('');
  return x.trim();
}

function joinRelLabel(t: TableFact, endLabels: string[], endTables: string[]): { label: string; from: LabelFrom } {
  if (t.comment && t.comment.trim()) {
    let x = cutLabel(t.comment).replace(/表$/, '').replace(/(记录|信息|历史|明细|关系)$/, '');
    const y = stripAll(x, endLabels);
    if (y) return { label: y, from: 'derived' };
    if (/关联$/.test(x)) return { label: '关联', from: 'derived' };
    x = '';
  }
  const parts = t.name.toLowerCase().split(/[_\s]+/).filter((p) => !endTables.some((e) => norm(e) === norm(p) || norm(singular(e)) === norm(p)) && !TABLE_PREFIXES.includes(p + '_'));
  const rest = parts.join('_');
  if (rest && !/^(rel|relation|link|map|mapping|ref|assoc|r)$/.test(rest)) return { label: rest, from: 'name' };
  return { label: '关联', from: 'default' };
}

// 外键列注释里能当关系动词的角色词。注释通常写的是对方表的名字（名词，如“订单id”），那种不能当动词。
const ROLE_VERBS = ['所属', '上级', '父级', '归属', '隶属', '创建', '发布', '评论', '回复', '审核', '购买', '收货', '关注', '推荐', '负责', '管理', '指导', '授课', '选择', '提交', '上传', '发送', '接收', '操作', '修改', '处理', '下单', '支付', '收藏', '点赞', '举报', '分配', '邀请', '申请', '审批'];

/** “发布人”“创建者”这种：前半是已知动作词，整体指做这件事的人。“作者”“读者”不是。 */
function rolePerson(x: string): string | undefined {
  const m = /^([\u3400-\u9fff]{2,3})(人|者)$/.exec(x);
  return m && ROLE_VERBS.includes(m[1]) ? m[1] : undefined;
}

function stripId(s: string): string {
  return s.replace(/\s*(ID|Id|id|编号|外键|号|主键)$/, '').trim();
}

function fkRelLabel(t: TableFact, cols: string[], targetLabel: string): { label: string; from: LabelFrom } {
  const c = t.columns.find((x) => lower(x.name) === lower(cols[0]));
  if (c?.comment) {
    const x = stripAll(stripId(cutLabel(c.comment)), [targetLabel]);
    const verb = ROLE_VERBS.find((v) => x === v || x.startsWith(v));
    if (verb && x.length <= verb.length + 1) return { label: verb, from: 'derived' };
    const person = rolePerson(x);
    if (person) return { label: person, from: 'derived' };
  }
  return { label: '拥有', from: 'default' };
}

/** 表没有注释时，看引用它的外键列注释：“订单id”“所属分类ID” → 订单、分类。取出现最多的。 */
function nameFromReferences(target: string, groups: Map<TableFact, LinkGroup[]>): string | undefined {
  const votes = new Map<string, number>();
  for (const [t, gs] of groups) {
    for (const g of gs) {
      if (lower(g.target) !== lower(target) || g.cols.length !== 1) continue;
      const c = t.columns.find((x) => lower(x.name) === lower(g.cols[0]));
      if (!c?.comment) continue;
      let x = stripId(cutLabel(c.comment));
      if (x.includes('的')) x = x.slice(x.lastIndexOf('的') + 1); // 此群的用户 → 用户
      for (const v of ROLE_VERBS) if (x.startsWith(v) && x.length > v.length + 1) x = x.slice(v.length);
      if (x.length < 2 || x.length > 8 || !CJK.test(x) || rolePerson(x)) continue; // “发布人”不能拿来给用户表起名
      votes.set(x, (votes.get(x) ?? 0) + 1);
    }
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return best?.[0];
}

const CARD_LETTERS = ['N', 'M', 'P', 'Q', 'R'];

export function convert(facts: FactSet, d: Decisions): ConvertResult {
  const issues: Issue[] = [];
  const pending: Pending[] = [];
  const ledger: Ledger = { tables: [], columns: [] };
  const active = facts.tables.filter((t) => !(t.name in d.exclusions) && !(lower(t.name) in lowerKeys(d.exclusions)));
  const excludedTables = facts.tables.filter((t) => !active.includes(t));
  const byLower = new Map(active.map((t) => [lower(t.name), t] as const));
  const allByLower = new Map(facts.tables.map((t) => [lower(t.name), t] as const));
  const prefix = commonPrefix(active.map((t) => t.name));
  const unlinks = new Set(d.unlinks.map(lower));
  const exclCols = lowerKeys(d.exclusions);

  for (const t of excludedTables) {
    const reason = d.exclusions[t.name] ?? exclCols[lower(t.name)] ?? '';
    ledger.tables.push({ table: t.name, role: 'excluded', target: '', reason: `已排除：${reason}`, ref: t.ref });
    for (const c of t.columns) ledger.columns.push({ id: `${t.name}.${c.name}`, table: t.name, column: c.name, fate: 'excluded', target: reason, note: '整张表被排除', ref: c.ref });
  }

  // 1. 每张表的外键分组
  const groups = new Map<TableFact, LinkGroup[]>();
  for (const t of active) {
    const gs: LinkGroup[] = [];
    const taken = new Set<string>();
    const colId = (c: string) => lower(`${t.name}.${c}`);
    const isExcludedCol = (c: string) => colId(c) in exclCols;
    // 决定优先
    for (const c of t.columns) {
      const dl = d.links[`${t.name}.${c.name}`] ?? lowerKeys(d.links)[colId(c.name)];
      if (!dl || isExcludedCol(c.name)) continue;
      const tg = byLower.get(lower(dl.table));
      if (!tg) {
        issues.push({ level: 'error', code: 'decision.link.missing', message: `决定把 ${t.name}.${c.name} 连到 ${dl.table}，但这张表不存在或已排除`, ids: [`${t.name}.${c.name}`] });
        continue;
      }
      gs.push({ cols: [c.name], target: tg.name, origin: 'decision' });
      taken.add(lower(c.name));
    }
    for (const fk of t.foreignKeys) {
      const cols = fk.columns.filter((c) => !taken.has(lower(c)) && !unlinks.has(colId(c)) && !isExcludedCol(c));
      if (cols.length !== fk.columns.length) continue;
      const tg = byLower.get(lower(fk.refTable));
      if (!tg) {
        const why = allByLower.has(lower(fk.refTable)) ? '已被排除' : '不存在';
        issues.push({ level: 'warning', code: 'fk.target.missing', message: `${t.name}.${cols.join(',')} 的外键指向表 ${fk.refTable}，但它${why}；这些列按普通属性画`, ref: fk.ref, ids: cols.map((c) => `${t.name}.${c}`) });
        continue;
      }
      gs.push({ cols: fk.columns.map((c) => t.columns.find((x) => lower(x.name) === lower(c))?.name ?? c), target: tg.name, origin: 'fk', fk });
      for (const c of fk.columns) taken.add(lower(c));
    }
    const singlePk = t.primaryKey.length === 1 ? lower(t.primaryKey[0]) : null;
    for (const c of t.columns) {
      if (taken.has(lower(c.name)) || unlinks.has(colId(c.name)) || isExcludedCol(c.name)) continue;
      if (singlePk === lower(c.name)) continue;
      if (c.type && NOT_ID_TYPES.test(c.type)) continue;
      const r = inferTarget(t, c.name, active, prefix);
      if (r.target) {
        gs.push({ cols: [c.name], target: r.target, origin: 'fk-inferred' });
        taken.add(lower(c.name));
        pending.push({ kind: 'fk-inferred', id: `${t.name}.${c.name}`, message: `源码没有声明外键，按列名推断 ${t.name}.${c.name} → ${r.target}`, suggestions: [r.target] });
      } else if (r.ambiguous) {
        pending.push({ kind: 'fk-ambiguous', id: `${t.name}.${c.name}`, message: `${t.name}.${c.name} 像外键，可能指向 ${r.ambiguous.join(' / ')}，暂按普通属性画`, suggestions: r.ambiguous });
      } else if (r.suspicious) {
        const base = norm(fkBase(c.name) ?? '');
        const userLike = ROLE_WORDS.some((w) => norm(w) === base) ? active.filter((u) => /user|member|account|admin|employee|staff|customer/i.test(u.name)).map((u) => u.name) : [];
        pending.push({ kind: 'fk-ambiguous', id: `${t.name}.${c.name}`, message: `${t.name}.${c.name} 像外键，但没找到对应的表，暂按普通属性画`, suggestions: userLike });
      }
    }
    groups.set(t, gs);
  }

  // 2. 表的角色：实体还是关系
  const incoming = new Map<string, number>();
  for (const [t, gs] of groups) for (const g of gs) if (lower(g.target) !== lower(t.name)) incoming.set(lower(g.target), (incoming.get(lower(g.target)) ?? 0) + 1);
  const role = new Map<TableFact, { role: 'entity' | 'relationship'; reason: string }>();
  for (const t of active) {
    const gs = groups.get(t)!;
    const dr = d.tableRoles[t.name] ?? lowerKeys(d.tableRoles)[lower(t.name)];
    const linked = new Set(gs.flatMap((g) => g.cols.map(lower)));
    const pk = new Set(t.primaryKey.map(lower));
    const own = t.columns.filter((c) => !linked.has(lower(c.name)) && !pk.has(lower(c.name)) && !(`${t.name}.${c.name}` in d.exclusions));
    const inc = incoming.get(lower(t.name)) ?? 0;
    if (dr) {
      if (dr === 'relationship' && gs.length < 2) {
        issues.push({ level: 'error', code: 'decision.role.invalid', message: `决定把表 ${t.name} 当关系，但它只连了 ${gs.length} 张表（至少要 2 张）`, ids: [t.name] });
        role.set(t, { role: 'entity', reason: '决定无效，仍按实体' });
      } else role.set(t, { role: dr, reason: '按决定' });
      continue;
    }
    // 有指向自己的外键（如回复的 parent_id）：它自己就是被连的一端，只能是实体
    const hasSelf = gs.some((g) => lower(g.target) === lower(t.name));
    if (gs.length >= 2 && !hasSelf) {
      const ends = gs.map((g) => g.target);
      const assocName =
        /(_rel|_relation|_link|_map|_mapping|_ref|_assoc|_r)$/i.test(t.name) ||
        /关联|关系|中间表/.test(t.comment ?? '') ||
        ends.every((e) => tableVariants(e, prefix).some((v) => norm(t.name).includes(v)));
      // 关联表的特征：主键就是这几个外键；或表名由所连的表拼成 / 带 _rel、_map；自身列只是时间、排序、进度这类关系属性。
      // 有名称、标题、姓名这种“标识自己”的列，说明它是实体（如 book 有 title）。
      const pkIsLinks = t.primaryKey.length >= 2 && t.primaryKey.every((c) => linked.has(lower(c)));
      const naming = own.find((c) => /(^|_)(name|title|nickname|username|label|subject|full_?name)$/i.test(c.name) || /名称|名字|姓名|标题|题目/.test(c.comment ?? ''));
      const isRel = inc === 0 && (pkIsLinks || assocName || (gs.length === 2 && own.length <= 3 && !naming));
      const why = pkIsLinks ? '主键就是这几个外键' : assocName ? '表名像关联表' : `自身列只有 ${own.length} 个、没有名称类的列`;
      const reason = isRel
        ? `连了 ${gs.length} 张表，${why}，没有别的表引用它 → M:N 关系`
        : `连了 ${gs.length} 张表，但${inc > 0 ? `被 ${inc} 处引用` : naming ? `有名称类的列 ${naming.name}` : `自身列有 ${own.length} 个`} → 实体`;
      role.set(t, { role: isRel ? 'relationship' : 'entity', reason });
      pending.push({ kind: 'role-heuristic', id: t.name, message: `表 ${t.name}：${reason}；要改用 set_table_role`, suggestions: [isRel ? 'entity' : 'relationship'] });
    } else role.set(t, { role: 'entity', reason: hasSelf ? '有指向自己的外键 → 实体' : gs.length ? `只连了 1 张表 → 实体` : '没有外键 → 实体' });
  }

  // 3. 实体
  const entities: Entity[] = [];
  const entityOf = new Map<string, Entity>();
  // 推关系名时用实体的原始名（注释/推导出来的），不用用户改过的名：改一个名字不该牵连别的名字
  const baseLabel = new Map<string, string>();
  const attrFrom = (t: TableFact, c: TableFact['columns'][number], key: boolean): Attribute => {
    const id = `${t.name}.${c.name}`;
    const lab = columnLabel(c);
    const f = d.flags[id] ?? {};
    const a: Attribute = {
      id,
      label: d.labels[id] ?? lab.label,
      labelFrom: d.labels[id] ? 'decision' : lab.from,
      column: c.name,
      key: f.key ?? key,
      partialKey: f.partialKey ?? false,
      multivalued: f.multivalued ?? false,
      derived: f.derived ?? !!c.generated,
      ref: c.ref,
    };
    return a;
  };

  for (const t of active) {
    if (role.get(t)!.role !== 'entity') continue;
    const gs = groups.get(t)!;
    const linked = new Set(gs.flatMap((g) => g.cols.map(lower)));
    let lab = tableLabel(t);
    if (lab.from === 'name') {
      const ref = nameFromReferences(t.name, groups);
      if (ref) lab = { label: ref, from: 'derived' };
    }
    baseLabel.set(t.name, lab.label);
    const e: Entity = {
      id: t.name,
      label: d.labels[t.name] ?? lab.label,
      labelFrom: d.labels[t.name] ? 'decision' : lab.from,
      table: t.name,
      weak: false,
      attributes: [],
      ref: t.ref,
    };
    const pk = new Set(t.primaryKey.map(lower));
    // 弱实体：复合主键里含外键，另有自己的主键列
    const pkLinked = gs.filter((g) => g.cols.every((c) => pk.has(lower(c))) && lower(g.target) !== lower(t.name));
    const pkOwn = t.primaryKey.filter((c) => !linked.has(lower(c)));
    const weak = t.primaryKey.length >= 2 && pkLinked.length >= 1 && pkOwn.length >= 1;
    e.weak = d.flags[t.name]?.weak ?? weak;
    for (const c of t.columns) {
      const id = `${t.name}.${c.name}`;
      if (id in d.exclusions || lower(id) in exclCols) {
        ledger.columns.push({ id, table: t.name, column: c.name, fate: 'excluded', target: d.exclusions[id] ?? exclCols[lower(id)], ref: c.ref });
        continue;
      }
      if (linked.has(lower(c.name))) continue; // 在关系里记
      const a = attrFrom(t, c, pk.has(lower(c.name)) && !(e.weak && weak));
      if (e.weak && weak && pk.has(lower(c.name))) a.partialKey = d.flags[id]?.partialKey ?? true;
      e.attributes.push(a);
      ledger.columns.push({ id, table: t.name, column: c.name, fate: 'attribute', target: a.id, ref: c.ref });
    }
    // 主键排前面（图上靠前），其余按建表顺序
    e.attributes.sort((a, b) => Number(b.key || b.partialKey) - Number(a.key || a.partialKey));
    entities.push(e);
    entityOf.set(lower(t.name), e);
    ledger.tables.push({ table: t.name, role: 'entity', target: e.id, reason: role.get(t)!.reason, ref: t.ref });
    if (!e.attributes.some((a) => a.key || a.partialKey)) pending.push({ kind: 'no-key', id: e.id, message: `实体 ${e.label}（${t.name}）没有主键属性` });
  }

  // 4. 关系
  const relationships: Relationship[] = [];
  const cardOf = (relId: string, i: number, auto: string) => d.cards[`${relId}#${i}`] ?? auto;
  for (const t of active) {
    const r = role.get(t)!;
    const gs = groups.get(t)!;
    if (r.role === 'entity') {
      const e = entityOf.get(lower(t.name))!;
      const pk = new Set(t.primaryKey.map(lower));
      for (const g of gs) {
        const id = `fk:${t.name}.${g.cols.join('+')}`;
        const target = entityOf.get(lower(g.target));
        if (!target) {
          // 只会因为决定把被引用的表改成了关系
          issues.push({ level: 'error', code: 'fk.target.not-entity', message: `${t.name}.${g.cols.join(',')} 指向的 ${g.target} 被设成了关系，这条外键画不出来；请把 ${g.target} 改回实体`, ids: [t.name, g.target] });
          continue;
        }
        const colsSet = new Set(g.cols.map(lower));
        const isUnique =
          (t.primaryKey.length === g.cols.length && g.cols.every((c) => pk.has(lower(c)))) ||
          t.uniques.some((u) => u.length === g.cols.length && u.every((c) => colsSet.has(lower(c)))) ||
          (g.cols.length === 1 && !!t.columns.find((c) => lower(c.name) === lower(g.cols[0]))?.unique);
        const lab = fkRelLabel(t, g.cols, baseLabel.get(target.id) ?? target.label);
        const f = d.flags[id] ?? {};
        const identifying = e.weak && g.cols.every((c) => pk.has(lower(c))) && lower(g.target) !== lower(t.name);
        const rel: Relationship = {
          id,
          label: d.labels[id] ?? lab.label,
          labelFrom: d.labels[id] ? 'decision' : lab.from,
          ends: [
            { entity: target.id, card: cardOf(id, 0, '1') },
            { entity: e.id, card: cardOf(id, 1, isUnique ? '1' : 'N'), column: g.cols.join('+') },
          ],
          attributes: [],
          identifying: f.identifying ?? identifying,
          dashed: f.dashed ?? false,
          origin: g.origin === 'fk' ? 'fk' : 'fk-inferred',
          ref: g.fk?.ref ?? t.columns.find((c) => lower(c.name) === lower(g.cols[0]))?.ref,
        };
        relationships.push(rel);
        for (const c of g.cols) {
          const col = t.columns.find((x) => lower(x.name) === lower(c));
          ledger.columns.push({ id: `${t.name}.${col?.name ?? c}`, table: t.name, column: col?.name ?? c, fate: 'relationship', target: id, note: g.origin === 'fk' ? `外键 → ${g.target}` : g.origin === 'decision' ? `按决定 → ${g.target}` : `推断 → ${g.target}`, ref: col?.ref });
        }
        if (rel.labelFrom === 'default') pending.push({ kind: 'label-default', id, message: `关系 ${target.label}—${e.label} 用的是默认名“${rel.label}”，请起一个动词` });
      }
    } else {
      const id = `rel:${t.name}`;
      const linked = new Set(gs.flatMap((g) => g.cols.map(lower)));
      const ends: RelEnd[] = [];
      const uniqueSingle = gs.map((g) => t.uniques.some((u) => u.length === g.cols.length && u.every((c) => g.cols.map(lower).includes(lower(c)))) || (g.cols.length === 1 && !!t.columns.find((c) => lower(c.name) === lower(g.cols[0]))?.unique));
      gs.forEach((g, i) => {
        const auto = uniqueSingle.some(Boolean) && gs.length === 2 ? (uniqueSingle[i] ? 'N' : '1') : CARD_LETTERS[i] ?? 'N';
        ends.push({ entity: entityOf.get(lower(g.target))?.id ?? g.target, card: cardOf(id, i, auto), column: g.cols.join('+') });
      });
      const missing = ends.filter((x) => !entityOf.has(lower(x.entity)));
      if (missing.length) {
        issues.push({ level: 'error', code: 'rel.end.not-entity', message: `关系表 ${t.name} 连到的 ${missing.map((m) => m.entity).join('、')} 不是实体（自己也被判成了关系），请用 set_table_role 把其中一个改成实体`, ids: [t.name] });
      }
      const endLabels = ends.map((x) => baseLabel.get(entityOf.get(lower(x.entity))?.id ?? '') ?? x.entity);
      const lab = joinRelLabel(t, endLabels, ends.map((x) => x.entity));
      const pk = new Set(t.primaryKey.map(lower));
      const rel: Relationship = {
        id,
        label: d.labels[id] ?? lab.label,
        labelFrom: d.labels[id] ? 'decision' : lab.from,
        ends,
        attributes: [],
        identifying: d.flags[id]?.identifying ?? false,
        dashed: d.flags[id]?.dashed ?? false,
        origin: 'join-table',
        table: t.name,
        ref: t.ref,
      };
      for (const c of t.columns) {
        const cid = `${t.name}.${c.name}`;
        if (cid in d.exclusions || lower(cid) in exclCols) {
          ledger.columns.push({ id: cid, table: t.name, column: c.name, fate: 'excluded', target: d.exclusions[cid] ?? exclCols[lower(cid)], ref: c.ref });
          continue;
        }
        if (linked.has(lower(c.name))) {
          const g = gs.find((x) => x.cols.map(lower).includes(lower(c.name)))!;
          ledger.columns.push({ id: cid, table: t.name, column: c.name, fate: 'relationship', target: id, note: g.origin === 'fk' ? `外键 → ${g.target}` : `推断 → ${g.target}`, ref: c.ref });
          continue;
        }
        const a = attrFrom(t, c, pk.has(lower(c.name)));
        rel.attributes.push(a);
        ledger.columns.push({ id: cid, table: t.name, column: c.name, fate: 'attribute', target: a.id, ref: c.ref });
      }
      rel.attributes.sort((a, b) => Number(b.key) - Number(a.key));
      relationships.push(rel);
      ledger.tables.push({ table: t.name, role: 'relationship', target: id, reason: r.reason, ref: t.ref });
      if (rel.labelFrom === 'default') pending.push({ kind: 'label-default', id, message: `关系表 ${t.name} 用的是默认名“${rel.label}”，请起一个动词` });
    }
  }

  // 5. 手工/agent 加的关系
  for (const x of d.extraRelationships) {
    const bad = x.ends.filter((e) => !entities.some((en) => en.id === e.entity));
    if (bad.length) {
      issues.push({ level: 'error', code: 'rel.extra.end-missing', message: `加上的关系 ${x.label}（${x.id}）连到不存在的实体：${bad.map((b) => b.entity).join('、')}`, ids: [x.id] });
      continue;
    }
    const f = d.flags[x.id] ?? {};
    relationships.push({
      id: x.id,
      label: d.labels[x.id] ?? x.label,
      labelFrom: 'decision',
      ends: x.ends.map((e, i) => ({ entity: e.entity, card: cardOf(x.id, i, e.card) })),
      attributes: (x.attributes ?? []).map((a, i) => {
        const aid = `${x.id}.${i + 1}`;
        return { id: aid, label: d.labels[aid] ?? a.label, labelFrom: 'decision' as const, key: d.flags[aid]?.key ?? !!a.key, partialKey: false, multivalued: d.flags[aid]?.multivalued ?? false, derived: d.flags[aid]?.derived ?? false };
      }),
      identifying: f.identifying ?? !!x.identifying,
      dashed: f.dashed ?? !!x.dashed,
      origin: 'added',
      evidence: x.evidence,
      assertedBy: x.assertedBy,
    });
  }

  // 6. 待命名
  const flagName = (id: string, label: string, from: LabelFrom, what: string) => {
    if (from === 'name' && !CJK.test(label)) pending.push({ kind: 'label-untranslated', id, message: `${what} ${label} 没有能当名字的注释，用的是原名，请起中文名` });
  };
  for (const e of entities) {
    flagName(e.id, e.label, e.labelFrom, '实体');
    for (const a of e.attributes) if (!a.key) flagName(a.id, a.label, a.labelFrom, `属性 ${e.label}.`);
  }
  for (const r of relationships) {
    flagName(r.id, r.label, r.labelFrom, '关系');
    for (const a of r.attributes) if (!a.key) flagName(a.id, a.label, a.labelFrom, `关系属性 ${r.label}.`);
  }

  // 7. 决定里指向不存在对象的条目
  const known = new Set<string>([...entities.map((e) => e.id), ...relationships.map((r) => r.id), ...entities.flatMap((e) => e.attributes.map((a) => a.id)), ...relationships.flatMap((r) => r.attributes.map((a) => a.id))]);
  const knownLower = new Set([...known].map(lower));
  for (const k of Object.keys(d.labels)) if (!knownLower.has(lower(k))) issues.push({ level: 'warning', code: 'decision.stale', message: `改名决定指向的 ${k} 已经不存在（源码变了？）`, ids: [k] });

  return { model: { entities, relationships }, ledger, pending, issues };
}

function lowerKeys<T>(o: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(o)) out[lower(k)] = v;
  return out;
}

export { tableLabel, columnLabel };
