# Firefox Video Downloader

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Firefox](https://img.shields.io/badge/Firefox-MV2-orange.svg)](https://extensionworkshop.com/)
[![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)](manifest.json)

현재 탭의 동영상을 자동으로 감지해서 원본 화질로 다운로드하는 Firefox 확장 프로그램입니다. TikTok(FYP·프로필·단일 영상)에서는 작성자명과 캡션까지 자동으로 추출해 파일명에 반영합니다.

---

## 목차

- [특징](#특징)
- [스크린샷](#스크린샷)
- [설치](#설치)
- [사용법](#사용법)
- [아키텍처](#아키텍처)
- [프로젝트 구조](#프로젝트-구조)
- [권한](#권한)
- [알려진 한계](#알려진-한계)
- [개발](#개발)
- [기여](#기여)
- [라이선스](#라이선스)

---

## 특징

### 범용 동영상 감지
- `webRequest.onHeadersReceived`로 모든 HTTP 응답의 MIME 타입·크기를 분석해 비디오를 실시간 수집
- **포맷**: MP4, WebM, OGG, AVI, MKV, FLV, MOV, M4V, TS, HLS(`.m3u8`), DASH(`.mpd`)
- 썸네일·작은 프리뷰는 크기 필터로 자동 제외 (100KB 이상)

### 구조화된 제목 추출
- **JSON-LD** `VideoObject` / `SocialMediaPosting` / `Article` 스키마
- 메타 태그: `og:title`, `og:description`, `twitter:title`, `twitter:description`
- **사이트별 셀렉터**: YouTube 채널명, Twitter 계정, Instagram, Twitch 등
- `Content-Disposition` 헤더의 filename 파싱
- 여러 소스를 조합해 `작성자 - 제목 - 설명` 형태로 자동 파일명 생성

### TikTok 최적화
- **초기 로드 영상**: HTML에 포함된 `__UNIVERSAL_DATA_FOR_REHYDRATION__` 파싱
- **스크롤 로드 영상**: Firefox `filterResponseData`로 `/api/recommend/item_list/`, `/api/post/item_list/` 등 API 응답 본문을 background에서 직접 가로채기 (콘텐츠 스크립트 isolated world 우회)
- 작성자(`uniqueId`·`nickname`), 캡션, `videoId`, 파일 크기를 아이템별로 자동 추출
- 동일 `videoId`의 여러 화질 URL을 하나로 합쳐 **영상당 1개 엔트리만** 표시
- **워터마크 없는 URL 우선 선택**: `bitrateInfo`의 `lr=unwatermarked` → `playAddr` → `downloadAddr` 순
- CDN 다운로드 시 `Referer` 헤더 주입으로 403 방지

### SPA 네비게이션 대응
- `history.pushState` / `replaceState` / `popstate` 훅
- `MutationObserver`로 `<video>` 요소 추가 감지
- URL 변경 시 자동 재스캔 (1.5초 + 4초 두 번, 지연 로딩 대응)

### 팝업 UI
- 파일명·URL·확장자·제목 통합 검색
- 크기·최신·확장자별 정렬
- 확장자 필터 및 **제목 소스 선택** (full / author-title / video-desc / json-ld / og:title / ...)
- 동일 영상의 여러 화질은 접어서 표시 (열어서 개별 다운로드 가능)
- 첫 프레임 썸네일, 다운로드 완료 표시, 마퀴 스크롤 긴 제목 처리

---

## 스크린샷

> _추가 예정_

---

## 설치

### 임시 로드 (개발 · 테스트용)

1. `about:debugging` 접속
2. 좌측 **이 Firefox** 선택
3. **임시 부가 기능 로드...** 클릭
4. 이 저장소의 `manifest.json` 선택

Firefox를 재시작하면 임시 확장은 사라집니다. 영구 사용하려면 아래 *서명되지 않은 확장 허용* 방식을 참고하세요.

### 영구 설치 (Developer Edition / Nightly 전용)

1. `about:config` 에서 `xpinstall.signatures.required` 를 `false` 로 설정
2. 저장소 루트를 `.zip` 으로 압축 후 확장자를 `.xpi` 로 변경
3. `about:addons` 에 드래그하여 설치

### 빌드

```bash
# (선택) web-ext 로 개발·패키징
npx web-ext run              # 실시간 디버깅
npx web-ext build            # .zip 패키지 생성 → web-ext-artifacts/
```

---

## 사용법

1. 다운로드하고 싶은 동영상이 있는 페이지로 이동
2. 툴바의 확장 아이콘 클릭 → 팝업 오픈
3. 감지된 영상 목록에서 **다운로드** 버튼 클릭
4. 파일명은 자동으로 `작성자 - 제목 - 설명.mp4` 형태로 생성됨 (제목 소스는 드롭다운에서 변경 가능)

### TikTok 사용 팁

- 영상을 **재생한 후** 다운로드해야 합니다 (재생 전엔 TikTok이 CDN URL을 요청하지 않음)
- 스크롤로 여러 영상을 지나가면서 팝업을 열면 **배치로 한 번에 다운로드** 가능
- 서명된 URL은 약 1시간 후 만료 → 가능한 한 빨리 다운로드

### 스트림 파일(m3u8 / mpd)

브라우저 다운로드 API로는 매니페스트만 받을 수 있습니다. 실제 영상으로 합치려면 [ffmpeg](https://ffmpeg.org)가 필요합니다:

```bash
ffmpeg -i "https://...playlist.m3u8" -c copy output.mp4
```

---

## 아키텍처

```
┌─────────────────┐         ┌──────────────────┐         ┌──────────────┐
│   웹 페이지      │         │  content.js       │         │ background.js │
│                 │         │  (모든 탭)        │         │  (단일 인스턴스) │
│ __UNIVERSAL_    │──DOM──▶│ scanVideos()     │  scan   │              │
│ DATA__, <video>,│         │ extractPageTitle │────────▶│              │
│ DOM 요소         │         │ SPA 훅/옵저버    │         │ detectedVideos│
└─────────────────┘         └──────────────────┘         │ (탭별 목록)   │
                                                         │              │
┌─────────────────┐                                      │ onHeaders    │
│  TikTok API     │──── HTTP 응답 ────filterResponseData▶│ Received     │
│ /api/.../list/  │                                      │              │
└─────────────────┘                                      │ onBefore     │
                                                         │ SendHeaders  │
                                                         │ (Referer 주입)│
                                                         └───────┬──────┘
                                                                 │
┌─────────────────┐                                               │
│   팝업 UI       │◀─── getVideos ────────────────────────────────┘
│   (popup.js)    │──── download ───▶ browser.downloads.download()
└─────────────────┘
```

### 동영상 감지 경로 (중복 제거 포함)

1. **HTTP 응답 헤더** → `background.js` `webRequest.onHeadersReceived` → MIME/크기로 판별
2. **TikTok API 응답 본문** → `filterResponseData` → `itemList`/`aweme_list` 파싱 → 메타데이터 추출
3. **HTML 내장 데이터** → `content.js` → `__UNIVERSAL_DATA_FOR_REHYDRATION__` → `webapp.video-detail`, `webapp.updated-items`, `webapp.user-post`
4. **DOM 스캔** → `<video>`, `<source>`, `og:video`, JSON-LD, `data-*` 속성
5. **fetch/XHR 훅** → content.js 내 네트워크 인터셉트 (페이지의 fetch는 안 잡히지만, content script 자체 fetch는 잡힘)

모든 경로에서 수집된 URL은 `tiktokVideoId` 기반으로 중복 제거하여 영상당 1개 엔트리로 통합됩니다.

---

## 프로젝트 구조

```
firefox-video-downloader-extension/
├── manifest.json       # MV2 매니페스트 (permissions, background, content_scripts)
├── background.js       # webRequest 감지, TikTok API 필터링, 다운로드, Referer 주입
├── content.js          # DOM/JSON-LD/__UNIVERSAL_DATA__ 추출, SPA 감지, 제목 후보 수집
├── popup.html          # 팝업 마크업
├── popup.css           # 팝업 스타일
├── popup.js            # 팝업 로직 (검색/정렬/필터/제목 결정/다운로드 호출)
├── icons/              # 16 / 48 / 96 px 아이콘
├── LICENSE             # MIT
└── README.md
```

---

## 권한

| Permission | 용도 |
|------------|-----|
| `webRequest` | 응답 헤더로 비디오 MIME/크기 감지 |
| `webRequestBlocking` | TikTok CDN 요청에 `Referer` 헤더 주입, API 응답 본문 필터링 |
| `downloads` | `browser.downloads.download()` 호출 |
| `activeTab` / `tabs` | 현재 탭 정보 조회, 탭별 상태 관리 |
| `<all_urls>` | 콘텐츠 스크립트 전역 실행 |

모든 처리는 **로컬에서만** 이루어지며 외부 서버로 데이터를 전송하지 않습니다.

---

## 알려진 한계

- **Blob URL / MediaSource**: `<video>`의 `src`가 `blob:`인 경우 브라우저 API로 직접 다운로드 불가. 스트리밍 세그먼트를 ffmpeg 등으로 합쳐야 함.
- **TikTok 서명 만료**: API 응답의 CDN URL은 약 1시간 후 만료됨. 가능한 한 빨리 다운로드할 것.
- **작성자가 박아넣은 워터마크**: 영상 픽셀에 텍스트/로고가 합성된 경우 (TikTok 앱의 자동 워터마크와 다름) 제거 불가.
- **일부 보호된 콘텐츠**: DRM이 적용된 스트리밍 (Netflix, Disney+ 등)은 지원하지 않음.
- **Chromium 미지원**: MV3 에서는 `filterResponseData`와 blocking webRequest가 제거됐기 때문에 Firefox 전용.

---

## 개발

### 실시간 디버깅

```
about:debugging
  → 이 Firefox
  → Video Downloader
  → Inspect   ← background script 콘솔
```

콘텐츠 스크립트 로그는 해당 탭의 DevTools 콘솔에서 **Target** 드롭다운을 "Video Downloader" 로 변경해 확인합니다.

### 코드 수정 후 반영

`about:debugging` → 확장의 **새로 고침** 버튼. 페이지 새로고침은 필요 없음.

### 주요 상태 관리 (background.js)

| 변수 | 설명 |
|-----|------|
| `detectedVideos[tabId]` | 탭별 감지된 비디오 배열 |
| `tiktokVideoMeta[tabId][pathname]` | URL 경로 → TikTok 메타데이터 매핑 |
| `tiktokFeedByVideoId[tabId][videoId]` | videoId → 피드 영상 정보 |
| `completedUrls` | 다운로드 완료된 URL 집합 |

---

## 기여

이슈와 PR 모두 환영합니다.

### 버그 제보 시 포함해주세요

- Firefox 버전 (`about:support`)
- 재현 페이지 URL과 절차
- `about:debugging` → 확장의 **Inspect** → Console 의 에러/경고
- 가능하다면 실패한 요청의 응답 구조 (DevTools Network)

### 개발 가이드라인

- 새 사이트 지원 추가는 `content.js` 의 `extractPageTitle()` 사이트별 섹션에 셀렉터 추가
- TikTok 외 다른 플랫폼의 API 응답 파싱은 `background.js` 의 `filterResponseData` 블록에 분기 추가
- 기존 UI 컴포넌트는 재사용하되 새 기능은 점진적 개선 선호

---

## 라이선스

[MIT](LICENSE) © 2026 hajunwon

이 확장은 개인적·합법적 용도로만 사용해야 합니다. 저작권 보호되는 콘텐츠의 무단 다운로드·배포에 대한 책임은 사용자에게 있습니다.
