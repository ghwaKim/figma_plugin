// 문서 순회 + 4개 규칙 검사. 각 문제에 예외(무시) 여부와 원클릭 수정 정보를 함께 담음.
import { IgnoreMap, isIgnored, loadIgnores } from './ignore';
import { DEFAULT_NAME, suggestName } from './naming';
import { buildColorIndex, ColorIndex, ColorTarget, fillTarget, findColorVariable, rgbToHex } from './tokens';
import type { FixInfo, Issue, RuleId, ScanOptions } from './types';

// 이름이 코드의 클래스/컴포넌트명이 되는 "컨테이너" 레이어. 도형은 옵션으로만 검사.
const CONTAINER_TYPES = new Set<NodeType>(['FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET']);

interface Ctx {
  opts: ScanOptions;
  issues: Issue[];
  scanned: number;
  page: string;
  ignores: IgnoreMap;
  colors: ColorIndex;
  componentNames: Map<string, string>;
  // 인스턴스 내부 리포트를 원본 노드 기준으로 묶기 위한 맵 (같은 컴포넌트 인스턴스가 여러 개여도 한 줄)
  instanceAbsolute: Map<string, { issue: Issue; base: string; count: number }>;
}

export async function scan(opts: ScanOptions) {
  const started = Date.now();

  let targets: { page: PageNode; nodes: readonly SceneNode[] }[];
  if (opts.scope === 'selection') {
    const sel = figma.currentPage.selection;
    if (sel.length === 0) throw new Error('선택된 레이어가 없습니다. 레이어를 선택하거나 범위를 바꿔 주세요.');
    targets = [{ page: figma.currentPage, nodes: sel }];
  } else if (opts.scope === 'page') {
    targets = [{ page: figma.currentPage, nodes: figma.currentPage.children }];
  } else {
    await figma.loadAllPagesAsync(); // dynamic-page 모드에서는 다른 페이지를 먼저 로드해야 함
    targets = figma.root.children.map((page) => ({ page, nodes: page.children }));
  }

  const ctx: Ctx = {
    opts,
    issues: [],
    scanned: 0,
    page: '',
    ignores: loadIgnores(),
    colors: await buildColorIndex(),
    componentNames: new Map(),
    instanceAbsolute: new Map(),
  };

  for (const { page, nodes } of targets) {
    ctx.page = page.name;
    for (const node of nodes) await visit(node, ancestorNames(node), ctx);
  }

  return {
    issues: ctx.issues,
    scanned: ctx.scanned,
    durationMs: Date.now() - started,
    scope: opts.scope,
    colorTokens: ctx.colors.size,
  };
}

// instance: 지금 인스턴스 내부를 돌고 있다면 가장 바깥 인스턴스
async function visit(node: SceneNode, path: string[], ctx: Ctx, instance: InstanceNode | null = null): Promise<void> {
  if (!ctx.opts.includeHidden && !node.visible) return;

  ctx.scanned++;
  if (ctx.scanned % 400 === 0) {
    figma.ui.postMessage({ type: 'progress', scanned: ctx.scanned });
    await new Promise((r) => setTimeout(r, 0)); // UI가 진행 상황을 그릴 틈을 줌
  }

  if (instance) {
    // 인스턴스 내부: 색·이름 등은 메인 컴포넌트의 책임이라 건너뛰고,
    // 화면 레이아웃에 그대로 드러나는 "Auto Layout 무시"만 검사
    checkAbsoluteInInstance(node, path, ctx, instance);
  } else {
    checkAutoLayout(node, path, ctx);
    checkColors(node, path, ctx);
    await checkDetached(node, path, ctx);
    checkDefaultName(node, path, ctx);
  }

  if ('children' in node) {
    const childPath = [...path, node.name];
    const inside = instance || (node.type === 'INSTANCE' ? node : null);
    for (const child of node.children) await visit(child, childPath, ctx, inside);
  }
}

function ancestorNames(node: BaseNode): string[] {
  const names: string[] = [];
  let p = node.parent;
  while (p && p.type !== 'PAGE' && p.type !== 'DOCUMENT') {
    names.unshift(p.name);
    p = p.parent;
  }
  return names;
}

