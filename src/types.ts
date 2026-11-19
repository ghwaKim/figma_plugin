export type RuleId = 'no-autolayout' | 'hardcoded-color' | 'detached-instance' | 'default-name';
export type Scope = 'selection' | 'page' | 'document';
export type FixKind = 'bind-color' | 'rename' | 'replace-detached';

export interface ScanOptions {
  scope: Scope;
  includeHidden: boolean;
  includeShapes: boolean;
}

/** 원클릭 수정 정보. suggestion은 이름 변경 시 미리 채워 둘 추천 이름 */
export interface FixInfo {
  kind: FixKind;
  label: string;
  suggestion?: string;
}

export interface Issue {
  id: string;
  /** 예외(무시) 처리에 쓰는 키. 일반 노드는 node.id, 인스턴스 내부는 원본 노드 id */
  key: string;
  name: string;
  nodeType: string;
  rule: RuleId;
  detail: string;
  page: string;
  path: string;
  ignored: boolean;
  fix?: FixInfo;
}

export type UiMessage =
  | ({ type: 'scan' } & ScanOptions)
  | { type: 'select'; id: string }
  | { type: 'notify'; message: string }
  | { type: 'fix'; uid: number; id: string; kind: FixKind; value?: string }
  | { type: 'fix-all-colors'; items: { uid: number; id: string }[] }
  | { type: 'ignore'; key: string; rule: RuleId; ignored: boolean };
