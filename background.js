// 탭별로 감지된 비디오 URL 저장
const detectedVideos = {};

// 탭별 페이지 제목 후보
const pageTitles = {};
const pageFlags = {};
const gridVideoTitles = {};

// 비디오 관련 MIME 타입
const VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/avi",
  "video/mkv",
  "video/x-flv",
  "video/quicktime",
  "video/x-matroska",
  "video/x-msvideo",
  "application/vnd.apple.mpegurl",  // HLS
  "application/x-mpegurl",          // HLS
  "application/dash+xml",           // DASH
];

// URL 패턴으로 비디오 감지
const VIDEO_URL_PATTERNS = /\.(mp4|webm|ogg|avi|mkv|flv|mov|m4v|ts)(\?[^#]*)?$/i;
const STREAM_URL_PATTERNS = /\.(m3u8|mpd)(\?[^#]*)?$/i;

// TikTok CDN URL 패턴: 확장자 없이 mime_type 파라미터 또는 경로로 비디오 판별
const TIKTOK_CDN_PATTERNS = /^https?:\/\/(v\d+-[^.]*\.tiktok\.com|[^.]*\.tiktokcdn\.com|[^.]*\.tiktokv\.com)\//i;
const TIKTOK_VIDEO_HINT = /mime_type=video|\/video\//i;
// 오디오/음악 트랙 패턴 (TikTok CDN에서 제외)
const TIKTOK_AUDIO_HINT = /\/music\/|mime_type=audio|_audio_|\/tos-[^/]+-audio\//i;

// 최소 크기 필터 (100KB) - 썸네일이나 작은 프리뷰 제외
const MIN_SIZE = 100 * 1024;
// TikTok 비디오 최소 크기 (1MB) - 오디오 트랙/프리뷰 제외
const TIKTOK_MIN_VIDEO_SIZE = 1024 * 1024;

function addVideo(tabId, info) {
  if (!detectedVideos[tabId]) {
    detectedVideos[tabId] = [];
  }

  // TikTok URL이면 pathname 조회로 메타데이터 보강 (누락 필드만)
  if (info.isTiktok && tiktokVideoMeta[tabId]) {
    const meta = tiktokVideoMeta[tabId][tiktokUrlKey(info.url)];
    if (meta) {
      info.tiktokVideoId = info.tiktokVideoId || meta.videoId || null;
      info.tiktokUsername = info.tiktokUsername || meta.username || null;
      info.tiktokNickname = info.tiktokNickname || meta.nickname || null;
      info.tiktokDesc = info.tiktokDesc || meta.desc || null;
    }
  }

  // 1) 동일 URL 중복 제거 (메타데이터 병합)
  const existingIdx = detectedVideos[tabId].findIndex((v) => v.url === info.url);
  if (existingIdx !== -1) {
    const existing = detectedVideos[tabId][existingIdx];
    detectedVideos[tabId][existingIdx] = {
      ...info,
      ...existing,
      tiktokVideoId: existing.tiktokVideoId || info.tiktokVideoId || null,
      tiktokUsername: existing.tiktokUsername || info.tiktokUsername || null,
      tiktokNickname: existing.tiktokNickname || info.tiktokNickname || null,
      tiktokDesc: existing.tiktokDesc || info.tiktokDesc || null,
      isTiktok: existing.isTiktok || info.isTiktok || false,
    };
    return;
  }

  // 2) TikTok 영상: 동일 videoId가 이미 있으면 스킵 (다른 화질 URL이라도 같은 영상)
  if (info.isTiktok && info.tiktokVideoId) {
    const existingByVid = detectedVideos[tabId].findIndex((v) =>
      v.tiktokVideoId === info.tiktokVideoId
    );
    if (existingByVid !== -1) {
      // 기존 엔트리의 부족한 메타데이터만 보충
      const existing = detectedVideos[tabId][existingByVid];
      existing.tiktokUsername = existing.tiktokUsername || info.tiktokUsername;
      existing.tiktokNickname = existing.tiktokNickname || info.tiktokNickname;
      existing.tiktokDesc = existing.tiktokDesc || info.tiktokDesc;
      return;
    }
  }

  detectedVideos[tabId].push(info);

  // 배지 업데이트
  const count = detectedVideos[tabId].length;
  browser.browserAction.setBadgeText({ text: String(count), tabId });
  browser.browserAction.setBadgeBackgroundColor({ color: "#e74c3c", tabId });

  // 팝업이 열려있으면 알림
  browser.runtime.sendMessage({ action: "videoAdded", tabId }).catch(() => {});
}

// Content-Type 헤더로 비디오 감지
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const contentType = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === "content-type"
    );
    const contentLength = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === "content-length"
    );

    const mime = contentType?.value?.toLowerCase() || "";
    const size = parseInt(contentLength?.value || "0", 10);
    const url = details.url;

    // Content-Disposition에서 파일명 추출
    const contentDisp = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === "content-disposition"
    );
    const dispFilename = parseContentDisposition(contentDisp?.value);

    const isMimeVideo = VIDEO_MIME_TYPES.some((t) => mime.includes(t));
    const isUrlVideo = VIDEO_URL_PATTERNS.test(url);
    const isStream = STREAM_URL_PATTERNS.test(url);
    const isTiktokCdn = TIKTOK_CDN_PATTERNS.test(url);
    const isTiktokAudio = isTiktokCdn && TIKTOK_AUDIO_HINT.test(url);
    // TikTok CDN: 도메인 매칭 + (MIME 타입 또는 URL 힌트) + 오디오 제외
    const isTiktokVideo = isTiktokCdn && !isTiktokAudio && (isMimeVideo || TIKTOK_VIDEO_HINT.test(url));

    // TikTok 오디오 트랙은 완전히 제외
    if (isTiktokAudio) return;

    if (isMimeVideo || isUrlVideo || isStream || isTiktokVideo) {
      // 작은 파일 필터링 (스트림은 크기 무시)
      if (!isStream && !isTiktokVideo && size > 0 && size < MIN_SIZE) return;
      // TikTok 비디오는 더 큰 크기 임계값 (오디오/프리뷰 제외)
      if (isTiktokVideo && size > 0 && size < TIKTOK_MIN_VIDEO_SIZE) return;
      // MIME이 오디오면 제외
      if (mime.startsWith("audio/")) return;

      const type = isStream ? "stream" : "direct";
      const ext = guessExtension(url, mime);

      addVideo(details.tabId, {
        url,
        type,
        mime,
        size,
        ext,
        dispFilename,
        isTiktok: isTiktokCdn,
        timestamp: Date.now(),
      });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// URL에서 확장자 추측
function guessExtension(url, mime) {
  const urlMatch = url.match(/\.([a-z0-9]{2,5})(\?|$)/i);
  if (urlMatch) return urlMatch[1].toLowerCase();

  // TikTok CDN URL에서 mime_type 쿼리 파라미터 확인
  const mimeParam = url.match(/[?&]mime_type=video[_/](\w+)/i);
  if (mimeParam) return mimeParam[1].toLowerCase();

  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpegurl")) return "m3u8";
  if (mime.includes("dash")) return "mpd";
  return "mp4";
}

// 다운로드 파일명 안전하게 정리
function sanitizeDownloadFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim() || "video.mp4";
}

// Content-Disposition 헤더에서 filename 추출
function parseContentDisposition(value) {
  if (!value) return null;
  // filename*=UTF-8''encoded_name
  const utf8Match = value.match(/filename\*\s*=\s*UTF-8''(.+?)(?:;|$)/i);
  if (utf8Match) {
    try { return decodeURIComponent(utf8Match[1].trim()); } catch {}
  }
  // filename="name" or filename=name
  const match = value.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (match) return match[1].trim();
  return null;
}

// 파일 크기 포맷
function formatSize(bytes) {
  if (!bytes || bytes === 0) return "크기 불명";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

// TikTok CDN URL을 경로(pathname)로 정규화 — 쿼리 서명 차이 무시
function tiktokUrlKey(url) {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url;
  }
}

// tiktokMeta는 content script에서 이미 경로(key) 기반으로 저장되어 있음
function findTiktokMetaByPath(url, tiktokMeta) {
  const key = tiktokUrlKey(url);
  return tiktokMeta[key] || tiktokMeta[url] || null;
}

// content script에서 TikTok 비디오 메타데이터 저장
// key는 URL 경로(pathname) — 쿼리 서명 차이 무시
// 병합 규칙: 기존 메타 유지 + API 소스가 DOM 스냅샷보다 우선
function storeTiktokVideoMetadata(tabId, scanResult) {
  if (!scanResult) return;
  if (!tiktokVideoMeta[tabId]) tiktokVideoMeta[tabId] = {};

  // domVideos에서 tiktokVideoId 추출
  if (scanResult.domVideos) {
    for (const v of scanResult.domVideos) {
      if (v.tiktokVideoId) {
        const key = tiktokUrlKey(v.url);
        const existing = tiktokVideoMeta[tabId][key] || {};
        tiktokVideoMeta[tabId][key] = {
          ...existing,
          videoId: v.tiktokVideoId,
          quality: v.quality || existing.quality || null,
          source: v.source || existing.source,
        };
      }
    }
  }

  // TikTok API 응답 / DOM 스냅샷에서 수집된 메타데이터 병합
  if (scanResult.tiktokVideoMap) {
    for (const [key, meta] of Object.entries(scanResult.tiktokVideoMap)) {
      const existing = tiktokVideoMeta[tabId][key] || {};
      // API 메타는 DOM 스냅샷보다 우선, 기존 정보는 유지
      const isApi = meta.source === "tiktok-api";
      const existingIsApi = existing.source === "tiktok-api";
      if (isApi || !existingIsApi) {
        tiktokVideoMeta[tabId][key] = { ...existing, ...meta };
      } else {
        // 기존 API 메타에 부족한 필드만 보충
        tiktokVideoMeta[tabId][key] = {
          ...meta,
          ...existing,
        };
      }
    }
  }

  // TikTok 피드 영상 리스트 저장 (videoId → 작성자/캡션)
  if (scanResult.tiktokFeedVideos) {
    if (!tiktokFeedByVideoId[tabId]) tiktokFeedByVideoId[tabId] = {};
    for (const feed of scanResult.tiktokFeedVideos) {
      if (feed.videoId) {
        tiktokFeedByVideoId[tabId][feed.videoId] = feed;
      }
    }
  }
}

// 탭별 TikTok 비디오 메타데이터
const tiktokVideoMeta = {};

// 탭별 TikTok 피드 영상 리스트 (videoId 기반 매핑)
// tiktokFeedByVideoId[tabId][videoId] = { username, nickname, desc, source }
const tiktokFeedByVideoId = {};

// 이미 등록된 detectedVideos 엔트리에 대해 tiktokVideoMeta(pathname 기반)로 메타데이터 보강
function enrichDetectedWithTiktokMeta(tabId) {
  if (!detectedVideos[tabId] || !tiktokVideoMeta[tabId]) return;
  for (const v of detectedVideos[tabId]) {
    if (!v.isTiktok || v.tiktokVideoId) continue;
    const meta = tiktokVideoMeta[tabId][tiktokUrlKey(v.url)];
    if (meta) {
      v.tiktokVideoId = meta.videoId || null;
      v.tiktokUsername = v.tiktokUsername || meta.username || null;
      v.tiktokNickname = v.tiktokNickname || meta.nickname || null;
      v.tiktokDesc = v.tiktokDesc || meta.desc || null;
    }
  }
}

// 같은 tiktokVideoId를 가진 중복 엔트리를 1개로 합침
function dedupTiktokVideos(tabId) {
  if (!detectedVideos[tabId]) return;
  const before = detectedVideos[tabId].length;
  const seen = new Map(); // videoId -> kept entry
  const toKeep = [];
  for (const v of detectedVideos[tabId]) {
    if (v.tiktokVideoId && v.isTiktok) {
      const existing = seen.get(v.tiktokVideoId);
      if (existing) {
        existing.tiktokUsername = existing.tiktokUsername || v.tiktokUsername;
        existing.tiktokNickname = existing.tiktokNickname || v.tiktokNickname;
        existing.tiktokDesc = existing.tiktokDesc || v.tiktokDesc;
        // 크기 정보가 있는 쪽을 보존
        if (!existing.size && v.size) existing.size = v.size;
        if (!existing.mime && v.mime) existing.mime = v.mime;
        continue;
      }
      seen.set(v.tiktokVideoId, v);
    }
    toKeep.push(v);
  }
  detectedVideos[tabId] = toKeep;
  // 중복이 제거됐다면 배지 업데이트
  if (toKeep.length !== before) {
    const count = toKeep.length;
    browser.browserAction.setBadgeText({
      text: count > 0 ? String(count) : "",
      tabId,
    });
  }
}

// content script에서 감지된 비디오 추가
function mergeContentScriptVideos(tabId, scanResult) {
  if (!scanResult) return;

  const allUrls = [];

  // DOM에서 발견된 비디오 — 메타데이터 전체 동봉
  if (scanResult.domVideos) {
    scanResult.domVideos.forEach((v) => allUrls.push({
      url: v.url,
      source: v.source,
      tiktokVideoId: v.tiktokVideoId || null,
      tiktokUsername: v.tiktokUsername || null,
      tiktokNickname: v.tiktokNickname || null,
      tiktokDesc: v.tiktokDesc || null,
    }));
  }

  // fetch/XHR로 가로챈 비디오 URL — 메타데이터 동봉
  if (scanResult.interceptedUrls) {
    scanResult.interceptedUrls.forEach((v) => allUrls.push({
      url: v.url,
      source: v.source,
      tiktokVideoId: v.tiktokVideoId || null,
      tiktokUsername: v.tiktokUsername || null,
      tiktokNickname: v.tiktokNickname || null,
      tiktokDesc: v.tiktokDesc || null,
    }));
  }

  for (const item of allUrls) {
    const url = item.url;
    if (!url || url.startsWith("blob:")) continue;

    const ext = guessExtension(url, "");
    const isStream = /\.(m3u8|mpd)(\?|$)/i.test(url);
    const isTiktok = TIKTOK_CDN_PATTERNS.test(url) || (item.source && item.source.startsWith("tiktok-"));

    addVideo(tabId, {
      url,
      type: isStream ? "stream" : "direct",
      mime: "",
      size: 0,
      ext: isTiktok && ext === "mp4" ? "mp4" : ext,
      source: item.source,
      tiktokVideoId: item.tiktokVideoId || null,
      tiktokUsername: item.tiktokUsername || null,
      tiktokNickname: item.tiktokNickname || null,
      tiktokDesc: item.tiktokDesc || null,
      isTiktok,
      timestamp: Date.now(),
    });
  }

  // TikTok 메타데이터 저장
  storeTiktokVideoMetadata(tabId, scanResult);

  // Blob URL 정보 (다운로드는 불가하지만 표시)
  if (scanResult.capturedBlobs) {
    scanResult.capturedBlobs.forEach((blob) => {
      addVideo(tabId, {
        url: blob.blobUrl,
        type: "blob",
        mime: blob.mimeType,
        size: 0,
        ext: blob.mimeType === "MediaSource" ? "mse" : "blob",
        source: "blob-capture",
        timestamp: blob.timestamp,
      });
    });
  }

  // 메타데이터 저장 후 기존 엔트리 재보강 및 중복 제거
  enrichDetectedWithTiktokMeta(tabId);
  dedupTiktokVideos(tabId);

  // 페이지 제목 후보 저장
  if (scanResult.titleCandidates?.length) {
    pageTitles[tabId] = scanResult.titleCandidates;
  }

  // 단일 영상 페이지 여부
  if (scanResult.singleVideoPage !== undefined) {
    pageFlags[tabId] = { singleVideoPage: scanResult.singleVideoPage };
  }

  // 그리드 영상별 제목 (TikTok 프로필 등)
  if (scanResult.gridTitles && Object.keys(scanResult.gridTitles).length > 0) {
    gridVideoTitles[tabId] = scanResult.gridTitles;
  }
}

// 팝업에서 메시지 수신
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // TikTok SPA 네비게이션: content script에서 URL 변경 감지 시 재스캔 결과 수신
  if (msg.action === "spaNavigation" && sender.tab) {
    const tabId = sender.tab.id;
    mergeContentScriptVideos(tabId, msg.scanResult);
    // 팝업이 열려있으면 알림
    browser.runtime.sendMessage({ action: "videoAdded", tabId }).catch(() => {});
    return;
  }

  if (msg.action === "getVideos") {
    // content script에서도 비디오 스캔 후 합쳐서 반환
    browser.tabs
      .sendMessage(msg.tabId, { action: "scanDOM" })
      .then((scanResult) => {
        mergeContentScriptVideos(msg.tabId, scanResult);
      })
      .catch(() => {})
      .finally(() => {
        const videos = detectedVideos[msg.tabId] || [];
        const titles = pageTitles[msg.tabId] || [];
        const flags = pageFlags[msg.tabId] || {};
        const gridTitles = gridVideoTitles[msg.tabId] || {};
        const tiktokMeta = tiktokVideoMeta[msg.tabId] || {};
        const feedByVid = tiktokFeedByVideoId[msg.tabId] || {};
        sendResponse({
          videos: videos.map((v) => {
            // 메타데이터 조회 우선순위:
            // 1) 비디오 객체에 직접 부착된 메타데이터 (가장 신뢰 가능)
            // 2) URL 직접 매칭 (tiktokMeta)
            // 3) 경로 기반 매칭
            // 4) videoId 기반 피드 매칭
            const directMeta = (v.tiktokUsername || v.tiktokDesc) ? {
              videoId: v.tiktokVideoId,
              username: v.tiktokUsername,
              nickname: v.tiktokNickname,
              desc: v.tiktokDesc,
            } : null;
            let meta = directMeta || tiktokMeta[v.url] || findTiktokMetaByPath(v.url, tiktokMeta) || {};
            const vid = v.tiktokVideoId || meta.videoId || null;
            if ((!meta.username && !meta.desc) && vid && feedByVid[vid]) {
              meta = { ...meta, ...feedByVid[vid] };
            }
            return {
              ...v,
              sizeText: formatSize(v.size),
              downloaded: completedUrls.has(v.url),
              tiktokVideoId: vid,
              tiktokAuthor: meta.username ? (meta.nickname && meta.nickname !== meta.username
                ? `${meta.nickname} (@${meta.username})`
                : `@${meta.username}`) : null,
              tiktokDesc: meta.desc || null,
              tiktokUsername: meta.username || null,
              tiktokNickname: meta.nickname || null,
            };
          }),
          titleCandidates: titles,
          singleVideoPage: !!flags.singleVideoPage,
          gridTitles,
          tiktokFeedVideos: Object.values(feedByVid),
        });
      });
    return true; // 비동기 sendResponse
  }

  if (msg.action === "isDownloaded") {
    sendResponse({ downloaded: completedUrls.has(msg.url) });
  }

  if (msg.action === "download") {
    const filename = msg.filename || `video.${msg.ext || "mp4"}`;
    const safeName = sanitizeDownloadFilename(filename);

    // TikTok CDN URL인 경우 Referer 헤더 주입 예약
    if (TIKTOK_CDN_PATTERNS.test(msg.url)) {
      pendingTiktokDownloads.add(msg.url);
    }

    browser.downloads
      .download({
        url: msg.url,
        filename: safeName,
        saveAs: true,
      })
      .then((downloadId) => {
        activeDownloads[downloadId] = msg.url;
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error("Download failed:", err);
        sendResponse({ success: false, error: err.message || "다운로드 실패" });
      });
    return true; // 비동기 sendResponse
  }

  if (msg.action === "removeVideo") {
    const videos = detectedVideos[msg.tabId];
    if (videos) {
      detectedVideos[msg.tabId] = videos.filter((v) => v.url !== msg.url);
      const count = detectedVideos[msg.tabId].length;
      browser.browserAction.setBadgeText({
        text: count > 0 ? String(count) : "",
        tabId: msg.tabId,
      });
    }
  }

  if (msg.action === "clearVideos") {
    delete detectedVideos[msg.tabId];
    browser.browserAction.setBadgeText({ text: "", tabId: msg.tabId });
  }
});

