# Handoff Lint (Figma 플러그인)

디자인을 코드로 옮길 때 품질을 떨어뜨리는 4가지 요소를 찾아 리포트합니다.

| 규칙 | 판별 방법 (Plugin API) | 왜 문제인가 |
|---|---|---|
| Auto Layout 없음 | `FRAME`/`COMPONENT`이면서 `layoutMode === 'NONE'`이고 자식이 있음 | 코드에서 absolute 배치가 되어 반응형이 깨짐 |
| 토큰 없는 색 | SOLID 채우기·선이 `boundVariables.color`도 없고 `fillStyleId`/`strokeStyleId`도 없음 | 테마나 다크모드 변경이 반영되지 않음 |
| Detach된 인스턴스 | `FrameNode.detachedInfo !== null` | 컴포넌트 업데이트가 전파되지 않고 코드 컴포넌트와 매핑되지 않음 |
| 기본 레이어명 | `Frame 12`, `Group 3` 같은 이름 (정규식 `DEFAULT_NAME`) | 생성된 코드의 클래스·컴포넌트 이름이 의미를 잃음 |

리포트 항목을 클릭하면 해당 레이어로 이동하고 선택합니다. 리포트는 체크리스트 형식의 Markdown으로 복사할 수 있습니다.

## 개발

```bash
npm install
npm run build      # 타입 검사 후 dist/code.js 생성
npm run watch      # 저장할 때마다 다시 번들
```

Figma 데스크톱 앱에서 **Plugins → Development → Import plugin from manifest…**를 열고 이 폴더의 `manifest.json`을 선택합니다.
이후에는 Plugins → Development → Handoff Lint로 실행합니다. `ui.html`은 번들 없이 바로 읽히므로 플러그인을 다시 실행하기만 하면 변경이 반영됩니다.

## 구조

```
manifest.json   플러그인 메타데이터 (documentAccess: dynamic-page)
src/code.ts     메인 스레드: 문서 순회 + 4개 규칙 검사
src/ui.html     iframe UI: 결과 목록, 필터, Markdown 복사
dist/code.js    빌드 결과 (esbuild)
```

## 동작 메모

- **인스턴스 내부는 검사하지 않습니다.** 인스턴스 안의 문제는 메인 컴포넌트에서 한 번만 리포트합니다.
- 기본 레이어명 검사는 기본적으로 **컨테이너(Frame, Group, Section, Component)** 만 대상입니다. 아이콘 내부의 `Vector` 같은 도형까지 보려면 "도형 이름까지 검사"를 켭니다.
- 색 검사는 SOLID만 대상입니다. 그라디언트와 그림자(effect) 색은 아직 검사하지 않습니다.
- `DEFAULT_NAME`은 영문 UI의 기본 이름 기준입니다. 다른 언어 UI를 쓰면 `src/code.ts`에 해당 이름을 추가합니다.

## 배포

- **팀 공유 (플랜 무관)**: 이 폴더를 저장소로 공유하고, 각자 빌드한 뒤 manifest를 import합니다.
- **조직 내부 배포**: Organization/Enterprise 플랜에서 Publish → 조직 내부(Private)를 선택합니다.
- **Community 공개**: 2단계 인증, 아이콘, 커버 이미지를 준비한 뒤 Publish하면 Figma 심사를 거칩니다. 게시하면 Figma가 manifest의 `id`를 새 값으로 바꿔 줍니다.
