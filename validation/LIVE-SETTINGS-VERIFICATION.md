# Flow 연결 및 생성 설정 검증

2026-09-10, 사용자 승인에 따라 프로젝트 개발 복사본을 수정했습니다. 원본 설치 저장소는 변경하지 않았습니다.

## 실제 계정 확인

- 로그인 후 브라우저 정상 종료/재실행 및 MCP 서버 재시작 후에도 connected, signedIn=true, workspaceAvailable=true 확인.
- 이미지 모델: Nano Banana Pro, Nano Banana 2, Nano Banana 2 Lite.
- 영상 모델: Omni 1.1 Flash, Veo 3.1 Lite/Fast/Quality.

## 실제 설정 검증 — 생성 제출 없음

같은 MCP 세션에서 다음 순서대로 연속 검사해 모두 settings_verified 및 originalSettingsRestored=true를 받았습니다.

| 모델 | 종류 | 화면 비율 | 길이 | 출력 수 |
|---|---|---|---|---|
| Veo 3.1 Fast | 영상 | 16:9 | 선택 옵션 미노출, 길이 인자 미전달 | 1 |
| Nano Banana 2 | 이미지 | 16:9 | 해당 없음 | 1 |
| Omni 1.1 Flash | 영상 | 16:9 | 실제 선택 8초 | 1 |

각 검사에서 generationSubmitted=false, jobCreated=false. 모델 변경 후 실제 옵션을 다시 읽고 비활성·미노출 값은 거절합니다. 정확한 크레딧 비용은 확인되지 않았습니다.

## 적용

- 수동 화면의 설정을 선택·검증하도록 생성 코드 보완. Agent 모드는 기존 별도 경로 유지.
- flow_validate_generation_settings는 프롬프트를 받지 않으며 생성 Job/제출을 만들지 않고 이전 설정을 복원합니다.
- Codex google_flow 연결 경로를 프로젝트 개발 복사본의 dist/index.js 및 검증된 계정 데이터로 변경했습니다. codex mcp get google_flow --json으로 확인했습니다. 기존 설정은 백업했습니다.
- 현재 작업의 SDK 세션26178은 수정본을 사용합니다. 앱의 이미 로드된 도구는 다음 MCP/Codex 재시작 시 새 설정을 읽습니다. 재로그인은 필요하지 않은 상태로 검증됐습니다.

실제 생성·Job 처리·다운로드까지의 검증은 아직 하지 않았습니다. 영상 제목/주제, 전체 대본 승인, 테스트 조건과 크레딧 사용에 대한 명시 승인 후 진행합니다. 다운로드는 제목 폴더 아래 장면별 폴더에 저장합니다.

## 최종 코드 검사

최종 npm run check: 46개 통과, 실패·건너뜀0. 결과는 manual-generation-final-check.txt에 저장했습니다. 실제 생성·다운로드는 승인 후 별도 검증합니다.
