// ============================================================
//  RESIDENTIAL PROXY TEST  —  ek hi sawaal ka jawab dhundhne ke liye
//
//  Sawaal: kya residential IP se Instagram BINA account ke data deta hai?
//
//  Ab tak jo pata hai:
//    Vercel (AWS datacenter IP)      -> NEED_LOGIN
//    Cloudflare (CF datacenter IP)   -> NEED_LOGIN
//  Dono jagah code bilkul ek jaisa tha. Sirf IP badla tha, aur natija same aaya.
//  Ab teesri baar sirf IP badal rahe hain — is baar RESIDENTIAL IP se.
//
//  ⚠️ Is file me sessionid ka naam tak nahi hai. Ye jaan bujh kar hai.
//     Agar yahan session daal denge to test ka matlab hi khatam ho jayega —
//     pata hi nahi chalega ki kaam proxy ne kiya ya session ne.
//
//  Ye file aapki LIVE api/reel.js se bilkul alag hai. Alag repo, alag project.
//  Isse aapki chalti hui site par koi asar nahi padega.
//
//  Test:  /api/test?url=<reel link>&country=in
// ============================================================

import { ProxyAgent, Agent } from 'undici';
import { gzipSync } from 'node:zlib';

export const maxDuration = 30;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const IG_APP_ID = '936619743392459';
const DOC_ID = process.env.IG_DOC_ID || '8845758582119845';

const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const UA_MOBILE =
  'Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2400; ' +
  'samsung; SM-G991B; o1s; exynos2100; en_US; 526face9)';

// ⚠️ Ye tabhi use hoti hai jab URL me &session=1 ho. Default me test poori tarah
//    anonymous rehta hai — yahi shuru se is file ka usool tha.
const SESSIONID = process.env.IG_SESSIONID || '';

const PROXY_HOST = process.env.PROXY_HOST || 'gw.dataimpulse.com';
const PROXY_PORT = process.env.PROXY_PORT || '823';
const PROXY_USER = process.env.PROXY_USER || '';
const PROXY_PASS = process.env.PROXY_PASS || '';

// ---------------------------------------------------------------- proxy
//
// DataImpulse ka username hi saari settings carry karta hai:
//     <login>__cr.in;sessid.abc123
//                ^^      ^^^^^^
//                |       ek hi exit IP par tike rehne ke liye
//                country
//
// sessid isliye zaroori hai: cookies ek IP se laayein aur API call doosre IP
// se karein, to Instagram ko turant shak ho jayega. Ek lookup = ek IP.

function buildDispatcher(country, sess) {
  if (!PROXY_USER || !PROXY_PASS) return null;

  let user = PROXY_USER;
  const parts = [];
  if (country) parts.push(`cr.${country}`);
  if (sess) parts.push(`sessid.${sess}`);
  if (parts.length) user += '__' + parts.join(';');

  return new ProxyAgent({
    uri: `http://${PROXY_HOST}:${PROXY_PORT}`,
    token: 'Basic ' + Buffer.from(`${user}:${PROXY_PASS}`).toString('base64'),
    requestTls: { timeout: 15000 },
    connect: { timeout: 15000 },
  });
}

// ---------------------------------------------------------------- byte meter
//
// Yahi is test ka doosra maqsad hai. "5 GB kitne din chalega" ka jawab
// anumaan se nahi, naap kar dena hai.
//
// Do number nikaalte hain:
//   wire    = content-length header. Ye compressed (gzip) size hai — proxy
//             isi hisaab se paisa kaatta hai. Yahi asli number hai.
//   decoded = unzip hone ke baad ka size. Hamesha bada aayega. Isse dhoka
//             mat khana, bill isse nahi banta.
//
// Kabhi-kabhi Instagram chunked bhejta hai aur content-length aata hi nahi.
// Aise me wire null rahega — aur hum poori imaandari se bolenge ki wo request
// naapi nahi ja saki, guess nahi karenge.

