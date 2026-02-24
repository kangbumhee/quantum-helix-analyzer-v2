import { ShopeeAPI } from './lib/api.js';
import { ShopeeKeywords, KeywordEngine } from './lib/keywords.js';
import { ShopAnalyzer } from './lib/analyzer.js';
import { StorageHelper } from './lib/storage.js';
import { GeminiOptimizer } from './lib/gemini.js';
import { ShopeeUpdater } from './lib/updater.js';

const SELLER_DOMAINS = [
  'seller.shopee.kr', 'seller.shopee.co.id', 'seller.shopee.com.my',
  'seller.shopee.sg', 'seller.shopee.co.th', 'seller.shopee.vn',
  'seller.shopee.ph', 'seller.shopee.tw', 'seller.shopee.com.br',
  'seller.shopee.com.mx', 'seller.shopee.com.co', 'seller.shopee.cl'
];

const REGION_MAP = {
  'seller.shopee.kr': 'KR', 'seller.shopee.co.id': 'ID',
  'seller.shopee.com.my': 'MY', 'seller.shopee.sg': 'SG',
  'seller.shopee.co.th': 'TH', 'seller.shopee.vn': 'VN',
  'seller.shopee.ph': 'PH', 'seller.shopee.tw': 'TW',
  'seller.shopee.com.br': 'BR', 'seller.shopee.com.mx': 'MX',
  'seller.shopee.com.co': 'CO', 'seller.shopee.cl': 'CL'
};

/* ── Cookie 탐색 ── */
async function findSpcCds() {
  for (const domain of SELLER_DOMAINS) {
    try {
      const cookie = await chrome.cookies.get({ url: `https://${domain}`, name: 'SPC_CDS' });
      if (cookie && cookie.value) {
        return { token: cookie.value, domain, region: REGION_MAP[domain] || 'KR' };
      }
    } catch (e) { /* skip */ }
  }
  return null;
}

/* ── 쿠키 연결 ── */
async function handleConnectViaCookie() {
  const cds = await findSpcCds();
  if (!cds) return { success: false, error: 'SPC_CDS 쿠키를 찾을 수 없습니다. seller.shopee.kr에 로그인하세요.' };

  const { token, domain, region } = cds;
  const baseUrl = `https://${domain}`;
  const endpoints = [
    '/api/v3/merchant/get_shop_list',
    '/api/v3/general/get_shop_list',
    '/api/v3/merchant/get_all_shop_info_list'
  ];

  let shops = [];
  for (const ep of endpoints) {
    try {
      const res = await fetch(`${baseUrl}${ep}`, {
        headers: { 'Content-Type': 'application/json', Cookie: `SPC_CDS=${token}` },
        credentials: 'include'
      });
      const json = await res.json();
      const list = json?.data?.list || json?.data?.shop_list || [];
      if (list.length > 0) {
        shops = list.filter(s => s.status === 1 || s.is_active).map(s => ({
          shopId: s.shop_id,
          name: s.user_name || s.shop_name || s.name || `Shop ${s.shop_id}`,
          region: s.region || region,
          domain
        }));
        break;
      }
    } catch (e) { continue; }
  }

  if (shops.length === 0) {
    shops = [{ shopId: 0, name: 'My Shop', region, domain }];
  }

  await chrome.storage.local.set({ shops, spcToken: token, sellerDomain: domain, region });
  return { success: true, shops };
}

/* ── Gemini API 키 가져오기 ── */
async function getStoredApiKey() {
  const data = await chrome.storage.local.get(['geminiApiKey', 'optimizer_settings', 'optimizerSettings']);
  return data.geminiApiKey
    || data.optimizer_settings?.geminiKey
    || data.optimizerSettings?.geminiKey
    || '';
}

async function getStoredModel() {
  const data = await chrome.storage.local.get(['optimizer_settings', 'optimizerSettings']);
  return data.optimizer_settings?.geminiModel
    || data.optimizerSettings?.geminiModel
    || 'gemini-2.0-flash';
}

