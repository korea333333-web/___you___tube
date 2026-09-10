# 저장소 게시 전 검증 — 2026-09-10

- Flow MCP TypeScript 검사: npm run typecheck 통과.
- Flow MCP 기존 테스트: node --import tsx --test tests/*.test.ts, 총 51개 중 42개 통과, 9개 건너뜀, 실패 0개. 브라우저 실행 조건이 설정되지 않은 테스트는 건너뛰었으며 실제 Flow 계정을 조작하지 않았습니다.
- 내레이션 영상 조립: node --test tests/assemble-narrated-video.test.mjs, 총 5개 통과, 실패 0개. 합성 테스트 자료로 원본 보존, 클립 원음 교체, 경로 이탈 거부, 잘못된 계획 거부와 최종 MP4를 확인했습니다.
- 원본 영상 34개와 내레이션 8개, 기존 렌더 및 미리보기의 파일 크기·SHA-256은 제목 폴더의 MEDIA-INVENTORY.json에 기록했습니다.
- 이번 검증은 새로운 영상이나 내레이션을 생성하지 않았습니다. 기술 검사 통과는 사용자의 목소리 품질 승인을 의미하지 않습니다.
- 게시 후보 텍스트·소스의 인증 정보와 서명 URL을 검토했습니다. 서명 URL이 포함된 원본 큐·Job·Flow 응답은 제외하고 로컬에 보존합니다.