function meter(ctx, label, res, text) {
  const decoded = Buffer.byteLength(text);

  const cl = res.headers.get('content-length');
  const wire = cl && /^\d+$/.test(cl) ? Number(cl) : null;

  // Jab content-length nahi aata (chunked response), tab hum khud gzip karke
  // dekh lete hain ki compress hone par kitna banta. Instagram bhi gzip hi
  // bhejta hai, isliye ye asli bill ke bahut kareeb hota hai.
  //
  // Pichli baar meri galti yahi thi: content-length na milne par maine un
  // requests ko hisaab se hi baahar kar diya tha, aur 600 byte ke aadhar par
  // "88 lakh lookups" chhaap diya jabki asli data 1.6 MB tha.
  let est = wire;
  let how = wire === null ? null : 'header';
  if (wire === null) {
    try { est = gzipSync(Buffer.from(text)).length; how = 'gzip-anumaan'; }
    catch { est = null; }
  }

  ctx.calls.push({ call: label, status: res.status, wire, gzip_est: est, how, decoded });
  return est;
}

async function grab(ctx, label, url, opts, dispatcher) {
  const res = await fetch(url, {
    ...opts,
    dispatcher: dispatcher || undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  meter(ctx, label, res, text);
  return { res, text };
}

// ---------------------------------------------------------------- helpers

function extractShortcode(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{5,30}$/.test(s) && !s.includes('/')) return s;
  const m = s.match(
    /instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i
  );
  return m ? m[1] : null;
}

function shortcodeToMediaId(shortcode) {
  let id = 0n;
  for (const ch of shortcode.slice(0, 11)) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) throw new Error('Invalid shortcode');
    id = id * 64n + BigInt(i);
  }
  return id.toString();
}

function clean(s) {
  return s
    .replace(/\\u0026/g, '&')
    .replace(/\\u003C/gi, '<')
    .replace(/\\u003E/gi, '>')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');
}

function looksLikeHtml(t) {
  return /^\s*<(?:!doctype|html)/i.test(t);
}

function igMessageFrom(text) {
  try {
    const j = JSON.parse(text);
    return j.message || j.error_title || j.errors?.[0]?.message || j.error_type || null;
  } catch {
    return null;
  }
}

/** sessionid ke andar hi user id chhupi hoti hai: "12345678%3AabcXYZ%3A12..." */
function dsUserIdFromSession(sid) {
  if (!sid) return null;
  const first = decodeURIComponent(String(sid)).split(':')[0];
  return /^\d+$/.test(first) ? first : null;
}

function cookieHeader(jar, withSession) {
  const all = { ...jar };
  if (withSession && SESSIONID) {
    all.sessionid = SESSIONID;
    const ds = dsUserIdFromSession(SESSIONID);
    if (ds) all.ds_user_id = ds;
  }
  return Object.entries(all).map(([k, v]) => `${k}=${v}`).join('; ');
}

function webHeaders(jar, withSession, extra = {}) {
  return {
    'User-Agent': UA_WEB,
    'Accept-Language': 'en-US,en;q=0.9',
    'x-ig-app-id': IG_APP_ID,
    'x-requested-with': 'XMLHttpRequest',
    'x-csrftoken': jar.csrftoken || '',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    Cookie: cookieHeader(jar, withSession),
    ...extra,
  };
}

// ---------------------------------------------------------------- exit IP
//
// Sabse pehle ye check hota hai, aur agar ye fail ho gaya to aage badhne ka
// koi matlab nahi — matlab proxy hi nahi chala. Iske bina Instagram ka
// NEED_LOGIN dekh kar hum galat natije par pahunch jaate ("residential se
// bhi nahi chala"), jabki asal me request proxy se gayi hi nahi hoti.

async function whereAmI(ctx, dispatcher) {
  try {
    const { text } = await grab(ctx, 'ip-check', 'http://ip-api.com/json/', {
      headers: { 'User-Agent': UA_WEB },
    }, dispatcher);
    const j = JSON.parse(text);
    return {
      ip: j.query || null,
      country: j.country || null,
      city: j.city || null,
      isp: j.isp || null,
      org: j.org || null,
      as: j.as || null,
    };
  } catch (e) {
    return { error: `${e.name}: ${e.message}` };
  }
}