// 다운로드 완료 추적
const activeDownloads = {};
const completedUrls = new Set();

browser.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === "complete") {
    const url = activeDownloads[delta.id];
    if (url) {
      completedUrls.add(url);
      delete activeDownloads[delta.id];
    }
  }
  // 취소/에러 시 정리
  if (delta.state?.current === "interrupted" || delta.error) {
    delete activeDownloads[delta.id];
  }
});

// ---- TikTok API 응답 본문 가로채기 (Firefox 전용 filterResponseData) ----
// 콘텐츠 스크립트의 isolated world 이슈를 우회하여
// background script에서 직접 HTTP 응답 본문을 읽음

const TIKTOK_API_URL_PATTERN = /tiktok\.com\/(api|webapi|v\d+|aweme\/v\d+)\//i;

// TikTok API 응답 아이템 처리 (content.js의 processTiktokItem과 동일 로직)
// 메타데이터는 모든 화질 URL 경로에 저장 (어떤 화질로 fetch되어도 매칭됨)
// detectedVideos에는 대표 URL 1개만 추가 (downloadAddr 우선, 없으면 playAddr)
function processTiktokApiItemBg(tabId, item) {
  if (!item) return;
  try {
    const video = item.video;
    const author = item.author?.uniqueId || (typeof item.author === "string" ? item.author : null);
    const nickname = item.author?.nickname || null;
    const desc = item.desc || null;
    const videoId = item.id || null;

    if (!video) return;

    // 파일 크기 추출: video.size (메인) 또는 bitrateInfo에서 가장 큰 DataSize
    let sizeBytes = 0;
    if (video.size) sizeBytes = parseInt(video.size, 10) || 0;
    if (!sizeBytes && Array.isArray(video.bitrateInfo)) {
      for (const br of video.bitrateInfo) {
        const ds = parseInt(br.PlayAddr?.DataSize || br.dataSize || "0", 10);
        if (ds > sizeBytes) sizeBytes = ds;
      }
    }

    // 모든 화질 URL 수집 (메타데이터 매핑용) + URL별 크기 기록
    const allUrls = [];
    const urlSizes = new Map(); // pathname → size
    const recordUrl = (url, size) => {
      if (!url) return;
      allUrls.push(url);
      if (size) urlSizes.set(tiktokUrlKey(url), size);
    };
    recordUrl(video.downloadAddr, sizeBytes);
    recordUrl(video.playAddr, sizeBytes);
    if (Array.isArray(video.bitrateInfo)) {
      for (const br of video.bitrateInfo) {
        const brUrl = br.PlayAddr?.UrlList?.[0] || br.playAddr;
        const brSize = parseInt(br.PlayAddr?.DataSize || br.dataSize || "0", 10) || 0;
        recordUrl(brUrl, brSize);
      }
    }

    // 모든 화질 URL의 경로 key에 메타데이터 저장
    // → webRequest가 어떤 화질 URL을 캡처해도 pathname으로 매칭됨
    if (!tiktokVideoMeta[tabId]) tiktokVideoMeta[tabId] = {};
    const urlPathSet = new Set();
    for (const url of allUrls) {
      if (!url || url.startsWith("blob:")) continue;
      const key = tiktokUrlKey(url);
      urlPathSet.add(key);
      tiktokVideoMeta[tabId][key] = {
        videoId,
        username: author,
        nickname,
        desc,
        source: "tiktok-api-bg",
      };
    }

    // 이미 detectedVideos에 있는 엔트리 중 이 영상의 화질 URL과 pathname이 일치하는 것을 찾아
    // 메타데이터 보강 (webRequest가 API 응답보다 먼저 URL을 캡처한 경우)
    if (detectedVideos[tabId]) {
      for (const v of detectedVideos[tabId]) {
        if (!v.isTiktok || v.tiktokVideoId) continue;
        if (urlPathSet.has(tiktokUrlKey(v.url))) {
          v.tiktokVideoId = videoId;
          v.tiktokUsername = v.tiktokUsername || author;
          v.tiktokNickname = v.tiktokNickname || nickname;
          v.tiktokDesc = v.tiktokDesc || desc;
        }
      }
      // 같은 videoId 엔트리가 이미 있으면 primaryUrl 추가 스킵
      const already = detectedVideos[tabId].some((v) => v.tiktokVideoId === videoId);
      if (already) return;
    }

    // 대표 URL 1개만 detectedVideos에 추가 (downloadAddr > playAddr)
    const primaryUrl = video.downloadAddr || video.playAddr;
    if (primaryUrl && !primaryUrl.startsWith("blob:")) {
      const ext = guessExtension(primaryUrl, "");
      const isStream = /\.(m3u8|mpd)(\?|$)/i.test(primaryUrl);
      const primarySize = urlSizes.get(tiktokUrlKey(primaryUrl)) || sizeBytes || 0;
      addVideo(tabId, {
        url: primaryUrl,
        type: isStream ? "stream" : "direct",
        mime: "",
        size: primarySize,
        ext: ext || "mp4",
        source: "tiktok-api-bg",
        tiktokVideoId: videoId,
        tiktokUsername: author,
        tiktokNickname: nickname,
        tiktokDesc: desc,
        isTiktok: true,
        timestamp: Date.now(),
      });
    }
  } catch (e) {
    console.warn("[VideoDownloader] processTiktokApiItemBg failed:", e);
  }
}

