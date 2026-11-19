// Handoff Lint — 코드 변환 품질을 떨어뜨리는 요소를 찾아 리포트합니다.
// 이 파일은 Figma 샌드박스(메인 스레드)에서 실행되며 `figma` 전역 객체로 문서를 읽습니다.

type RuleId = 'no-autolayout' | 'hardcoded-color' | 'detached-instance' | 'default-name';
type Scope = 'selection' | 'page' | 'document';

interface ScanOptions {
  scope: Scope;
  includeHidden: boolean;
  includeShapes: boolean;
}

interface Issue {
  id: string;
  name: string;
  nodeType: string;
  rule: RuleId;
  detail: string;
  page: string;
  path: string;
}

type UiMessage =
  | ({ type: 'scan' } & ScanOptions)
  | { type: 'select'; id: string }
  | { type: 'notify'; message: string };

// Figma가 새 레이어에 붙이는 기본 이름. (영문 UI 기준 — 다른 언어 UI라면 여기에 추가)
const DEFAULT_NAME = /^(Frame|Group|Section|Component|Rectangle|Ellipse|Vector|Line|Arrow|Polygon|Star|Slice|Image|Union|Subtract|Intersect|Exclude)( \d+)?$/;

// 이름이 코드의 클래스/컴포넌트명이 되는 "컨테이너" 레이어. 도형은 옵션으로만 검사.
const CONTAINER_TYPES = new Set<NodeType>(['FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET']);

figma.showUI(__html__, { width: 440, height: 620, themeColors: true });

let scanning = false;

const postSelectionCount = () =>
  figma.ui.postMessage({ type: 'selection', count: figma.currentPage.selection.length });

figma.on('selectionchange', postSelectionCount);
figma.on('currentpagechange', postSelectionCount);
postSelectionCount();

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type === 'scan') {
    if (scanning) return;
    scanning = true;
    try {
      const result = await scan(msg);
      figma.ui.postMessage({ type: 'result', ...result });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      scanning = false;
    }
  } else if (msg.type === 'select') {
    await selectNode(msg.id);
  } else if (msg.type === 'notify') {
    figma.notify(msg.message);
  }
};

// ---------------------------------------------------------------------------
// 순회
// ---------------------------------------------------------------------------

interface Ctx {
  opts: ScanOptions;
  issues: Issue[];
  scanned: number;
  page: string;
  componentNames: Map<string, string>;
  // 인스턴스 내부 리포트를 원본 노드 기준으로 묶기 위한 맵 (같은 컴포넌트 인스턴스가 여러 개여도 한 줄)
  instanceAbsolute: Map<string, { issue: Issue; base: string; count: number }>;
}

