// 색 토큰(변수) 인덱스: hex 값 → 그 값을 가진 COLOR 변수 목록.
// 로컬 변수만 대상으로 하되, 로컬 변수가 라이브러리 변수를 별칭(alias)으로 참조하면 끝까지 따라가 실제 값을 구함.

export type ColorTarget = 'TEXT_FILL' | 'FRAME_FILL' | 'SHAPE_FILL' | 'STROKE_COLOR';

interface Candidate {
  variable: Variable;
  isAlias: boolean; // 다른 변수를 참조하는 시맨틱 토큰인지 (코드에선 시맨틱 토큰이 더 적합)
}

export type ColorIndex = Map<string, Candidate[]>;

export async function buildColorIndex(): Promise<ColorIndex> {
  const index: ColorIndex = new Map();
  const variables = await figma.variables.getLocalVariablesAsync('COLOR');
  const collections = new Map<string, VariableCollection>();
  for (const c of await figma.variables.getLocalVariableCollectionsAsync()) collections.set(c.id, c);

  for (const variable of variables) {
    const collection = collections.get(variable.variableCollectionId);
    if (!collection) continue;
    const raw = variable.valuesByMode[collection.defaultModeId];
    const rgba = await resolveColor(raw, collections, 0);
    if (!rgba || rgba.a < 0.999) continue; // 반투명 변수는 opacity 해석이 모호해 제외
    const hex = rgbToHex(rgba);
    const list = index.get(hex) || [];
    list.push({ variable, isAlias: isAlias(raw) });
    index.set(hex, list);
  }

  // 시맨틱(별칭) 토큰 우선, 그다음 이름순
  for (const list of index.values()) {
    list.sort((a, b) => Number(b.isAlias) - Number(a.isAlias) || a.variable.name.localeCompare(b.variable.name));
  }
  return index;
}

function isAlias(value: VariableValue | undefined): value is VariableAlias {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'VARIABLE_ALIAS';
}

async function resolveColor(
  value: VariableValue | undefined,
  collections: Map<string, VariableCollection>,
  depth: number,
): Promise<RGBA | null> {
  if (value === undefined || depth > 10) return null;
  if (isAlias(value)) {
    const target = await figma.variables.getVariableByIdAsync(value.id);
    if (!target) return null;
    let collection = collections.get(target.variableCollectionId);
    if (!collection) {
      const remote = await figma.variables.getVariableCollectionByIdAsync(target.variableCollectionId);
      if (!remote) return null;
      collections.set(remote.id, remote);
      collection = remote;
    }
    return resolveColor(target.valuesByMode[collection.defaultModeId], collections, depth + 1);
  }
  if (typeof value === 'object' && value !== null && 'r' in value) {
    return 'a' in value ? value : { ...value, a: 1 };
  }
  return null;
}

/** 변수의 사용 범위(scopes)가 해당 위치를 허용하는지 */
function scopeAllows(variable: Variable, target: ColorTarget): boolean {
  const scopes = variable.scopes;
  if (scopes.indexOf('ALL_SCOPES') !== -1) return true;
  if (target === 'STROKE_COLOR') return scopes.indexOf('STROKE_COLOR') !== -1;
  return scopes.indexOf('ALL_FILLS') !== -1 || scopes.indexOf(target) !== -1;
}

export function findColorVariable(index: ColorIndex, color: RGB, target: ColorTarget): Variable | undefined {
  const list = index.get(rgbToHex(color));
  if (!list) return undefined;
  const hit = list.find((c) => scopeAllows(c.variable, target));
  return hit && hit.variable;
}

export function fillTarget(node: SceneNode): ColorTarget {
  if (node.type === 'TEXT') return 'TEXT_FILL';
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.type === 'INSTANCE' || node.type === 'SECTION') {
    return 'FRAME_FILL';
  }
  return 'SHAPE_FILL';
}

export function rgbToHex({ r, g, b }: RGB): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}