function processTiktokApiResponseBg(tabId, data) {
  if (!data) return;
  const items = data.itemList || data.items || data.aweme_list || data.item_list || [];
  if (!Array.isArray(items) || items.length === 0) return;
  for (const item of items) {
    processTiktokApiItemBg(tabId, item);
  }
  // 메타데이터 반영 후 기존 엔트리 재보강 + 중복 제거 (videoId 기반)
  enrichDetectedWithTiktokMeta(tabId);
  dedupTiktokVideos(tabId);
  // 팝업이 열려있으면 알림
  browser.runtime.sendMessage({ action: "videoAdded", tabId }).catch(() => {});
}

// filterResponseData 기반 응답 본문 캡처
// Firefox MV2에서 background script가 HTTP 응답 본문을 직접 읽음
// (콘텐츠 스크립트의 isolated world 이슈 회피)
if (typeof browser.webRequest.filterResponseData === "function") {
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;

      // 정적 리소스/미디어는 제외 (성능)
      if (/\.(js|css|png|jpg|jpeg|webp|gif|svg|woff2?|mp4|ts|m3u8|mpd)(\?|$)/i.test(details.url)) return;
      if (/\.(tiktokcdn|ttwstatic)\.com\//i.test(details.url)) return;
      if (/tiktok\.com\/(favicon|manifest|sw\.js|robots)/i.test(details.url)) return;

      try {
        const filter = browser.webRequest.filterResponseData(details.requestId);
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        filter.ondata = (event) => {
          try { buffer += decoder.decode(event.data, { stream: true }); } catch {}
          filter.write(event.data);
        };

        filter.onstop = () => {
          try {
            buffer += decoder.decode();
            filter.close();
            const trimmed = buffer.trimStart();
            if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;

            const data = JSON.parse(buffer);
            // 최상위 또는 .body 안의 itemList 탐지
            const candidates = [data, data && data.body].filter(Boolean);
            for (const d of candidates) {
              if (d.itemList || d.items || d.aweme_list || d.item_list) {
                processTiktokApiResponseBg(details.tabId, d);
                return;
              }
            }
          } catch {
            // JSON 아니거나 파싱 실패 — 무시
          }
        };

        filter.onerror = () => {
          try { filter.close(); } catch {}
        };
      } catch {}
    },
    {
      urls: [
        "*://*.tiktok.com/*",
        "*://*.tiktokv.com/*",
        "*://*.tiktokv.us/*",
        "*://*.tiktokw.us/*",
        "*://*.byteoversea.com/*",
      ],
    },
    ["blocking"]
  );
}

