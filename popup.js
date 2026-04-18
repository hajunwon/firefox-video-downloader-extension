let allVideos = [];
let titleCandidates = [];
let singleVideoPage = false;
let gridTitles = {};
let currentTabId = null;
let initialized = false;

async function init() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tabs[0]?.id;
  if (!currentTabId) return;

  await refreshVideos();

  if (allVideos.length === 0) {
    document.getElementById("empty-state").style.display = "block";
  }

  document.getElementById("search").addEventListener("input", render);
  document.getElementById("sort-by").addEventListener("change", render);
  document.getElementById("filter-ext").addEventListener("change", render);
  document.getElementById("title-source").addEventListener("change", render);
  document.getElementById("refresh-btn").addEventListener("click", refreshVideos);

  // background에서 새 비디오 감지 시 실시간 반영
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.action === "videoAdded" && msg.tabId === currentTabId) {
      refreshVideos();
    }
  });

  document.getElementById("clear-btn").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ action: "clearVideos", tabId: currentTabId });
    allVideos = [];
    titleCandidates = [];
    document.getElementById("video-list").innerHTML = "";
    document.getElementById("toolbar").style.display = "none";
    document.getElementById("empty-state").style.display = "block";
  });

  pollDownloadState();
}

async function refreshVideos() {
  const resp = await browser.runtime.sendMessage({
    action: "getVideos",
    tabId: currentTabId,
  });

  const prevCount = allVideos.length;
  allVideos = resp?.videos || [];
  titleCandidates = resp?.titleCandidates || [];
  singleVideoPage = resp?.singleVideoPage || false;
  gridTitles = resp?.gridTitles || {};

  if (allVideos.length > 0) {
    document.getElementById("empty-state").style.display = "none";
    document.getElementById("toolbar").style.display = "block";
  }

  if (!initialized) {
    buildExtFilter();
    buildTitleSourceOptions();
    initialized = true;
  } else if (allVideos.length !== prevCount) {
    rebuildFilters();
  }

  updateCount();
  render();
}

// ---- 제목 결정 ----

const TITLE_PRIORITY = [
  "full",
  "author-title",
  "video-desc",
  "content-disposition",
  "json-ld",
  "og:title",
  "description",
  "twitter:title",
  "video-attr",
  "video-aria",
  "page-title",
];

function resolveTitle(video, mode) {
  if (mode === "url") return null;

  const available = getTitleMap(video);

  if (mode === "auto") {
    for (const src of TITLE_PRIORITY) {
      if (available[src]) return { title: available[src], source: src };
    }
    return null;
  }

  if (available[mode]) return { title: available[mode], source: mode };
  return null;
}

// "full" 소스 생성: 작성자 + 제목 + 설명을 최대한 합침
function buildFullTitle(map) {
  // 작성자: author-title에서 " - " 앞부분 (닉네임 (@아이디) 형태 유지)
  let author = null;
  const authorTitle = map["author-title"] || "";
  // "닉네임 (@아이디) - 설명" → "닉네임 (@아이디)"
  // 괄호 안의 " - "는 건너뛰기 위해 마지막 닫는 괄호 이후의 " - "를 찾음
  const parenEnd = authorTitle.lastIndexOf(")");
  const dashSearch = parenEnd > 0 ? authorTitle.indexOf(" - ", parenEnd) : authorTitle.indexOf(" - ");
  if (dashSearch > 0) {
    author = authorTitle.substring(0, dashSearch);
  } else if (authorTitle && !authorTitle.includes(" - ")) {
    author = authorTitle; // " - " 없이 작성자만 있는 경우
  }

  // 제목 (og:title, json-ld 등에서)
  const title = map["json-ld"] || map["og:title"] || map["video-attr"] || map["page-title"] || null;

  // 설명/캡션
  const desc = map["description"] || map["video-desc"] || null;

  // 제목과 설명이 동일하면 중복 제거
  const titleClean = title?.replace(/\s+/g, " ").trim();
  const descClean = desc?.replace(/\s+/g, " ").trim();
  const isDuplicate = titleClean && descClean &&
    (titleClean.includes(descClean) || descClean.includes(titleClean));

  const parts = [];
  if (author) parts.push(author);
  if (titleClean) parts.push(titleClean);
  if (descClean && !isDuplicate) parts.push(descClean);

  if (parts.length >= 2) return parts.join(" - ");
  return null; // 합칠 게 부족하면 null
}

