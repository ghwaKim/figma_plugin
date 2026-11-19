// 기본 레이어명 판별과 이름 추천.

// Figma가 새 레이어에 붙이는 기본 이름. (영문 UI 기준 — 다른 언어 UI라면 여기에 추가)
export const DEFAULT_NAME = /^(Frame|Group|Section|Component|Rectangle|Ellipse|Vector|Line|Arrow|Polygon|Star|Slice|Image|Union|Subtract|Intersect|Exclude)( \d+)?$/;

const VECTOR_TYPES = new Set<NodeType>(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE', 'ELLIPSE', 'RECTANGLE']);

/** 구조(Auto Layout 방향, 타입)로 역할을 정하고, 안에 있는 첫 텍스트로 의미를 붙임. 예: "로그인 Row" */
export function suggestName(node: SceneNode): string {
  const role = roleOf(node);
  const text = role === 'Icon' ? '' : firstText(node);
  return text ? `${text} ${role}` : role;
}

function roleOf(node: SceneNode): string {
  if (isIcon(node)) return 'Icon';
  switch (node.type) {
    case 'FRAME':
    case 'COMPONENT':
      if (node.layoutMode === 'HORIZONTAL') return 'Row';
      if (node.layoutMode === 'VERTICAL') return 'Stack';
      if (node.layoutMode === 'GRID') return 'Grid';
      return 'Container';
    case 'GROUP':
      return 'Wrapper';
    case 'SECTION':
      return 'Area';
    case 'COMPONENT_SET':
      return 'Variants';
    case 'RECTANGLE':
      return hasImageFill(node) ? 'Picture' : 'Box';
    case 'ELLIPSE':
      return 'Circle';
    case 'LINE':
      return 'Divider';
    default:
      return 'Shape';
  }
}

// 48px 이하이면서 내부가 전부 벡터 도형이면 아이콘으로 판단
function isIcon(node: SceneNode): boolean {
  if (node.type !== 'FRAME' && node.type !== 'GROUP' && node.type !== 'COMPONENT') return false;
  if (node.width > 48 || node.height > 48 || node.children.length === 0) return false;
  return node.findAll(() => true).every((n) => VECTOR_TYPES.has(n.type) || n.type === 'GROUP' || n.type === 'FRAME');
}

function hasImageFill(node: RectangleNode): boolean {
  return node.fills !== figma.mixed && node.fills.some((p) => p.type === 'IMAGE');
}

function firstText(node: SceneNode): string {
  if (!('findOne' in node)) return '';
  const text = node.findOne((n) => n.type === 'TEXT' && n.visible) as TextNode | null;
  if (!text) return '';
  const clean = text.characters.replace(/\s+/g, ' ').trim();
  return clean.length > 20 ? `${clean.slice(0, 20)}…` : clean;
}
