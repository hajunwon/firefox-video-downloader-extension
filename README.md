# Firefox Video Downloader

현재 탭에서 재생되거나 로드된 비디오를 자동 감지하고 다운로드하는 Firefox 확장 프로그램입니다. 일반 비디오 사이트는 물론 **TikTok**(FYP, 프로필, 단일 영상 페이지)에서도 원본 화질로 다운로드할 수 있습니다.

## 주요 기능

- **자동 감지**: `webRequest`로 네트워크 트래픽을 모니터링하여 페이지의 비디오/스트림 URL을 실시간 수집
- **다양한 포맷 지원**: MP4, WebM, OGG, AVI, MKV, FLV, MOV, M4V, TS, HLS(`.m3u8`), DASH(`.mpd`)
- **TikTok 전용 최적화**:
  - `__UNIVERSAL_DATA_FOR_REHYDRATION__` 파싱으로 초기 로드 영상 즉시 인식
  - `filterResponseData`로 `/api/recommend/item_list/` 등 API 응답을 background에서 직접 캡처 (isolated world 우회)
  - 작성자, 닉네임, 캡션, videoId 자동 추출
  - CDN URL의 화질 변형들을 `videoId` 기반으로 묶어 **영상당 1개 엔트리**만 표시
  - 다운로드 시 `Referer` 헤더 주입(403 방지)
- **사이트별 제목 추출**: YouTube, Twitter/X, Instagram, Twitch 등에서 작성자/제목을 구조화 데이터(JSON-LD, og/twitter 메타, 사이트 셀렉터)로 추출
- **SPA 네비게이션 대응**: `pushState/replaceState/popstate` 훅 + `MutationObserver`로 URL 변경 시 자동 재스캔
- **팝업 UI**:
  - 파일명/URL/확장자/제목 검색
  - 크기·최신·확장자별 정렬
  - 확장자/제목 소스 필터
  - 제목 소스 선택 (full · author-title · video-desc · json-ld · og:title · description · ...)
  - 화질 그룹핑 (동일 영상의 여러 화질을 접기/펼치기)
  - 썸네일, 마퀴 스크롤, 다운로드 완료 표시
- **제목 조합**: 자동 모드에서 `작성자 + 제목 + 설명`을 최적 조합으로 파일명 생성

## 설치 (임시 로드)

```
1) Firefox 주소창에 about:debugging 입력
2) 좌측 메뉴에서 "이 Firefox" 선택
3) "임시 부가 기능 로드..." 클릭
4) 저장소의 manifest.json 파일 선택
```

확장을 재시작하면 사라집니다. 코드 수정 후에는 같은 화면의 **새로 고침** 버튼으로 반영할 수 있습니다.

## 사용법

1. 비디오가 있는 페이지를 엽니다
2. 툴바의 확장 아이콘을 클릭하여 팝업을 엽니다
3. 감지된 비디오 목록에서 원하는 항목의 **다운로드** 클릭
4. 스트림(`.m3u8`, `.mpd`) 또는 블랍 URL은 ffmpeg 같은 외부 도구가 필요합니다

## 폴더 구조

```
firefox-video-downloader-extension/
├── manifest.json       # MV2 매니페스트
├── background.js       # webRequest 감지, TikTok API 응답 파싱, 다운로드 처리
├── content.js          # DOM/JSON-LD/__UNIVERSAL_DATA__ 추출, 제목 후보 수집
├── popup.html          # 팝업 마크업
├── popup.css           # 팝업 스타일
├── popup.js            # 팝업 로직 (검색/정렬/필터/제목 결정)
└── icons/              # 16/48/96 아이콘
```

## 권한 사용 내역

| Permission | 용도 |
|------------|-----|
| `webRequest` | 응답 헤더 분석으로 비디오 MIME/크기 감지 |
| `webRequestBlocking` | TikTok CDN 다운로드 요청에 `Referer` 헤더 주입, 응답 본문 필터링 |
| `downloads` | `browser.downloads.download()` 호출 |
| `activeTab` / `tabs` | 현재 탭 정보 조회, 탭별 비디오 상태 관리 |
| `<all_urls>` | 모든 사이트에서 콘텐츠 스크립트 실행 |

## 제약 및 알려진 한계

- **Blob URL(MSE)**: `<video>`의 `src`가 `blob:`인 경우 브라우저 API로는 직접 다운로드 불가 → 외부 도구(ffmpeg) 안내
- **TikTok CDN 서명 만료**: API 응답의 서명된 URL은 보통 수십 분~1시간 후 만료. 가능한 한 빨리 다운로드 권장
- **스트리밍 포맷**: `.m3u8`, `.mpd`는 매니페스트만 다운로드되며 실제 재생을 위해서는 ffmpeg 등이 필요
- **동영상 사이트 정책 준수**: 저작권·이용약관을 확인하고 개인적·합법적 용도로만 사용하세요

## 브라우저 호환성

- Firefox **MV2** 전용입니다 (`filterResponseData`, `webRequestBlocking` 의존)
- Chrome MV3로 포팅하려면 이 두 API의 대체 방법이 필요합니다

## 기여

이슈와 PR 환영합니다. 버그 제보 시 다음 정보가 있으면 좋습니다:
- Firefox 버전
- 재현 URL 및 절차
- `about:debugging` → 확장의 **Inspect** → Console 로그

## 라이선스

[MIT](LICENSE)