function report(ctx: Ctx, node: SceneNode, path: string[], rule: RuleId, detail: string, fix?: FixInfo, key = node.id): Issue {
  const issue: Issue = {
    id: node.id,
    key,
    name: node.name,
    nodeType: node.type,
    rule,
    detail,
    page: ctx.page,
    path: path.join(' / '),
    ignored: isIgnored(ctx.ignores, key, rule),
    fix,
  };
  ctx.issues.push(issue);
  return issue;
}

// ---------------------------------------------------------------------------
// 규칙 1: Auto Layout이 아닌 프레임 + "Auto Layout 무시"가 켜진 자식
// (자동 수정은 레이어 위치가 바뀔 위험이 커서 제공하지 않음 → 예외 처리만)
// ---------------------------------------------------------------------------

// Auto Layout 부모 안에서 "Auto Layout 무시"(절대 위치)가 켜진 자식도 코드에선 absolute가 됨
function absoluteDetail(node: SceneNode): string | null {
  if (!('layoutPositioning' in node) || node.layoutPositioning !== 'ABSOLUTE') return null;
  const parent = node.parent;
  const parentName = parent && 'name' in parent ? parent.name : '';
  return `"Auto Layout 무시" 켜짐: 부모 "${parentName}" 안에서 절대 위치`;
}

function checkAbsoluteInInstance(node: SceneNode, path: string[], ctx: Ctx, instance: InstanceNode) {
  const detail = absoluteDetail(node);
  if (!detail) return;
  // 인스턴스 하위 노드 id는 "I<인스턴스>;<원본 노드>" 형태 → 마지막 조각이 컴포넌트 안의 원본 노드
  const sourceId = node.id.split(';').pop() || node.id;
  const seen = ctx.instanceAbsolute.get(sourceId);
  if (seen) {
    seen.count++;
    seen.issue.detail = `${seen.base} (같은 컴포넌트 인스턴스 ${seen.count}곳)`;
    return;
  }
  const base = `${detail} · 인스턴스 "${instance.name}" 내부`;
  // 예외 키를 원본 노드 id로 → 한 번 무시하면 모든 인스턴스와 메인 컴포넌트에 함께 적용
  const issue = report(ctx, node, path, 'no-autolayout', base, undefined, sourceId);
  ctx.instanceAbsolute.set(sourceId, { issue, base, count: 1 });
}

function checkAutoLayout(node: SceneNode, path: string[], ctx: Ctx) {
  const absolute = absoluteDetail(node);
  if (absolute) report(ctx, node, path, 'no-autolayout', absolute);

  if (node.type !== 'FRAME' && node.type !== 'COMPONENT') return;
  if (node.layoutMode !== 'NONE') return;
  const n = node.children.length;
  if (n === 0) return; // 빈 프레임(배경 박스 등)은 레이아웃 문제가 아님
  report(ctx, node, path, 'no-autolayout', `자식 ${n}개가 절대 위치로 배치됨`);
}

// ---------------------------------------------------------------------------
// 규칙 2: 변수/스타일 없이 hex를 직접 쓴 색 (+ 같은 값의 변수가 있으면 연결 제안)
// ---------------------------------------------------------------------------

interface ColorFinding {
  where: string;
  hex: string;
  token?: string;
}

