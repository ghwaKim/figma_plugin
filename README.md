# Handoff Lint (Figma 플러그인)

디자인을 코드로 옮길 때 품질을 떨어뜨리는 4가지 요소를 찾아 리포트합니다.

| 규칙 | 판별 방법 (Plugin API) | 왜 문제인가 |
|---|---|---|
| Auto Layout 미적용 | ① `FRAME`/`COMPONENT`이면서 `layoutMode === 'NONE'`이고 자식이 있음<br>② "Auto Layout 무시"가 켜진 자식 (`layoutPositioning === 'ABSOLUTE'`) | 코드에서 absolute 배치가 되어 반응형이 깨짐 |
| 토큰 없는 색 | SOLID 채우기·선이 `boundVariables.color`도 없고 `fillStyleId`/`strokeStyleId`도 없음 | 테마나 다크모드 변경이 반영되지 않음 |
| Detach된 인스턴스 | `FrameNode.detachedInfo !== null` | 컴포넌트 업데이트가 전파되지 않고 코드 컴포넌트와 매핑되지 않음 |
| 기본 레이어명 | `Frame 12`, `Group 3` 같은 이름 (정규식 `DEFAULT_NAME`) | 생성된 코드의 클래스·컴포넌트 이름이 의미를 잃음 |

리포트 항목을 클릭하면 해당 레이어로 이동하고 선택합니다. 리포트는 체크리스트 형식의 Markdown으로 복사할 수 있습니다.

## 원클릭 수정

| 규칙 | 수정 | 방법 |
|---|---|---|
| 토큰 없는 색 | **변수 연결** | 같은 hex 값을 가진 로컬 COLOR 변수를 찾아 `setBoundVariableForPaint`로 연결. 변수의 사용 범위(scopes)가 맞는 것만, 시맨틱(별칭) 토큰을 우선. "일치하는 색 모두 연결"로 일괄 처리 |
| 기본 레이어명 | **이름 변경** | Auto Layout 방향(Row/Stack/Grid)과 안쪽 첫 텍스트로 이름을 추천 (예: `로그인 Row`). 입력창에서 고친 뒤 적용 |
| Detach된 인스턴스 | **원본으로 교체** | 원본 컴포넌트(로컬 또는 라이브러리)의 인스턴스를 같은 자리에 만들고, 바뀐 텍스트는 옮겨 담은 뒤 기존 프레임을 삭제. 두 번 눌러야 실행 |
| Auto Layout 미적용 | 없음 | 자동 적용 시 레이어 위치가 바뀔 위험이 커서 제공하지 않음 |

모든 수정은 Figma의 실행 취소(⌘Z)로 되돌릴 수 있습니다. 수정 하나가 실행 취소 한 번이고, 일괄 연결은 한 번에 되돌립니다.

## 예외 처리 (무시)

의도된 경우(예: 배지에 쓴 "Auto Layout 무시")는 **무시**를 누르면 다음 검사부터 문제 수에서 빠집니다.

- 문서 루트의 pluginData(`handoff-lint-ignores`)에 저장되므로 **파일을 쓰는 팀원 모두에게 적용**됩니다.
- 인스턴스 내부 항목은 원본 노드 기준으로 저장되어, 한 번 무시하면 같은 컴포넌트의 모든 인스턴스에 적용됩니다.
- "무시한 항목 보기"를 켜면 무시한 항목이 보이고, **무시 해제**로 되돌릴 수 있습니다.
- Dev Mode에서는 문서를 수정할 수 없어 수정·무시 버튼이 숨겨집니다.

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
src/code.ts     메인 스레드 진입점: UI 메시지 처리
src/scan.ts     문서 순회 + 4개 규칙 검사
src/fixes.ts    원클릭 수정 (변수 연결, 이름 변경, 원본 교체)
src/tokens.ts   hex → COLOR 변수 인덱스 (별칭 추적, scopes 확인)
src/naming.ts   기본 이름 판별 + 이름 추천
src/ignore.ts   예외(무시) 저장소
src/types.ts    공용 타입과 메시지 정의
src/ui.html     iframe UI: 결과 목록, 필터, 수정·무시 버튼, Markdown 복사
dist/code.js    빌드 결과 (esbuild)
```

## 동작 메모

- **인스턴스 내부는 "Auto Layout 무시"만 검사합니다.** 색·이름 같은 나머지 규칙은 메인 컴포넌트에서 한 번만 리포트합니다. 같은 컴포넌트의 인스턴스가 여러 개면 한 줄로 묶어 개수를 표시합니다.
- 기본 레이어명 검사는 기본적으로 **컨테이너(Frame, Group, Section, Component)** 만 대상입니다. 아이콘 내부의 `Vector` 같은 도형까지 보려면 "도형 이름까지 검사"를 켭니다.
- "Auto Layout 무시"는 배지·오버레이처럼 의도적으로 쓰는 경우도 있습니다. 리포트를 보고 의도된 것인지 판단합니다.
- 변수 연결은 **로컬 변수**(라이브러리 변수를 별칭으로 참조하는 로컬 변수 포함)만 찾습니다. 라이브러리 변수를 직접 찾는 기능은 아직 없습니다. 기본 모드 값으로 비교하고, 반투명 변수는 제외합니다.
- 색 검사는 SOLID만 대상입니다. 그라디언트와 그림자(effect) 색은 아직 검사하지 않습니다.
- `DEFAULT_NAME`은 영문 UI의 기본 이름 기준입니다. 다른 언어 UI를 쓰면 `src/naming.ts`에 해당 이름을 추가합니다.

## 배포

- **팀 공유 (플랜 무관)**: 이 폴더를 저장소로 공유하고, 각자 빌드한 뒤 manifest를 import합니다.
- **조직 내부 배포**: Organization/Enterprise 플랜에서 Publish → 조직 내부(Private)를 선택합니다.
- **Community 공개**: 2단계 인증, 아이콘, 커버 이미지를 준비한 뒤 Publish하면 Figma 심사를 거칩니다. 게시하면 Figma가 manifest의 `id`를 새 값으로 바꿔 줍니다.