// ---------------------------------------------------------------- cookies

async function getGuestCookies(ctx, dispatcher) {
  const res = await fetch('https://www.instagram.com/', {
    headers: {
      'User-Agent': UA_WEB,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
    },
    redirect: 'follow',
    dispatcher: dispatcher || undefined,
    signal: AbortSignal.timeout(10000),
  });

  const jar = {};
  for (const line of res.headers.getSetCookie?.() || []) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }

  const html = await res.text();
  meter(ctx, 'cookie-bootstrap', res, html);

  if (!jar.csrftoken) {
    const m = html.match(/"csrf_token":"([^"]+)"/);
    if (m) jar.csrftoken = m[1];
  }

  return { jar, status: res.status, got: Object.keys(jar) };
}

// ---------------------------------------------------------------- tiers

async function tierGraphql(ctx, shortcode, jar, dispatcher, withSession) {
  const body = new URLSearchParams({
    variables: JSON.stringify({
      shortcode,
      fetch_tagged_user_count: null,
      hoisted_comment_id: null,
      hoisted_reply_id: null,
    }),
    doc_id: DOC_ID,
    server_timestamps: 'true',
  });

  const { res, text } = await grab(ctx, 'graphql', 'https://www.instagram.com/graphql/query/', {
    method: 'POST',
    headers: webHeaders(jar, withSession, {
      'content-type': 'application/x-www-form-urlencoded',
      Accept: '*/*',
      Origin: 'https://www.instagram.com',
      Referer: `https://www.instagram.com/reel/${shortcode}/`,
    }),
    body,
  }, dispatcher);

  if (looksLikeHtml(text))
    return { ok: false, status: res.status, reason: 'graphql ne HTML bheja' };
  if (!res.ok)
    return { ok: false, status: res.status, reason: `graphql HTTP ${res.status}`, igMessage: igMessageFrom(text), sample: text.slice(0, 300) };

  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, status: res.status, reason: 'graphql JSON parse fail' }; }

  const m = json?.data?.xdt_shortcode_media || json?.data?.shortcode_media;
  if (!m)
    return { ok: false, status: res.status, reason: 'graphql me media null (doc_id purana ho sakta hai)', igMessage: json?.message || null, sample: text.slice(0, 300) };

  const nodes = m.edge_sidecar_to_children?.edges?.length
    ? m.edge_sidecar_to_children.edges.map((e) => e.node)
    : [m];

  return {
    ok: true,
    status: res.status,
    found: {
      username: m.owner?.username || null,
      is_video: Boolean(m.video_url),
      items: nodes.length,
      firstUrl: m.video_url ? clean(m.video_url).slice(0, 90) + '…' : (m.display_url ? clean(m.display_url).slice(0, 90) + '…' : null),
    },
  };
}

async function tierMobile(ctx, shortcode, jar, dispatcher, withSession) {
  const mediaId = shortcodeToMediaId(shortcode);

  // Default me yahan koi Cookie header nahi jaata — anonymous test ka usool.
  // &session=1 par hi sessionid lagti hai, aur tab ye poori tarah alag sawaal
  // ban jaata hai: "kya residential IP par ye account zinda rehta hai?"
  const headers = {
    'User-Agent': UA_MOBILE,
    'X-IG-App-ID': IG_APP_ID,
    'X-IG-Capabilities': '3brTvw==',
    'X-IG-Connection-Type': 'WIFI',
    'Accept-Language': 'en-US',
    Accept: '*/*',
  };
  if (withSession && SESSIONID) {
    const ds = dsUserIdFromSession(SESSIONID);
    headers.Cookie = `sessionid=${SESSIONID}` + (ds ? `; ds_user_id=${ds}` : '');
    if (ds) headers['X-IG-Android-ID'] = `android-${ds.slice(0, 16)}`;
  }

  const { res, text } = await grab(ctx, 'mobile-api', `https://i.instagram.com/api/v1/media/${mediaId}/info/`, { headers }, dispatcher);

  if (looksLikeHtml(text))
    return { ok: false, status: res.status, reason: 'mobile api ne HTML bheja' };
  if (!res.ok)
    return { ok: false, status: res.status, reason: `mobile api HTTP ${res.status}`, igMessage: igMessageFrom(text), sample: text.slice(0, 300) };

  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, status: res.status, reason: 'mobile api JSON parse fail' }; }

  const item = json?.items?.[0];
  if (!item)
    return { ok: false, status: res.status, reason: 'mobile api me items nahi mile', igMessage: json?.message || null };

  const nodes = item.carousel_media?.length ? item.carousel_media : [item];
  const v = item.video_versions?.[0]?.url || null;

  return {
    ok: true,
    status: res.status,
    found: {
      username: item.user?.username || null,
      is_video: Boolean(v),
      items: nodes.length,
      firstUrl: v ? v.slice(0, 90) + '…' : (item.image_versions2?.candidates?.[0]?.url || '').slice(0, 90) + '…',
    },
  };
}

