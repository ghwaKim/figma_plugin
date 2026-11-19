// Handoff Lint — 코드 변환 품질을 떨어뜨리는 요소를 찾아 리포트하고, 예외 처리·원클릭 수정을 제공합니다.
// 이 파일은 Figma 샌드박스(메인 스레드)에서 실행되며 UI(iframe)와 postMessage로 통신합니다.
import { bindColors, rename, replaceDetached } from './fixes';
import { setIgnored } from './ignore';
import { inspectColors, scan } from './scan';
import { buildColorIndex } from './tokens';
import type { FixKind, UiMessage } from './types';

// Dev Mode는 문서를 수정할 수 없으므로 검사·이동만 허용
const readOnly = figma.editorType === 'dev';

figma.showUI(__html__, { width: 460, height: 640, themeColors: true });
figma.ui.postMessage({ type: 'init', readOnly });

let busy = false;

const postSelectionCount = () =>
  figma.ui.postMessage({ type: 'selection', count: figma.currentPage.selection.length });

figma.on('selectionchange', postSelectionCount);
figma.on('currentpagechange', postSelectionCount);
postSelectionCount();

figma.ui.onmessage = async (msg: UiMessage) => {
  switch (msg.type) {
    case 'scan':
      if (busy) return;
      busy = true;
      try {
        figma.ui.postMessage({ type: 'result', ...(await scan(msg)) });
      } catch (e) {
        figma.ui.postMessage({ type: 'error', message: errorMessage(e) });
      } finally {
        busy = false;
      }
      return;

    case 'select':
      await selectNode(msg.id);
      return;

    case 'notify':
      figma.notify(msg.message);
      return;

    case 'ignore':
      if (guardReadOnly()) return;
      setIgnored(msg.key, msg.rule, msg.ignored);
      figma.ui.postMessage({ type: 'ignored', key: msg.key, rule: msg.rule, ignored: msg.ignored });
      return;

    case 'fix':
      if (guardReadOnly()) return;
      await runFix(msg.uid, msg.id, msg.kind, msg.value);
      return;

    case 'fix-all-colors': {
      if (guardReadOnly()) return;
      const index = await buildColorIndex();
      let total = 0;
      for (const item of msg.items) {
        const node = await figma.getNodeByIdAsync(item.id);
        if (!node || !isScene(node)) continue;
        try {
          total += await bindColors(node, index);
          figma.ui.postMessage({ type: 'fixed', uid: item.uid, update: inspectColors(node, index) });
        } catch (e) {
          figma.ui.postMessage({ type: 'fix-failed', uid: item.uid, message: errorMessage(e) });
        }
      }
      figma.commitUndo(); // 일괄 수정을 한 번의 실행 취소 단위로
      figma.notify(`색 ${total}개를 변수에 연결했어요. ⌘Z로 되돌릴 수 있습니다.`);
      return;
    }
  }
};

async function runFix(uid: number, id: string, kind: FixKind, value?: string) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || !isScene(node)) {
    figma.ui.postMessage({ type: 'fix-failed', uid, message: '레이어를 찾을 수 없습니다. 삭제되었을 수 있어요.' });
    return;
  }
  try {
    if (kind === 'bind-color') {
      const index = await buildColorIndex();
      const n = await bindColors(node, index);
      // 일부만 연결된 경우 남은 색으로 항목을 갱신, 모두 연결되면 update = null(해결됨)
      figma.ui.postMessage({ type: 'fixed', uid, update: inspectColors(node, index) });
      figma.notify(`색 ${n}개를 변수에 연결했어요.`);
    } else if (kind === 'rename') {
      rename(node, value);
      figma.ui.postMessage({ type: 'fixed', uid, update: null });
    } else if (kind === 'replace-detached') {
      const { instance, textsCopied } = await replaceDetached(node);
      figma.currentPage.selection = [instance];
      figma.viewport.scrollAndZoomIntoView([instance]);
      figma.ui.postMessage({ type: 'fixed', uid, update: null });
      figma.notify(`원본 컴포넌트로 교체했어요${textsCopied ? ` (텍스트 ${textsCopied}개 유지)` : ''}. ⌘Z로 되돌릴 수 있습니다.`);
    }
    figma.commitUndo(); // 수정 하나 = 실행 취소 한 번
  } catch (e) {
    figma.ui.postMessage({ type: 'fix-failed', uid, message: errorMessage(e) });
  }
}

function guardReadOnly(): boolean {
  if (readOnly) figma.notify('Dev Mode에서는 문서를 수정할 수 없어요. 디자인 모드에서 실행해 주세요.');
  return readOnly;
}

function isScene(node: BaseNode): node is SceneNode {
  return node.type !== 'PAGE' && node.type !== 'DOCUMENT';
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 리포트 항목 클릭 → 해당 노드로 이동
async function selectNode(id: string) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.removed || !isScene(node)) {
    figma.notify('레이어를 찾을 수 없습니다. 삭제되었을 수 있어요.');
    return;
  }
  let page: BaseNode | null = node.parent;
  while (page && page.type !== 'PAGE') page = page.parent;
  if (page && page.type === 'PAGE' && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}