// 비디오별 사용 가능한 제목 맵 생성
function getTitleMap(video) {
  const map = {};

  // per-video: Content-Disposition
  if (video.dispFilename) {
    const clean = video.dispFilename.replace(/\.[^.]+$/, "");
    if (clean.length > 3 && !/^[a-f0-9\-_]{16,}$/i.test(clean)) {
      map["content-disposition"] = clean;
    }
  }

  // per-video: TikTok API에서 수집된 메타데이터 (가장 정확)
  if (video.tiktokAuthor || video.tiktokDesc) {
    if (video.tiktokDesc) {
      map["video-desc"] = video.tiktokDesc;
    }
    if (video.tiktokAuthor && video.tiktokDesc) {
      map["author-title"] = `${video.tiktokAuthor} - ${truncate(video.tiktokDesc, 60)}`;
    } else if (video.tiktokAuthor) {
      map["author-title"] = video.tiktokAuthor;
    }
  }

  // per-video: URL 또는 메타데이터에서 video ID를 추출해서 grid 제목과 매칭
  const videoIdFromUrl = extractVideoIdFromUrl(video.url, video);
  if (videoIdFromUrl && gridTitles[videoIdFromUrl]) {
    if (!map["video-desc"]) map["video-desc"] = gridTitles[videoIdFromUrl];
    const parsed = parseGridTitle(gridTitles[videoIdFromUrl]);
    if (parsed && !map["author-title"]) {
      map["author-title"] = parsed;
    }
  }

  // page-level 제목 후보 적용 규칙
  // - TikTok 영상은 per-video 메타데이터만 사용 (page의 og:title 등이 섞여 모든 영상에 같은
  //   접미사가 붙는 문제 방지). 단, 메타데이터가 없는 경우에 한해 제한적으로 폴백 허용.
  // - 단일 영상 페이지(TikTok 외): 모든 후보 사용 (페이지 = 영상 1:1)
  // - 기타 다중 영상 페이지: author-title만 가장 큰 영상에 적용
  if (video.isTiktok) {
    const hasMeta = video.tiktokAuthor || video.tiktokDesc;
    if (!hasMeta) {
      // TikTok 영상에 per-video 메타데이터가 없을 때만 video-desc 후보 허용
      // (제목 없이 URL만 보이는 것보다 낫지만, 여러 영상에 동일 제목이 붙을 위험 있음)
      for (const c of titleCandidates) {
        if (c.source === "video-desc" && c.title && !map[c.source]) {
          map[c.source] = c.title;
        }
      }
    }
    // TikTok 메타데이터가 있으면 page-level og:title/page-title 등은 일절 사용하지 않음
  } else if (singleVideoPage) {
    for (const c of titleCandidates) {
      if (c.title && !map[c.source]) {
        map[c.source] = c.title;
      }
    }
  } else {
    // 다중 영상 페이지 (TikTok 외): 기존 로직
    for (const c of titleCandidates) {
      if (c.source === "video-desc" || c.source === "video-attr" || c.source === "video-aria") {
        if (c.title && !map[c.source]) map[c.source] = c.title;
      }
    }
    if (!map["author-title"]) {
      const authorTitle = titleCandidates.find((c) => c.source === "author-title");
      if (authorTitle && isLargestVideo(video)) {
        map["author-title"] = authorTitle.title;
      }
    }
  }

  // "full" 조합 생성: 작성자 + 제목 + 설명이 2개 이상 있을 때
  const full = buildFullTitle(map);
  if (full) map["full"] = full;

  return map;
}

// URL 또는 비디오 메타데이터에서 TikTok video ID 추출
function extractVideoIdFromUrl(url, video) {
  // 1. 비디오 객체에 직접 tiktokVideoId가 있으면 사용
  if (video?.tiktokVideoId) return video.tiktokVideoId;

  // 2. TikTok 페이지 URL 패턴: /@user/video/ID 또는 /@user/photo/ID
  const pageMatch = url.match(/\/(video|photo)\/(\d+)/);
  if (pageMatch) return pageMatch[2];

  // 3. TikTok CDN URL에서 video ID 힌트 추출 시도
  // 일부 CDN URL에는 /video/tos/... 경로 내에 ID가 포함됨
  const cdnMatch = url.match(/\/video\/tos\/[^/]+\/([a-f0-9]{32})/i);
  if (cdnMatch) return cdnMatch[1];

  return null;
}