/** 노드의 하드코딩 색을 찾음. 수정 후 재검사에도 사용 */
export function inspectColors(node: SceneNode, index: ColorIndex): { detail: string; fix?: FixInfo } | null {
  const found: ColorFinding[] = [];
  const collect = (paints: readonly Paint[], where: string, target: ColorTarget) => {
    for (const p of paints) {
      if (p.type !== 'SOLID' || p.visible === false) continue;
      if (p.boundVariables && p.boundVariables.color) continue; // 변수(토큰)에 바인딩됨
      const opacity = p.opacity === undefined || p.opacity >= 1 ? '' : ` ${Math.round(p.opacity * 100)}%`;
      const v = findColorVariable(index, p.color, target);
      found.push({ where, hex: rgbToHex(p.color) + opacity, token: v && v.name });
    }
  };

  if ('fills' in node) {
    if (node.type === 'TEXT' && (node.fills === figma.mixed || node.fillStyleId === figma.mixed)) {
      // 텍스트 일부 구간만 색이 다른 경우: 구간별로 검사
      for (const seg of node.getStyledTextSegments(['fills', 'fillStyleId'])) {
        if (!seg.fillStyleId) collect(seg.fills, '글자', 'TEXT_FILL');
      }
    } else if (node.fills !== figma.mixed && !hasStyle(node.fillStyleId)) {
      collect(node.fills as readonly Paint[], node.type === 'TEXT' ? '글자' : '채우기', fillTarget(node));
    }
  }
  if ('strokes' in node && node.strokes.length > 0) {
    const strokeStyleId = 'strokeStyleId' in node ? node.strokeStyleId : '';
    if (!hasStyle(strokeStyleId)) collect(node.strokes, '선', 'STROKE_COLOR');
  }
  if (found.length === 0) return null;

  const seen = new Set<string>();
  const parts: string[] = [];
  for (const f of found) {
    const text = `${f.where} ${f.hex}${f.token ? ` → ${f.token}` : ''}`;
    if (!seen.has(text)) {
      seen.add(text);
      parts.push(text);
    }
  }
  const shown = parts.slice(0, 4).join(', ');
  const detail = parts.length > 4 ? `${shown} 외 ${parts.length - 4}개` : shown;

  const matched = found.filter((f) => f.token).length;
  const fix: FixInfo | undefined = matched > 0 ? { kind: 'bind-color', label: matched === found.length ? '변수 연결' : `변수 연결 (${matched}/${found.length})` } : undefined;
  return { detail, fix };
}

function checkColors(node: SceneNode, path: string[], ctx: Ctx) {
  const result = inspectColors(node, ctx.colors);
  if (result) report(ctx, node, path, 'hardcoded-color', result.detail, result.fix);
}

export function hasStyle(styleId: string | symbol): boolean {
  return typeof styleId === 'string' && styleId.length > 0;
}

// ---------------------------------------------------------------------------
// 규칙 3: detach된 인스턴스 (+ 원본 컴포넌트로 교체 제안)
// ---------------------------------------------------------------------------

async function checkDetached(node: SceneNode, path: string[], ctx: Ctx) {
  if (node.type !== 'FRAME' || !node.detachedInfo) return;
  const info = node.detachedInfo;
  const replace: FixInfo = { kind: 'replace-detached', label: '원본으로 교체' };
  if (info.type === 'local') {
    const name = await localComponentName(info.componentId, ctx);
    report(ctx, node, path, 'detached-instance', `원본: ${name || '삭제된 로컬 컴포넌트'}`, name ? replace : undefined);
  } else {
    report(ctx, node, path, 'detached-instance', `원본: 라이브러리 컴포넌트 (key ${info.componentKey.slice(0, 8)}…)`, replace);
  }
}

async function localComponentName(id: string, ctx: Ctx): Promise<string> {
  const cached = ctx.componentNames.get(id);
  if (cached !== undefined) return cached;
  const comp = await figma.getNodeByIdAsync(id);
  let name = '';
  if (comp && comp.type === 'COMPONENT') {
    name = comp.parent && comp.parent.type === 'COMPONENT_SET' ? `${comp.parent.name} (${comp.name})` : comp.name;
  }
  ctx.componentNames.set(id, name);
  return name;
}

// ---------------------------------------------------------------------------
// 규칙 4: 기본 레이어명 (+ 구조·텍스트 기반 이름 추천)
// ---------------------------------------------------------------------------

function checkDefaultName(node: SceneNode, path: string[], ctx: Ctx) {
  if (node.type === 'TEXT' || node.type === 'INSTANCE') return; // 내용/컴포넌트명을 따라가므로 제외
  if (!ctx.opts.includeShapes && !CONTAINER_TYPES.has(node.type)) return;
  if (!DEFAULT_NAME.test(node.name.trim())) return;
  report(ctx, node, path, 'default-name', `${node.type.toLowerCase()} 레이어가 기본 이름 사용`, {
    kind: 'rename',
    label: '이름 변경',
    suggestion: suggestName(node),
  });
}
