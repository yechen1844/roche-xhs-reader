/**
 * Roche 小红书链接注入器 v2.6.5
 *
 * 模式一（直注模式）：原文 + 独立图片消息
 * 模式二（副 API 总结模式）：下载图片 → 发给副 API（vision）总结 → 丢弃图片
 *                            注入：总结文本（详尽，500字左右）+ 评论 + 卡片占位符
 *
 * v2.6.0 关键改进（内置 CF Worker 代理，开箱即用）：
 *   1. 内置官方 CF Worker 代理（默认开启，浏览器端优先使用）
 *      - 地址：https://xhs-proxy.1844316589.workers.dev
 *      - 处理的数据仅限：小红书笔记链接、笔记HTML、小红书图片（全部公开数据）
 *      - 不经过用户隐私数据（聊天内容、角色人设、API Key 均不经过此代理）
 *      - 不放心可以自己部署 CF Worker，或关闭内置代理改用公共代理
 *   2. APK 端保持原逻辑：corsproxy 优先，CF Worker 仅用于图片下载
 *   3. 浏览器端：内置 CF Worker 优先（HTML+图片）→ 公共代理降级
 *   4. 设置面板新增开关：一键开启/关闭内置代理
 *
 * v2.5.x 特性保留：isApkWebView() / smartFetch() CORS 拦截识别 / CF Worker 通用化
 * v2.4.x 特性保留：关闭面板不停监听 / autoListen 恢复 / 会话上限 3 个
 *
 * 触发方式：监听消息库，用户回车后 2s 内立即替换
 * 重要：关闭面板后监听继续在后台运行
 */

window.RochePlugin.register({
  id: "xhs-reader",
  name: "小红书链接注入器",
  version: "2.6.5",
  apps: [
    {
      id: "xhs-reader-home",
      name: "小红书注入器",
      icon: "extension",
      iconImage: "",
      async mount(container, roche) {
        const root = document.createElement('div');
        root.className = 'roche-plugin-xhs-reader';
        container.appendChild(root);
        await initApp(root, roche);
      },
      async unmount(container, roche) {
        // 关闭面板时保留监听，监听继续在后台运行
        if (runtime.rootEl) {
          runtime.rootEl = null;
        }
        container.replaceChildren();
      }
    }
  ]
});

// ============================================================
// 常量
// ============================================================
const BUILTIN_CF_WORKER = 'https://xhs-proxy.luyi90720.workers.dev';

// ============================================================
// 状态
// ============================================================
let runtime = {
  initialized: false,
  roche: null,
  rootEl: null,
  mode: 1,                     // 1 = 直注模式, 2 = 总结模式
  autoListen: false,
  useBuiltinCf: true,          // 默认开启内置 CF Worker 代理
  pollTimer: null,
  pollInterval: 2000,           // 2秒检测一次（之前 300ms 太频繁导致 Roche reactive 系统变卡）
  isPolling: false,            // 关键：全局锁，防止 pollOnce 并发执行
  selectedIds: [],
  processedLinks: {},          // {key: {ts, convId, textMsgId, imageMsgIds, msgCountAtInject}}
  deleteAfterCount: 10,        // 10 条后自动删
  deleteTextEnabled: true,
  deleteImagesEnabled: true,
  cleanupTimer: null,
  cleanupInterval: 5000,       // 5 秒检查一次
  apiPresets: [],              // [{id, name, baseUrl, apiKey, model, temperature}]
  activePresetId: null,
  userPersona: null,           // 缓存用户人设
  logs: []
};

const STORE_KEYS = {
  mode: 'xhs_mode',
  autoListen: 'xhs_auto_listen',
  useBuiltinCf: 'xhs_use_builtin_cf',
  selectedIds: 'xhs_selected_ids',
  processedLinks: 'xhs_processed_links',
  deleteAfterCount: 'xhs_delete_after_count',
  deleteTextEnabled: 'xhs_delete_text_enabled',
  deleteImagesEnabled: 'xhs_delete_images_enabled',
  apiPresets: 'xhs_api_presets',
  activePresetId: 'xhs_active_preset_id',
  cfWorker: 'xhs_cf_worker'
};

let rocheStorage = null;

// ============================================================
// IndexedDB 操作（Roche 主消息库）
// ============================================================
const DB_NAME = 'Roche_db';
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) { resolve(_db); return; }
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function getAllRecords(storeName) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function getMessagesByConversation(conversationId) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const store = tx.objectStore('messages');
    const index = store.index('conversationId');
    const req = index.getAll(conversationId);
    req.onsuccess = () => {
      req.result.sort((a, b) => a.timestamp - b.timestamp);
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  }));
}

function addMessage(msg) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction('messages', 'readwrite').objectStore('messages').add(msg);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function deleteMessage(id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction('messages', 'readwrite').objectStore('messages').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}

// ============================================================
// 日志
// ============================================================
function log(msg, type = 'info') {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  runtime.logs.push({ time: t, msg, type });
  if (runtime.logs.length > 200) runtime.logs.shift();
  if (runtime.rootEl) {
    const el = runtime.rootEl.querySelector('#xhs-logs');
    if (el) renderLogs();
  }
}

// ============================================================
// 环境检测 + 智能代理（解决 APK vs 浏览器行为差异）
// ============================================================

/**
 * 检测当前运行环境是否为 Android WebView（APK 环境）
 * APK WebView 的 UA 通常包含 "wv" 或 "Android" + "Version"
 *
 * 关键差异：
 * - APK WebView 通常关闭 CORS 检查 → 任何代理都能用
 * - 浏览器强制 CORS 检查 → 只有用 CORS 友好的代理才能读到响应
 */
function isApkWebView() {
  try {
    const ua = navigator.userAgent || '';
    // Android WebView 标识：含 "wv" 或 "Android.*Version/\d"
    if (/Android.*wv/i.test(ua)) return true;
    if (/Android.*Version\/\d/i.test(ua)) return true;
    // 含 Chrome 但不带完整 Chrome 版本号（WebView 特征）
    if (/Android.*Chrome\/[\d.]+.*Mobile/i.test(ua) && !/Chrome\/\d+\.\d+\.\d+\.\d+\sMobile/i.test(ua)) {
      // 仅作辅助判断，可能误判，保守起见需要同时满足 wv 标识
    }
    return false;
  } catch (e) { return false; }
}

/**
 * 检测当前是否为浏览器打开的本地 HTML 文件（最严苛的 CORS 环境）
 * file:// 协议下 Origin 为 null，代理最容易拒绝
 */
function isBrowserLocalFile() {
  try {
    return location.protocol === 'file:';
  } catch (e) { return false; }
}

/**
 * 智能抓取 - 区分真 HTTP 错误 vs CORS 拦截
 *
 * 浏览器中：
 * - 真 HTTP 错误（403/408）：resp.status 有值，resp.ok === false
 * - CORS 拦截：fetch 直接抛 TypeError "Failed to fetch"，看不到响应
 *
 * APK 中：
 * - 几乎所有错误都能看到 resp.status（CORS 被关闭）
 */
async function smartFetch(proxyUrl, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const opts = Object.assign({
      signal: controller.signal,
      mode: 'cors',           // 显式声明跨域
      credentials: 'omit',    // 不带 Cookie，避免缓存干扰
      redirect: 'follow',     // 跟随重定向
      referrerPolicy: 'no-referrer'  // 不发 Referer，绕过部分代理的 Referer 检查
    }, options);
    const resp = await fetch(proxyUrl, opts);
    clearTimeout(timeout);
    return { ok: true, resp, error: null };
  } catch (e) {
    clearTimeout(timeout);
    let errType;
    if (e.name === 'AbortError') {
      errType = `超时(${timeoutMs/1000}s)`;
    } else if (e instanceof TypeError && /Failed to fetch|NetworkError|Load failed/i.test(e.message)) {
      // 浏览器 CORS 拦截的典型表现：TypeError: Failed to fetch
      errType = `CORS拦截(${e.message})`;
    } else {
      errType = e.message || e.name;
    }
    return { ok: false, resp: null, error: errType };
  }
}

/**
 * 返回 HTML 抓取的代理列表（按环境排序）
 *
 * APK 环境：保持原顺序（corsproxy 优先，已验证可用）
 *   - 内置 CF Worker 不使用（APK corsproxy 可用且更快）
 *   - 用户自定义 CF Worker 优先用于图片（保持原行为）
 *
 * 浏览器环境：
 *   - 内置 CF Worker 优先（如果开关开启）→ 处理 HTML+图片
 *   - 用户自定义 CF Worker 次之
 *   - allorigins JSON 模式再次之
 *   - corsproxy 仅在 localhost 可用（免费版 Origin 白名单限制）
 */
