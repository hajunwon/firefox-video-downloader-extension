// DOM에서 비디오 요소를 직접 스캔하여 URL 수집

function scanVideos() {
  const found = [];

  // 1. <video> 태그의 src
  document.querySelectorAll("video").forEach((video) => {
    if (video.src && !video.src.startsWith("blob:")) {
      found.push({ url: video.src, source: "video-tag" });
    }
    // currentSrc (실제 재생 중인 소스)
    if (video.currentSrc && !video.currentSrc.startsWith("blob:")) {
      found.push({ url: video.currentSrc, source: "video-currentSrc" });
    }
  });

  // 2. <source> 태그
  document.querySelectorAll("video source, audio source").forEach((source) => {
    if (source.src && !source.src.startsWith("blob:")) {
      found.push({ url: source.src, source: "source-tag" });
    }
  });

  // 3. <iframe> 내부는 접근 불가하므로 iframe src만 기록
  // (cross-origin 제한)

  // 4. og:video 메타 태그 (소셜 미디어 공유용 비디오 URL)
  document
    .querySelectorAll(
      'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]'
    )
    .forEach((meta) => {
      const url = meta.getAttribute("content");
      if (url) found.push({ url, source: "og-meta" });
    });

  // 5. JSON-LD에서 비디오 URL 추출
  document
    .querySelectorAll('script[type="application/ld+json"]')
    .forEach((script) => {
      try {
        const data = JSON.parse(script.textContent);
        extractVideoFromJsonLd(data, found);
      } catch {}
    });

  // 6. data-* 속성에서 비디오 URL 패턴 탐색
  const videoUrlPattern =
    /https?:\/\/[^\s"'<>]+\.(mp4|webm|ogg|m3u8|mpd)(\?[^\s"'<>]*)?/gi;

  document
    .querySelectorAll("[data-video-url], [data-src], [data-video], [data-hls], [data-dash]")
    .forEach((el) => {
      for (const attr of el.attributes) {
        if (attr.name.startsWith("data-")) {
          const matches = attr.value.match(videoUrlPattern);
          if (matches) {
            matches.forEach((url) =>
              found.push({ url, source: `attr:${attr.name}` })
            );
          }
        }
      }
    });

  // 7. TikTok 내장 데이터에서 비디오 다운로드 URL 추출 (단일 영상 페이지)
  if (location.hostname.includes("tiktok.com")) {
    const tiktokData = extractTikTokEmbeddedData();
    if (tiktokData?.videoUrls) {
      for (const v of tiktokData.videoUrls) {
        if (v.url && !v.url.startsWith("blob:")) {
          found.push({
            url: v.url,
            source: v.source,
            tiktokVideoId: tiktokData.videoId || null,
            tiktokUsername: tiktokData.username || null,
            tiktokNickname: tiktokData.nickname || null,
            tiktokDesc: tiktokData.desc || null,
            quality: v.quality || null,
          });
        }
      }
    }

    // 8. TikTok FYP/피드 페이지: __UNIVERSAL_DATA_FOR_REHYDRATION__ 직접 파싱
    // webapp.updated-items는 초기 로드된 영상들의 전체 메타데이터를 포함
    try {
      const scriptEl = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (scriptEl && scriptEl.textContent) {
        const json = JSON.parse(scriptEl.textContent);
        const scope = json?.__DEFAULT_SCOPE__;
        const feedArrays = [
          scope?.["webapp.updated-items"],
          scope?.["webapp.user-post"]?.items,
          scope?.["webapp.user-detail"]?.userPost?.items,
        ].filter(Array.isArray);

        for (const items of feedArrays) {
          for (const item of items) {
            if (!item) continue;
            const author = item.author?.uniqueId || null;
            const nickname = item.author?.nickname || null;
            const desc = item.desc || null;
            const videoId = item.id || null;

            // 모든 화질 URL을 tiktokVideoMap에 저장 (메타데이터 매핑용)
            const allUrls = [];
            if (item.video?.downloadAddr) allUrls.push(item.video.downloadAddr);
            if (item.video?.playAddr) allUrls.push(item.video.playAddr);
            const bitrates = item.video?.bitrateInfo || [];
            for (const br of bitrates) {
              const brUrl = br.PlayAddr?.UrlList?.[0] || br.playAddr;
              if (brUrl) allUrls.push(brUrl);
            }
            for (const url of allUrls) {
              if (!url || url.startsWith("blob:")) continue;
              setTiktokVideoMeta(url, {
                videoId,
                username: author,
                nickname,
                desc,
                source: "tiktok-embedded",
              }, true);
            }

            // 대표 URL 1개만 detectedVideos에 추가 (워터마크 없는 것 우선)
            // (1) bitrateInfo의 lr=unwatermarked → (2) playAddr → (3) downloadAddr
            let primaryUrl = null;
            if (Array.isArray(item.video?.bitrateInfo)) {
              const unwatermarked = item.video.bitrateInfo
                .map((br) => br.PlayAddr?.UrlList?.[0] || br.playAddr)
                .find((u) => u && /[?&]lr=unwatermarked(\b|&)/i.test(u));
              if (unwatermarked) primaryUrl = unwatermarked;
            }
            if (!primaryUrl) primaryUrl = item.video?.playAddr || item.video?.downloadAddr;
            if (primaryUrl && !primaryUrl.startsWith("blob:") && !found.some((f) => f.url === primaryUrl)) {
              found.push({
                url: primaryUrl,
                source: "tiktok-embedded",
                tiktokVideoId: videoId,
                tiktokUsername: author,
                tiktokNickname: nickname,
                tiktokDesc: desc,
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn("[VideoDownloader] Failed to parse __UNIVERSAL_DATA_FOR_REHYDRATION__:", e);
    }
  }

  return found;
}

function extractVideoFromJsonLd(data, found) {
  if (!data) return;
  if (Array.isArray(data)) {
    data.forEach((item) => extractVideoFromJsonLd(item, found));
    return;
  }
  if (typeof data !== "object") return;

  // VideoObject schema
  if (data.contentUrl) {
    found.push({ url: data.contentUrl, source: "json-ld" });
  }
  if (data.embedUrl) {
    found.push({ url: data.embedUrl, source: "json-ld" });
  }

  for (const val of Object.values(data)) {
    if (typeof val === "object") extractVideoFromJsonLd(val, found);
  }
}

// ---- Blob URL 캡처를 위한 MSE 후킹 ----

// MediaSource로 만들어진 blob URL을 추적
const capturedBlobs = [];

// URL.createObjectURL 후킹
const originalCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = function (obj) {
  const url = originalCreateObjectURL.call(this, obj);
  if (obj instanceof MediaSource || obj instanceof Blob) {
    capturedBlobs.push({
      blobUrl: url,
      type: obj instanceof MediaSource ? "MediaSource" : "Blob",
      mimeType: obj.type || "unknown",
      timestamp: Date.now(),
    });
  }
  return url;
};

// ---- 네트워크 요청 가로채기 (XHR/Fetch) ----

const interceptedUrls = [];
const videoUrlPattern =
  /\.(mp4|webm|ogg|m3u8|mpd|ts)(\?[^#]*)?$/i;
const videoMimePattern =
  /video\/|application\/x-mpegurl|application\/dash\+xml|application\/vnd\.apple\.mpegurl/i;

// TikTok CDN URL 패턴: 확장자 없이 mime_type 파라미터로 비디오 판별
const tiktokCdnPattern =
  /^https?:\/\/(v\d+-[^.]*\.tiktok\.com|[^.]*\.tiktokcdn\.com|[^.]*\.tiktokv\.com)\/.*(mime_type=video|\/video\/)/i;

// TikTok API 응답 패턴 (영상 메타데이터 포함)
// recommend(FYP), post(프로필), item/detail, related, collection, search, challenge, user, favorite
const tiktokApiPattern =
  /tiktok\.com\/(api|webapi|v\d+)\/.*(item_list|itemlist|item\/detail|item\/list|feed|recommend|related|collection|challenge|favorite|bookmark|list\/item)/i;

// TikTok 비디오 URL → 메타데이터 매핑 (XHR API 응답 + DOM 스냅샷에서 수집)
// key: URL 경로 지문 (쿼리 제외), value: { videoId, username, nickname, desc, source }
const tiktokVideoMap = {};

// HLS 세그먼트(.ts) 여부: 개별로는 재생 불가하므로 감지에서 제외
function isHlsSegment(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;
    if (!/\.ts(\?|$)/i.test(path)) return false;
    if (/\/[^/]*(video|chunk|segment|seg|part|media|fragment|frag)[_-]?\d+\.ts$/i.test(path)) return true;
    if (/\/(chunklist|segments?|hls|playlist|stream)\//i.test(path)) return true;
    if (/\/\d+\.ts$/i.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

function isVideoUrl(url) {
  if (isHlsSegment(url)) return false;
  return videoUrlPattern.test(url) || tiktokCdnPattern.test(url);
}

// TikTok CDN URL의 경로 지문 추출 (쿼리 파라미터 제외)
// 같은 영상의 다른 서명 URL을 동일하게 매칭
function tiktokUrlKey(url) {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url;
  }
}

// 비디오 URL에 메타데이터 연결 (이미 있으면 덮어쓰지 않음 - 더 정확한 API 소스 우선)
function setTiktokVideoMeta(url, meta, preferApi = false) {
  const key = tiktokUrlKey(url);
  const existing = tiktokVideoMap[key];
  if (!existing) {
    tiktokVideoMap[key] = { ...meta, _url: url };
    return;
  }
  // API 메타데이터가 들어오면 DOM 스냅샷을 덮어씀
  if (preferApi && existing.source === "dom-snapshot") {
    tiktokVideoMap[key] = { ...meta, _url: url };
  }
}

// TikTok 아이템 하나에서 메타데이터 + URL 추출 → tiktokVideoMap 저장
// 사용처: webapp.updated-items (초기 로드), API 응답 (스크롤)
function processTiktokItem(item, sourceTag) {
  if (!item) return;
  try {
    const video = item.video;

    const meta = {
      videoId: item.id || null,
      username: (item.author && typeof item.author === "object")
        ? item.author.uniqueId
        : (typeof item.author === "string" ? item.author : null),
      nickname: (item.author && typeof item.author === "object") ? item.author.nickname : null,
      desc: item.desc || null,
      source: sourceTag || "tiktok-api",
    };

    // 비디오 URL 수집 (playAddr/downloadAddr가 비어있지 않은 경우에만 — 사진 포스트는 빈 문자열)
    if (video) {
      const urls = [];
      if (video.downloadAddr) urls.push({ url: video.downloadAddr, quality: "original", hookSource: sourceTag + "-downloadAddr" });
      if (video.playAddr) urls.push({ url: video.playAddr, quality: video.ratio || "default", hookSource: sourceTag + "-playAddr" });
      if (video.bitrateInfo && Array.isArray(video.bitrateInfo)) {
        for (const br of video.bitrateInfo) {
          const brUrl = br.PlayAddr?.UrlList?.[0] || br.playAddr;
          if (brUrl) urls.push({ url: brUrl, quality: br.QualityType || br.GearName || "variant", hookSource: sourceTag + "-bitrate" });
        }
      }

      for (const u of urls) {
        if (!u.url) continue;
        setTiktokVideoMeta(u.url, { ...meta, quality: u.quality }, true);
        if (!interceptedUrls.some((i) => i.url === u.url)) {
          // 메타데이터를 URL 엔트리에 직접 부착 (pathname 매칭 실패에 대비)
          interceptedUrls.push({
            url: u.url,
            source: u.hookSource,
            tiktokVideoId: meta.videoId,
            tiktokUsername: meta.username,
            tiktokNickname: meta.nickname,
            tiktokDesc: meta.desc,
            quality: u.quality,
            timestamp: Date.now(),
          });
        }
      }
    }
  } catch {}
}

// TikTok API 응답 JSON에서 영상 메타데이터 추출
function processTiktokApiResponse(data) {
  if (!data) return;
  const items = data.itemList || data.items || data.aweme_list || data.item_list || [];
  for (const item of items) {
    processTiktokItem(item, "tiktok-api");
  }
}

// ---- TikTok FYP/프로필 피드: 컨테이너별 영상 정보 추출 ----
// 여러 영상이 DOM에 동시 존재하므로 container마다 개별 추출

// 현재 화면에 보이는 TikTok 영상 컨테이너 (IntersectionObserver로 추적)
let currentVisibleTiktokContainer = null;

// 단일 컨테이너에서 영상 정보 추출
function extractInfoFromTiktokContainer(container) {
  if (!container) return null;
  const info = { source: "dom-snapshot" };

  // 캡션 (데이터가 여러 span으로 쪼개져 있을 수 있음)
  const descEl = container.querySelector('[data-e2e="video-desc"]');
  if (descEl) {
    info.desc = descEl.textContent?.trim().replace(/\s+/g, " ") || null;
  }

  // username: a[href^="/@"] 링크의 href에서 추출
  // nickname: 그 링크의 텍스트 또는 별개의 링크 텍스트
  const authorLinks = container.querySelectorAll('a[href^="/@"]');
  for (const link of authorLinks) {
    const href = link.getAttribute("href") || "";
    const m = href.match(/^\/@([^/?#]+)/);
    if (!m) continue;
    const uname = m[1];
    const text = link.textContent?.trim() || "";

    if (!info.username) info.username = uname;
    // 링크 텍스트가 username과 다르면 nickname으로 간주
    if (text && text !== uname && text !== `@${uname}` && !info.nickname) {
      info.nickname = text;
    }
  }

  // 영상 ID 추출 (컨테이너 내부 video/photo 링크에서)
  const videoLink = container.querySelector('a[href*="/video/"], a[href*="/photo/"]');
  if (videoLink) {
    const idMatch = videoLink.getAttribute("href")?.match(/\/(video|photo)\/(\d+)/);
    if (idMatch) info.videoId = idMatch[2];
  }

  return (info.desc || info.username) ? info : null;
}

// 모든 TikTok 영상 컨테이너 조회
function queryTiktokContainers() {
  return document.querySelectorAll(
    '[data-e2e="feed-video"], [data-e2e="recommend-list-item-container"]'
  );
}

// 현재 DOM에서 보이는 영상의 정보 스냅샷
// 1순위: IntersectionObserver가 추적 중인 현재 화면 컨테이너
// 2순위: 첫 번째 컨테이너 (초기 로드 시점)
// 3순위: 기존 방식 (레거시)
function snapshotCurrentTiktokDomInfo() {
  if (!location.hostname.includes("tiktok.com")) return null;

  // 1) 현재 화면에 보이는 컨테이너에서 추출
  if (currentVisibleTiktokContainer && document.contains(currentVisibleTiktokContainer)) {
    const info = extractInfoFromTiktokContainer(currentVisibleTiktokContainer);
    if (info) return info;
  }

  // 2) 첫 번째 컨테이너 (초기/단일 영상 페이지 대응)
  const containers = queryTiktokContainers();
  if (containers.length === 1) {
    const info = extractInfoFromTiktokContainer(containers[0]);
    if (info) return info;
  }

  // 3) 레거시: 활성 오버레이에서 추출 (single video page 등)
  const legacy = extractActiveVideoInfo();
  if (legacy) {
    return {
      username: legacy.username || null,
      nickname: legacy.nickname || null,
      desc: legacy.desc || null,
      source: "dom-snapshot",
    };
  }

  return null;
}

// DOM 전체에서 관찰 중인 TikTok 영상 컨테이너 목록 (IntersectionObserver용)
const observedTiktokContainers = new WeakSet();
let tiktokIntersectionObserver = null;

function ensureTiktokIntersectionObserver() {
  if (!location.hostname.includes("tiktok.com")) return;
  if (tiktokIntersectionObserver) return;

  tiktokIntersectionObserver = new IntersectionObserver(
    (entries) => {
      // 가장 많이 보이는 컨테이너를 현재 활성으로 지정
      let best = null;
      let bestRatio = 0;
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > bestRatio) {
          bestRatio = entry.intersectionRatio;
          best = entry.target;
        }
      }
      if (best) currentVisibleTiktokContainer = best;
    },
    { threshold: [0.25, 0.5, 0.75] }
  );
}

// 컨테이너 관찰 등록 (새로 추가된 것만)
function observeTiktokContainers() {
  if (!location.hostname.includes("tiktok.com")) return;
  ensureTiktokIntersectionObserver();
  if (!tiktokIntersectionObserver) return;

  for (const el of queryTiktokContainers()) {
    if (!observedTiktokContainers.has(el)) {
      observedTiktokContainers.add(el);
      tiktokIntersectionObserver.observe(el);
    }
  }
}

// TikTok CDN 비디오 URL 감지 시: 현재 DOM 상태 스냅샷 → URL에 영구 연결
// API 메타데이터가 없는 영상도 감지 시점의 DOM 정보로 제목 확보
function captureVideoUrl(url, source) {
  if (!url || !isVideoUrl(url)) return;
  if (!interceptedUrls.some((i) => i.url === url)) {
    interceptedUrls.push({ url, source, timestamp: Date.now() });
  }
  // TikTok CDN URL인 경우 현재 DOM 스냅샷 저장 (API 메타가 나중에 오면 덮어씀)
  if (tiktokCdnPattern.test(url) && !tiktokVideoMap[tiktokUrlKey(url)]) {
    const snapshot = snapshotCurrentTiktokDomInfo();
    if (snapshot) {
      setTiktokVideoMeta(url, snapshot, false);
    }
  }
}

// ---- 페이지 컨텍스트에 fetch/XHR 후킹 스크립트 주입 ----
// Firefox 콘텐츠 스크립트는 isolated world에서 실행되므로
// 페이지의 window.fetch를 직접 후킹할 수 없음
// <script> 태그로 페이지 컨텍스트에 코드를 주입하고 postMessage로 통신

(function injectPageHooks() {
  // 페이지 컨텍스트에서 실행될 코드 (문자열로 주입)
  // Firefox XRay 이슈 방지를 위해 API 응답은 JSON 문자열로 직렬화하여 전달
  const hookCode = `(function() {
    function post(type, data) {
      try {
        window.postMessage({ __vdl: true, type, payload: JSON.stringify(data) }, location.origin);
      } catch (e) {}
    }

    const TT_API_RE = /tiktok\\.com\\/(api|webapi|v\\d+|aweme\\/v\\d+)\\//i;

    const origFetch = window.fetch;
    window.fetch = function() {
      var args = arguments;
      var url = null;
      try {
        url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || null;
      } catch (e) {}

      if (url) post("url", { url: url, source: "fetch" });

      var promise = origFetch.apply(this, args);

      if (url && TT_API_RE.test(url)) {
        promise.then(function(resp) {
          try {
            resp.clone().text().then(function(text) {
              if (!text) return;
              try {
                var data = JSON.parse(text);
                if (data && (data.itemList || data.items || data.aweme_list || data.item_list)) {
                  post("apiResponse", { url: url, data: data });
                }
              } catch (e) {}
            }, function() {});
          } catch (e) {}
        }, function() {});
      }

      return promise;
    };

    const origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      if (typeof url === "string" && url) {
        post("url", { url: url, source: "xhr" });

        if (TT_API_RE.test(url)) {
          var xhr = this;
          xhr.addEventListener("load", function() {
            try {
              var text = xhr.responseText;
              if (!text) return;
              var data = JSON.parse(text);
              if (data && (data.itemList || data.items || data.aweme_list || data.item_list)) {
                post("apiResponse", { url: url, data: data });
              }
            } catch (e) {}
          });
        }
      }
      return origXhrOpen.apply(this, arguments);
    };
  })();`;

  try {
    const script = document.createElement("script");
    script.textContent = hookCode;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (e) {
    // fallback: content script level hook (not effective in isolated world, but keeps old behavior)
  }

  // 페이지 컨텍스트에서 postMessage로 전달된 데이터 수신
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || !msg.__vdl) return;

    let payload = null;
    try {
      payload = JSON.parse(msg.payload);
    } catch {
      return;
    }
    if (!payload) return;

    if (msg.type === "url") {
      captureVideoUrl(payload.url, payload.source || "page-hook");
    } else if (msg.type === "apiResponse") {
      processTiktokApiResponse(payload.data);
    }
  });
})();

// ---- 현재 열린 영상 뷰어에서 정보 추출 ----

function extractActiveVideoInfo() {
  // 1) 영상 설명 컨테이너 찾기 (FYP, 브라우저 모드, 피드 모두 지원)
  const browseContainer = document.querySelector('[data-e2e="browse-video-desc"]')
    || document.querySelector('[data-e2e="feed-video-desc"]')
    || document.querySelector('[data-e2e="video-desc"]');
  if (!browseContainer) return null;

  const info = {};

  // 2) username 추출: data-e2e 우선, 실패 시 컨테이너 근처의 a[href^="/@"] 링크에서 추출
  const usernameEl = document.querySelector('[data-e2e="browse-username"]')
    || document.querySelector('[data-e2e="video-author-uniqueid"]')
    || document.querySelector('[data-e2e="feed-video-author-uniqueid"]');
  if (usernameEl) info.username = usernameEl.textContent?.trim().replace(/^@/, "");

  // FYP 등에서는 data-e2e가 없을 수 있으니 컨테이너의 상위에서 @username 링크 탐색
  if (!info.username) {
    // 영상 설명의 가장 가까운 공통 부모에서 /@username 링크 찾기
    let scope = browseContainer.parentElement;
    for (let i = 0; i < 6 && scope; i++) {
      const link = scope.querySelector('a[href^="/@"]');
      if (link) {
        const m = link.getAttribute("href")?.match(/^\/@([^/?#]+)/);
        if (m) { info.username = m[1]; break; }
      }
      scope = scope.parentElement;
    }
  }

  // 3) 닉네임 (표시 이름)
  const nicknameEl = document.querySelector('[data-e2e="browser-nickname"] span')
    || document.querySelector('[data-e2e="browser-nickname"]')
    || document.querySelector('[data-e2e="video-author-nickname"]');
  if (nicknameEl) {
    const raw = nicknameEl.textContent?.trim();
    info.nickname = raw?.split("·")[0]?.trim() || raw;
  }

  // 4) "닉네임 (@아이디)" 형식 조합
  if (info.nickname && info.username) {
    if (info.nickname !== info.username) {
      info.author = `${info.nickname} (@${info.username})`;
    } else {
      info.author = `@${info.username}`;
    }
  } else if (info.nickname) {
    info.author = info.nickname;
  } else if (info.username) {
    info.author = `@${info.username}`;
  }

  // 5) 영상 설명 (캡션/해시태그 포함)
  info.desc = browseContainer.textContent?.trim().replace(/\s+/g, " ") || null;

  return (info.author || info.desc) ? info : null;
}

// ---- TikTok 내장 데이터 추출 ----

function extractTikTokEmbeddedData() {
  if (!location.hostname.includes("tiktok.com")) return null;

  const result = { username: null, nickname: null, author: null, desc: null, title: null, videoUrls: [], videoId: null };

  // 1) __UNIVERSAL_DATA_FOR_REHYDRATION__ — 가장 신뢰할 수 있는 소스
  try {
    const scriptEl = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
    if (scriptEl) {
      const json = JSON.parse(scriptEl.textContent);
      const scope = json?.__DEFAULT_SCOPE__;

      // 단일 영상 페이지
      const videoDetail = scope?.["webapp.video-detail"]?.itemInfo?.itemStruct
        || scope?.["webapp.video-detail"]?.itemStruct;
      if (videoDetail) {
        if (videoDetail.author) {
          result.username = videoDetail.author.uniqueId || null;
          result.nickname = videoDetail.author.nickname || null;
        }
        if (videoDetail.desc) result.desc = videoDetail.desc;
        if (videoDetail.id) result.videoId = videoDetail.id;

        // 비디오 다운로드 URL 추출 (playAddr, downloadAddr)
        const video = videoDetail.video;
        if (video) {
          if (video.downloadAddr) {
            result.videoUrls.push({ url: video.downloadAddr, source: "tiktok-downloadAddr", quality: "original" });
          }
          if (video.playAddr) {
            result.videoUrls.push({ url: video.playAddr, source: "tiktok-playAddr", quality: video.ratio || "default" });
          }
          // bitrateInfo에서 추가 화질 URL 추출
          if (video.bitrateInfo && Array.isArray(video.bitrateInfo)) {
            for (const br of video.bitrateInfo) {
              const brUrl = br.PlayAddr?.UrlList?.[0] || br.playAddr;
              if (brUrl && !result.videoUrls.some(v => v.url === brUrl)) {
                result.videoUrls.push({
                  url: brUrl,
                  source: "tiktok-bitrate",
                  quality: br.QualityType || br.GearName || "variant",
                });
              }
            }
          }
        }
      }

      // 프로필 페이지 — 유저 정보
      const userDetail = scope?.["webapp.user-detail"]?.userInfo?.user;
      if (userDetail && !result.username) {
        result.username = userDetail.uniqueId || null;
        result.nickname = userDetail.nickname || null;
      }

      // FYP(For You) 피드의 초기 로드 영상 배열 — 가장 중요!
      // 각 아이템에 id, desc, author, video.playAddr, video.downloadAddr가 완전히 포함됨
      const updatedItems = scope?.["webapp.updated-items"];
      if (Array.isArray(updatedItems)) {
        for (const item of updatedItems) {
          processTiktokItem(item, "tiktok-embedded");
        }
      }

      // 프로필 페이지의 사용자 포스트 배열
      const userPostItems = scope?.["webapp.user-post"]?.items
        || scope?.["webapp.user-detail"]?.userPost?.items;
      if (Array.isArray(userPostItems)) {
        for (const item of userPostItems) {
          processTiktokItem(item, "tiktok-embedded-userpost");
        }
      }
    }
  } catch {}

  // 2) SIGI_STATE (구버전 TikTok 페이지)
  if (!result.username) {
    try {
      const sigiEl = document.getElementById("SIGI_STATE");
      if (sigiEl) {
        const sigi = JSON.parse(sigiEl.textContent);
        // ItemModule에서 첫 번째 영상의 author 정보
        const items = sigi?.ItemModule;
        if (items) {
          const first = Object.values(items)[0];
          if (first) {
            result.username = result.username || first.author || null;
            result.nickname = result.nickname || first.nickname || null;
            result.desc = result.desc || first.desc || null;
            if (first.id && !result.videoId) result.videoId = first.id;
            // SIGI_STATE에서도 비디오 URL 추출
            const vid = first.video;
            if (vid) {
              if (vid.downloadAddr) {
                result.videoUrls.push({ url: vid.downloadAddr, source: "tiktok-downloadAddr", quality: "original" });
              }
              if (vid.playAddr) {
                result.videoUrls.push({ url: vid.playAddr, source: "tiktok-playAddr", quality: vid.ratio || "default" });
              }
            }
          }
        }
        // UserModule
        const users = sigi?.UserModule?.users;
        if (users && !result.username) {
          const firstUser = Object.values(users)[0];
          if (firstUser) {
            result.username = firstUser.uniqueId || null;
            result.nickname = firstUser.nickname || null;
          }
        }
      }
    } catch {}
  }

  // 3) URL 경로에서 username 폴백: /@username/...
  if (!result.username) {
    result.username = location.pathname.match(/^\/@([^/]+)/)?.[1] || null;
  }

  // 4) og:title에서 닉네임 폴백: "TikTok의 닉네임" 또는 "닉네임 on TikTok"
  if (!result.nickname) {
    const ogTitle = getMeta('meta[property="og:title"]');
    if (ogTitle) {
      const m1 = ogTitle.match(/^TikTok[의의]\s*(.+)$/i);
      const m2 = ogTitle.match(/^(.+?)\s+(?:on TikTok|['']s?\s*video)/i);
      result.nickname = m1?.[1]?.trim() || m2?.[1]?.trim() || null;
    }
  }

  // "닉네임 (@아이디)" 형식 조합
  if (result.nickname && result.username && result.nickname !== result.username) {
    result.author = `${result.nickname} (@${result.username})`;
  } else if (result.username) {
    result.author = `@${result.username}`;
  } else if (result.nickname) {
    result.author = result.nickname;
  }

  return (result.author || result.desc) ? result : null;
}

// ---- 페이지에서 영상 제목 추출 ----

function extractPageTitle() {
  const candidates = [];
  let author = null;
  let title = null;
  let description = null;

  // ---- 0a. TikTok 내장 데이터 (최우선) ----
  const tiktokData = extractTikTokEmbeddedData();
  if (tiktokData) {
    if (tiktokData.author) author = tiktokData.author;
    if (tiktokData.desc) {
      description = tiktokData.desc;
      title = truncate(tiktokData.desc, 80);
      candidates.push({ title: truncate(tiktokData.desc, 80), source: "video-desc" });
    }
    if (tiktokData.author && tiktokData.desc) {
      candidates.push({
        title: `${tiktokData.author} - ${truncate(tiktokData.desc, 60)}`,
        source: "author-title",
      });
    }
  }

  // ---- 0b. 현재 열린 영상 뷰어 (브라우저 모드 오버레이) ----
  // TikTok 프로필에서 영상 클릭 시, 개별 영상 정보는 오버레이 안에만 있음
  const activeVideo = extractActiveVideoInfo();
  if (activeVideo) {
    if (activeVideo.author) author = author || activeVideo.author;
    if (activeVideo.desc) {
      if (!description) {
        description = activeVideo.desc;
        title = title || truncate(activeVideo.desc, 80);
        candidates.push({ title: truncate(activeVideo.desc, 80), source: "video-desc" });
      }
    }
    if (activeVideo.author && activeVideo.desc) {
      const avAuthor = activeVideo.author;
      const avDesc = truncate(activeVideo.desc, 60);
      const avTitle = `${avAuthor} - ${avDesc}`;
      if (!candidates.some((c) => c.source === "author-title" && c.title === avTitle)) {
        candidates.push({ title: avTitle, source: "author-title" });
      }
    }
  }

  // ---- 1. JSON-LD: 가장 구조화된 데이터 ----
  document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      const data = JSON.parse(script.textContent);
      findJsonLdInfo(data, candidates, (info) => {
        if (info.title) title = title || info.title;
        if (info.author) author = author || info.author;
        if (info.description) description = description || info.description;
      });
    } catch {}
  });

  // ---- 2. 메타 태그 ----
  const ogTitle = getMeta('meta[property="og:title"]');
  if (ogTitle) candidates.push({ title: ogTitle, source: "og:title" });
  title = title || ogTitle;

  const twTitle = getMeta('meta[name="twitter:title"]');
  if (twTitle) candidates.push({ title: twTitle, source: "twitter:title" });

  const ogDesc = getMeta('meta[property="og:description"]');
  const metaDesc = getMeta('meta[name="description"]');
  const twDesc = getMeta('meta[name="twitter:description"]');
  const bestDesc = ogDesc || twDesc || metaDesc;
  if (bestDesc) {
    description = description || bestDesc;
    candidates.push({ title: truncate(bestDesc, 80), source: "description" });
  }

  // ---- 3. 작성자 추출 ----

  // 3a. 메타 태그 (구조화 데이터 다음으로 신뢰도 높음)
  if (!author) {
    author = getMeta('meta[name="author"]')
      || getMeta('meta[name="twitter:creator"]')
      || getMeta('meta[property="article:author"]');
  }

  // 3b. 사이트별 작성자 셀렉터 — 영상 컨텍스트 내부만 탐색
  if (!author) {
    const host = location.hostname;

    if (host.includes("tiktok.com")) {
      // 위에서 tiktokData/activeVideo로 이미 처리됨 — DOM 셀렉터 폴백만
      const username = getTextFrom([
        '[data-e2e="video-author-uniqueid"]',
        '[data-e2e="browse-username"]',
      ]);
      const nickname = getTextFrom([
        '[data-e2e="browser-nickname"] span',
        '[data-e2e="video-author-nickname"]',
      ]);
      if (nickname && username && nickname !== username) {
        author = `${nickname} (@${username})`;
      } else if (username) {
        author = `@${username}`;
      }

    } else if (host.includes("youtube.com")) {
      author = getTextFrom([
        '#above-the-fold ytd-video-owner-renderer #text a',
        '#owner #channel-name yt-formatted-string a',
        '#owner #channel-name a',
      ]);

    } else if (host.includes("twitter.com") || host.includes("x.com")) {
      // Twitter/X: og:title에서 "Name (@handle)" 패턴 추출
      author = extractAuthorFromOgTitle(ogTitle, /^(.+?)\s+(?:\(@|\/)/)
        || getMeta('meta[name="twitter:creator"]');

    } else if (host.includes("instagram.com")) {
      author = extractAuthorFromOgTitle(ogTitle, /^(.+?)(?:\s+on Instagram|\s*[-•|])/i);

    } else if (host.includes("twitch.tv")) {
      author = getTextFrom([
        '[data-a-target="stream-title"]',
      ]);
      // Twitch 채널명은 URL에서 추출
      if (!author) {
        const match = location.pathname.match(/^\/([^/]+)/);
        if (match) author = match[1];
      }
    }
  }

  // 3c. 범용 폴백: og:title에서 "이름 - 제목" 패턴 추출
  if (!author && ogTitle) {
    const match = ogTitle.match(/^(@?[\w\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF]+)\s*[-–—|:]\s+/);
    if (match) author = match[1];
  }

  // ---- 4. <video> 요소 속성 ----
  document.querySelectorAll("video").forEach((video) => {
    if (video.title) candidates.push({ title: video.title.trim(), source: "video-attr" });
    const label = video.getAttribute("aria-label");
    if (label) candidates.push({ title: label.trim(), source: "video-aria" });
  });

  // ---- 5. 페이지 제목 ----
  const pageTitle = cleanPageTitle(document.title);
  if (pageTitle) candidates.push({ title: pageTitle, source: "page-title" });
  title = title || pageTitle;

  // ---- 6. 조합 제목 생성 ----
  if (author && title) {
    candidates.push({ title: `${author} - ${title}`, source: "author-title" });
  } else if (author && description) {
    candidates.push({ title: `${author} - ${truncate(description, 60)}`, source: "author-title" });
  } else if (author) {
    candidates.push({ title: author, source: "author-title" });
  }

  return candidates;
}

function findJsonLdInfo(data, candidates, onInfo) {
  if (!data) return;
  if (Array.isArray(data)) { data.forEach((d) => findJsonLdInfo(d, candidates, onInfo)); return; }
  if (typeof data !== "object") return;

  const type = data["@type"];
  if (type === "VideoObject" || type === "SocialMediaPosting" || type === "Article") {
    if (data.name) {
      candidates.push({ title: data.name.trim(), source: "json-ld" });
      onInfo({ title: data.name.trim() });
    }
    if (data.description) {
      onInfo({ description: data.description.trim() });
    }
    // 작성자 추출
    const a = data.author || data.creator;
    if (a) {
      const name = typeof a === "string" ? a : (a.name || a.alternateName);
      if (name) onInfo({ author: name.trim() });
    }
    if (data.interactionStatistic) return; // 불필요한 하위 탐색 방지
  }

  for (const val of Object.values(data)) {
    if (typeof val === "object") findJsonLdInfo(val, candidates, onInfo);
  }
}

function getMeta(selector) {
  const el = document.querySelector(selector);
  const val = el?.getAttribute("content") || el?.textContent;
  return val?.trim() || null;
}

function getTextFrom(selectors, scopeSelector) {
  const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
  if (!scope) return null;
  for (const sel of selectors) {
    try {
      const el = scope.querySelector(sel);
      const text = el?.textContent?.trim();
      if (text && text.length > 0 && text.length < 100) return text;
    } catch {}
  }
  return null;
}

// og:title에서 정규식으로 작성자 추출
function extractAuthorFromOgTitle(ogTitle, pattern) {
  if (!ogTitle) return null;
  const match = ogTitle.match(pattern);
  return match ? match[1].trim() : null;
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.substring(0, max).trim() + "..." : str;
}

// 사이트 접미사 패턴 제거
function cleanPageTitle(raw) {
  if (!raw) return "";
  return raw
    .replace(/\s*[\-\|–—]\s*(YouTube|TikTok|Vimeo|Twitter|X|Facebook|Instagram|Twitch|Dailymotion|Naver|네이버|카카오TV|Kakao TV)\s*$/i, "")
    .replace(/^\s*(Watch|시청)\s*[\-\|:]\s*/i, "")
    .trim();
}

// 페이지가 단일 영상 페이지인지 판별
function isSingleVideoPage() {
  const path = location.pathname;
  // TikTok: /@user/video/ID 또는 /@user/photo/ID
  if (/\/@[^/]+\/(video|photo)\/\d+/.test(path)) return true;
  // YouTube: /watch
  if (location.hostname.includes("youtube.com") && path.startsWith("/watch")) return true;
  // Vimeo: /12345
  if (location.hostname.includes("vimeo.com") && /^\/\d+/.test(path)) return true;
  return false;
}

// 현재 열린 영상 그리드에서 개별 영상 제목 추출 (TikTok 프로필 등)
function extractGridVideoTitles() {
  const map = {};
  // TikTok 그리드 썸네일의 alt 텍스트에 작성자+설명이 들어있음
  document.querySelectorAll('[data-e2e="user-post-item"] img[alt], [data-e2e="favorites-item"] img[alt]').forEach((img) => {
    const alt = img.alt?.trim();
    if (!alt) return;
    // 가장 가까운 a 태그에서 video URL 추출
    const link = img.closest("a[href*='/video/'], a[href*='/photo/']");
    if (link) {
      const videoId = link.href.match(/\/(video|photo)\/(\d+)/)?.[2];
      if (videoId) map[videoId] = alt;
    }
  });
  return map;
}

// 모든 TikTok 영상 컨테이너에서 메타데이터 추출해서 리스트로 반환
// popup에서 감지된 URL에 매칭 시도 가능
function collectTiktokFeedVideos() {
  if (!location.hostname.includes("tiktok.com")) return [];
  const results = [];
  for (const container of queryTiktokContainers()) {
    const info = extractInfoFromTiktokContainer(container);
    if (info) results.push(info);
  }
  return results;
}

// background.js에서 메시지를 받으면 스캔 결과 반환
function performFullScan() {
  // 관찰 등록 갱신 (초기 popup 열 때 필요)
  observeTiktokContainers();

  const domVideos = scanVideos();
  const titleCandidates = extractPageTitle();
  const singleVideoPage = isSingleVideoPage();
  const gridTitles = extractGridVideoTitles();
  const tiktokFeedVideos = collectTiktokFeedVideos();

  return {
    domVideos,
    interceptedUrls,
    capturedBlobs,
    titleCandidates,
    singleVideoPage,
    gridTitles,
    tiktokVideoMap,
    tiktokFeedVideos,
  };
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "scanDOM") {
    sendResponse(performFullScan());
  }
});

// ---- TikTok SPA 네비게이션 감지 ----
// TikTok은 SPA이므로 페이지 전환 시 URL만 바뀌고 페이지가 새로고침되지 않음
// pushState/replaceState 후킹으로 URL 변경을 감지하여 자동 재스캔

(function setupSpaDetection() {
  if (!location.hostname.includes("tiktok.com")) return;

  let lastUrl = location.href;
  let rescanTimer = null;

  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;

    // URL 변경 후 새 콘텐츠 로딩 대기 후 재스캔
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      const scanResult = performFullScan();
      browser.runtime.sendMessage({
        action: "spaNavigation",
        scanResult,
      }).catch(() => {});
    }, 1500);

    // 추가 딜레이 후 한 번 더 스캔 (느린 로딩 대응)
    setTimeout(() => {
      const scanResult = performFullScan();
      browser.runtime.sendMessage({
        action: "spaNavigation",
        scanResult,
      }).catch(() => {});
    }, 4000);
  }

  // pushState/replaceState 후킹
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    onUrlChange();
  };
  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    onUrlChange();
  };
  window.addEventListener("popstate", onUrlChange);

  // MutationObserver: video 요소 추가 시 재스캔 + 영상 컨테이너 IntersectionObserver 등록
  let videoScanDebounce = null;
  const videoObserver = new MutationObserver((mutations) => {
    // 새로 추가된 TikTok 영상 컨테이너 관찰 등록 (매 mutation마다 빠르게)
    observeTiktokContainers();

    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeName === "VIDEO" || (node.querySelector && node.querySelector("video"))) {
          clearTimeout(videoScanDebounce);
          videoScanDebounce = setTimeout(() => {
            const scanResult = performFullScan();
            browser.runtime.sendMessage({
              action: "spaNavigation",
              scanResult,
            }).catch(() => {});
          }, 2000);
          return;
        }
      }
    }
  });

  // DOM 로드 후 observer 시작
  const startObservers = () => {
    videoObserver.observe(document.body, { childList: true, subtree: true });
    observeTiktokContainers();
  };
  if (document.body) {
    startObservers();
  } else {
    document.addEventListener("DOMContentLoaded", startObservers);
  }
})();
