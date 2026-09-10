# YouTube 영상 제작 프로젝트

Google Flow로 장면 클립을 만들고, 대본과 내레이션에 맞춰 로컬 영상 파일을 조립하는 프로젝트입니다.

**현재 상태:** 롯데월드타워 원본 클립 34개와 약 5분 7초의 MP4를 만들었습니다. 사용자가 Microsoft Heami 내레이션 품질을 거절했으므로 최종 품질 승인은 완료되지 않았습니다. 다음 작업은 목소리 비교와 교체 방향 논의입니다.

## 이어서 작업하기

먼저 [HANDOFF.md](HANDOFF.md)를 읽고 최신 요청과 검증된 상태를 확인하세요. [AGENTS.md](AGENTS.md) 뒤쪽에는 최초 범위보다 우선하는 사용자의 추가 제작 승인이 기록되어 있습니다. 과거 전체 제작 승인을 새로운 대량 재생성 승인으로 해석하지 않습니다.

- scripts/: 실제 Job 추적, 제작 기록 정리, 내레이션과 영상 조립, 프레임 검수 도구.
- tools/google-flow-mcp/: 사용자가 수정하도록 승인한 Flow MCP 개발 복사본.
- flow-login-bridge/: 기존 브라우저의 Flow 로그인 연결 확장.
- drafts/lotte-world-tower/: 조사 자료, 대본 초안, 편집 계획.
- 555m 롯데월드타워는 어떻게 지었을까/: 실제 제작 대본, 장면, 프롬프트, 생성 기록, 편집 및 검수 메타데이터.
- FLOW-SETUP.md: 이전 설치·오류 해결 기록. 실시간 계정 상태를 보장하지 않습니다.

## 파일 보관

GitHub에는 소스 코드와 제작 문서를 보관합니다. 영상·음성·이미지 파일, 로그인/런타임 데이터, 서명 URL이 포함된 원본 Job 기록은 로컬에 남기며 Git에서 제외합니다. 영상 제목 폴더의 MEDIA-INVENTORY.json에 원본 영상 34개, 내레이션 8개, 렌더링 결과 및 미리보기의 상대 경로·크기·SHA-256을 기록했습니다.

**GitHub를 새 PC에 복제하는 것만으로 기존 영상이 복원되지는 않습니다.** 같은 로컬 프로젝트를 사용하거나 제목 폴더의 원본 미디어와 필요한 비공개 실행 기록을 별도로 옮겨야 합니다. 기존 JSON 일부는 제작 PC의 절대 경로를 포함하므로, 다른 PC에서는 경로를 점검하고 새 편집 계획을 작성하세요. 클립을 무조건 재생성하지 마세요.

## 로컬 검증

Node.js 20 이상, npm, FFmpeg/ffprobe가 필요합니다. 개발 복사본의 패키지는 다음처럼 설치·검증할 수 있습니다.

```powershell
npm ci --prefix tools/google-flow-mcp
npm run typecheck --prefix tools/google-flow-mcp
npm test --prefix tools/google-flow-mcp
node --test tests/assemble-narrated-video.test.mjs
```

이 명령은 패키지·코드 검증이며 Google 계정 연결이나 유료 영상 생성 명령이 아닙니다. 브라우저가 필요한 일부 테스트의 실행 조건과 이번 실제 결과는 [검증 기록](validation/REPOSITORY-VERIFICATION.md)을 참고하세요.

## 개발 복사본 출처

Flow MCP 개발 복사본의 원본은 [retrolyze52/google-flow-mcp](https://github.com/retrolyze52/google-flow-mcp)이며, 기준 커밋은 6826452a4a2e93bf7313d1be1626a9034fd7dc27입니다. 이 프로젝트의 Flow UI 대응 수정이 포함되어 있으므로 수정되지 않은 원본 배포판으로 취급하지 않습니다. 원본 MIT 라이선스와 저작권 고지는 tools/google-flow-mcp/LICENSE에 보존했습니다.