async function scan(opts: ScanOptions) {
  const started = Date.now();
  const ctx: Ctx = { opts, issues: [], scanned: 0, page: '', componentNames: new Map(), instanceAbsolute: new Map() };

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

  for (const { page, nodes } of targets) {
    ctx.page = page.name;
    for (const node of nodes) await visit(node, ancestorNames(node), ctx);
  }

  return { issues: ctx.issues, scanned: ctx.scanned, durationMs: Date.now() - started, scope: opts.scope };
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

function report(ctx: Ctx, node: SceneNode, path: string[], rule: RuleId, detail: string) {
  ctx.issues.push({
    id: node.id,
    name: node.name,
    nodeType: node.type,
    rule,
    detail,
    page: ctx.page,
    path: path.join(' / '),
  });
}

// ---------------------------------------------------------------------------
// 규칙 1: Auto Layout이 아닌 프레임 + "Auto Layout 무시"가 켜진 자식
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
  report(ctx, node, path, 'no-autolayout', base);
  ctx.instanceAbsolute.set(sourceId, { issue: ctx.issues[ctx.issues.length - 1], base, count: 1 });
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
// 규칙 2: 변수/스타일 없이 hex를 직접 쓴 색
// ---------------------------------------------------------------------------

function checkColors(node: SceneNode, path: string[], ctx: Ctx) {
  const found: string[] = [];

  if ('fills' in node) {
    if (node.type === 'TEXT' && (node.fills === figma.mixed || node.fillStyleId === figma.mixed)) {
      // 텍스트 일부 구간만 색이 다른 경우: 구간별로 검사
      for (const seg of node.getStyledTextSegments(['fills', 'fillStyleId'])) {
        if (seg.fillStyleId) continue;
        for (const hex of unboundSolids(seg.fills)) found.push(`글자 ${hex}`);
      }
    } else if (node.fills !== figma.mixed && !hasStyle(node.fillStyleId)) {
      for (const hex of unboundSolids(node.fills as readonly Paint[])) found.push(`채우기 ${hex}`);
    }
  }

  if ('strokes' in node && node.strokes.length > 0) {
    const strokeStyleId = 'strokeStyleId' in node ? node.strokeStyleId : '';
    if (!hasStyle(strokeStyleId)) {
      for (const hex of unboundSolids(node.strokes)) found.push(`선 ${hex}`);
    }
  }

  if (found.length === 0) return;
  const unique = [...new Set(found)];
  const shown = unique.slice(0, 4).join(', ');
  report(ctx, node, path, 'hardcoded-color', unique.length > 4 ? `${shown} 외 ${unique.length - 4}개` : shown);
}

function hasStyle(styleId: string | symbol): boolean {
  return typeof styleId === 'string' && styleId.length > 0;
}

function unboundSolids(paints: readonly Paint[]): string[] {
  const out: string[] = [];
  for (const p of paints) {
    if (p.type !== 'SOLID' || p.visible === false) continue;
    if (p.boundVariables && p.boundVariables.color) continue; // 변수(토큰)에 바인딩됨
    out.push(toHex(p.color, p.opacity));
  }
  return out;
}

function toHex({ r, g, b }: RGB, opacity = 1): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  const hex = `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
  return opacity < 1 ? `${hex} ${Math.round(opacity * 100)}%` : hex;
}

// ---------------------------------------------------------------------------
// 규칙 3: detach된 인스턴스
// ---------------------------------------------------------------------------

async function checkDetached(node: SceneNode, path: string[], ctx: Ctx) {
  if (node.type !== 'FRAME' || !node.detachedInfo) return;
  const info = node.detachedInfo;
  let detail: string;
  if (info.type === 'local') {
    detail = `원본: ${await localComponentName(info.componentId, ctx)}`;
  } else {
    detail = `원본: 라이브러리 컴포넌트 (key ${info.componentKey.slice(0, 8)}…)`;
  }
  report(ctx, node, path, 'detached-instance', detail);
}

async function localComponentName(id: string, ctx: Ctx): Promise<string> {
  const cached = ctx.componentNames.get(id);
  if (cached) return cached;
  const comp = await figma.getNodeByIdAsync(id);
  let name = '삭제된 로컬 컴포넌트';
  if (comp) {
    name = comp.parent && comp.parent.type === 'COMPONENT_SET' ? `${comp.parent.name} (${comp.name})` : comp.name;
  }
  ctx.componentNames.set(id, name);
  return name;
}

// ---------------------------------------------------------------------------
// 규칙 4: 기본 레이어명
// ---------------------------------------------------------------------------

function checkDefaultName(node: SceneNode, path: string[], ctx: Ctx) {
  if (node.type === 'TEXT' || node.type === 'INSTANCE') return; // 내용/컴포넌트명을 따라가므로 제외
  if (!ctx.opts.includeShapes && !CONTAINER_TYPES.has(node.type)) return;
  if (!DEFAULT_NAME.test(node.name.trim())) return;
  report(ctx, node, path, 'default-name', `${node.type.toLowerCase()} 레이어가 기본 이름 사용`);
}

// ---------------------------------------------------------------------------
// 리포트 항목 클릭 → 해당 노드로 이동
// ---------------------------------------------------------------------------

async function selectNode(id: string) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.removed || node.type === 'PAGE' || node.type === 'DOCUMENT') {
    figma.notify('레이어를 찾을 수 없습니다. 삭제되었을 수 있어요.');
    return;
  }
  let page: BaseNode | null = node.parent;
  while (page && page.type !== 'PAGE') page = page.parent;
  if (page && page.type === 'PAGE' && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  const scene = node as SceneNode;
  figma.currentPage.selection = [scene];
  figma.viewport.scrollAndZoomIntoView([scene]);
}
