# 새 대화 인수인계 — 2026-09-10

현재 프로젝트는 **롯데월드타워 설명 영상의 첫 제작본이 로컬에 있고, 내레이션 품질 개선을 논의하는 단계**입니다. 영상 34개를 다시 생성하는 단계가 아닙니다. 파일 생성·디코딩 성공과 사용자가 원하는 목소리 품질 달성을 구분해야 합니다.

## 프로젝트와 파일 위치

- 저장소: https://github.com/korea333333-web/___you___tube
- 작업 폴더: 이 저장소의 루트. 같은 PC에서는 기존 `youtube` 프로젝트를 열어 이어서 작업합니다.
- 영상 제목 폴더: `555m 롯데월드타워는 어떻게 지었을까/`
- 루트의 `script.md`, `scenes.md`, `veo-prompts.md`, `generation-log.md`는 양식입니다. 실제 대본과 제작 기록은 제목 폴더에 있습니다.
- GitHub에는 소스·테스트·대본·프롬프트·생성 로그·편집 메타데이터·검수 요약을 보관합니다. `MEDIA-INVENTORY.json`에는 원본 클립·내레이션·완성본 등의 상대 경로, 파일 크기와 SHA-256을 기록합니다. 실제 영상·음성 파일은 로컬에만 남습니다.
- 서명된 미디어 URL이 포함될 수 있는 `generation-queue.json`, `scene-*/job.json`, `*.flow.json`, `production-runs/`, `document-sync-backups/` 및 원시 진단 자료는 GitHub에 포함하지 않습니다. 아래에 이 파일이 언급되면 같은 로컬 프로젝트에서 확인할 자료라는 뜻입니다. GitHub만 새 PC에 복제하면 원본 미디어·실행 큐·인증 상태가 없으므로 다운로드나 재생성을 임의로 시작하지 않습니다. `.gitignore`와 실제 추적 파일을 함께 확인합니다.
- 로컬 경로가 들어 있는 기존 실행 manifest는 다른 PC에서 경로를 확인하고 새 manifest로 바인딩해야 합니다. 기존 산출물과 기록을 임의로 덮어쓰지 않습니다.

## 실제 제작 결과와 남은 문제

2026-09-10 로컬 `production-plan.json`, `audio/narration-groups.json`, `production-notes.md`, `qa/final-film-verification.json`을 확인했습니다.

- Google Flow의 Omni 1.1 Flash로 10초·16:9·1출력 클립 34개를 생성하고 다운로드했습니다. 원본 클립은 제목 폴더의 `scene-01/`부터 `scene-34/`에 있습니다. 정확한 과금 크레딧 수치는 도구에서 확인되지 않았습니다.
- `555m-롯데월드타워-완성본.mp4`는 306.766667초, 약 5분 7초, 1280×720, 30fps, H.264/AAC이며 파일 크기는 118,320,446바이트입니다.
- 내레이션은 8개 그룹의 한국어 여성 `Microsoft Heami Desktop`, rate 0입니다. 오디오 메타데이터에는 `local_free_voice_candidate_not_user_voice_approved`로 기록되어 있습니다.
- 사용자는 이 목소리에 명확히 불만을 표시했습니다. 원하는 결과는 자연스럽고 신뢰감 있는 여성 아나운서 톤입니다. 현재 목소리는 승인된 최종 목소리가 아닙니다.
- 전체 디코딩, 검정 화면 구간, 음량 등의 기술 검사는 수행했습니다. 시각 검수는 원본의 표본 프레임과 완성본 9개 프레임에 근거합니다. 에이전트가 전체 음성을 실제로 듣고 자연스러움까지 검수했다고 주장해서는 안 됩니다.
- `production-plan.json`의 `complete`와 `complete_verified`는 기존 산출물·기술 검사 상태입니다. 사용자 음성 품질 승인이나 공개 가능한 콘텐츠의 최종 승인을 뜻하지 않습니다.
- 생성 장면은 설명용 AI 재구성입니다. 실제 공사 기록 영상이나 실제 도면의 정확한 재현이 아닙니다. 일부 모형·카트·엘리베이터 디자인 및 생성 문자에 불연속이 있습니다.

장면 순서에 주의합니다. 최초 테스트가 대본 Scene 2여서 출력 폴더 `scene-01`에는 대본 Scene 2, 출력 폴더 `scene-02`에는 대본 Scene 1이 대응합니다. 이후 3~34는 같습니다. 파일 이름이나 폴더 번호만으로 순서를 추측하지 말고 `generation-queue.json`의 `sceneNumber`와 `outputSlot`을 사용합니다.

## 사용자의 최신 의도