// TikTok grid 제목 파싱: "닉네임 님이 닉네임 님의 사운드(으)로 만든 설명"
function parseGridTitle(alt) {
  if (!alt) return null;
  // 한국어: "잡채밥 님이 잡채밥 님의 오리지널 사운드 - 잡채밥(으)로 만든 이거 밖에 좋다 #배그"
  const matchKo = alt.match(/^(.+?)\s+님이\s+.+?\(으\)로 만든\s+(.+)$/);
  if (matchKo) return `${matchKo[1]} - ${matchKo[2].trim()}`;
  // 영어: "nickname by nickname's original sound - nickname made desc"
  const matchEn = alt.match(/^(.+?)\s+(?:님의|'s)\s+.+?(?:\(으\)로|made)\s+(.+)$/i);
  if (matchEn) return `${matchEn[1]} - ${matchEn[2].trim()}`;
  return alt;
}

// 현재 비디오가 감지된 비디오 중 가장 큰지 확인
function isLargestVideo(video) {
  if (!allVideos.length) return false;
  const maxSize = Math.max(...allVideos.map((v) => v.size || 0));
  return video.size > 0 && video.size === maxSize;
}


// 실제 데이터가 있는 소스만 활성화
function buildTitleSourceOptions() {
  const select = document.getElementById("title-source");
  const allSources = new Set();

  for (const v of allVideos) {
    const map = getTitleMap(v);
    for (const src of Object.keys(map)) allSources.add(src);
  }

  for (const opt of select.options) {
    const val = opt.value;
    if (val === "auto" || val === "url") continue;
    // 기존 "(없음)" 텍스트 제거 후 재평가
    opt.textContent = opt.textContent.replace(" (없음)", "");
    opt.disabled = false;
    if (!allSources.has(val)) {
      opt.disabled = true;
      opt.textContent += " (없음)";
    }
  }
}

function rebuildFilters() {
  // 확장자 필터 재구성
  const extSelect = document.getElementById("filter-ext");
  const prevExt = extSelect.value;
  extSelect.innerHTML = '<option value="all">모든 형식</option>';
  buildExtFilter();
  if ([...extSelect.options].some((o) => o.value === prevExt)) extSelect.value = prevExt;

  buildTitleSourceOptions();
  updateCount();
}

// ---- 그룹핑 ----

function getVideoGroupKey(video) {
  try {
    const u = new URL(video.url);
    let path = u.pathname;
    path = path.replace(/[_\-]((\d{3,4}p)|(high|mid|low|hd|sd|hq|lq|original))/gi, "");
    path = path.replace(/[_\-]?\d{3,4}x\d{3,4}/gi, "");
    return u.hostname + "::" + path + "::" + video.ext;
  } catch {
    return video.url;
  }
}

function groupVideos(videos) {
  const groups = new Map();
  for (const v of videos) {
    const key = getVideoGroupKey(v);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => (b.size || 0) - (a.size || 0));
  }
  return groups;
}

// ---- 필터/검색 ----

function buildExtFilter() {
  const exts = [...new Set(allVideos.map((v) => v.ext))].sort();
  const select = document.getElementById("filter-ext");
  for (const ext of exts) {
    const opt = document.createElement("option");
    opt.value = ext;
    opt.textContent = `.${ext}`;
    select.appendChild(opt);
  }
}

function updateCount() {
  const filtered = getFilteredVideos();
  document.getElementById("video-count").textContent =
    `${filtered.length}/${allVideos.length}`;
}

function getFilteredVideos() {
  const query = document.getElementById("search").value.toLowerCase().trim();
  const extFilter = document.getElementById("filter-ext").value;
  const sortBy = document.getElementById("sort-by").value;
  const titleMode = document.getElementById("title-source").value;

  let videos = [...allVideos];

  if (extFilter !== "all") {
    videos = videos.filter((v) => v.ext === extFilter);
  }

  if (query) {
    videos = videos.filter((v) => {
      const resolved = resolveTitle(v, titleMode);
      const title = (resolved?.title || "").toLowerCase();
      const name = extractName(v.url).toLowerCase();
      const url = v.url.toLowerCase();
      return title.includes(query) || name.includes(query) || url.includes(query) || v.ext.includes(query) || v.sizeText.toLowerCase().includes(query);
    });
  }

  videos.sort((a, b) => {
    switch (sortBy) {
      case "size-desc": return (b.size || 0) - (a.size || 0);
      case "size-asc": return (a.size || 0) - (b.size || 0);
      case "time-desc": return (b.timestamp || 0) - (a.timestamp || 0);
      case "ext": return a.ext.localeCompare(b.ext);
      default: return 0;
    }
  });

  return videos;
}

// ---- 렌더링 ----

function render() {
  const videos = getFilteredVideos();
  const listEl = document.getElementById("video-list");
  const emptyEl = document.getElementById("empty-state");

  listEl.innerHTML = "";
  updateCount();

  if (videos.length === 0 && allVideos.length > 0) {
    emptyEl.style.display = "block";
    emptyEl.querySelector("p").textContent = "검색 결과가 없습니다.";
    emptyEl.querySelector(".hint").textContent = "";
    return;
  }
  emptyEl.style.display = "none";

  const groups = groupVideos(videos);

  for (const [, group] of groups) {
    const best = group[0];
    const others = group.slice(1);
    const hasGroup = others.length > 0;

    listEl.appendChild(buildVideoRow(best, hasGroup ? "best" : null));

    if (hasGroup) {
      const toggle = document.createElement("div");
      toggle.className = "group-toggle";
      toggle.textContent = `${others.length}개 다른 화질 보기`;
      toggle.addEventListener("click", () => {
        const collapsed = toggle.nextElementSibling;
        const visible = collapsed.style.display !== "none";
        collapsed.style.display = visible ? "none" : "block";
        toggle.textContent = visible
          ? `${others.length}개 다른 화질 보기`
          : `${others.length}개 다른 화질 접기`;
        toggle.classList.toggle("open", !visible);
      });
      listEl.appendChild(toggle);

      const collapsedGroup = document.createElement("div");
      collapsedGroup.className = "group-collapsed";
      collapsedGroup.style.display = "none";
      for (const v of others) {
        collapsedGroup.appendChild(buildVideoRow(v, "alt"));
      }
      listEl.appendChild(collapsedGroup);
    }
  }

  // overflow 감지 → 마퀴 스크롤 활성화
  requestAnimationFrame(() => setupMarquee(listEl));
}

function setupMarquee(container) {
  container.querySelectorAll(".video-title, .video-url").forEach((el) => {
    const inner = el.querySelector(".scroll-text");
    if (!inner) return;
    el.classList.remove("overflowing");
    inner.style.removeProperty("--scroll-distance");
    inner.style.removeProperty("--scroll-duration");

    if (inner.scrollWidth > el.clientWidth) {
      el.classList.add("overflowing");
      const overflow = inner.scrollWidth - el.clientWidth;
      inner.style.setProperty("--scroll-distance", `-${overflow}px`);
      // 속도: 50px/s
      inner.style.setProperty("--scroll-duration", `${Math.max(2, overflow / 50)}s`);
    }
  });
}

function buildVideoRow(video, role) {
  const titleMode = document.getElementById("title-source").value;
  const resolved = resolveTitle(video, titleMode);

  const item = document.createElement("div");
  item.className = "video-item";
  if (role === "alt") item.classList.add("video-item-alt");

  const displayName = resolved?.title || extractName(video.url);
  const urlName = extractName(video.url);
  const hostname = extractHostname(video.url);
  const isBlob = video.type === "blob";
  const isStream = video.type === "stream";
  const isHlsGroup = video.isHlsGroup === true;
  const hasTitle = !!resolved;

  let typeTags = "";
  if (role === "best") typeTags += `<span class="tag tag-best">BEST</span>`;
  if (isStream) typeTags += `<span class="tag tag-stream">stream</span>`;
  if (isBlob) typeTags += `<span class="tag tag-blob">blob</span>`;
  if (isHlsGroup) typeTags += `<span class="tag tag-stream">HLS ${video.segmentCount || 1}개 세그먼트</span>`;
  if (hasTitle) typeTags += `<span class="tag tag-source">${escapeHtml(resolved.source)}</span>`;

  const safeFilename = sanitizeFilename(displayName, video.ext);

  let actionBtns;
  if (isBlob) {
    actionBtns = `<span class="blob-hint">ffmpeg 필요</span>`;
  } else if (isHlsGroup) {
    // HLS 그룹: m3u8 매니페스트를 받아 ffmpeg로 합쳐야 함
    actionBtns = `<span class="blob-hint" title="이 영상은 HLS 스트림입니다. 같은 목록에 .m3u8 파일이 있으면 그걸 받아 ffmpeg로 합치세요.">m3u8 + ffmpeg 필요</span>`;
  } else if (video.downloaded) {
    actionBtns = `<button class="download-btn done" data-url="${escapeAttr(video.url)}" data-ext="${video.ext}" data-filename="${escapeAttr(safeFilename)}">다운로드 ✓</button>`;
  } else {
    actionBtns = `<button class="download-btn" data-url="${escapeAttr(video.url)}" data-ext="${video.ext}" data-filename="${escapeAttr(safeFilename)}">다운로드</button>`;
  }

  // HLS 그룹은 URL 대신 디렉토리 경로(세그먼트 prefix)를 표시
  const displayUrl = isHlsGroup && video.hlsGroupKey
    ? `HLS 스트림: ${video.hlsGroupKey}`
    : urlName;

  const titleHtml = hasTitle
    ? `<div class="video-title"><span class="scroll-text">${escapeHtml(displayName)}</span></div>
       <div class="video-url" title="${escapeHtml(video.url)}"><span class="scroll-text">${escapeHtml(displayUrl)}</span></div>`
    : `<div class="video-url" title="${escapeHtml(video.url)}"><span class="scroll-text">${escapeHtml(displayUrl)}</span></div>`;

  const canThumb = !isBlob && !isStream && !isHlsGroup;

  item.innerHTML = `
    <button class="remove-btn" data-url="${escapeAttr(video.url)}" title="목록에서 제거">✕</button>
    <div class="thumb-container">${canThumb ? `<video class="thumb" src="${escapeAttr(video.url)}" preload="metadata" muted></video>` : `<div class="thumb thumb-placeholder"></div>`}</div>
    <div class="video-info">
      ${titleHtml}
      <div class="video-meta">
        <span class="tag tag-ext">${video.ext}</span>
        ${typeTags}
        <span class="tag-size">${video.sizeText}</span>
        <span class="tag-host">${escapeHtml(hostname)}</span>
      </div>
    </div>
    <button class="copy-btn" data-url="${escapeAttr(video.url)}">URL 복사</button>
    ${actionBtns}
  `;

  // 썸네일: 첫 프레임 로드 후 0.1초 지점으로 이동하여 표시
  const thumbEl = item.querySelector("video.thumb");
  if (thumbEl) {
    thumbEl.addEventListener("loadeddata", () => {
      thumbEl.currentTime = 0.1;
    });
    thumbEl.addEventListener("error", () => {
      thumbEl.replaceWith(Object.assign(document.createElement("div"), {
        className: "thumb thumb-placeholder thumb-error",
      }));
    });
  }

  item.querySelector(".remove-btn").addEventListener("click", (e) => {
    const url = e.target.dataset.url;
    allVideos = allVideos.filter((v) => v.url !== url);
    browser.runtime.sendMessage({ action: "removeVideo", tabId: currentTabId, url });
    render();
    if (allVideos.length === 0) {
      document.getElementById("toolbar").style.display = "none";
      document.getElementById("empty-state").style.display = "block";
    }
  });

  item.querySelector(".copy-btn")?.addEventListener("click", (e) => {
    navigator.clipboard.writeText(e.target.dataset.url).then(() => {
      e.target.textContent = "복사됨!";
      setTimeout(() => (e.target.textContent = "URL 복사"), 1500);
    });
  });

  const dlBtn = item.querySelector(".download-btn:not(.done)");
  if (dlBtn) {
    dlBtn.addEventListener("click", async (e) => {
      const btn = e.target;
      btn.textContent = "다운로드 중...";
      btn.classList.add("downloading");
      try {
        const resp = await browser.runtime.sendMessage({
          action: "download",
          url: btn.dataset.url,
          ext: btn.dataset.ext,
          filename: btn.dataset.filename,
        });
        if (resp && !resp.success) {
          btn.textContent = "실패 - 재시도";
          btn.classList.remove("downloading");
          btn.classList.add("failed");
        }
      } catch {
        btn.textContent = "실패 - 재시도";
        btn.classList.remove("downloading");
        btn.classList.add("failed");
      }
    });
  }

  return item;
}

function sanitizeFilename(name, ext) {
  let clean = name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length > 100) clean = clean.substring(0, 100).trim();
  if (!clean) clean = "video";
  if (!clean.toLowerCase().endsWith(`.${ext}`)) {
    clean += `.${ext}`;
  }
  return clean;
}

// ---- 다운로드 완료 폴링 ----

function pollDownloadState() {
  setInterval(async () => {
    let changed = false;
    for (const video of allVideos) {
      if (video.downloaded) continue;
      const resp = await browser.runtime.sendMessage({
        action: "isDownloaded",
        url: video.url,
      });
      if (resp?.downloaded) {
        video.downloaded = true;
        changed = true;
      }
    }
    if (changed) render();
  }, 1000);
}

// ---- 유틸 ----

function extractName(url) {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split("/").pop()) || url;
  } catch {
    return url;
  }
}

function extractHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.substring(0, max).trim() + "..." : str;
}

init();