// ---------------------------------------------------------------- TIER: reel page
//
// Ye Aayush ki khoj hai. Unhone incognito me (bina login ke) reel kholi aur
// DevTools me `video_versions` search kiya — vo seedha `/reel/{shortcode}/` ke
// HTML me mila. Hamare baaki tier API endpoints par jaate hain; page kabhi
// fetch hi nahi kiya tha.
//
// ⚠️ v3 me is tier ne JHOOTH bola tha. `og:image` wale fallback ne Instagram ka
//    apna UI logo (static.cdninstagram.com/rsrc.php/...png) utha liya aur
//    `ok: true` bol diya, jabki page bilkul khaali tha. Isliye ab:
//
//    1. Media URL ki HOST check hoti hai — static.cdninstagram.com aur
//       /rsrc.php/ hamesha reject. Wahan sirf UI ke icons hote hain.
//    2. Pehle page ke andar ka JSON parse hota hai, regex baad me. JSON se
//       carousel ke saare slide bhi mil jaate hain, jo regex se nahi milte.
//    3. ok: true tabhi jab kam se kam EK asli media URL mile. Warna nahi.

const STATIC_ASSET = /static\.cdninstagram\.com|\/rsrc\.php\//i;

/** Kya ye sach me media hai, ya Instagram ke UI ka koi icon? */
function isRealMedia(u) {
  if (typeof u !== 'string' || !u) return false;
  if (!/(?:cdninstagram\.com|fbcdn\.net)/i.test(u)) return false;
  return !STATIC_ASSET.test(u);
}

/** Page ke andar <script type="application/json"> blocks */
function jsonBlobs(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1])); } catch { /* har blob JSON nahi hota */ }
  }
  return out;
}

/**
 * Gehraai me ja kar wo object dhoondhta hai jo ek media item lagta hai.
 * Instagram ka JSON bahut ghont kar rakha hota hai, isliye seedha rasta nahi hai.
 * `code` milne wala item sabse behtar; na mile to koi bhi media item.
 */
function findMediaItem(node, shortcode, depth = 0, best = { exact: null, any: null }) {
  if (!node || typeof node !== 'object' || depth > 40) return best;

  if (Array.isArray(node)) {
    for (const x of node) findMediaItem(x, shortcode, depth + 1, best);
    return best;
  }

  const isItem = Boolean(node.video_versions || node.carousel_media || node.image_versions2);
  if (isItem) {
    if (node.code === shortcode && !best.exact) best.exact = node;
    else if (!best.any) best.any = node;
  }

  for (const k of Object.keys(node)) findMediaItem(node[k], shortcode, depth + 1, best);
  return best;
}

/** Ek node me se sabse achhi media URL — video ho to video, warna sabse badi photo */
function mediaOf(node) {
  const v = node.video_versions?.find((x) => isRealMedia(x?.url))?.url;
  if (v) return { type: 'video', url: clean(v) };
  const cands = (node.image_versions2?.candidates || []).filter((c) => isRealMedia(c?.url));
  const best = [...cands].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return best ? { type: 'image', url: clean(best.url) } : null;
}

