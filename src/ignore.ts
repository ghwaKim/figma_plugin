// 예외(무시) 처리 저장소.
// 문서 루트의 pluginData에 { [노드 키]: RuleId[] } 형태로 저장 → 파일에 남아 팀원 모두에게 적용됨.
// 노드 자체가 아닌 루트에 저장하는 이유: 인스턴스 내부 레이어에는 pluginData를 쓸 수 없는 경우가 있어서.
import type { RuleId } from './types';

const STORAGE_KEY = 'handoff-lint-ignores';

export type IgnoreMap = Record<string, RuleId[]>;

export function loadIgnores(): IgnoreMap {
  try {
    return JSON.parse(figma.root.getPluginData(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function isIgnored(map: IgnoreMap, key: string, rule: RuleId): boolean {
  const rules = map[key];
  return !!rules && rules.indexOf(rule) !== -1;
}

export function setIgnored(key: string, rule: RuleId, ignored: boolean) {
  const map = loadIgnores();
  const rules = new Set(map[key] || []);
  if (ignored) rules.add(rule);
  else rules.delete(rule);
  if (rules.size > 0) map[key] = [...rules];
  else delete map[key];
  figma.root.setPluginData(STORAGE_KEY, JSON.stringify(map));
}