// ---- TikTok CDN 다운로드 시 Referer 헤더 주입 ----
// TikTok CDN은 Referer 없이 요청하면 403을 반환할 수 있음
const pendingTiktokDownloads = new Set();

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // TikTok CDN 도메인 요청에만 적용
    if (!TIKTOK_CDN_PATTERNS.test(details.url)) return;

    const headers = details.requestHeaders || [];
    let hasReferer = false;

    for (const h of headers) {
      if (h.name.toLowerCase() === "referer") {
        // 이미 Referer가 있으면 tiktok.com으로 설정
        h.value = "https://www.tiktok.com/";
        hasReferer = true;
        break;
      }
    }

    if (!hasReferer) {
      headers.push({ name: "Referer", value: "https://www.tiktok.com/" });
    }

    // 다운로드 완료 후 정리
    pendingTiktokDownloads.delete(details.url);

    return { requestHeaders: headers };
  },
  {
    urls: [
      "*://*.tiktok.com/*",
      "*://*.tiktokcdn.com/*",
      "*://*.tiktokv.com/*",
    ],
  },
  ["blocking", "requestHeaders"]
);

// 탭이 닫히면 데이터 정리
browser.tabs.onRemoved.addListener((tabId) => {
  delete detectedVideos[tabId];
  delete pageTitles[tabId];
  delete pageFlags[tabId];
  delete gridVideoTitles[tabId];
  delete tiktokVideoMeta[tabId];
  delete tiktokFeedByVideoId[tabId];
});

// 탭 이동 시 배지 업데이트
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    delete detectedVideos[tabId];
    delete pageTitles[tabId];
    delete pageFlags[tabId];
    delete gridVideoTitles[tabId];
    delete tiktokVideoMeta[tabId];
    delete tiktokFeedByVideoId[tabId];
    browser.browserAction.setBadgeText({ text: "", tabId });
  }
});