async function tierReelPage(ctx, shortcode, jar, dispatcher, withSession) {
  const { res, text: html } = await grab(ctx, 'reel-page', `https://www.instagram.com/reel/${shortcode}/`, {
    headers: {
      'User-Agent': UA_WEB,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      Cookie: cookieHeader(jar, withSession),
    },
    redirect: 'follow',
  }, dispatcher);

  // Ye teen number hamesha bahar jaate hain — inhi se pata chalta hai ki page
  // asli tha ya khaali. Pichli baar yahi na hone ki wajah se galti pakdi nahi gayi.
  const facts = {
    htmlLength: html.length,
    hasVideoVersions: html.includes('video_versions'),
    hasCarousel: html.includes('carousel_media'),
  };

  if (!res.ok) return { ok: false, status: res.status, reason: `reel-page HTTP ${res.status}`, ...facts };

  // --- 1. JSON rasta (behtar — carousel ke saare slide isi se milte hain)
  let item = null;
  for (const blob of jsonBlobs(html)) {
    const found = findMediaItem(blob, shortcode);
    item = found.exact || found.any;
    if (item) break;
  }

  if (item) {
    const nodes = item.carousel_media?.length ? item.carousel_media : [item];
    const media = nodes.map(mediaOf).filter(Boolean);
    if (media.length) {
      return {
        ok: true,
        status: res.status,
        via: 'json',
        found: {
          username: item.user?.username || item.owner?.username || null,
          is_video: media.some((m) => m.type === 'video'),
          items: media.length,
          types: media.map((m) => m.type),
          caption: (item.caption?.text || '').slice(0, 60) || null,
          ...facts,
          firstUrl: media[0].url.slice(0, 90) + '…',
        },
      };
    }
  }

  // --- 2. Regex rasta (JSON na mile to) — par host check ke saath
  let video = null;
  const vv = html.match(/"video_versions"\s*:\s*\[(.*?)\]/s);
  if (vv) video = (vv[1].match(/"url"\s*:\s*"(.*?)"/) || [])[1] || null;
  if (!video) video = (html.match(/"video_url"\s*:\s*"(.*?)"/) || [])[1] || null;
  if (!video) video = (html.match(/"playable_url(?:_quality_hd)?"\s*:\s*"(.*?)"/) || [])[1] || null;
  video = video && isRealMedia(clean(video)) ? clean(video) : null;

  let image = (html.match(/"display_url"\s*:\s*"(.*?)"/) || [])[1] || null;
  image = image && isRealMedia(clean(image)) ? clean(image) : null;

  if (video || image) {
    const username = (html.match(/"owner"\s*:\s*\{[^}]*?"username"\s*:\s*"(.*?)"/) || [])[1] || null;
    return {
      ok: true,
      status: res.status,
      via: 'regex',
      found: {
        username,
        is_video: Boolean(video),
        items: 1,
        types: [video ? 'video' : 'image'],
        ...facts,
        firstUrl: (video || image).slice(0, 90) + '…',
      },
    };
  }

  // --- 3. Kuch nahi mila. Ab saaf saaf batao ki kya nahi mila.
  const cdn = [...html.matchAll(/https:\\?\/\\?\/[^"'\s]*?(?:cdninstagram\.com|fbcdn\.net)[^"'\s]*/g)]
    .map((x) => clean(x[0]))
    .filter(isRealMedia)
    .slice(0, 2)
    .map((u) => u.slice(0, 100));

  return {
    ok: false,
    status: res.status,
    reason: facts.hasVideoVersions
      ? 'page me video_versions to hai par media nikal nahi paye — parsing sudharni hai'
      : 'page khaali aaya (video_versions hai hi nahi) — Instagram ne data diya hi nahi',
    ...facts,
    realMediaLinks: cdn,
    isAppShell: html.length > 300000 && !facts.hasVideoVersions,
  };
}

async function tierEmbed(ctx, shortcode, jar, dispatcher, withSession) {
  const { res, text: html } = await grab(ctx, 'embed', `https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
    headers: {
      'User-Agent': UA_WEB,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer: 'https://www.instagram.com/',
      Cookie: cookieHeader(jar, withSession),
    },
  }, dispatcher);

  if (!res.ok) return { ok: false, status: res.status, reason: `embed HTTP ${res.status}` };

  const video = (html.match(/"video_url":"(.*?)"/) || html.match(/"playable_url(?:_quality_hd)?":"(.*?)"/) || [])[1];
  const image = (html.match(/"display_url":"(.*?)"/) || html.match(/class="EmbeddedMediaImage"[^>]*?src="(.*?)"/) || [])[1];

  if (!video && !image) {
    const cdn = [...html.matchAll(/https:\\?\/\\?\/(?:scontent|video)[^"'\s]*?(?:cdninstagram\.com|fbcdn\.net)[^"'\s]*/g)]
      .slice(0, 2).map((x) => clean(x[0]).slice(0, 100));
    return {
      ok: false,
      status: res.status,
      reason: 'embed me media nahi mila',
      htmlLength: html.length,
      mediaCdnLinks: cdn,
      isAppShell: html.length > 300000,
    };
  }

  return {
    ok: true,
    status: res.status,
    found: { is_video: Boolean(video), items: 1, firstUrl: clean(video || image).slice(0, 90) + '…' },
  };
}

async function tierWebApi(ctx, shortcode, jar, dispatcher, withSession) {
  const mediaId = shortcodeToMediaId(shortcode);

  const { res, text } = await grab(ctx, 'web-api', `https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
    headers: webHeaders(jar, withSession, { Accept: '*/*', Referer: `https://www.instagram.com/p/${shortcode}/` }),
  }, dispatcher);

  // JSON ki jagah HTML aaya matlab Instagram ne data nahi, apna web page bhej
  // diya. Agar wo page bahut bada hai to wo poora logged-out app shell hai.
  // Ye flag zaroori hai — iske bina akele chalne par verdict UNKNOWN aa jata
  // tha, jabki asli wajah saaf thi.
  if (looksLikeHtml(text))
    return {
      ok: false,
      status: res.status,
      reason: 'web api ne HTML bheja',
      htmlLength: text.length,
      isAppShell: text.length > 300000,
    };
  if (!res.ok) return { ok: false, status: res.status, reason: `web api HTTP ${res.status}`, igMessage: igMessageFrom(text), sample: text.slice(0, 250) };

  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, status: res.status, reason: 'web api JSON parse fail' }; }

  const item = json?.items?.[0];
  if (!item) return { ok: false, status: res.status, reason: 'web api me items nahi mile', igMessage: json?.message || null };

  const nodes = item.carousel_media?.length ? item.carousel_media : [item];
  return {
    ok: true,
    status: res.status,
    found: { username: item.user?.username || null, items: nodes.length },
  };
}