/* ── 상품 전체 페이지네이션 ── */
async function getShopProducts(msg, spcToken, domain) {
  if (msg.products && msg.products.length > 0) return msg.products;

  const shopId = msg.shopId;
  const baseUrl = `https://${domain}/api/v3/opt/mpsku/list/v2/search_product_list`;
  const pageSize = 48;
  let allProducts = [];

  const firstUrl = `${baseUrl}?page_number=1&page_size=${pageSize}&source=seller_center&need_statistic_info=true&SPC_CDS=${encodeURIComponent(spcToken)}&SPC_CDS_VER=2&cnsc_shop_id=${shopId}&cbsc_shop_region=${msg.region || ''}`;
  const firstRes = await fetch(firstUrl, {
    headers: { Cookie: `SPC_CDS=${spcToken}` }, credentials: 'include'
  });
  const firstJson = await firstRes.json();
  const total = firstJson?.data?.page_info?.total || 0;
  const firstItems = firstJson?.data?.products || firstJson?.data?.list || firstJson?.data?.items || [];
  allProducts.push(...firstItems);

  const totalPages = Math.min(Math.ceil(total / pageSize), 120);
  for (let page = 2; page <= totalPages; page++) {
    try {
      const url = `${baseUrl}?page_number=${page}&page_size=${pageSize}&source=seller_center&need_statistic_info=true&SPC_CDS=${encodeURIComponent(spcToken)}&SPC_CDS_VER=2&cnsc_shop_id=${shopId}&cbsc_shop_region=${msg.region || ''}`;
      const res = await fetch(url, {
        headers: { Cookie: `SPC_CDS=${spcToken}` }, credentials: 'include'
      });
      const json = await res.json();
      const items = json?.data?.products || json?.data?.list || json?.data?.items || [];
      allProducts.push(...items);
    } catch (e) { console.warn(`Page ${page} fetch failed`, e); }
    await new Promise(r => setTimeout(r, 200));
  }

  const seen = new Set();
  const unique = allProducts.filter(p => {
    const id = p.item_id || p.product_id || p.id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  console.log(`[GET_PRODUCTS] total=${total}, fetched=${unique.length}`);
  return unique;
}

/* ── 전체 샵 분석 ── */
async function analyzeAllShops(sendProgress) {
  const data = await chrome.storage.local.get(['shops', 'spcToken', 'sellerDomain', 'region']);
  const shops = data.shops || [];
  const results = [];
  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    sendProgress({ current: i + 1, total: shops.length, shopName: shop.name });
    try {
      const report = await ShopAnalyzer.analyzeShop(shop.shopId, shop.region, shop.name);
      await StorageHelper.saveReport(shop.shopId, report);
      results.push({ shopId: shop.shopId, success: true });
    } catch (e) {
      results.push({ shopId: shop.shopId, success: false, error: e.message });
    }
  }
  return results;
}

/* ── 메시지 핸들러 ── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PRODUCTS') {
    (async function () {
      try {
        const spcData = await findSpcCds();
        if (!spcData) {
          sendResponse({ success: false, error: 'Not logged in' });
          return;
        }
        const domain = msg.sellerDomain || spcData.domain;
        const shopId = msg.shopId;
        const region = msg.region != null ? msg.region : spcData.region;
        const PAGE_SIZE = 48;

        const firstUrl = `https://${domain}/api/v3/opt/mpsku/list/v2/search_product_list?page_number=1&page_size=${PAGE_SIZE}&source=seller_center&need_statistic_info=true&SPC_CDS=${encodeURIComponent(spcData.token)}&SPC_CDS_VER=2&cnsc_shop_id=${shopId}&cbsc_shop_region=${region || ''}`;
        const firstRes = await fetch(firstUrl, { credentials: 'include' });
        const firstJson = await firstRes.json();
        const total = firstJson?.data?.page_info?.total || 0;
        let allProducts = firstJson?.data?.products || [];

        const totalPages = Math.min(Math.ceil(total / PAGE_SIZE), 120);
        for (let page = 2; page <= totalPages; page++) {
          try {
            const url = `https://${domain}/api/v3/opt/mpsku/list/v2/search_product_list?page_number=${page}&page_size=${PAGE_SIZE}&source=seller_center&need_statistic_info=true&SPC_CDS=${encodeURIComponent(spcData.token)}&SPC_CDS_VER=2&cnsc_shop_id=${shopId}&cbsc_shop_region=${region || ''}`;
            const res = await fetch(url, { credentials: 'include' });
            const json = await res.json();
            const items = json?.data?.products || [];
            allProducts = allProducts.concat(items);
          } catch (e) {
            console.warn('[GET_PRODUCTS] page', page, 'failed:', e.message);
          }
          await new Promise(r => setTimeout(r, 200));
        }

        const seen = {};
        const unique = [];
        allProducts.forEach(function (p) {
          const id = p.id ?? p.item_id ?? p.product_id;
          if (id != null && !seen[id]) {
            seen[id] = true;
            unique.push(p);
          }
        });

        console.log('[GET_PRODUCTS] total=' + total + ', fetched=' + unique.length);
        sendResponse({ success: true, data: unique, products: unique });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  const handle = async () => {
    try {
      switch (msg.type) {

        case 'CONNECT_VIA_COOKIE':
          return await handleConnectViaCookie();

        case 'GET_SHOPS': {
          const d = await chrome.storage.local.get('shops');
          if (d.shops && d.shops.length > 0) return { success: true, shops: d.shops };
          const conn = await handleConnectViaCookie();
          return conn;
        }

        case 'ANALYZE_SHOP': {
          const report = await ShopAnalyzer.analyzeShop(msg.shopId, msg.region, msg.shopName);
          await StorageHelper.saveReport(msg.shopId, report);
          return { success: true, report };
        }

        case 'ANALYZE_ALL': {
          const results = await analyzeAllShops((progress) => {
            chrome.runtime.sendMessage({ type: 'ANALYSIS_PROGRESS', ...progress }).catch(() => {});
          });
          return { success: true, results };
        }

        case 'GET_REPORT': {
          const report = await StorageHelper.loadReport(msg.shopId);
          return { success: true, report };
        }

        case 'GET_ALL_REPORTS': {
          const reports = await StorageHelper.loadAllReports();
          return { success: true, reports };
        }

        case 'GET_HISTORY': {
          const history = await StorageHelper.loadHistory(msg.shopId);
          return { success: true, history };
        }

        case 'OPEN_DASHBOARD': {
          chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
          return { success: true };
        }

        case 'GET_SETTINGS': {
          const settings = await StorageHelper.loadSettings();
          return { success: true, settings };
        }

        case 'GET_KEYWORDS': {
          const store = await chrome.storage.local.get(['spcToken', 'sellerDomain']);
          const kw = new ShopeeKeywords(store.spcToken, store.sellerDomain);
          const keywords = await kw.getAggregatedKeywords(msg.shopId);
          return { success: true, keywords };
        }

        case 'AI_OPTIMIZE_PRODUCTS': {
          const store = await chrome.storage.local.get(['spcToken', 'sellerDomain', 'region']);
          const apiKey = await getStoredApiKey();
          const model = await getStoredModel();
          if (!apiKey) return { success: false, error: 'Gemini API 키가 설정되지 않았습니다.' };

          const gemini = new GeminiOptimizer(apiKey, model);

          const notify = (step, pct, text) => {
            chrome.runtime.sendMessage({
              type: 'AI_PROGRESS', step, percentage: pct, text
            }).catch(() => {});
          };

          notify('init', 0, '상품 목록 로딩 중...');
          const products = await getShopProducts(msg, store.spcToken, store.sellerDomain);
          if (!products || products.length === 0) return { success: false, error: '상품을 찾을 수 없습니다.' };

          notify('classify', 10, `${products.length}개 상품 분류 중...`);
          const classified = await gemini.classifyProducts(products);

          notify('keywords', 30, '검색어 추출 중...');
          const searchTerms = await gemini.extractSearchTerms(classified, store.region || 'KR');

          notify('collect', 50, '키워드 데이터 수집 중...');
          const kw = new ShopeeKeywords(store.spcToken, store.sellerDomain);
          const topKeywords = await kw.getTopKeywords(msg.shopId);
          const trendingKeywords = await kw.getTrendingKeywords(msg.shopId);
          const suggestions = await kw.getSuggestionKeywords(msg.shopId);

          notify('optimize', 70, 'AI 최적화 실행 중...');
          const batchSize = 10;
          const allResults = [];
          for (let i = 0; i < classified.length; i += batchSize) {
            const batch = classified.slice(i, i + batchSize).map((p, idx) => ({
              ...p,
              suggestedKeywords: searchTerms[i + idx] || [],
              topKeywords: topKeywords.slice(0, 10),
              trendingKeywords: trendingKeywords.slice(0, 10)
            }));
            const pct = 70 + Math.round((i / classified.length) * 25);
            notify('optimize', pct, `배치 ${Math.floor(i / batchSize) + 1} 최적화 중...`);
            const result = await gemini.optimizeBatch(batch, store.region || 'KR');
            const withTitle = result.map(r => {
              const p = batch.find(b => (b.item_id || b.product_id || b.id) === r.id);
              return { ...r, currentTitle: p ? (p.name || p.title || '') : '' };
            });
            allResults.push(...withTitle);
            await new Promise(r => setTimeout(r, 2000));
          }

          notify('done', 100, '최적화 완료!');
          return {
            success: true,
            results: allResults,
            summary: {
              totalProducts: products.length,
              optimized: allResults.length,
              topKeywords: topKeywords.slice(0, 20),
              trendingKeywords: trendingKeywords.slice(0, 20)
            },
            keywords: { top: topKeywords, trending: trendingKeywords, suggestions }
          };
        }

        case 'APPLY_OPTIMIZATIONS': {
          const store = await chrome.storage.local.get(['spcToken', 'sellerDomain', 'region']);
          const result = await ShopeeUpdater.executeBatchUpdate(
            store.spcToken, msg.plan,
            (progress) => chrome.runtime.sendMessage({ type: 'APPLY_PROGRESS', ...progress }).catch(() => {})
          );
          return { success: true, result };
        }

        case 'RUN_FRESHNESS': {
          const store = await chrome.storage.local.get(['spcToken', 'sellerDomain']);
          const result = await ShopeeUpdater.freshnessRotation(
            store.spcToken, msg.products, msg.shopConfig
          );
          return { success: true, result };
        }

        case 'RESTORE_BACKUP': {
          const store = await chrome.storage.local.get(['spcToken', 'sellerDomain']);
          return { success: true };
        }

        default:
          return { success: false, error: `알 수 없는 메시지 타입: ${msg.type}` };
      }
    } catch (err) {
      console.error('[background]', msg.type, err);
      return { success: false, error: err.message };
    }
  };

  handle().then(sendResponse);
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'auto_analyze') {
    await analyzeAllShops(() => {});
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await StorageHelper.loadSettings();
  const hours = settings.autoAnalyzeInterval || 24;
  chrome.alarms.create('auto_analyze', { periodInMinutes: hours * 60 });
});