function getHtmlProxies(cfWorker, useBuiltin) {
  const isApk = isApkWebView();
  if (isApk) {
    log(`环境检测: APK WebView (UA: ${(navigator.userAgent||'').substring(0,50)}...)`, 'info');
    return [
      // APK 中用户自定义 CF Worker 优先
      ...(cfWorker ? [{ name: 'CF-Worker(自定义)', fn: (u) => cfWorker.replace(/\/$/, '') + '?url=' + encodeURIComponent(u) }] : []),
      { name: 'corsproxy', fn: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
      { name: 'codetabs', fn: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}` },
      { name: 'thingproxy', fn: (u) => `https://thingproxy.freeboard.io/fetch/${u}` },
      { name: 'allorigins-raw', fn: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` }
    ];
  }
  // 浏览器环境（含本地 file://）
  const isLocal = isBrowserLocalFile();
  const origin = (typeof location !== 'undefined' ? location.origin : 'unknown');
  log(`环境检测: 浏览器 (本地文件: ${isLocal}, Origin: ${origin}, 内置代理: ${useBuiltin ? '开启' : '关闭'})`, 'info');
  if (!isLocal && origin && !/^(https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.))/i.test(origin)) {
    if (!cfWorker && !useBuiltin) {
      log(`⚠️ 当前 Origin 不在 corsproxy 免费白名单 → corsproxy 将返回 403，建议开启内置代理或配置自定义 CF Worker`, 'warn');
    }
  }
  const proxies = [];
  // 内置 CF Worker 优先（浏览器端默认开启）
  if (useBuiltin) {
    proxies.push({ name: '内置代理', fn: (u) => BUILTIN_CF_WORKER.replace(/\/$/, '') + '?url=' + encodeURIComponent(u) });
  }
  // 用户自定义 CF Worker 次之
  if (cfWorker) {
    proxies.push({ name: 'CF-Worker(自定义)', fn: (u) => cfWorker.replace(/\/$/, '') + '?url=' + encodeURIComponent(u) });
  }
  // allorigins JSON 模式 - 返回 {contents: "..."}，CORS 头最完整
  proxies.push({ name: 'allorigins-json', fn: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, jsonMode: true });
  // codetabs - 长期稳定，CORS 支持好
  proxies.push({ name: 'codetabs', fn: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}` });
  // thingproxy
  proxies.push({ name: 'thingproxy', fn: (u) => `https://thingproxy.freeboard.io/fetch/${u}` });
  // allorigins raw 模式（备用）
  proxies.push({ name: 'allorigins-raw', fn: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` });
  // corsproxy 仅在 localhost 有效（其他 Origin 会 403）
  if (isLocal || /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(origin)) {
    proxies.push({ name: 'corsproxy', fn: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` });
  } else {
    proxies.push({ name: 'corsproxy(403预期)', fn: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` });
  }
  return proxies;
}

/**
 * 返回图片下载的代理列表（按环境排序）
 */
function getImageProxies(cfWorker, useBuiltin) {
  const proxies = [];
  const isApk = isApkWebView();
  if (isApk) {
    // APK 环境：用户自定义 CF Worker 优先（防盗链），然后公共代理
    if (cfWorker) {
      proxies.push({ name: 'CF-Worker(自定义)', fn: (u) => cfWorker.replace(/\/$/, '') + '?url=' + encodeURIComponent(u) });
    }
    proxies.push({ name: 'codetabs', fn: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}` });
    proxies.push({ name: 'thingproxy', fn: (u) => `https://thingproxy.freeboard.io/fetch/${u}` });
    proxies.push({ name: 'allorigins', fn: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` });
    proxies.push({ name: 'corsproxy', fn: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` });
  } else {
    // 浏览器环境：内置 CF Worker 优先（如果开启）
    if (useBuiltin) {
      proxies.push({ name: '内置代理', fn: (u) => BUILTIN_CF_WORKER.replace(/\/$/, '') + '?url=' + encodeURIComponent(u) });
    }
    if (cfWorker) {
      proxies.push({ name: 'CF-Worker(自定义)', fn: (u) => cfWorker.replace(/\/$/, '') + '?url=' + encodeURIComponent(u) });
    }
    proxies.push({ name: 'allorigins', fn: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` });
    proxies.push({ name: 'codetabs', fn: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}` });
    proxies.push({ name: 'thingproxy', fn: (u) => `https://thingproxy.freeboard.io/fetch/${u}` });
    proxies.push({ name: 'corsproxy', fn: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` });
  }
  return proxies;
}

// ============================================================
// 小红书抓取
// ============================================================
const CORS_PROXIES = [
  // 兼容旧引用（实际逻辑由 getHtmlProxies/getImageProxies 动态生成）
  (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`
];

async function fetchXhsHtml(xhsUrl) {
  // 读取 CF Worker 地址（通用版可同时处理 HTML 和图片）
  const cfWorker = await rocheStorage.get(STORE_KEYS.cfWorker);
  const useBuiltin = runtime.useBuiltinCf;
  if (useBuiltin) {
    log(`fetchXhsHtml: 内置代理已开启，将优先使用内置代理`, 'info');
  }
  if (cfWorker) {
    log(`fetchXhsHtml: 检测到自定义 CF Worker 配置`, 'info');
  }
  // 根据环境动态选择代理顺序
  const proxies = getHtmlProxies(cfWorker, useBuiltin);

  let lastErr = null;
  const errors = [];
  for (let i = 0; i < proxies.length; i++) {
    const proxyName = proxies[i].name;
    const proxyUrl = proxies[i].fn(xhsUrl);
    const isJsonMode = proxies[i].jsonMode === true;
    try {
      log(`fetchXhsHtml: [${proxyName}] 尝试: ${proxyUrl.substring(0, 80)}...`, 'info');
      const result = await smartFetch(proxyUrl, {}, 15000);
      if (!result.ok) {
        log(`fetchXhsHtml: [${proxyName}] ${result.error}`, 'error');
        errors.push(`${proxyName}: ${result.error}`);
        lastErr = new Error(result.error);
        continue;
      }
      const resp = result.resp;
      if (!resp.ok) {
        const err = `HTTP ${resp.status}`;
        log(`fetchXhsHtml: [${proxyName}] ${err}`, 'error');
        errors.push(`${proxyName}: ${err}`);
        lastErr = new Error(err);
        continue;
      }
      let html;
      if (isJsonMode) {
        // allorigins /get 返回 JSON: { contents: "...", status: {...} }
        const data = await resp.json();
        if (data && typeof data.contents === 'string') {
          html = data.contents;
        } else {
          lastErr = new Error('allorigins-json: contents 字段缺失');
          errors.push(`${proxyName}: contents 缺失`);
          continue;
        }
      } else {
        html = await resp.text();
      }
      log(`fetchXhsHtml: [${proxyName}] OK, ${html.length} 字节`, 'success');
      if (html && html.includes('__INITIAL_STATE__')) {
        // 严格验证：必须是 iPhone UA 返回的移动版 HTML（含 commentData）
        // 桌面版 HTML（Chrome UA）虽然也有 __INITIAL_STATE__ 但评论为空，不能接受
        if (html.includes('commentData')) {
          log(`fetchXhsHtml: [${proxyName}] 移动版 HTML（含评论数据），采用`, 'success');
          return html;
        }
        log(`fetchXhsHtml: [${proxyName}] 桌面版 HTML（无 commentData），跳过`, 'warn');
        lastErr = new Error('桌面版 HTML 无评论数据');
        errors.push(`${proxyName}: 桌面版无评论`);
        continue;
      }
      lastErr = new Error('页面未包含 __INITIAL_STATE__');
      errors.push(`${proxyName}: 无 __INITIAL_STATE__`);
    } catch (e) {
      const errType = e.name === 'AbortError' ? '超时(15s)' : e.message;
      log(`fetchXhsHtml: [${proxyName}] 异常: ${errType}`, 'error');
      errors.push(`${proxyName}: ${errType}`);
      lastErr = e;
    }
    // 每次代理失败后等 500ms，给代理喘息时间
    if (i < proxies.length - 1) await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`fetchXhsHtml 所有代理失败: ${errors.join(' | ')}`);
}

function parseXhsState(html) {
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*<\/script>/);
  if (!m) throw new Error('未找到 __INITIAL_STATE__');
  const jsonStr = m[1].replace(/undefined/g, 'null');
  return JSON.parse(jsonStr);
}

function extractNote(state) {
  // 只支持 iPhone UA 返回的移动版结构
  return state?.noteData?.data?.noteData || null;
}

function extractComments(state) {
  // 只支持 iPhone UA 返回的移动版结构
  return state?.noteData?.data?.commentData || null;
}

const MAX_IMAGES = 9;

function normalizeImgUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  if (!url.startsWith('http')) return '';
  return url;
}

function extractNoteImages(note) {
  const imgs = [];
  if (note.type === 'video') {
    const cover = note.video?.imageUrl || note.video?.coverImage?.url || '';
    const url = normalizeImgUrl(cover);
    if (url) imgs.push({ url, alt: '视频封面' });
  }
  if (note.imageList?.length) {
    for (const item of note.imageList.slice(0, MAX_IMAGES)) {
      const url = normalizeImgUrl(item.url || item.urlDefault || '');
      if (url) imgs.push({ url, alt: '笔记配图' });
    }
  }
  return imgs;
}

function extractTags(note) {
  const tags = [];
  if (note.tagList?.length) {
    for (const t of note.tagList) {
      const name = typeof t === 'string' ? t : (t.name || t.id || '');
      if (name) tags.push(name);
    }
  }
  return tags;
}

function extractPreview(note, maxLen = 100) {
  const desc = note.desc || '';
  if (desc.length <= maxLen) return desc;
  return desc.substring(0, maxLen) + '...';
}

async function downloadImageAsDataUrl(imageUrl) {
  const cfWorker = await rocheStorage.get(STORE_KEYS.cfWorker);
  const useBuiltin = runtime.useBuiltinCf;
  // 按环境动态选择代理顺序
  const proxies = getImageProxies(cfWorker, useBuiltin);

  const errors = [];
  for (let i = 0; i < proxies.length; i++) {
    const proxyName = proxies[i].name;
    const proxyUrl = proxies[i].fn(imageUrl);
    try {
      log(`  [${proxyName}] 尝试下载`, 'info');
      const result = await smartFetch(proxyUrl, {}, 20000);
      if (!result.ok) {
        log(`  [${proxyName}] ${result.error}`, 'error');
        errors.push(`${proxyName}: ${result.error}`);
        continue;
      }
      const resp = result.resp;
      if (!resp.ok) {
        const err = `HTTP ${resp.status}`;
        log(`  [${proxyName}] ${err}`, 'error');
        errors.push(`${proxyName}: ${err}`);
        continue;
      }
      const blob = await resp.blob();
      if (blob.size === 0) {
        const err = 'blob 大小为 0';
        log(`  [${proxyName}] ${err}`, 'error');
        errors.push(`${proxyName}: ${err}`);
        continue;
      }
      const ct = blob.type || 'image/jpeg';
      log(`  [${proxyName}] OK, ${blob.size} 字节, 类型: ${ct}`, 'success');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      log(`  [${proxyName}] base64 长度: ${dataUrl.length}`, 'success');
      return dataUrl;
    } catch (e) {
      log(`  [${proxyName}] 异常: ${e.message}`, 'error');
      errors.push(`${proxyName}: ${e.message}`);
    }
  }
  throw new Error(`所有代理失败: ${errors.join(' | ')}`);
}

async function processXhsLinkFull(xhsUrl) {
  const html = await fetchXhsHtml(xhsUrl);
  const state = parseXhsState(html);
  const note = extractNote(state);
  if (!note) throw new Error('未找到笔记数据');
  const comments = extractComments(state);
  if (comments?.comments?.length) {
    log(`抓取到 ${comments.comments.length} 条首屏评论`, 'success');
  } else {
    log('未抓取到首屏评论（可能为空或 UA 不匹配）', 'warn');
  }
  const images = extractNoteImages(note);
  const tags = extractTags(note);
  const preview = extractPreview(note);
  return { note, comments, images, tags, preview };
}

// ============================================================
// 用户人设（获取分享者名字）
// ============================================================
async function getSharerName() {
  if (runtime.userPersona) return runtime.userPersona;
  try {
    if (runtime.roche?.persona?.getActiveUserPersona) {
      const p = await runtime.roche.persona.getActiveUserPersona();
      runtime.userPersona = p?.handle || p?.name || '我';
      return runtime.userPersona;
    }
  } catch (e) {}
  return '我';
}

// ============================================================
// Pinia store 工具（参考 RocheNavToolkit v1.1）
// 关键：Pinia 通过 app._context.config.globalProperties.$pinia 访问
// ============================================================
function getPinia() {
  try {
    const selectors = ['#app', '#roche', '[data-v-app]', '#root'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el?.__vue_app__) continue;
      const app = el.__vue_app__;
      // 正确路径（RocheNavToolkit 已验证）
      const gp = (app._context && app._context.config && app._context.config.globalProperties)
              || (app.config && app.config.globalProperties);
      if (gp?.$pinia?._s) return gp.$pinia;
    }
    // 遍历 body 直接子元素
    for (const child of document.body.children) {
      if (!child.__vue_app__) continue;
      const app = child.__vue_app__;
      const gp = (app._context && app._context.config && app._context.config.globalProperties)
              || (app.config && app.config.globalProperties);
      if (gp?.$pinia?._s) return gp.$pinia;
    }
  } catch (e) {
    log(`getPinia: ${e.message}`, 'warn');
  }
  return null;
}

function findMessagesArrayInPinia(cid) {
  const pinia = getPinia();
  if (!pinia) return null;
  for (const [, store] of pinia._s) {
    const state = store.$state || store;
    if (state[cid] !== undefined && Array.isArray(state[cid])) return state[cid];
    if (store[cid] !== undefined && Array.isArray(store[cid])) return store[cid];
  }
  return null;
}

function getViewStackStore() {
  const pinia = getPinia();
  if (!pinia) return null;
  for (const [, store] of pinia._s) {
    if (store.viewStack !== undefined) return store;
  }
  return null;
}

// ============================================================
// 刷新 Roche 聊天界面（三方案自动降级）
// 参考 RocheNavToolkit.refreshChat + forceRefreshChat
// ============================================================
async function refreshRocheChat(conversationId) {
  try {
    if (!conversationId) return;
    const cid = String(conversationId);

    // ---- 方案 A：Pinia reactive 数组 splice（最佳，无闪烁） ----
    const piniaArr = findMessagesArrayInPinia(cid);
    if (piniaArr) {
      try {
        const dbMsgs = await getMessagesByConversation(cid);
        if (dbMsgs.length > 0) {
          // 参考 RocheNavToolkit：先清空再逐个 push（触发 Vue per-item 响应式追踪）
          piniaArr.splice(0, piniaArr.length);
          for (const m of dbMsgs) {
            piniaArr.push(m);
          }
          log(`refreshRocheChat: Pinia splice ${dbMsgs.length} 条 OK`, 'success');
          return;
        }
      } catch (e) {
        log(`refreshRocheChat: Pinia 异常: ${e.message}`, 'warn');
      }
    } else {
      log('refreshRocheChat: Pinia 未找到消息数组', 'warn');
    }

    // ---- 方案 B：事件派发兜底 ----
    try {
      window.dispatchEvent(new CustomEvent('roche-open-chat-request', {
        detail: { conversationId: cid, pushType: '', source: 'xhs-reader-plugin' }
      }));
    } catch (e) {}
    try {
      document.dispatchEvent(new CustomEvent('roche-open-chat-request', {
        detail: { conversationId: cid, pushType: '', source: 'xhs-reader-plugin' }
      }));
    } catch (e) {}
    setTimeout(() => {
      try {
        window.dispatchEvent(new CustomEvent('roche-messages-updated', {
          detail: { conversationId: cid, source: 'xhs-reader-plugin' }
        }));
      } catch (e) {}
    }, 100);

    // ---- 方案 C：viewStack pop+push 强制重新挂载 Chat 组件（保证 100% 刷新） ----
    const navStore = getViewStackStore();
    if (navStore?.viewStack?.length > 0) {
      const top = navStore.viewStack[navStore.viewStack.length - 1];
      if (top && top.name === 'chat' && top.params?.id === cid) {
        // 已在目标聊天页 → pop 退出 → 50ms 后 push 回来，Chat 组件完全重新挂载
        navStore.viewStack.pop();
        setTimeout(() => {
          navStore.viewStack.push({ name: 'chat', params: { id: cid } });
        }, 50);
        log(`refreshRocheChat: viewStack pop/push 强制刷新 ${cid}`, 'success');
        return;
      }
    }

    log(`refreshRocheChat: 事件兜底 ${cid}`, 'info');
  } catch (e) {
    log(`refreshRocheChat 失败: ${e.message}`, 'error');
  }
}

// ============================================================
// 消息注入辅助
// ============================================================
function genMsgId() {
  return `msg_${Date.now()}${Math.random().toString().slice(1)}`;
}

async function injectTextMessage(originalMsg, text) {
  const newMsg = {
    id: genMsgId(),
    text,
    isMe: originalMsg.isMe === undefined ? true : originalMsg.isMe,
    type: 'text',
    timestamp: (originalMsg.timestamp || Date.now()) + 1,
    conversationId: originalMsg.conversationId
  };
  if (originalMsg.senderId !== undefined) newMsg.senderId = originalMsg.senderId;
  if (originalMsg.senderName !== undefined) newMsg.senderName = originalMsg.senderName;
  // 关键：删除原消息，容错处理（原消息 id 可能来自官方 API，格式可能不一致）
  if (originalMsg.id) {
    try {
      await deleteMessage(originalMsg.id);
      log(`injectTextMessage: 已删除原消息 ${originalMsg.id}`, 'info');
    } catch (e) {
      log(`injectTextMessage: 删除原消息失败 (非致命): ${e.message}`, 'warn');
    }
  }
  await addMessage(newMsg);
  log(`injectTextMessage: 已注入新消息 ${newMsg.id}, 长度 ${text.length}`, 'info');
  return newMsg;
}

async function injectImageMessage(originalMsg, imageDataUrl, offset) {
  const imgMsg = {
    id: genMsgId(),
    text: '[Image Upload]',
    isMe: originalMsg.isMe,
    content: imageDataUrl,
    type: 'image',
    timestamp: (originalMsg.timestamp || Date.now()) + 2 + (offset || 0),
    conversationId: originalMsg.conversationId,
    isVisionRecognized: false
  };
  if (originalMsg.senderId !== undefined) imgMsg.senderId = originalMsg.senderId;
  if (originalMsg.senderName !== undefined) imgMsg.senderName = originalMsg.senderName;
  await addMessage(imgMsg);
  return imgMsg;
}

// ============================================================
// 模式一：直注模式
// ============================================================
function formatNoteMode1(note, comments, sharerName) {
  const lines = [];
  lines.push(`${sharerName}分享了一个小红书笔记：`);
  lines.push('');
  lines.push(`# ${note.title || '(无标题)'}`);
  lines.push('');
  lines.push(note.desc || '(无正文)');
  lines.push('');
  const tags = extractTags(note);
  if (tags.length > 0) {
    lines.push(`标签：${tags.join(' ')}`);
    lines.push('');
  }
  if (comments?.comments?.length) {
    lines.push('热门评论：');
    for (const c of comments.comments.slice(0, 10)) {
      const u = c.user?.nickName || c.user?.nickname || '匿名';
      const t = (c.content || '').trim();
      let line = `- ${u}：${t}`;
      if (c.likeCount > 0) line += ` (${c.likeCount}赞)`;
      lines.push(line);
      if (c.subComments?.length) {
        for (const sc of c.subComments.slice(0, 2)) {
          const su = sc.user?.nickName || sc.user?.nickname || '匿名';
          lines.push(`  ↳ ${su}：${sc.content || ''}`);
        }
      }
    }
  }
  return lines.join('\n');
}

async function processMode1(msg, xhsUrl, result) {
  const { note, comments, images } = result;
  const sharerName = await getSharerName();
  const text = formatNoteMode1(note, comments, sharerName);
  const newTextMsg = await injectTextMessage(msg, text);
  const imageMsgIds = [];
  let imgOk = 0, imgFail = 0;
  for (let i = 0; i < images.length; i++) {
    try {
      log(`下载图片 ${i + 1}/${images.length}`, 'info');
      const dataUrl = await downloadImageAsDataUrl(images[i].url);
      const imgMsg = await injectImageMessage(newTextMsg, dataUrl, i);
      imageMsgIds.push(imgMsg.id);
      imgOk++;
    } catch (e) {
      imgFail++;
      log(`图片 ${i + 1} 失败: ${e.message}`, 'error');
    }
  }
  return { textMsgId: newTextMsg.id, imageMsgIds, imgOk, imgFail };
}

// ============================================================
// 模式二：总结模式
// ============================================================
function formatCommentsText(comments) {
  if (!comments?.comments?.length) return '(无评论)';
  const lines = [];
  for (const c of comments.comments.slice(0, 10)) {
    const u = c.user?.nickName || c.user?.nickname || '匿名';
    const t = (c.content || '').trim();
    let line = `- ${u}：${t}`;
    if (c.likeCount > 0) line += ` (${c.likeCount}赞)`;
    lines.push(line);
    if (c.subComments?.length) {
      for (const sc of c.subComments.slice(0, 2)) {
        const su = sc.user?.nickName || sc.user?.nickname || '匿名';
        lines.push(`  ↳ ${su}：${sc.content || ''}`);
      }
    }
  }
  return lines.join('\n');
}

function getActivePreset() {
  return runtime.apiPresets.find(p => p.id === runtime.activePresetId);
}

async function callSubApi(systemPrompt, userPrompt, imageUrls) {
  const preset = getActivePreset();
  if (!preset) throw new Error('未选择副 API 预设');
  if (!preset.baseUrl || !preset.apiKey || !preset.model) {
    throw new Error('预设配置不完整');
  }
  let url = preset.baseUrl.replace(/\/$/, '');
  if (!url.endsWith('/v1/chat/completions')) {
    if (url.endsWith('/v1')) url += '/chat/completions';
    else if (url.endsWith('/chat/completions')) {} // 已是完整 URL
    else url += '/v1/chat/completions';
  }
  log(`调用副 API: ${url} 模型: ${preset.model} 图片: ${imageUrls?.length || 0}张`, 'info');

  // 构造 messages：如果有图片就发多模态格式
  const userContent = [];
  if (imageUrls && imageUrls.length > 0) {
    for (const img of imageUrls) {
      userContent.push({ type: 'image_url', image_url: { url: img } });
    }
  }
  userContent.push({ type: 'text', text: userPrompt });

  const body = {
    model: preset.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature: preset.temperature ?? 0.5,
    max_tokens: 2000  // 详尽总结需要更多 token
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);  // vision 请求给 60 秒
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${preset.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${errText.substring(0, 200)}`);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('副 API 返回空内容');
    return text.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeNote(note, comments, imageDataUrls) {
  const desc = note.desc || '';
  const title = note.title || '(无标题)';
  const commentsText = formatCommentsText(comments);
  const tags = extractTags(note).join('、');

  // 系统提示：详尽总结，保留所有关键信息
  const systemPrompt = `你是一个小红书笔记总结助手。请基于提供的笔记正文、图片和评论，生成一份详尽的中文总结。

要求：
1. 保留所有关键信息，不要省略：
   - 地点、地址、店名、产品名、人名等专有名词
   - 价格、数量、规格、时长等数字信息
   - 步骤、方法、注意事项等流程信息
   - 时间、日期、营业时段等时效信息
2. 允许把值得记录的原文句子（如具体价格、关键步骤、金句、推荐语）原样放入总结
3. 图片里的信息也要详细纳入总结（图片上的文字、价格、菜单、地址等）
4. 评论中有价值的补充信息（如追问、纠错、补充推荐）也要纳入
5. 不要主观评价，只做客观归纳
6. 控制在 500 字左右，可以更多，但不要超过 800 字
7. 按逻辑分点组织，让 char 能完整理解笔记内容`;

  const userPrompt = `标题：${title}
标签：${tags}

正文：
${desc}

评论：
${commentsText}

请详尽总结这篇笔记（包括图片中的所有可见信息），不要省略关键内容，让没看过的人能完全理解这篇笔记在讲什么。`;

  // 如果有图片，必须调用副 API 让 vision 模型看图
  if (imageDataUrls && imageDataUrls.length > 0) {
    log(`准备发送 ${imageDataUrls.length} 张图片给副 API 详尽总结`, 'info');
    const summary = await callSubApi(systemPrompt, userPrompt, imageDataUrls);
    log(`副 API 总结完成（含图片识别），长度 ${summary.length}`, 'success');
    return summary;
  }

  // 没图片：≤500 字原样，>500 字调 API 总结
  if (desc.length <= 500) {
    log(`无图片且正文 ${desc.length} 字 ≤500，原样输出`, 'info');
    return desc;
  }
  log(`无图片且正文 ${desc.length} 字 >500，调用副 API 详尽总结`, 'info');
  const summary = await callSubApi(systemPrompt, userPrompt, null);
  log(`副 API 总结完成，长度 ${summary.length}`, 'success');
  return summary;
}

function formatNoteMode2(note, comments, summary, sharerName) {
  const title = note.title || '';
  const tags = extractTags(note);
  const images = extractNoteImages(note);
  const preview = extractPreview(note, 120);
  const commentsText = formatCommentsText(comments);
  const imageUrls = images.map(i => i.url).join(',');

  // char 看到的部分 + 卡片占位符
  const lines = [];
  lines.push(`${sharerName}分享了一个小红书笔记：`);
  lines.push('');
  lines.push(`# ${title || '(无标题)'}`);
  lines.push('');
  lines.push('[笔记总结]');
  lines.push(summary);
  lines.push('[/笔记总结]');
  lines.push('');
  lines.push('[用户评论]');
  lines.push(commentsText);
  lines.push('[/用户评论]');
  lines.push('');
  // 卡片占位符（user 通过正则渲染成卡片，char 看到的是一串标记，但很短）
  lines.push('[XHS_CARD]');
  lines.push(`title=${title}`);
  lines.push(`images=${imageUrls}`);
  lines.push(`preview=${preview}`);
  lines.push(`tags=${tags.join(',')}`);
  lines.push('[/XHS_CARD]');

  return lines.join('\n');
}

async function processMode2(msg, xhsUrl, result) {
  const { note, comments, images } = result;
  const sharerName = await getSharerName();

  // 下载所有图片为 base64 data URL（仅用于发送给副 API，不注入消息库）
  // 总结完成后这些数据会随函数返回自然丢弃
  const imageDataUrls = [];
  for (let i = 0; i < images.length; i++) {
    try {
      log(`模式二: 下载图片 ${i + 1}/${images.length} (临时, 总结后丢弃)`, 'info');
      const dataUrl = await downloadImageAsDataUrl(images[i].url);
      imageDataUrls.push(dataUrl);
    } catch (e) {
      log(`模式二: 图片 ${i + 1} 下载失败: ${e.message}`, 'error');
    }
  }

  // 调用副 API 总结（带上图片让 vision 模型看图）
  const summary = await summarizeNote(note, comments, imageDataUrls);

  // 总结完成，图片数据不再需要（不注入消息库，随作用域自然释放）
  log(`模式二: 总结完成, 已丢弃 ${imageDataUrls.length} 张图片数据`, 'info');

  const text = formatNoteMode2(note, comments, summary, sharerName);
  const newTextMsg = await injectTextMessage(msg, text);
  return {
    textMsgId: newTextMsg.id,
    imageMsgIds: [],  // 模式二不注入图片消息
    imgOk: imageDataUrls.length,
    imgFail: images.length - imageDataUrls.length
  };
}

// ============================================================
// 自动删除：10 条后删除注入内容
// ============================================================
async function checkAutoDelete() {
  if (!runtime.deleteTextEnabled && !runtime.deleteImagesEnabled) return;
  const processed = runtime.processedLinks;
  for (const key of Object.keys(processed)) {
    const info = processed[key];
    if (!info || info.deleted) continue;
    try {
      const msgs = await getMessagesByConversation(info.convId);
      // 计算注入后新增的消息数（排除自己注入的）
      const newMsgs = msgs.filter(m =>
        m.timestamp > info.injectTs &&
        !info.imageMsgIds.includes(m.id) &&
        m.id !== info.textMsgId
      );
      if (newMsgs.length >= runtime.deleteAfterCount) {
        log(`会话 ${info.convId} 新增 ${newMsgs.length} 条，触发自动删除`, 'info');
        if (runtime.deleteTextEnabled && info.textMsgId) {
          try { await deleteMessage(info.textMsgId); } catch (e) {}
        }
        if (runtime.deleteImagesEnabled && info.imageMsgIds.length) {
          for (const imgId of info.imageMsgIds) {
            try { await deleteMessage(imgId); } catch (e) {}
          }
        }
        info.deleted = true;
        rocheStorage.set(STORE_KEYS.processedLinks, processed);
        log(`已清理会话 ${info.convId} 的小红书内容`, 'success');
      }
    } catch (e) {}
  }
}

// ============================================================
// 自动监听主循环
// ============================================================
function extractXhsUrl(text) {
  if (!text) return null;
  // 从混合文本中匹配完整的小红书链接，支持：
  //   - 反引号/括号/引号包裹的链接
  //   - 多段路径（xhslink.com/o/xxx）
  //   - 各种小红书 URL 格式
  // 遇到空白、中文标点、闭合括号、CJK 字符等结束
  const m = text.match(/https?:\/\/(?:xhslink\.com\/[^\s`'"（()）,。！？；、）)\]》\u4e00-\u9fa5]+|www\.xiaohongshu\.com\/[^\s`'"（()）,。！？；、）)\]》\u4e00-\u9fa5]+)/);
  if (m) {
    return m[0].replace(/[,。！？；，、]+$/, '').trim();
  }
  return null;
}

function getMessageById(id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction('messages', 'readonly').objectStore('messages').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// ============================================================
// 全局浮层提示（即使插件面板关闭也能显示在 Roche 主界面上）
// ============================================================
function ensureFloatLayer() {
  let el = document.getElementById('xhs-float-layer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'xhs-float-layer';
    el.style.cssText = `
      position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
      z-index: 99999; pointer-events: none;
      display: flex; flex-direction: column; align-items: center; gap: 6px;
      max-width: 90vw;
    `;
    document.body.appendChild(el);
  }
  return el;
}

function showFloat(message, type = 'info', duration = 3000) {
  try {
    const layer = ensureFloatLayer();
    const toast = document.createElement('div');
    const colors = {
      info: 'background:rgba(59,130,246,0.95);color:#fff;',
      success: 'background:rgba(34,197,94,0.95);color:#fff;',
      error: 'background:rgba(239,68,68,0.95);color:#fff;',
      warn: 'background:rgba(245,158,11,0.95);color:#fff;'
    };
    toast.style.cssText = `
      ${colors[type] || colors.info}
      padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: 600;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 90vw;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      opacity: 0; transform: translateY(-10px);
      transition: opacity 0.3s, transform 0.3s;
    `;
    toast.textContent = message;
    layer.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  } catch (e) {}
}

// ============================================================
// 悬浮球（即使插件面板关闭也显示在屏幕边缘，点击快速打开插件）
// ============================================================
function ensureFloatingBall() {
  let ball = document.getElementById('xhs-floating-ball');
  if (ball) return ball;
  ball = document.createElement('div');
  ball.id = 'xhs-floating-ball';
  ball.style.cssText = `
    position: fixed; right: 16px; bottom: 100px;
    width: 48px; height: 48px; border-radius: 50%;
    background: linear-gradient(135deg, #ec4899, #f43f5e);
    color: #fff; font-size: 20px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 12px rgba(236,72,153,0.4);
    cursor: pointer; z-index: 99998;
    user-select: none; transition: transform 0.2s;
    font-family: -apple-system, sans-serif;
  `;
  ball.textContent = '书';
  ball.title = '小红书注入器 (点击打开面板)';
  // 状态指示器（小圆点）
  const dot = document.createElement('div');
  dot.id = 'xhs-ball-dot';
  dot.style.cssText = `
    position: absolute; top: 0; right: 0;
    width: 12px; height: 12px; border-radius: 50%;
    background: #9ca3af; border: 2px solid #fff;
    transition: background 0.3s;
  `;
  ball.appendChild(dot);
  // 点击打开插件面板
  ball.addEventListener('click', () => {
    try {
      if (runtime.roche?.ui?.openApp) {
        runtime.roche.ui.openApp('xhs-reader-home');
      } else if (runtime.roche?.ui?.open) {
        runtime.roche.ui.open('xhs-reader-home');
      } else {
        showFloat('请手动打开小红书注入器面板', 'warn', 3000);
      }
    } catch (e) {
      showFloat('打开面板失败: ' + e.message, 'error', 3000);
    }
  });
  document.body.appendChild(ball);
  return ball;
}

function updateBallStatus(state, text) {
  // state: idle | listening | processing | success | error
  try {
    const ball = document.getElementById('xhs-floating-ball');
    if (!ball) return;
    const dot = document.getElementById('xhs-ball-dot');
    if (!dot) return;
    const colors = {
      idle: '#9ca3af',
      listening: '#3b82f6',
      processing: '#f59e0b',
      success: '#22c55e',
      error: '#ef4444'
    };
    dot.style.background = colors[state] || colors.idle;
    if (text) ball.title = text;
  } catch (e) {}
}

// 便捷封装：兼容面板打开/关闭两种场景
function notify(message, type = 'info', duration = 3000) {
  // 1. 始终写日志
  log(message, type);
  // 2. 始终显示顶部浮层（即使插件面板关闭也能看到）
  showFloat(message, type, duration);
  // 3. 面板打开时额外用 roche.ui.toast（如果可用）
  try {
    if (runtime.roche?.ui?.toast && runtime.rootEl) {
      runtime.roche.ui.toast(message);
    }
  } catch (e) {}
  // 4. 关键错误用系统通知
  try {
    if (type === 'error' && Notification.permission === 'granted') {
      new Notification('小红书注入器', { body: message });
    }
  } catch (e) {}
  // 5. 更新悬浮球状态
  try {
    if (type === 'success') updateBallStatus('success');
    else if (type === 'error') updateBallStatus('error');
    else if (type === 'warn') updateBallStatus('processing');
  } catch (e) {}
}

async function pollOnce() {
  if (!runtime.autoListen || runtime.selectedIds.length === 0) return;
  // 关键：全局锁，防止 setInterval 在上一次处理未完成时并发触发
  if (runtime.isPolling) return;
  runtime.isPolling = true;
  try {
    const now = Date.now();
    const FAIL_COOLDOWN = 5000;
    const MAX_FAILS = 5;
    for (const convId of runtime.selectedIds) {
      try {
        // 关键优化：只读取最新 3 条消息（不要读 30 条，会触发 Roche 大量 reactive 更新导致卡顿）
        let msgs = [];
        try {
          const result = await runtime.roche.memory.getShortTerm({
            conversationId: convId,
            limit: 3
          });
          msgs = Array.isArray(result) ? result : (result?.messages || []);
        } catch (apiErr) {
          // 官方 API 失败时不回退到 IndexedDB（会加重卡顿）
          continue;
        }
        if (msgs.length === 0) continue;
        // 只检查最后一条消息（最新发送的）
        const m = msgs[msgs.length - 1];
        // isMe 判断兼容多种字段格式
        const isMe = m.isMe === true || m.senderId === 'me' || m.role === 'user' ||
                     (m.senderName === undefined && m.type !== 'assistant');
        if (!isMe) continue;
        if (m.type && m.type !== 'text') continue;
        const msgText = m.text || m.content || '';
        const url = extractXhsUrl(msgText);
        if (!url) continue;
        const msgId = m.id || m.messageId || `${convId}_${m.timestamp}`;
        const key = `${convId}_${msgId}`;
        const rec = runtime.processedLinks[key];
        if (rec) {
          if (rec.done) continue;
          if (rec.processing) continue;
          if (rec.fails > 0 && (now - (rec.lastFailTs || 0)) < FAIL_COOLDOWN) continue;
          if (rec.fails >= MAX_FAILS) {
            if (!rec.gaveUpLogged) {
              notify(`链接已达最大重试次数 (${MAX_FAILS})，放弃: ${url.substring(0, 40)}...`, 'error', 5000);
              rec.gaveUpLogged = true;
            }
            continue;
          }
          notify(`重试处理 (第 ${rec.fails + 1}/${MAX_FAILS} 次): ${url.substring(0, 40)}...`, 'warn');
        }
        // 标记正在处理
        runtime.processedLinks[key] = { processing: true, ts: now, fails: rec?.fails || 0 };
        notify(`检测到小红书链接，开始抓取...`, 'info', 2000);
        updateBallStatus('processing', `处理中: ${url.substring(0, 30)}...`);
        try {
          notify('正在抓取小红书内容并下载图片...', 'info', 2000);
          const result = await processXhsLinkFull(url);
          // 构造一个伪消息对象供 processMode1/2 使用
          const fakeMsg = {
            id: msgId,
            text: msgText,
            isMe: true,
            type: 'text',
            timestamp: m.timestamp || Date.now(),
            conversationId: convId
          };
          if (m.senderId !== undefined) fakeMsg.senderId = m.senderId;
          if (m.senderName !== undefined) fakeMsg.senderName = m.senderName;
          let procResult;
          if (runtime.mode === 2) {
            procResult = await processMode2(fakeMsg, url, result);
          } else {
            procResult = await processMode1(fakeMsg, url, result);
          }
          runtime.processedLinks[key] = {
            done: true,
            ts: Date.now(),
            injectTs: m.timestamp || Date.now(),
            convId,
            textMsgId: procResult.textMsgId,
            imageMsgIds: procResult.imageMsgIds,
            mode: runtime.mode,
            deleted: false
          };
          rocheStorage.set(STORE_KEYS.processedLinks, runtime.processedLinks);
          const title = result.note.title?.substring(0, 30) || '(无标题)';
          notify(`注入成功: ${title}`, 'success', 4000);
          updateBallStatus('success', `注入成功: ${title}`);
          setTimeout(() => updateBallStatus(runtime.autoListen ? 'listening' : 'idle'), 3000);
          refreshRocheChat(convId);
        } catch (e) {
          notify(`处理失败: ${e.message}`, 'error', 5000);
          updateBallStatus('error', `失败: ${e.message.substring(0, 30)}`);
          setTimeout(() => updateBallStatus(runtime.autoListen ? 'listening' : 'idle'), 5000);
          const prevFails = runtime.processedLinks[key]?.fails || 0;
          runtime.processedLinks[key] = {
            fails: prevFails + 1,
            lastFailTs: Date.now(),
            ts: Date.now()
          };
          rocheStorage.set(STORE_KEYS.processedLinks, runtime.processedLinks);
          notify(`将在 ${FAIL_COOLDOWN / 1000} 秒后重试 (已失败 ${prevFails + 1}/${MAX_FAILS})`, 'warn', 3000);
        }
      } catch (e) {
        log(`pollOnce 处理会话 ${convId} 异常: ${e.message}`, 'error');
      }
    }
  } finally {
    runtime.isPolling = false;
  }
}

function startAutoListen() {
  if (runtime.pollTimer) clearInterval(runtime.pollTimer);
  runtime.pollTimer = setInterval(pollOnce, runtime.pollInterval);
  // 取消自动删除定时器（用户要求：不自动删除，让用户自己处理）
  // if (runtime.cleanupTimer) clearInterval(runtime.cleanupTimer);
  // runtime.cleanupTimer = setInterval(checkAutoDelete, runtime.cleanupInterval);
  log(`自动监听已启动 (${runtime.pollInterval}ms 间隔)`, 'info');
  updateBallStatus('listening', '小红书注入器 (监听中)');
}

function stopAutoListen() {
  if (runtime.pollTimer) { clearInterval(runtime.pollTimer); runtime.pollTimer = null; }
  if (runtime.cleanupTimer) { clearInterval(runtime.cleanupTimer); runtime.cleanupTimer = null; }
  log('自动监听已停止', 'info');
  updateBallStatus('idle', '小红书注入器 (未监听)');
}

// ============================================================
// 副 API 预设管理
// ============================================================
async function fetchModels(preset) {
  let url = preset.baseUrl.replace(/\/$/, '');
  if (!url.endsWith('/v1/models')) {
    if (url.endsWith('/v1')) url += '/models';
    else url += '/v1/models';
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${preset.apiKey}` },
      signal: controller.signal
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${t.substring(0, 100)}`);
    }
    const data = await resp.json();
    const models = (data.data || []).map(m => m.id).filter(Boolean);
    return models.sort();
  } finally {
    clearTimeout(timeout);
  }
}

async function testPreset(preset) {
  // 发一个简单请求测试
  let url = preset.baseUrl.replace(/\/$/, '');
  if (!url.endsWith('/v1/chat/completions')) {
    if (url.endsWith('/v1')) url += '/chat/completions';
    else url += '/v1/chat/completions';
  }
  const body = {
    model: preset.model,
    messages: [{ role: 'user', content: '回复"OK"' }],
    max_tokens: 10
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${preset.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${t.substring(0, 200)}`);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// 初始化
// ============================================================
async function initApp(root, roche) {
  runtime.roche = roche;
  runtime.rootEl = root;
  rocheStorage = {
    get: (k) => roche.storage.get(k),
    set: (k, v) => roche.storage.set(k, v),
    delete: (k) => roche.storage.delete(k)
  };

  // 加载配置
  const [mode, sel, proc, auto, deleteAfter, delText, delImgs, presets, activePresetId, useBuiltinCf] = await Promise.all([
    rocheStorage.get(STORE_KEYS.mode),
    rocheStorage.get(STORE_KEYS.selectedIds),
    rocheStorage.get(STORE_KEYS.processedLinks),
    rocheStorage.get(STORE_KEYS.autoListen),
    rocheStorage.get(STORE_KEYS.deleteAfterCount),
    rocheStorage.get(STORE_KEYS.deleteTextEnabled),
    rocheStorage.get(STORE_KEYS.deleteImagesEnabled),
    rocheStorage.get(STORE_KEYS.apiPresets),
    rocheStorage.get(STORE_KEYS.activePresetId),
    rocheStorage.get(STORE_KEYS.useBuiltinCf)
  ]);
  runtime.mode = mode || 1;
  runtime.selectedIds = sel || [];
  runtime.processedLinks = proc || {};
  runtime.autoListen = auto === true;
  runtime.useBuiltinCf = useBuiltinCf !== false; // 默认开启
  runtime.deleteAfterCount = deleteAfter || 10;
  runtime.deleteTextEnabled = delText !== false;
  runtime.deleteImagesEnabled = delImgs !== false;
  runtime.apiPresets = presets || [];
  runtime.activePresetId = activePresetId || (runtime.apiPresets[0]?.id || null);

  render(root);
  bindEvents(roche);

  // 如果之前开启了监听且勾选了会话，自动启动
  if (runtime.autoListen && runtime.selectedIds.length > 0) {
    startAutoListen();
  }
  // 同步 UI 开关状态
  const autoToggle = root.querySelector('#xhs-auto-toggle');
  if (autoToggle) autoToggle.checked = runtime.autoListen;
  const status = root.querySelector('#xhs-listen-status');
  if (status) status.textContent = runtime.autoListen && runtime.selectedIds.length > 0 ? '运行中' : '已停止';
  // 请求系统通知权限（用于面板关闭时的关键错误提醒）
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch (e) {}
  // 创建悬浮球（隐藏，不显示在屏幕上）
  ensureFloatingBall();
  // 隐藏悬浮球（用户要求）
  const ball = document.getElementById('xhs-floating-ball');
  if (ball) ball.style.display = 'none';
  updateBallStatus(runtime.autoListen ? 'listening' : 'idle', runtime.autoListen ? '小红书注入器 (监听中)' : '小红书注入器 (未监听)');
  log('插件已加载 v2.6.5', 'success');
}

function cleanup() {
  stopAutoListen();
  runtime.rootEl = null;
}

// ============================================================
// 渲染
// ============================================================
function render(root) {
  root.innerHTML = `
    <style>
      .roche-plugin-xhs-reader { --xhs-bg:#fff;--xhs-bg-soft:#f8f9fa;--xhs-border:#e5e7eb;--xhs-text:#1f2937;--xhs-text-dim:#6b7280;--xhs-accent:#ec4899;--xhs-accent-hover:#db2777; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; font-size:14px; color:var(--xhs-text); background:var(--xhs-bg); height:100%; display:flex; flex-direction:column; }
      .roche-plugin-xhs-reader * { box-sizing:border-box; }
      .xhs-header { padding:12px 16px; border-bottom:1px solid var(--xhs-border); background:var(--xhs-bg-soft); }
      .xhs-title { font-size:16px; font-weight:600; margin:0 0 4px 0; }
      .xhs-subtitle { font-size:12px; color:var(--xhs-text-dim); margin:0; }
      .xhs-tabs { display:flex; gap:4px; padding:8px 16px; background:var(--xhs-bg-soft); border-bottom:1px solid var(--xhs-border); }
      .xhs-tab { padding:6px 14px; border:none; background:transparent; color:var(--xhs-text-dim); cursor:pointer; border-radius:6px; font-size:13px; }
      .xhs-tab.active { background:var(--xhs-accent); color:white; }
      .xhs-content { flex:1; overflow-y:auto; padding:16px; }
      .xhs-panel { display:none; }
      .xhs-panel.active { display:block; }
      .xhs-field { margin-bottom:16px; }
      .xhs-label { display:block; font-size:13px; font-weight:500; margin-bottom:6px; color:var(--xhs-text); }
      .xhs-input { width:100%; padding:8px 10px; border:1px solid var(--xhs-border); border-radius:6px; font-size:13px; font-family:inherit; background:white; }
      .xhs-input:focus { outline:none; border-color:var(--xhs-accent); }
      .xhs-hint { font-size:12px; color:var(--xhs-text-dim); line-height:1.5; }
      .xhs-btn { padding:8px 14px; border:1px solid var(--xhs-border); border-radius:6px; background:white; cursor:pointer; font-size:13px; color:var(--xhs-text); }
      .xhs-btn:hover { background:var(--xhs-bg-soft); }
      .xhs-btn-primary { background:var(--xhs-accent); color:white; border:none; }
      .xhs-btn-primary:hover { background:var(--xhs-accent-hover); }
      .xhs-btn-danger { background:#e74c3c; color:white; border:none; }
      .xhs-btn-danger:hover { background:#c0392b; }
      .xhs-log { font-family:'Consolas',monospace; font-size:11px; line-height:1.5; }
      .xhs-log-line { padding:2px 0; border-bottom:1px dashed var(--xhs-border); word-break:break-all; }
      .xhs-log-time { color:var(--xhs-text-dim); margin-right:6px; }
      .xhs-log-info { color:var(--xhs-text); }
      .xhs-log-success { color:#10b981; }
      .xhs-log-error { color:#ef4444; }
      .xhs-conv-list { max-height:240px; overflow-y:auto; border:1px solid var(--xhs-border); border-radius:6px; }
      .xhs-conv-item { padding:8px 10px; border-bottom:1px solid var(--xhs-border); cursor:pointer; font-size:13px; }
      .xhs-conv-item:hover { background:var(--xhs-bg-soft); }
      .xhs-conv-item.selected { background:#fce7f3; }
      .xhs-preset-item { padding:10px; border:1px solid var(--xhs-border); border-radius:6px; margin-bottom:8px; background:white; }
      .xhs-preset-item.active { border-color:var(--xhs-accent); background:#fdf2f8; }
      .xhs-row { display:flex; gap:8px; align-items:center; }
      .xhs-row > * { flex:1; }
      .xhs-status { padding:6px 10px; border-radius:4px; font-size:12px; background:var(--xhs-bg-soft); }
      .xhs-regex-block { border:1px solid var(--xhs-border); border-radius:8px; padding:10px; background:#fafafa; margin-top:4px; }
      .xhs-regex-label { font-size:12px; font-weight:600; color:var(--xhs-text-dim); margin:6px 0 4px 0; }
      .xhs-regex-label:first-child { margin-top:0; }
      .xhs-regex-code { width:100%; padding:8px 10px; border:1px solid var(--xhs-border); border-radius:4px; font-family:'Consolas','Monaco',monospace; font-size:11px; line-height:1.5; background:#fff; color:#1f2937; resize:vertical; box-sizing:border-box; }
      .xhs-regex-code:focus { outline:none; border-color:var(--xhs-accent); }
    </style>
    <div class="xhs-header">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="flex:1;min-width:0;">
          <h2 class="xhs-title">小红书链接注入器</h2>
          <p class="xhs-subtitle">v2.6.5 · 模式${runtime.mode === 2 ? '二：副 API 详尽总结' : '一：直注模式'}</p>
        </div>
        <button class="xhs-btn" id="xhs-close-btn" title="退出插件面板（监听继续运行）" style="flex:0 0 auto;padding:6px 14px;font-size:13px;">退出</button>
      </div>
    </div>
    <nav class="xhs-tabs">
      <button class="xhs-tab ${runtime.mode === 1 ? 'active' : ''}" data-tab="main">主面板</button>
      <button class="xhs-tab" data-tab="api">副 API</button>
      <button class="xhs-tab" data-tab="delete">自动删除</button>
      <button class="xhs-tab" data-tab="regex">正则文案</button>
      <button class="xhs-tab" data-tab="settings">设置</button>
      <button class="xhs-tab" data-tab="logs">日志</button>
    </nav>
    <div class="xhs-content">
      <!-- 主面板 -->
      <section class="xhs-panel ${runtime.mode === 1 ? 'active' : ''}" id="xhs-panel-main">
        <div class="xhs-field">
          <label class="xhs-label">运行模式</label>
          <div class="xhs-row">
            <button class="xhs-btn xhs-mode-btn ${runtime.mode === 1 ? 'xhs-btn-primary' : ''}" data-mode="1">模式一：直注（原文+图片）</button>
            <button class="xhs-btn xhs-mode-btn ${runtime.mode === 2 ? 'xhs-btn-primary' : ''}" data-mode="2">模式二：副 API 总结</button>
          </div>
          <div class="xhs-hint" style="margin-top:6px;">
            模式一：抓取笔记全文+评论，独立注入文本和图片消息（最省事，但耗 token）<br/>
            模式二：下载图片 → 发给副 API（vision 模型）总结为 300 字左右 → 丢弃图片<br/>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;最终注入：总结文本 + 评论 + 卡片占位符（user 看卡片，char 只看总结）
          </div>
        </div>
        <div class="xhs-field">
          <label class="xhs-label">手动注入（粘贴小红书链接）</label>
          <input type="text" class="xhs-input" id="xhs-link-input" placeholder="https://www.xiaohongshu.com/explore/..." />
          <div class="xhs-row" style="margin-top:8px;">
            <select class="xhs-input" id="xhs-conv-select">
              <option value="">选择目标会话...</option>
            </select>
            <button class="xhs-btn xhs-btn-primary" id="xhs-inject-btn" style="flex:0 0 auto;">注入</button>
          </div>
          <button class="xhs-btn" id="xhs-preview-btn" style="width:100%;margin-top:8px;">预览抓取内容</button>
          <div id="xhs-preview" style="margin-top:10px;padding:10px;background:var(--xhs-bg-soft);border-radius:6px;font-size:12px;display:none;white-space:pre-wrap;max-height:200px;overflow-y:auto;"></div>
        </div>
        <div class="xhs-field">
          <label class="xhs-label">自动监听</label>
          <div class="xhs-row">
            <label style="flex:0 0 auto;display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" id="xhs-auto-toggle" ${runtime.autoListen ? 'checked' : ''} />
              <span style="font-size:13px;">启用自动监听</span>
            </label>
            <span class="xhs-status" id="xhs-listen-status">${runtime.autoListen ? '运行中' : '已停止'}</span>
          </div>
          <div class="xhs-hint" style="margin-top:6px;">勾选后会自动处理勾选会话中的小红书链接（300ms 检测间隔）</div>
        </div>
        <div class="xhs-field">
          <label class="xhs-label">监听会话</label>
          <div class="xhs-conv-list" id="xhs-conv-list"></div>
        </div>
      </section>

      <!-- 副 API -->
      <section class="xhs-panel" id="xhs-panel-api">
        <div class="xhs-field">
          <label class="xhs-label">当前预设</label>
          <div class="xhs-row">
            <select class="xhs-input" id="xhs-preset-select">
              <option value="">未选择...</option>
              ${runtime.apiPresets.map(p => `<option value="${p.id}" ${p.id === runtime.activePresetId ? 'selected' : ''}>${p.name}</option>`).join('')}
            </select>
            <button class="xhs-btn" id="xhs-new-preset" style="flex:0 0 auto;">新建</button>
          </div>
        </div>
        <div id="xhs-preset-editor" style="display:none;">
          <div class="xhs-field">
            <label class="xhs-label">预设名称</label>
            <input type="text" class="xhs-input" id="xhs-preset-name" placeholder="例如：默认 / OpenAI / DeepSeek" />
          </div>
          <div class="xhs-field">
            <label class="xhs-label">Base URL</label>
            <input type="text" class="xhs-input" id="xhs-preset-url" placeholder="https://api.openai.com 或 https://api.openai.com/v1" />
            <div class="xhs-hint" style="margin-top:4px;">OpenAI 兼容接口的根地址</div>
          </div>
          <div class="xhs-field">
            <label class="xhs-label">API Key</label>
            <input type="password" class="xhs-input" id="xhs-preset-key" placeholder="sk-..." />
          </div>
          <div class="xhs-field">
            <label class="xhs-label">模型</label>
            <div class="xhs-row">
              <input type="text" class="xhs-input" id="xhs-preset-model" placeholder="gpt-4o-mini 或点刷新获取" />
              <button class="xhs-btn" id="xhs-refresh-models" style="flex:0 0 auto;">刷新</button>
            </div>
            <select class="xhs-input" id="xhs-model-list" style="margin-top:6px;display:none;" size="6"></select>
          </div>
          <div class="xhs-field">
            <label class="xhs-label">Temperature</label>
            <input type="number" class="xhs-input" id="xhs-preset-temp" value="0.5" min="0" max="2" step="0.1" />
          </div>
          <div class="xhs-row">
            <button class="xhs-btn xhs-btn-primary" id="xhs-save-preset">保存预设</button>
            <button class="xhs-btn" id="xhs-test-preset">测试连接</button>
            <button class="xhs-btn xhs-btn-danger" id="xhs-delete-preset">删除</button>
          </div>
          <div id="xhs-preset-test-result" style="margin-top:10px;font-size:12px;display:none;padding:8px;border-radius:4px;"></div>
        </div>
        <div class="xhs-hint" style="margin-top:16px;padding:10px;background:var(--xhs-bg-soft);border-radius:6px;">
          <strong>使用说明：</strong><br/>
          1. 新建预设 → 填 Base URL + API Key → 点刷新获取模型列表<br/>
          2. 选模型 → 保存预设（模型必须支持 vision 多模态）<br/>
          3. 在主面板切到「模式二」即可启用副 API 总结<br/>
          4. 模式二会下载笔记图片 → 一起发给副 API 总结（300 字左右）→ 丢弃图片
        </div>
      </section>

      <!-- 自动删除 -->
      <section class="xhs-panel" id="xhs-panel-delete">
        <div class="xhs-field">
          <label class="xhs-label">自动删除功能</label>
          <div class="xhs-hint" style="margin-bottom:10px;">注入小红书内容后，当该会话新增指定条数消息时自动删除注入的内容（避免长期占用 token）</div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px;">
            <input type="checkbox" id="xhs-del-text-toggle" ${runtime.deleteTextEnabled ? 'checked' : ''} />
            <span>自动删除注入的文本消息</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="xhs-del-img-toggle" ${runtime.deleteImagesEnabled ? 'checked' : ''} />
            <span>自动删除注入的图片消息</span>
          </label>
        </div>
        <div class="xhs-field">
          <label class="xhs-label">触发条数</label>
          <div class="xhs-row">
            <input type="number" class="xhs-input" id="xhs-del-count" value="${runtime.deleteAfterCount}" min="1" max="100" />
            <span class="xhs-hint">条消息后删除</span>
          </div>
        </div>
        <button class="xhs-btn xhs-btn-danger" id="xhs-clean-bad-images" style="width:100%;margin-top:20px;">扫描并清理坏图片消息（v1.4.2 之前）</button>
        <div id="xhs-clean-result" style="margin-top:8px;font-size:12px;"></div>
      </section>

      <!-- 正则文案 -->
      <section class="xhs-panel" id="xhs-panel-regex">
        <div class="xhs-hint" style="margin-bottom:12px;padding:10px;background:#fff3cd;border-radius:6px;color:#856404;">
          把以下三段正则配置复制到 Roche 的「正则替换」设置里，即可让模式二的消息渲染成精美卡片，同时把 AI 上下文（笔记总结/评论标签）隐藏起来。
        </div>

        <div class="xhs-field">
          <label class="xhs-label">正则 1：渲染 XHS_CARD 为卡片容器</label>
          <div class="xhs-hint" style="margin-bottom:6px;">把 [XHS_CARD]...[/XHS_CARD] 包成粉色渐变卡片容器（user 可见，char 看到的是简短标记）。</div>
          <div class="xhs-regex-block">
            <div class="xhs-regex-label">匹配：</div>
            <textarea class="xhs-regex-code" readonly rows="2" onclick="this.select()">[XHS_CARD]([\s\S]*?)[/XHS_CARD]</textarea>
            <div class="xhs-regex-label">替换：</div>
            <textarea class="xhs-regex-code" readonly rows="6" onclick="this.select()">&lt;div style="margin:8px 0;padding:12px;border-radius:12px;background:linear-gradient(135deg,#fff,#fdf2f8);border:1px solid #fce7f3;box-shadow:0 2px 8px rgba(236,72,153,0.1);"&gt;
$1
&lt;/div&gt;</textarea>
          </div>
        </div>

        <div class="xhs-field">
          <label class="xhs-label">正则 2：把卡片内的字段渲染为标题+图片+预览+标签</label>
          <div class="xhs-hint" style="margin-bottom:6px;">把 title= / images= / preview= / tags= 四行转成可视化布局，自动加载笔记图片。</div>
          <div class="xhs-regex-block">
            <div class="xhs-regex-label">匹配：</div>
            <textarea class="xhs-regex-code" readonly rows="2" onclick="this.select()">title=(.*?)\nimages=(.*?)\npreview=(.*?)\ntags=(.*?)(?=\n|$)</textarea>
            <div class="xhs-regex-label">替换：</div>
            <textarea class="xhs-regex-code" readonly rows="14" onclick="this.select()">&lt;div style="font-weight:600;font-size:15px;margin-bottom:8px;"&gt;$1&lt;/div&gt;
&lt;div id="xhs-imgs-$1" style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;"&gt;&lt;/div&gt;
&lt;script&gt;
(function(){
  var imgs='$2'.split(',');
  var box=document.querySelector('#xhs-imgs-$1');
  if(!box)return;
  imgs.forEach(function(u){
    if(!u)return;
    var img=document.createElement('img');
    img.src=u;img.style='width:80px;height:80px;object-fit:cover;border-radius:6px;';
    box.appendChild(img);
  });
})();
&lt;/script&gt;
&lt;div style="font-size:13px;color:#666;margin:8px 0;"&gt;$3&lt;/div&gt;
&lt;div style="font-size:12px;color:#ec4899;"&gt;$4&lt;/div&gt;</textarea>
          </div>
        </div>

        <div class="xhs-field">
          <label class="xhs-label">正则 3：隐藏 [笔记总结] / [用户评论] 标签</label>
          <div class="xhs-hint" style="margin-bottom:6px;">把这些方括号标签从渲染中移除（user 不看到奇怪标签，char 看到的是纯文本段落）。</div>
          <div class="xhs-regex-block">
            <div class="xhs-regex-label">匹配：</div>
            <textarea class="xhs-regex-code" readonly rows="2" onclick="this.select()">\[(笔记总结|用户评论|/笔记总结|/用户评论)\]</textarea>
            <div class="xhs-regex-label">替换：</div>
            <textarea class="xhs-regex-code" readonly rows="1" onclick="this.select()">（留空）</textarea>
          </div>
        </div>

        <div class="xhs-field">
          <label class="xhs-label">最终效果</label>
          <div class="xhs-hint" style="padding:10px;background:var(--xhs-bg-soft);border-radius:6px;line-height:1.7;">
            <strong>user 视角：</strong>看到一张粉色渐变卡片，里面有标题、缩略图、笔记预览、标签<br/>
            <strong>char 视角：</strong>看到「xxx分享了一个小红书笔记：」+ 标题 + 总结文本（300 字左右）+ 评论，不会看到乱码或图片 URL<br/>
            <strong>token 节省：</strong>相比模式一直接注入全文+图片，模式二只占约 400 字
          </div>
        </div>
      </section>

      <!-- 设置 -->
      <section class="xhs-panel" id="xhs-panel-settings">
        <div class="xhs-field">
          <label class="xhs-label">内置代理（推荐开启）</label>
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">
            <input type="checkbox" id="xhs-builtin-cf-toggle" ${runtime.useBuiltinCf ? 'checked' : ''} style="margin-top:2px;flex:0 0 auto;" />
            <div style="font-size:13px;line-height:1.6;">
              <strong>使用内置 CF Worker 代理</strong>（默认开启）<br/>
              <span style="color:var(--xhs-text-dim);">
                浏览器端自动使用官方代理解决 corsproxy 403 问题，无需自行部署。<br/>
                该代理仅处理小红书公开数据（笔记链接、HTML页面、图片），<strong>不经过任何用户隐私数据</strong>（聊天内容、角色人设、API Key 等均不经此代理）。<br/>
                若不放心可关闭，或填入自己的 CF Worker 地址。<br/>
                <strong>APK 端不受此开关影响</strong>，APK 默认走公共代理（corsproxy 可用）。
              </span>
            </div>
          </label>
        </div>
        <div class="xhs-field">
          <label class="xhs-label">自定义 Cloudflare Worker 代理地址（可选）</label>
          <input type="text" class="xhs-input" id="xhs-cf-worker" placeholder="https://xxx.your-name.workers.dev" />
          <div class="xhs-hint" style="margin-top:6px;">下载图片和抓取HTML时优先使用。开启内置代理后，自定义代理作为备选。留空则仅使用内置代理+公共代理。</div>
        </div>
        <div class="xhs-field">
          <label class="xhs-label">Worker 部署教程（如果想自己部署）</label>
          <div style="font-size:12px;color:var(--xhs-text-dim);line-height:1.7;padding:10px;background:var(--xhs-bg-soft);border:1px solid var(--xhs-border);border-radius:8px;">
            1. 注册 <a href="https://dash.cloudflare.com" target="_blank" style="color:var(--xhs-accent);">Cloudflare</a>（免费，建议手机端用谷歌商店注册谷歌账号再注册CF，被封了申诉基本会成功）<br/>
            2. 左侧菜单 Workers 和 Pages → 创建应用程序 → 创建 Worker<br/>
            3. 起名 → 部署 → 编辑代码 → 粘贴下方脚本 → 部署<br/>
            4. 复制 workers.dev 地址填到上面 → 保存
          </div>
        </div>
        <div class="xhs-field">
          <label class="xhs-label">Worker 脚本（复制这段）</label>
          <textarea class="xhs-input" readonly rows="10" style="font-family:monospace;font-size:11px;resize:vertical;" onclick="this.select()">export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '86400'
      }});
    }
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) return new Response('xhs-proxy ready. Usage: ?url=<xhs_url>', {
      status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain; charset=utf-8' }
    });
    try {
      const resp = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.xiaohongshu.com/',
          'Accept': '*/*'
        }
      });
      const body = await resp.arrayBuffer();
      const headers = new Headers(resp.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      headers.set('Access-Control-Allow-Headers', '*');
      headers.delete('content-security-policy');
      headers.delete('x-frame-options');
      return new Response(body, { status: resp.status, headers });
    } catch (e) {
      return new Response('fetch error: ' + e.message, {
        status: 502, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' }
      });
    }
  }
}</textarea>
        </div>
        <button class="xhs-btn xhs-btn-primary" id="xhs-save-settings" style="width:100%;">保存设置</button>
      </section>

      <!-- 日志 -->
      <section class="xhs-panel" id="xhs-panel-logs">
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <button class="xhs-btn" id="xhs-copy-logs" style="flex:1;padding:6px 10px;font-size:12px;">复制全部日志</button>
          <button class="xhs-btn" id="xhs-clear-logs" style="flex:0 0 auto;padding:6px 10px;font-size:12px;">清空</button>
        </div>
        <div class="xhs-log" id="xhs-logs"></div>
      </section>
    </div>
  `;
}

function renderLogs() {
  const el = runtime.rootEl?.querySelector('#xhs-logs');
  if (!el) return;
  if (runtime.logs.length === 0) {
    el.innerHTML = '<div style="color:var(--xhs-text-dim);font-size:12px;">暂无日志</div>';
    return;
  }
  el.innerHTML = runtime.logs.slice(-100).map(l => {
    const cls = `xhs-log-${l.type}`;
    return `<div class="xhs-log-line"><span class="xhs-log-time">${l.time}</span><span class="${cls}">${l.msg}</span></div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

async function renderConversationList() {
  const el = runtime.rootEl?.querySelector('#xhs-conv-list');
  const selectEl = runtime.rootEl?.querySelector('#xhs-conv-select');
  if (!el) return;
  try {
    const conversations = await getAllRecords('conversations');
    // 同步到下拉框
    if (selectEl) {
      const current = selectEl.value;
      selectEl.innerHTML = '<option value="">选择目标会话...</option>' +
        conversations.map(c => {
          const id = c.id || c.conversationId;
          const name = c.name || c.title || c.handle || id;
          return `<option value="${id}">${name}</option>`;
        }).join('');
      selectEl.value = current;
    }
    el.innerHTML = conversations.map(c => {
      const id = c.id || c.conversationId;
      const name = c.name || c.title || c.handle || id;
      const avatar = c.avatar || '';
      const selected = runtime.selectedIds.includes(id);
      const avatarHtml = avatar
        ? `<img src="${avatar}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex:0 0 auto;" onerror="this.style.display='none'" />`
        : `<div style="width:32px;height:32px;border-radius:50%;background:#e5e7eb;flex:0 0 auto;"></div>`;
      return `<div class="xhs-conv-item ${selected ? 'selected' : ''}" data-id="${id}" style="display:flex;align-items:center;gap:10px;">${avatarHtml}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</span></div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<div style="color:#e74c3c;font-size:12px;">加载失败: ${e.message}</div>`;
  }
}

// ============================================================
// 事件绑定
// ============================================================
function bindEvents(roche) {
  const root = runtime.rootEl;
  if (!root) return;

  // 退出按钮：关闭插件面板（监听继续运行，因为 unmount 不停止定时器）
  const closeBtn = root.querySelector('#xhs-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      try {
        if (roche.ui?.closeApp) {
          roche.ui.closeApp();
        } else if (roche.ui?.close) {
          roche.ui.close();
        } else {
          log('未找到 roche.ui.closeApp 方法', 'error');
        }
      } catch (e) {
        log(`退出失败: ${e.message}`, 'error');
      }
    });
  }

  // 复制全部日志
  const copyLogsBtn = root.querySelector('#xhs-copy-logs');
  if (copyLogsBtn) {
    copyLogsBtn.addEventListener('click', async () => {
      try {
        const text = runtime.logs.map(l => `[${l.time}] ${l.type.toUpperCase()}: ${l.msg}`).join('\n');
        await navigator.clipboard.writeText(text);
        roche.ui.toast(`已复制 ${runtime.logs.length} 条日志`);
      } catch (e) {
        // 备用方案：创建 textarea
        try {
          const ta = document.createElement('textarea');
          ta.value = runtime.logs.map(l => `[${l.time}] ${l.type.toUpperCase()}: ${l.msg}`).join('\n');
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          roche.ui.toast(`已复制 ${runtime.logs.length} 条日志`);
        } catch (e2) {
          roche.ui.toast('复制失败: ' + e2.message);
        }
      }
    });
  }

  // 清空日志
  const clearLogsBtn = root.querySelector('#xhs-clear-logs');
  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', () => {
      const n = runtime.logs.length;
      runtime.logs = [];
      renderLogs();
      roche.ui.toast(`已清空 ${n} 条日志`);
    });
  }

  // Tab 切换
  root.querySelectorAll('.xhs-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      root.querySelectorAll('.xhs-tab').forEach(b => b.classList.remove('active'));
      root.querySelectorAll('.xhs-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      root.querySelector(`#xhs-panel-${tab}`).classList.add('active');
      if (tab === 'main' || tab === 'logs') renderLogs();
      if (tab === 'main') renderConversationList();
    });
  });

  // 模式切换
  root.querySelectorAll('.xhs-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = parseInt(btn.dataset.mode);
      runtime.mode = mode;
      await rocheStorage.set(STORE_KEYS.mode, mode);
      root.querySelectorAll('.xhs-mode-btn').forEach(b => {
        b.classList.toggle('xhs-btn-primary', parseInt(b.dataset.mode) === mode);
      });
      const sub = root.querySelector('.xhs-subtitle');
      if (sub) sub.textContent = `v2.6.5 · 模式${mode === 2 ? '二：副 API 详尽总结' : '一：直注模式'}`;
      roche.ui.toast(`已切换到模式${mode === 2 ? '二' : '一'}`);
      log(`模式切换为: ${mode === 2 ? '模式二（副 API 总结）' : '模式一（直注）'}`, 'info');
    });
  });

  // 加载 CF Worker 配置 + 内置代理开关
  (async () => {
    try {
      const savedCfWorker = await rocheStorage.get(STORE_KEYS.cfWorker);
      if (savedCfWorker && root.querySelector('#xhs-cf-worker')) {
        root.querySelector('#xhs-cf-worker').value = savedCfWorker;
      }
      const savedBuiltin = await rocheStorage.get(STORE_KEYS.useBuiltinCf);
      if (savedBuiltin !== undefined && savedBuiltin !== null && root.querySelector('#xhs-builtin-cf-toggle')) {
        runtime.useBuiltinCf = savedBuiltin !== false;
        root.querySelector('#xhs-builtin-cf-toggle').checked = runtime.useBuiltinCf;
      }
    } catch (e) {}
  })();

  // 内置代理开关
  const builtinToggle = root.querySelector('#xhs-builtin-cf-toggle');
  if (builtinToggle) {
    builtinToggle.addEventListener('change', async (e) => {
      runtime.useBuiltinCf = e.target.checked;
      await rocheStorage.set(STORE_KEYS.useBuiltinCf, runtime.useBuiltinCf);
      roche.ui.toast(runtime.useBuiltinCf ? '已开启内置代理' : '已关闭内置代理');
    });
  }

  // 保存 CF Worker
  root.querySelector('#xhs-save-settings').addEventListener('click', async () => {
    const workerUrl = root.querySelector('#xhs-cf-worker').value.trim();
    await rocheStorage.set(STORE_KEYS.cfWorker, workerUrl);
    if (workerUrl) {
      roche.ui.toast('已保存自定义 CF Worker 地址');
    } else {
      roche.ui.toast('设置已保存');
    }
  });

  // 会话列表点击
  root.querySelector('#xhs-conv-list').addEventListener('click', async (e) => {
    const item = e.target.closest('.xhs-conv-item');
    if (!item) return;
    const id = item.dataset.id;
    const idx = runtime.selectedIds.indexOf(id);
    if (idx >= 0) runtime.selectedIds.splice(idx, 1);
    else {
      if (runtime.selectedIds.length >= 3) {
        roche.ui.toast('最多监听 3 个会话');
        return;
      }
      runtime.selectedIds.push(id);
    }
    await rocheStorage.set(STORE_KEYS.selectedIds, runtime.selectedIds);
    renderConversationList();
    const status = root.querySelector('#xhs-listen-status');
    if (status) status.textContent = runtime.autoListen && runtime.selectedIds.length > 0 ? '运行中' : '已停止';
  });

  // 自动监听开关
  root.querySelector('#xhs-auto-toggle').addEventListener('change', async (e) => {
    runtime.autoListen = e.target.checked;
    await rocheStorage.set(STORE_KEYS.autoListen, runtime.autoListen);
    if (runtime.autoListen) {
      if (runtime.selectedIds.length === 0) {
        roche.ui.toast('请先勾选要监听的会话');
        runtime.autoListen = false;
        e.target.checked = false;
        await rocheStorage.set(STORE_KEYS.autoListen, false);
        return;
      }
      startAutoListen();
    } else {
      stopAutoListen();
    }
    const status = root.querySelector('#xhs-listen-status');
    if (status) status.textContent = runtime.autoListen ? '运行中' : '已停止';
  });

  // 预览
  root.querySelector('#xhs-preview-btn').addEventListener('click', async () => {
    const link = root.querySelector('#xhs-link-input').value.trim();
    if (!link) { roche.ui.toast('请输入链接'); return; }
    if (!/xhslink\.com|xiaohongshu\.com/.test(link)) {
      roche.ui.toast('不是小红书链接'); return;
    }
    const previewEl = root.querySelector('#xhs-preview');
    previewEl.style.display = 'block';
    previewEl.textContent = '抓取中...';
    try {
      const result = await processXhsLinkFull(link);
      const { note, comments, images, tags, preview } = result;
      const sharerName = await getSharerName();
      let text;
      if (runtime.mode === 2) {
        // 模式二预览也下载图片并发给副 API 总结（与实际注入行为一致）
        previewEl.textContent = '模式二: 下载图片中...';
        const imageDataUrls = [];
        for (let i = 0; i < images.length; i++) {
          try {
            const d = await downloadImageAsDataUrl(images[i].url);
            imageDataUrls.push(d);
          } catch (e) {}
        }
        const summary = await summarizeNote(note, comments, imageDataUrls);
        text = formatNoteMode2(note, comments, summary, sharerName);
      } else {
        text = formatNoteMode1(note, comments, sharerName);
      }
      previewEl.textContent = text + `\n\n---\n图片数: ${images.length}, 标签: ${tags.join(', ')}`;
    } catch (e) {
      previewEl.textContent = `失败: ${e.message}`;
    }
  });

  // 手动注入
  root.querySelector('#xhs-inject-btn').addEventListener('click', async () => {
    const link = root.querySelector('#xhs-link-input').value.trim();
    const convId = root.querySelector('#xhs-conv-select').value;
    if (!link) { roche.ui.toast('请输入链接'); return; }
    if (!convId) { roche.ui.toast('请选择会话'); return; }
    if (!/xhslink\.com|xiaohongshu\.com/.test(link)) {
      roche.ui.toast('不是小红书链接'); return;
    }
    roche.ui.toast('正在抓取...');
    try {
      const result = await processXhsLinkFull(link);
      const now = Date.now();
      const fakeMsg = {
        id: genMsgId(),
        text: link,
        isMe: true,
        type: 'text',
        timestamp: now,
        conversationId: convId,
        senderId: 'me'
      };
      let procResult;
      if (runtime.mode === 2) {
        procResult = await processMode2(fakeMsg, link, result);
      } else {
        procResult = await processMode1(fakeMsg, link, result);
      }
      roche.ui.toast(`注入成功（图片 ${procResult.imgOk}/${procResult.imgOk + procResult.imgFail}）`);
      log(`手动注入成功到 ${convId} (图片 ${procResult.imgOk}/${procResult.imgOk + procResult.imgFail})`, 'success');
      // 关键：派发刷新事件，让 Roche 重新加载会话 → UI 实时显示替换后的内容
      refreshRocheChat(convId);
    } catch (e) {
      roche.ui.toast('注入失败: ' + e.message);
      log(`手动注入失败: ${e.message}`, 'error');
    }
  });

  // 自动删除设置
  root.querySelector('#xhs-del-text-toggle').addEventListener('change', async (e) => {
    runtime.deleteTextEnabled = e.target.checked;
    await rocheStorage.set(STORE_KEYS.deleteTextEnabled, runtime.deleteTextEnabled);
    roche.ui.toast(runtime.deleteTextEnabled ? '已开启自动删文本' : '已关闭自动删文本');
  });
  root.querySelector('#xhs-del-img-toggle').addEventListener('change', async (e) => {
    runtime.deleteImagesEnabled = e.target.checked;
    await rocheStorage.set(STORE_KEYS.deleteImagesEnabled, runtime.deleteImagesEnabled);
    roche.ui.toast(runtime.deleteImagesEnabled ? '已开启自动删图片' : '已关闭自动删图片');
  });
  root.querySelector('#xhs-del-count').addEventListener('change', async (e) => {
    const n = parseInt(e.target.value) || 10;
    runtime.deleteAfterCount = n;
    await rocheStorage.set(STORE_KEYS.deleteAfterCount, n);
    roche.ui.toast(`已设置: ${n} 条后删除`);
  });

  // 清理坏图片消息
  root.querySelector('#xhs-clean-bad-images').addEventListener('click', async () => {
    const resultEl = root.querySelector('#xhs-clean-result');
    const btn = root.querySelector('#xhs-clean-bad-images');
    const ok = await roche.ui.confirm({
      title: '清理坏图片消息',
      message: '将扫描所有会话，删除 id 为数字类型的图片消息。不可恢复，确定继续吗？'
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = '扫描中...';
    resultEl.textContent = '正在扫描...';
    try {
      const conversations = await getAllRecords('conversations');
      let totalScanned = 0, totalBad = 0, totalDeleted = 0;
      const badIds = [];
      for (const conv of conversations) {
        const convId = conv.id || conv.conversationId;
        if (!convId) continue;
        let msgs;
        try { msgs = await getMessagesByConversation(convId); } catch (e) { continue; }
        totalScanned += msgs.length;
        for (const m of msgs) {
          if (m.type === 'image' && typeof m.id === 'number') {
            badIds.push(m.id);
            totalBad++;
          }
        }
      }
      if (badIds.length === 0) {
        resultEl.textContent = `扫描 ${totalScanned} 条，未找到坏图片消息。`;
        resultEl.style.color = '#10b981';
      } else {
        for (const id of badIds) {
          try { await deleteMessage(id); totalDeleted++; } catch (e) {}
        }
        resultEl.textContent = `扫描 ${totalScanned} 条，找到 ${totalBad} 条坏消息，删除 ${totalDeleted} 条。`;
        resultEl.style.color = '#10b981';
        roche.ui.toast(`已清理 ${totalDeleted} 条坏图片消息`);
      }
    } catch (e) {
      resultEl.textContent = `失败: ${e.message}`;
      resultEl.style.color = '#e74c3c';
    } finally {
      btn.disabled = false;
      btn.textContent = '扫描并清理坏图片消息（v1.4.2 之前）';
    }
  });

  // ===== 副 API 预设管理 =====
  // 新建预设
  root.querySelector('#xhs-new-preset').addEventListener('click', () => {
    root.querySelector('#xhs-preset-editor').style.display = 'block';
    root.querySelector('#xhs-preset-name').value = '';
    root.querySelector('#xhs-preset-url').value = '';
    root.querySelector('#xhs-preset-key').value = '';
    root.querySelector('#xhs-preset-model').value = '';
    root.querySelector('#xhs-preset-temp').value = '0.5';
    root.querySelector('#xhs-model-list').style.display = 'none';
    root.querySelector('#xhs-preset-test-result').style.display = 'none';
    root.dataset.editingPresetId = '';
  });

  // 选择预设
  root.querySelector('#xhs-preset-select').addEventListener('change', (e) => {
    const id = e.target.value;
    runtime.activePresetId = id || null;
    rocheStorage.set(STORE_KEYS.activePresetId, runtime.activePresetId);
    const preset = runtime.apiPresets.find(p => p.id === id);
    if (preset) {
      root.querySelector('#xhs-preset-editor').style.display = 'block';
      root.querySelector('#xhs-preset-name').value = preset.name;
      root.querySelector('#xhs-preset-url').value = preset.baseUrl;
      root.querySelector('#xhs-preset-key').value = preset.apiKey;
      root.querySelector('#xhs-preset-model').value = preset.model;
      root.querySelector('#xhs-preset-temp').value = preset.temperature ?? 0.5;
      root.dataset.editingPresetId = id;
    } else {
      root.querySelector('#xhs-preset-editor').style.display = 'none';
    }
  });

  // 刷新模型列表
  root.querySelector('#xhs-refresh-models').addEventListener('click', async () => {
    const baseUrl = root.querySelector('#xhs-preset-url').value.trim();
    const apiKey = root.querySelector('#xhs-preset-key').value.trim();
    if (!baseUrl || !apiKey) { roche.ui.toast('请先填 Base URL 和 API Key'); return; }
    const btn = root.querySelector('#xhs-refresh-models');
    btn.disabled = true;
    btn.textContent = '获取中...';
    try {
      const models = await fetchModels({ baseUrl, apiKey });
      const listEl = root.querySelector('#xhs-model-list');
      listEl.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
      listEl.style.display = 'block';
      listEl.size = Math.min(8, models.length);
      listEl.addEventListener('change', () => {
        root.querySelector('#xhs-preset-model').value = listEl.value;
      });
      roche.ui.toast(`获取到 ${models.length} 个模型`);
    } catch (e) {
      roche.ui.toast('获取失败: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '刷新';
    }
  });

  // 保存预设
  root.querySelector('#xhs-save-preset').addEventListener('click', async () => {
    const name = root.querySelector('#xhs-preset-name').value.trim();
    const baseUrl = root.querySelector('#xhs-preset-url').value.trim();
    const apiKey = root.querySelector('#xhs-preset-key').value.trim();
    const model = root.querySelector('#xhs-preset-model').value.trim();
    const temperature = parseFloat(root.querySelector('#xhs-preset-temp').value) || 0.5;
    if (!name || !baseUrl || !apiKey || !model) {
      roche.ui.toast('请填写所有必填项');
      return;
    }
    const editId = root.dataset.editingPresetId;
    if (editId) {
      const idx = runtime.apiPresets.findIndex(p => p.id === editId);
      if (idx >= 0) {
        runtime.apiPresets[idx] = { ...runtime.apiPresets[idx], name, baseUrl, apiKey, model, temperature };
      }
    } else {
      const newPreset = { id: `p_${Date.now()}`, name, baseUrl, apiKey, model, temperature };
      runtime.apiPresets.push(newPreset);
      runtime.activePresetId = newPreset.id;
      await rocheStorage.set(STORE_KEYS.activePresetId, newPreset.id);
      root.dataset.editingPresetId = newPreset.id;
    }
    await rocheStorage.set(STORE_KEYS.apiPresets, runtime.apiPresets);
    // 刷新下拉
    const select = root.querySelector('#xhs-preset-select');
    select.innerHTML = '<option value="">未选择...</option>' +
      runtime.apiPresets.map(p => `<option value="${p.id}" ${p.id === runtime.activePresetId ? 'selected' : ''}>${p.name}</option>`).join('');
    select.value = runtime.activePresetId;
    roche.ui.toast('预设已保存');
    log(`预设已保存: ${name} (${model})`, 'success');
  });

  // 测试连接
  root.querySelector('#xhs-test-preset').addEventListener('click', async () => {
    const baseUrl = root.querySelector('#xhs-preset-url').value.trim();
    const apiKey = root.querySelector('#xhs-preset-key').value.trim();
    const model = root.querySelector('#xhs-preset-model').value.trim();
    if (!baseUrl || !apiKey || !model) { roche.ui.toast('请先填完整'); return; }
    const btn = root.querySelector('#xhs-test-preset');
    btn.disabled = true;
    btn.textContent = '测试中...';
    const resultEl = root.querySelector('#xhs-preset-test-result');
    resultEl.style.display = 'block';
    resultEl.style.background = '#f3f4f6';
    resultEl.textContent = '正在测试...';
    try {
      const reply = await testPreset({ baseUrl, apiKey, model });
      resultEl.style.background = '#d1fae5';
      resultEl.style.color = '#065f46';
      resultEl.textContent = `成功！模型回复: ${reply}`;
      roche.ui.toast('测试通过');
    } catch (e) {
      resultEl.style.background = '#fee2e2';
      resultEl.style.color = '#991b1b';
      resultEl.textContent = `失败: ${e.message}`;
      roche.ui.toast('测试失败');
    } finally {
      btn.disabled = false;
      btn.textContent = '测试连接';
    }
  });

  // 删除预设
  root.querySelector('#xhs-delete-preset').addEventListener('click', async () => {
    const editId = root.dataset.editingPresetId;
    if (!editId) { roche.ui.toast('请先选择要删除的预设'); return; }
    const ok = await roche.ui.confirm({
      title: '删除预设',
      message: '确定要删除这个预设吗？'
    });
    if (!ok) return;
    runtime.apiPresets = runtime.apiPresets.filter(p => p.id !== editId);
    if (runtime.activePresetId === editId) {
      runtime.activePresetId = runtime.apiPresets[0]?.id || null;
      await rocheStorage.set(STORE_KEYS.activePresetId, runtime.activePresetId);
    }
    await rocheStorage.set(STORE_KEYS.apiPresets, runtime.apiPresets);
    const select = root.querySelector('#xhs-preset-select');
    select.innerHTML = '<option value="">未选择...</option>' +
      runtime.apiPresets.map(p => `<option value="${p.id}" ${p.id === runtime.activePresetId ? 'selected' : ''}>${p.name}</option>`).join('');
    root.querySelector('#xhs-preset-editor').style.display = 'none';
    roche.ui.toast('预设已删除');
  });

  // 初始化会话列表
  renderConversationList();
  renderLogs();
}