// ---------------------------------------------------------------- verdict

function verdictOf(attempts, proxyOk, withSession) {
  const blob = JSON.stringify(attempts);

  if (attempts.some((a) => a.ok)) {
    return withSession
      ? {
          code: 'SESSION_WORKS_ON_PROXY',
          hindi: 'Chal gaya — residential IP par aapki sessionid accept ho gayi. Ab dekhna ye hai ki kitne din tikti hai; agar Vercel ke IP se zyada tiki, to yahi rasta hai.',
        }
      : {
          code: 'ANONYMOUS_WORKS',
          hindi: 'Chal gaya. Residential IP se Instagram ne bina kisi account ke data de diya. Aapko Instagram account chahiye hi nahi.',
        };
  }
  if (!proxyOk) {
    return {
      code: 'PROXY_NOT_WORKING',
      hindi: 'Proxy hi nahi chala — request residential IP se gayi hi nahi. Instagram ke jawab ka koi matlab nahi. Pehle credentials theek karo.',
    };
  }
  if (/challenge_required|checkpoint_required/i.test(blob)) {
    return { code: 'CHALLENGE', hindi: 'Instagram ne is IP par verification maang li.' };
  }
  if (withSession && /logout_reason|You.{0,3}ve Been Logged Out/i.test(blob)) {
    return {
      code: 'SESSION_DEAD',
      hindi: 'sessionid khud mar chuki hai — ye proxy ki galti nahi hai. Naya sessionid banao, phir dobara test karo.',
    };
  }
  if (withSession && /login_required|require_login/i.test(blob)) {
    return {
      code: 'SESSION_REJECTED',
      hindi: 'sessionid accept nahi hui. Ya to galat copy hui, ya expire ho chuki hai, ya Instagram ko IP badalna khatak gaya (account Vercel ke IP par bana tha, ab India/US ke ghar se aa raha hai).',
    };
  }
  if (/login_required|require_login/i.test(blob)) {
    return {
      code: 'NEED_LOGIN',
      hindi: 'Residential IP se bhi anonymous band hai. Matlab IP badalne se baat nahi banti — sessionid hi ek rasta hai.',
    };
  }
  if (/Please wait a few minutes|rate.?limit|Try again later/i.test(blob)) {
    return {
      code: 'RATE_LIMITED',
      hindi: 'Ye exit IP pehle se flag hai (proxy pool me kisi aur ne ise ghisa hoga). Dobara chalao — naya IP milega.',
    };
  }
  if (/"isAppShell":true/.test(blob)) {
    return { code: 'APP_SHELL', hindi: 'Instagram ne data ki jagah khaali page bheja — logged-out visitor maan raha hai.' };
  }
  return { code: 'UNKNOWN', hindi: 'Pehchana nahi gaya. Poora output bhejo.' };
}