사용자는 일단 새 작업을 멈추고 개선 방향을 이야기하자고 했으며, 이후 Google 목소리 샘플과 ElevenLabs 연결 방식을 물었습니다. **기존 34개 클립을 일괄 재생성하거나 다른 제공업체에서 새 유료 제작을 시작하라는 요청은 아닙니다.** 지금 요청한 작업은 저장소 커밋·푸시와 다음 대화로의 인수인계입니다.

- 사용자는 Higgsfield를 사용하지 않습니다. Higgsfield 경유 ElevenLabs 생성은 제외합니다.
- ElevenLabs는 사용자가 이미 월 구독 중이라고 밝혔습니다. 사용하려면 본인 ElevenLabs 계정에 직접 연결하는 방식을 검토합니다.
- Google Gemini TTS가 더 좋은지 관심이 있습니다. 같은 한국어 대본으로 직접 비교하기 전에는 어느 제공업체가 무조건 더 좋다고 단정하지 않습니다.
- 후속 작업은 기존 클립 재사용을 우선하고, 목소리와 읽는 방식부터 짧은 샘플로 검토하는 방향입니다. 실제 진행 범위는 새 대화에서 사용자의 요청에 맞춥니다.

## 음성 모델과 연결: 확인된 사실 / 미완료 상태

### Google

