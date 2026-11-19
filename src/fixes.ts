// 원클릭 수정. 모든 수정은 Figma 실행 취소(⌘Z)로 되돌릴 수 있음.
import { DEFAULT_NAME } from './naming';
import { hasStyle } from './scan';
import { ColorIndex, ColorTarget, fillTarget, findColorVariable } from './tokens';

// ---------------------------------------------------------------------------
// 하드코딩 색 → 같은 값의 변수 연결
// ---------------------------------------------------------------------------

/** 연결한 색 개수를 반환 */
export async function bindColors(node: SceneNode, index: ColorIndex): Promise<number> {
  let bound = 0;
  const bindAll = (paints: readonly Paint[], target: ColorTarget): Paint[] | null => {
    let changed = false;
    const next = paints.map((p) => {
      if (p.type !== 'SOLID' || p.visible === false || (p.boundVariables && p.boundVariables.color)) return p;
      const variable = findColorVariable(index, p.color, target);
      if (!variable) return p;
      changed = true;
      bound++;
      return figma.variables.setBoundVariableForPaint(p, 'color', variable);
    });
    return changed ? next : null;
  };

  if ('fills' in node) {
    if (node.type === 'TEXT' && (node.fills === figma.mixed || node.fillStyleId === figma.mixed)) {
      await loadFonts(node);
      for (const seg of node.getStyledTextSegments(['fills', 'fillStyleId'])) {
        if (seg.fillStyleId) continue;
        const next = bindAll(seg.fills, 'TEXT_FILL');
        if (next) node.setRangeFills(seg.start, seg.end, next);
      }
    } else if (node.fills !== figma.mixed && !hasStyle(node.fillStyleId)) {
      const next = bindAll(node.fills as readonly Paint[], fillTarget(node));
      if (next) node.fills = next;
    }
  }
  if ('strokes' in node && node.strokes.length > 0) {
    const strokeStyleId = 'strokeStyleId' in node ? node.strokeStyleId : '';
    if (!hasStyle(strokeStyleId)) {
      const next = bindAll(node.strokes, 'STROKE_COLOR');
      if (next) node.strokes = next;
    }
  }
  return bound;
}

// ---------------------------------------------------------------------------
// 기본 레이어명 → 이름 변경
// ---------------------------------------------------------------------------

export function rename(node: SceneNode, value: string | undefined) {
  const name = (value || '').trim();
  if (!name) throw new Error('새 이름을 입력해 주세요.');
  if (DEFAULT_NAME.test(name)) throw new Error(`"${name}"도 기본 이름이에요. 의미 있는 이름을 입력해 주세요.`);
  node.name = name;
}

// ---------------------------------------------------------------------------
// detach된 인스턴스 → 원본 컴포넌트의 인스턴스로 교체
// ---------------------------------------------------------------------------

/** 교체 후 새 인스턴스와 옮겨 담은 텍스트 개수를 반환 */
export async function replaceDetached(node: SceneNode): Promise<{ instance: InstanceNode; textsCopied: number }> {
  if (node.type !== 'FRAME' || !node.detachedInfo) throw new Error('detach된 인스턴스가 아닙니다.');
  const parent = node.parent;
  if (!parent || !('insertChild' in parent)) throw new Error('이 위치에서는 교체할 수 없습니다.');

  const info = node.detachedInfo;
  let component: ComponentNode;
  if (info.type === 'local') {
    const found = await figma.getNodeByIdAsync(info.componentId);
    if (!found || found.type !== 'COMPONENT') throw new Error('원본 컴포넌트를 찾을 수 없습니다. 삭제되었을 수 있어요.');
    component = found;
  } else {
    component = await figma.importComponentByKeyAsync(info.componentKey);
  }

  const instance = component.createInstance();
  parent.insertChild(parent.children.indexOf(node), instance); // 같은 레이어 순서에 삽입
  instance.name = node.name;
  instance.visible = node.visible;

  const parentIsAutoLayout = 'layoutMode' in parent && parent.layoutMode !== 'NONE';
  if (parentIsAutoLayout && node.layoutPositioning === 'AUTO') {
    // Auto Layout 흐름 안: 위치는 부모가 정하므로 크기 정책(Hug/Fill/Fixed)만 맞춤
    trySet(() => (instance.layoutSizingHorizontal = node.layoutSizingHorizontal));
    trySet(() => (instance.layoutSizingVertical = node.layoutSizingVertical));
  } else {
    if (parentIsAutoLayout) instance.layoutPositioning = 'ABSOLUTE';
    instance.x = node.x;
    instance.y = node.y;
    if (Math.abs(instance.width - node.width) > 0.5 || Math.abs(instance.height - node.height) > 0.5) {
      trySet(() => instance.resize(node.width, node.height));
    }
    trySet(() => (instance.constraints = node.constraints));
  }

  const textsCopied = await copyTexts(node, instance);
  node.remove();
  return { instance, textsCopied };
}

// detach 후 바뀐 문구(버튼 라벨 등)가 사라지지 않도록, 같은 이름·순서의 텍스트 레이어 내용을 옮겨 담음
async function copyTexts(from: FrameNode, to: InstanceNode): Promise<number> {
  const src = from.findAll((n) => n.type === 'TEXT') as TextNode[];
  const dst = to.findAll((n) => n.type === 'TEXT') as TextNode[];
  let copied = 0;
  for (let i = 0; i < Math.min(src.length, dst.length); i++) {
    if (src[i].name !== dst[i].name || src[i].characters === dst[i].characters) continue;
    if (dst[i].hasMissingFont) continue;
    await loadFonts(dst[i]);
    dst[i].characters = src[i].characters;
    copied++;
  }
  return copied;
}

async function loadFonts(text: TextNode) {
  const fonts =
    text.characters.length > 0
      ? text.getRangeAllFontNames(0, text.characters.length)
      : text.fontName !== figma.mixed
        ? [text.fontName]
        : [];
  await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
}

function trySet(fn: () => void) {
  try {
    fn();
  } catch {
    // 컴포넌트 구조상 허용되지 않는 값(예: Auto Layout이 아닌 인스턴스에 Hug)은 건너뜀
  }
}