// ---------------------------------------------------------------- handler

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store'); // test kabhi cache nahi hona chahiye

  if (!PROXY_USER || !PROXY_PASS) {
    return res.status(500).json({
      error: 'PROXY_USER / PROXY_PASS set nahi hain',
      kya_karo: 'Vercel → Settings → Environment Variables me dono daalo, phir Redeploy karo.',
    });
  }

  const shortcode = extractShortcode(req.query.url || 'https://www.instagram.com/reel/DbdoGAQMg8O/');
  if (!shortcode) {
    return res.status(400).json({ error: 'Sahi Instagram link bhejo' });
  }

  // '' = koi bhi desh (rotating pool). 'in' / 'us' = us desh ka IP.
  const country = (req.query.country || '').toLowerCase().replace(/[^a-z]/g, '');
  const useProxy = req.query.noproxy !== '1';
  const onlyTier = (req.query.tier || '').toLowerCase();

  // &session=1 tabhi kuch karta hai jab IG_SESSIONID env var bhi set ho.
  // Dono me se ek bhi na ho to test anonymous hi rahega — chupke se session
  // lag jana sabse bura hota, kyunki natija sach lagta par hota jhoot.
  const withSession = req.query.session === '1' && Boolean(SESSIONID);

  const sess = Math.random().toString(36).slice(2, 10);
  const ctx = { calls: [] };
  const dispatcher = useProxy ? buildDispatcher(country, sess) : new Agent();

  const t0 = Date.now();

  // --- 0. Pehle dekho hum kahan se nikal rahe hain
  const exit = await whereAmI(ctx, dispatcher);
  const proxyOk = useProxy ? Boolean(exit.ip) : true;

  // --- 1. Guest cookies
  let jar = {}, cookieInfo;
  try {
    const c = await getGuestCookies(ctx, dispatcher);
    jar = c.jar;
    cookieInfo = { status: c.status, got: c.got };
  } catch (e) {
    cookieInfo = { error: `${e.name}: ${e.message}` };
  }

  // --- 2. Chaaron tier
  // reel-page sabse pehle: yahi naya sawaal hai. Baaki tier waise hi rahe.
  const ALL = [
    ['reel-page', tierReelPage],
    ['web-api', tierWebApi],
    ['mobile-api', tierMobile],
    ['embed', tierEmbed],
    ['graphql', tierGraphql],
  ];
  const TIERS = onlyTier ? ALL.filter(([n]) => n === onlyTier) : ALL;

  // Residential proxy dheema hota hai (asli ghar ka internet hai, datacenter nahi).
  // Vercel function 30 second me kat jaata hai, aur kat gaya to koi report hi
  // nahi milegi — isliye 22 second par khud ruk kar jo mila wahi bata dete hain.
  const DEADLINE = 22000;

  const attempts = [];
  for (const [name, fn] of TIERS) {
    if (Date.now() - t0 > DEADLINE) {
      attempts.push({ tier: name, ok: false, reason: 'time khatam — ye tier chalaya hi nahi gaya' });
      continue;
    }
    try {
      const r = await fn(ctx, shortcode, jar, dispatcher, withSession);
      attempts.push({ tier: name, ...r });
      if (r.ok) break; // mil gaya to aage ka data kharch mat karo
    } catch (e) {
      attempts.push({ tier: name, ok: false, reason: `${e.name}: ${e.message}` });
    }
  }

  // --- 3. Kitna data laga
  //
  // Ab har request ka hisaab hai: ya header se, ya khud gzip karke. Koi request
  // hisaab se bahar nahi chhodi jaati — pichli baar wahi galti hui thi.
  const billable = ctx.calls.reduce((s, c) => s + (c.gzip_est || 0), 0);
  const decodedTotal = ctx.calls.reduce((s, c) => s + c.decoded, 0);
  const guessed = ctx.calls.filter((c) => c.how === 'gzip-anumaan').length;
  const missed = ctx.calls.filter((c) => c.gzip_est === null).length;

  const kb = (n) => Math.round(n / 102.4) / 10;

  const budget = billable
    ? {
        per_lookup_kb: kb(billable),
        note:
          (guessed ? `${guessed} request khud gzip karke naapi gayi (header nahi tha). ` : '') +
          (missed ? `${missed} request naapi hi nahi ja saki. ` : '') +
          'Ye asli bill ke kareeb hai, par bilkul barabar nahi — proxy TLS aur header ka kuch overhead bhi ginta hai.',
        lookups_in_5GB: Math.floor(5368709120 / billable),
        lookups_in_50GB: Math.floor(53687091200 / billable),
        // Asli site par har lookup itna mehnga nahi padega: jo tier pehle chal
        // jayega uske baad ke tier chalte hi nahi, aur CDN cache to bahut si
        // requests ko Instagram tak pahunchne hi nahi deta.
        dhyan_do: 'Ye ek POORE test ka kharcha hai (saare tier). Live site par jo tier chal jata hai wahin ruk jaata hai, aur cache hit par to kuch bhi kharch nahi hota.',
      }
    : { note: 'Kuch bhi naapa nahi ja saka.' };

  const verdict = verdictOf(attempts, proxyOk, withSession);

  return res.status(200).json({
    verdict: verdict.code,
    matlab: verdict.hindi,

    setup: {
      // Ye line sirf isliye hai taki ek nazar me pata chale ki GitHub par nayi
      // file chadhi ya nahi. Pichli baar teen test isliye bekaar gaye kyunki
      // purana code hi deploy tha aur bahar se ye dikhta hi nahi tha.
      code_version: 'v4-strict',
      shortcode,
      proxy_used: useProxy,
      country_asked: country || '(koi bhi)',
      session_id_used: withSession,
      session_available: Boolean(SESSIONID),
      doc_id: DOC_ID,
      took_ms: Date.now() - t0,
    },

    // Ye sabse pehle dekho. isp/org me "Jio", "Airtel", "BSNL" jaisa kuch dikhe
    // to residential hai. "Amazon", "Google", "DigitalOcean" dikhe to datacenter
    // hai aur test bekaar gaya.
    exit_ip: exit,

    cookies: cookieInfo,

    data_used: {
      requests: ctx.calls.length,
      billable_bytes: billable,
      billable_kb: kb(billable),
      decoded_kb: kb(decodedTotal),
      per_call: ctx.calls.map((c) => ({ ...c, billable_kb: c.gzip_est === null ? null : kb(c.gzip_est), decoded_kb: kb(c.decoded) })),
      budget,
    },

    attempts,
  });
}