Gemini TTS는 한국어와 자연어를 통한 말투·속도·억양 지시를 지원합니다. 문서상 후보로 `Kore`와 `Erinome`을 검토했지만, 이 프로젝트 대본으로 생성·청취 평가한 결과는 없습니다. 현재 모델 이름과 제공 조건은 실제 연결 시 공식 문서를 다시 확인합니다. [Gemini 음성 생성 문서](https://ai.google.dev/gemini-api/docs/speech-generation)

이전 대화에서 안내한 한국어 샘플은 **Chirp 3 HD의 공식 공개 데모**입니다. 프로젝트 대본으로 만든 Gemini TTS 결과가 아닙니다.

- [Chirp 3 HD Kore 데모](https://docs.cloud.google.com/static/text-to-speech/docs/audio/ko-KR-Chirp3-HD-Kore.wav)
- [Chirp 3 HD Erinome 데모](https://docs.cloud.google.com/static/text-to-speech/docs/audio/ko-KR-Chirp3-HD-Erinome.wav)

당시 Google TTS 전용 도구나 사용 가능한 Gemini API 인증을 확인하지 못했고, 브라우저 제어 도구의 로컬 실행 오류도 있었습니다. 따라서 새로운 Google 음성을 생성하지 못했습니다. 현재 Flow MCP의 이미지·동영상 생성 기능을 독립 TTS 기능으로 오인하지 않습니다. Flow 구독 크레딧과 Gemini API 이용 조건도 자동으로 같다고 가정하지 않습니다. [Google AI 요금제와 API 설명](https://ai.google.dev/gemini-api/docs/google-ai-plans)

### ElevenLabs 직접 연결

공식 hosted MCP 문서에 다음 서버와 OAuth 로그인이 안내되어 있습니다.

```text
https://api.elevenlabs.io/v1/mcp
```

문서상 본인 ElevenLabs 계정으로 로그인하며, 클라이언트에 API 키를 복사하지 않는 방식입니다. 텍스트에서 음성을 생성하여 짧은 유효기간의 다운로드 링크를 반환하는 기능도 명시되어 있습니다. 다만 **이 Codex 작업에서 실제 연결·인증·도구 목록 조회·음성 생성은 아직 하지 않았습니다.** 문서 지원과 현재 연결 완료를 구분해야 합니다. 클라이언트의 OAuth/hosted client metadata 지원도 실제 확인 대상입니다. [ElevenLabs 공식 hosted MCP 안내](https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp)

현재 대화에서 사용 가능한 도구 목록에는 ElevenLabs 전용 연결이 없었고, Higgsfield의 ElevenLabs 엔진 선택 기능만 보였습니다. 이것을 사용자의 ElevenLabs 계정이 연결되었다는 증거로 삼으면 안 됩니다.

ElevenLabs API를 쓴다는 이유만으로 별도 월 구독을 반드시 추가하는 것은 아닙니다. 같은 계정의 이용 한도와 모델·플랜에 따라 크레딧이 소비되고, 초과 사용은 별도 과금 가능성이 있습니다. 실제 사용자 플랜, 잔액, 초과 과금 설정은 확인하지 않았습니다. [ElevenLabs 결제 안내](https://elevenlabs.io/docs/overview/administration/billing)

## 후속 작업 때 읽을 파일과 재사용할 코드

제목 폴더:

- `script.md`, `research.md`: 실제 대본과 근거 자료
- `narration-brief.md`: 내레이션 요구
- `scenes.json`, `scenes.md`, `veo-prompts.md`: 장면 구성과 제출 프롬프트
- `generation-queue.json`, `generation-log.md`, `scene-*/job.json`: 기존 클립의 실제 생성·다운로드 대응 관계
- `audio/narration-groups.json`: 기존 8개 내레이션 그룹과 발화 텍스트
- `assembly.json`, `assembly-final-001/resolved-plan.json`, `assembly-final-001/assembly-result.json`: 기존 편집 구성과 결과
- `production-notes.md`, `qa/final-film-verification.json`, `qa/production-quality-summary.json`: 기술 검증과 알려진 한계

프로젝트 루트:

- `scripts/assemble-narrated-video.mjs`: 주어진 로컬 영상과 내레이션으로 MP4 편집. 원본 클립 음성 제거, 발화 길이에 따른 컷 배분, 기존 파일 덮어쓰기 거부. 부족한 영상을 임의 반복·정지·감속해 채우지 않음.
- `scripts/create-production-assembly.mjs`: 실제 다운로드 Job과 8개 음성 그룹을 바탕으로 편집 manifest 작성. 음성 교체 시 새 파일 경로·길이와 새 output/workDir를 검증해야 함.
- `drafts/lotte-world-tower/edit-shot-weights.json`: 기존 장면별 편집 길이 배분.
- `scripts/create-flow-contact-sheets.mjs`: 클립 표본 프레임 검수 자료 작성.
- `scripts/finalize-flow-documents.mjs`: 실제 결과에 근거한 문서 동기화. 기존 상태를 무조건 새 품질 승인으로 바꾸는 도구가 아님.
- `scripts/run-flow-production.mjs`: 유료 Flow 제출을 포함하는 제작 실행기. 상태 확인이나 음성 개선 논의를 위해 다시 실행하지 않음.
- `tools/google-flow-mcp/`: 사용자가 수정을 승인한 개발 복사본. 이번 저장소에는 실행 가능한 소스와 upstream MIT 라이선스를 함께 보관합니다. 내부 Git 이력은 로컬 `.local/git-backups/`에 백업하고 개발 소스는 상위 저장소에서 관리합니다. 원본 설치 소스는 수정 금지.

Flow 로그인 반복 문제와 새 UI 대응은 개발 복사본에서 개선했고, 실제 34개 생성·다운로드까지 수행했습니다. 새 대화에서 Flow 작업이 필요하면 먼저 계정 상태를 조회하고, 연결되어 있으면 불필요한 재로그인을 요구하지 않습니다. `FLOW-SETUP.md`는 여러 시점의 진단이 누적된 역사 기록이며, 앞부분의 미연결·미생성 상태를 현재 상태로 읽지 않습니다. 이전 세션 ID나 연결 ID는 재사용하지 않습니다.

## 범위와 승인 해석

`AGENTS.md`를 끝까지 읽습니다. 처음의 기본 범위에는 내레이션·편집 제외가 있지만, 같은 파일의 2026-09-10 추가 조항에는 이번 롯데월드타워 영상의 내레이션, 최종 편집, 34개 Flow 생성에 대한 명시 승인이 있습니다. 이 역사를 새로 없는 승인처럼 취급하거나 기본 조항만 읽고 이미 요청된 작업을 거부하지 않습니다.

동시에 그 승인을 다른 제공업체 과금, 새 일괄 재생성, 업스케일, 음악·자막·YouTube 업로드의 포괄 승인으로 확대하지 않습니다. 최신 사용자 요청인 음성 품질 논의와 현재 작업 범위를 먼저 반영합니다. 이번 인수인계 문서 작성에서는 `AGENTS.md`를 변경하지 않았습니다.

## 새 대화에 붙여 넣을 프롬프트

```text
이 GitHub 프로젝트를 이어서 도와줘:
https://github.com/korea333333-web/___you___tube

먼저 HANDOFF.md와 AGENTS.md를 끝까지 읽고 실제 파일 상태를 확인해줘.
롯데월드타워 영상은 Flow 클립 34개와 약 5분 7초 MP4까지 만들었지만, Windows Heami 내레이션이 마음에 들지 않아 목소리를 개선하는 단계야. 기술적으로 파일이 완성됐다는 것과 목소리 품질이 승인됐다는 것을 구분해줘.

나는 Higgsfield를 사용하지 않아. 이미 구독 중인 내 ElevenLabs 계정에 직접 연결할 수 있는 방법과 Google Gemini TTS를 비교하고 싶어. ElevenLabs 공식 OAuth MCP는 문서만 확인했고 실제 연결하지 않았어. 앞서 들려준 Google 공개 샘플은 Chirp 3 HD였고, 우리 대본으로 만든 Gemini TTS 샘플은 아직 없어.

우선 기존 결과와 연결 상태를 확인하고, 신뢰감 있는 한국어 여성 아나운서 목소리를 어떻게 짧게 비교할지 설명해줘. 내가 요청하기 전에는 기존 클립을 일괄 재생성하거나 전체 음성을 교체하지 마. 기존 34개 클립을 재사용하는 방향으로 이어가자.
```
