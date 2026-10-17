// 从源码里读出来的“事实”：表、列、主键、唯一、外键，每一项都带出处（文件 + 行号）。
// 后面的转换只依据这些事实和用户/agent 的决定，不凭空推测结构。

export interface SourceRef {
  file: string; // 相对项目文件所在目录，正斜杠
  line: number; // 从 1 开始
}

export interface ColumnFact {
  name: string;
  type: string;
  comment?: string;
  commentFrom?: 'comment' | 'line-comment' | 'docstring';
  pk: boolean;
  unique: boolean;
  notNull: boolean;
  generated?: boolean; // 计算列 / 生成列 → Chen 的派生属性
  ref?: SourceRef;
}

export interface FkFact {
  columns: string[];
  refTable: string;
  refColumns: string[];
  name?: string;
  ref?: SourceRef;
}

export interface TableFact {
  name: string;
  comment?: string;
  commentFrom?: 'comment' | 'docstring' | 'line-comment';
  columns: ColumnFact[];
  primaryKey: string[];
  uniques: string[][];
  foreignKeys: FkFact[];
  ref: SourceRef;
  origin: 'sql' | 'sqlalchemy';
  className?: string;
}

export type IssueLevel = 'error' | 'warning' | 'info';

export interface Issue {
  level: IssueLevel;
  code: string;
  message: string;
  ref?: SourceRef;
  ids?: string[];
}

export interface SourceFile {
  path: string;
  sha1: string;
  kind: 'sql' | 'python';
  encoding: string;
}

export interface FactSet {
  tables: TableFact[];
  issues: Issue[];
  files: SourceFile[];
  stats?: { sqlTables: number; crossChecked: number; crossUnchecked: string[]; pyTables: number };
}

export function lower(s: string): string {
  return s.toLowerCase();
}
