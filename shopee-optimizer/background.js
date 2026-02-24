/*============================================================
  Background Service Worker
  - 분석 요청 처리
  - 주기적 분석 스케줄링
  - 메시지 라우팅
  - 쿠키 연결 (CONNECT_VIA_COOKIE)
============================================================*/

importScripts('lib/api.js', 'lib/keywords.js', 'lib/analyzer.js', 'lib/storage.js', 'lib/gemini.js', 'lib/updater.js');

// ══════════════════════════════════════
// 쿠키 연결: 도메인/리전 맵 및 SPC_CDS 탐색
// ══════════════════════════════════════
const SELLER_DOMAINS = [
  'seller.shopee.kr', 'seller.shopee.sg', 'seller.shopee.com.my',
  'seller.shopee.co.th', 'seller.shopee.vn', 'seller.shopee.ph',
  'seller.shopee.tw', 'seller.shopee.co.id', 'seller.shopee.com.br',
  'seller.shopee.com.mx'
];

const REGION_MAP = {
  'seller.shopee.kr': 'kr', 'seller.shopee.sg': 'sg',
  'seller.shopee.com.my': 'my', 'seller.shopee.co.th': 'th',
  'seller.shopee.vn': 'vn', 'seller.shopee.ph': 'ph',
  'seller.shopee.tw': 'tw', 'seller.shopee.co.id': 'id',
  'seller.shopee.com.br': 'br', 'seller.shopee.com.mx': 'mx'
};

async function findSpcCds() {
  for (const domain of SELLER_DOMAINS) {
    try {
      const cookie = await chrome.cookies.get({
        url: 'https://' + domain,
        name: 'SPC_CDS'
      });
      if (cookie && cookie.value) {
        return { spcCds: cookie.value, sellerDomain: domain, spc: cookie.value, domain: domain };
      }
    } catch (e) {
      // skip
    }
  }
  return null;
}

async function handleConnectViaCookie() {
  try {
    const found = await findSpcCds();
    if (!found) {
      return {
        success: false,
        error: '셀러센터에 로그인되어 있지 않습니다. seller.shopee.kr 등에 로그인 후 다시 시도하세요.'
      };
    }

    const { spcCds, sellerDomain } = found;
    const region = REGION_MAP[sellerDomain] || 'sg';

    await chrome.storage.local.set({
      active_spc_cds: spcCds,
      active_seller_domain: sellerDomain
    });

    const endpoints = [
      '/api/v3/general/get_shop_list',
      '/api/v3/merchant/get_all_shop_info_list',
      '/api/v2/shop/get_shop_list'
    ];

    let shopList = [];

    for (const ep of endpoints) {
      try {
        const url = 'https://' + sellerDomain + ep + '?SPC_CDS=' + encodeURIComponent(spcCds) + '&SPC_CDS_VER=2';
        const res = await fetch(url, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) continue;
        const data = await res.json();

        shopList = data.data?.shop_list
          || data.data?.list
          || data.data?.shops
          || data.data?.all_shop_info_list
          || [];

        if (shopList.length > 0) {
          shopList = shopList.filter(function (s) {
            return s.status === undefined || s.status === 1;
          });
          break;
        }
      } catch (e) {
        // 다음 엔드포인트 시도
      }
    }

    if (shopList.length === 0) {
      return {
        success: false,
        error: '샵 목록을 가져오지 못했습니다. 셀러센터에 로그인 후 다시 시도하세요.'
      };
    }

    const storageResult = await chrome.storage.local.get(['connectedShops']);
    const existingShops = storageResult.connectedShops || [];
    const newShops = [];

    for (const shop of shopList) {
      const shopId = String(shop.shop_id || shop.id || '');
      if (!shopId) continue;

      const exists = existingShops.some(function (s) {
        return String(s.shop_id) === shopId;
      });
      if (exists) continue;

      const newShop = {
        shop_id: shopId,
        name: shop.user_name || shop.name || shop.shop_name || 'Shop ' + shopId,
        shop_name: shop.user_name || shop.name || shop.shop_name || 'Shop ' + shopId,
        region: ((shop.region || region) + '').toLowerCase(),
        cookie_auth: true,
        spc_cds: spcCds,
        seller_domain: sellerDomain,
        cnsc_shop_id: String(shop.shop_id || shopId),
        status: shop.status || 1,
        connected_at: new Date().toISOString()
      };
      newShops.push(newShop);
      existingShops.push(newShop);
    }

    await chrome.storage.local.set({ connectedShops: existingShops });

    return {
      success: true,
      message: newShops.length > 0
        ? newShops.length + '개 샵이 연결되었습니다.'
        : '이미 모든 샵이 연결되어 있습니다.',
      newShops: newShops,
      totalShops: existingShops.length,
      sellerDomain: sellerDomain
    };
  } catch (error) {
    return {
      success: false,
      error: '연결 실패: ' + (error && error.message ? error.message : String(error))
    };
  }
}

// ══════════════════════════════════════
// 메시지 핸들러
// ══════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'CONNECT_VIA_COOKIE') {
    handleConnectViaCookie()
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function (err) {
        sendResponse({ success: false, error: err && err.message ? err.message : 'Unknown error' });
      });
    return true;
  }

  if (msg.type === 'GET_SHOPS') {
    chrome.storage.local.get(['connectedShops']).then(function (result) {
      const shops = result.connectedShops || [];
      if (shops.length > 0) {
        sendResponse({ success: true, data: shops });
        return;
      }
      findSpcCds().then(function (found) {
        if (!found) {
          sendResponse({ success: false, error: '로그인 필요' });
          return;
        }
        const endpoints = [
          '/api/v3/merchant/get_shop_list',
          '/api/v3/general/get_shop_list',
          '/api/v3/merchant/get_all_shop_info_list'
        ];
        (async function () {
          for (const ep of endpoints) {
            try {
              const epUrl = 'https://' + found.sellerDomain + ep + '?SPC_CDS=' + encodeURIComponent(found.spcCds) + '&SPC_CDS_VER=2';
              const r = await fetch(epUrl, { credentials: 'include' });
              if (!r.ok) continue;
              const data = await r.json();
              const rawList = data.data?.list || data.data?.shop_list || data.data?.all_shop_info_list || data.data?.shops || [];
              if (rawList.length > 0) {
                const list = rawList.map(function (s) {
                  return {
                    shop_id: String(s.shop_id || s.id || ''),
                    name: s.user_name || s.shop_name || s.name || '',
                    shop_name: s.user_name || s.shop_name || s.name || '',
                    region: (s.region || s.cb_region || 'sg').toLowerCase(),
                    status: s.shop_status || s.status || 1
                  };
                });
                sendResponse({ success: true, data: list });
                return;
              }
            } catch (e) {
              // try next endpoint
            }
          }
          sendResponse({ success: false, error: '샵 목록 없음' });
        })();
      });
    });
    return true;
  }

  if (msg.type === 'ANALYZE_SHOP') {
    ShopeeAPI.getShopList()
      .then(function (shops) {
        const shop = shops.find(function (s) { return String(s.shop_id) === String(msg.shopId); });
        const shopName = (shop && (shop.name || shop.shop_name)) || msg.shopName;
        return ShopAnalyzer.analyzeShop(msg.shopId, msg.region, shopName);
      })
      .then(function (report) {
        return StorageHelper.saveReport(msg.shopId, report).then(function () { return report; });
      })
      .then(function (report) {
        sendResponse({ success: true, data: report });
      })
      .catch(function (err) {
        sendResponse({ success: false, error: err && err.message ? err.message : 'Analyze failed' });
      });
    return true;
  }

  if (msg.type === 'ANALYZE_ALL') {
    analyzeAllShops()
      .then(function (results) { sendResponse({ success: true, data: results }); })
      .catch(function (err) { sendResponse({ success: false, error: err && err.message ? err.message : 'Analyze failed' }); });
    return true;
  }

  if (msg.type === 'GET_REPORT') {
    StorageHelper.loadReport(msg.shopId)
      .then(function (report) { sendResponse({ success: true, data: report }); })
      .catch(function (err) { sendResponse({ success: false, error: err && err.message ? err.message : 'Load failed' }); });
    return true;
  }

  if (msg.type === 'GET_ALL_REPORTS') {
    StorageHelper.loadAllReports()
      .then(function (reports) { sendResponse({ success: true, data: reports }); })
      .catch(function (err) { sendResponse({ success: false, error: err && err.message ? err.message : 'Load failed' }); });
    return true;
  }

  if (msg.type === 'GET_HISTORY') {
    StorageHelper.loadHistory(msg.shopId)
      .then(function (history) { sendResponse({ success: true, data: history }); })
      .catch(function (err) { sendResponse({ success: false, error: err && err.message ? err.message : 'Load failed' }); });
    return true;
  }

  if (msg.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get('optimizerSettings', function (res) {
      sendResponse({ success: true, data: res.optimizerSettings || {} });
    });
    return true;
  }

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
        const region = msg.region;
        const PAGE_SIZE = 48;

        const firstUrl = `https://${domain}/api/v3/opt/mpsku/list/v2/search_product_list?page_number=1&page_size=${PAGE_SIZE}&source=seller_center&need_statistic_info=true&SPC_CDS=${encodeURIComponent(spcData.spc)}&SPC_CDS_VER=2&cnsc_shop_id=${shopId}&cbsc_shop_region=${region}`;
        const firstRes = await fetch(firstUrl, { credentials: 'include' });
        const firstData = await firstRes.json();
        let allProducts = firstData.data?.products || [];
        const total = firstData.data?.page_info?.total || allProducts.length;
        const totalPages = Math.min(Math.ceil(total / PAGE_SIZE), 120);

        for (let p = 2; p <= totalPages; p++) {
          const pageUrl = `https://${domain}/api/v3/opt/mpsku/list/v2/search_product_list?page_number=${p}&page_size=${PAGE_SIZE}&source=seller_center&need_statistic_info=true&SPC_CDS=${encodeURIComponent(spcData.spc)}&SPC_CDS_VER=2&cnsc_shop_id=${shopId}&cbsc_shop_region=${region}`;
          try {
            const pageRes = await fetch(pageUrl, { credentials: 'include' });
            const pageData = await pageRes.json();
            const products = pageData.data?.products || [];
            if (products.length === 0) break;
            allProducts = allProducts.concat(products);
          } catch (e) {
            console.warn('[GET_PRODUCTS] page', p, 'failed:', e.message);
          }
          await new Promise(function (r) { setTimeout(r, 200); });
        }

        const seen = {};
        const unique = allProducts.filter(function (p) {
          if (seen[p.id]) return false;
          seen[p.id] = true;
          return true;
        });
        console.log('[GET_PRODUCTS] total:', total, 'fetched:', unique.length);
        sendResponse({ success: true, data: unique });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_KEYWORDS') {
    (async function () {
      try {
        const spcData = await findSpcCds();
        if (!spcData) { sendResponse({ success: false, error: 'Not logged in' }); return; }

        const kwData = await ShopeeKeywords.fetchKeywords(
          spcData.spc, msg.shopId, msg.region, spcData.domain
        );
        sendResponse({ success: true, data: kwData });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'AI_OPTIMIZE_PRODUCTS') {
    (async function () {
      const { shopId, region } = msg;

      function sendProgress(message, percent, detail) {
        chrome.runtime.sendMessage({
          type: 'AI_PROGRESS_UPDATE',
          data: { message, percent, detail: detail || '' }
        }).catch(function () { });
      }

      async function getStoredApiKey() {
        const raw = await chrome.storage.local.get(['geminiApiKey', 'optimizerSettings']);
        return raw.geminiApiKey || raw.optimizerSettings?.geminiApiKey || raw.optimizerSettings?.geminiKey || '';
      }

      async function getShopProducts(targetShopId, targetRegion) {
        // 이미 상품이 전달되었으면 그대로 사용
        if (Array.isArray(msg.products) && msg.products.length > 0) {
          return msg.products;
        }

        // 직접 API에서 전체 페이지 수집
        var spcData = await findSpcCds();
        if (!spcData) throw new Error('Not logged in');

        var domain = msg.sellerDomain || spcData.domain;
        var PAGE_SIZE = 48;
        var baseParams = 'source=seller_center&need_statistic_info=true'
          + '&SPC_CDS=' + encodeURIComponent(spcData.spc)
          + '&SPC_CDS_VER=2'
          + '&cnsc_shop_id=' + targetShopId
          + '&cbsc_shop_region=' + targetRegion;

        // 첫 페이지
        var firstUrl = 'https://' + domain
          + '/api/v3/opt/mpsku/list/v2/search_product_list?page_number=1&page_size=' + PAGE_SIZE
          + '&' + baseParams;
        var firstRes = await fetch(firstUrl, { credentials: 'include' });
        var firstData = await firstRes.json();
        var allProducts = firstData.data?.products || [];
        var total = firstData.data?.page_info?.total || allProducts.length;
        var totalPages = Math.min(Math.ceil(total / PAGE_SIZE), 120);

        // 나머지 페이지 수집
        for (var p = 2; p <= totalPages; p++) {
          try {
            var pageUrl = 'https://' + domain
              + '/api/v3/opt/mpsku/list/v2/search_product_list?page_number=' + p
              + '&page_size=' + PAGE_SIZE + '&' + baseParams;
            var pageRes = await fetch(pageUrl, { credentials: 'include' });
            var pageData = await pageRes.json();
            var pageProducts = pageData.data?.products || [];
            if (pageProducts.length === 0) break;
            allProducts = allProducts.concat(pageProducts);
          } catch (e) {
            console.warn('[AI getShopProducts] page', p, 'failed:', e.message);
          }
          await new Promise(function(r) { setTimeout(r, 200); });
        }

        // 중복 제거
        var seen = {};
        var unique = allProducts.filter(function(prod) {
          if (seen[prod.id]) return false;
          seen[prod.id] = true;
          return true;
        });
        console.log('[AI getShopProducts] total:', total, 'fetched:', unique.length);
        return unique;
      }

      try {
        sendProgress('초기화 중...', 0);

        const apiKey = await getStoredApiKey();
        if (!apiKey) {
          sendResponse({ success: false, error: 'Gemini API 키가 설정되지 않았습니다.' });
          return;
        }

        const settings = await new Promise(function (r) {
          chrome.storage.local.get('optimizerSettings', function (res) { r(res.optimizerSettings || {}); });
        });
        const geminiModel = settings.geminiModel || 'gemini-2.0-flash';
        const gemini = new GeminiOptimizer(apiKey, geminiModel);

        sendProgress('상품 목록 가져오는 중...', 5);
        let products = [];
        try {
          products = await getShopProducts(shopId, region);
        } catch (e) {
          sendResponse({ success: false, error: `상품 로딩 실패: ${e.message}` });
          return;
        }

        if (!products.length) {
          sendResponse({ success: false, error: '상품이 없습니다.' });
          return;
        }

        products = products.map((p, i) => ({
          ...p,
          _globalIndex: i,
          title: p.title || p.name || ''
        }));

        sendProgress(`${products.length}개 상품 로드 완료`, 8);
        sendProgress('AI 상품 카테고리 분류 중...', 10);

        let classifications;
        try {
          classifications = await gemini.classifyProducts(products);
        } catch (e) {
          sendResponse({ success: false, error: `상품 분류 실패: ${e.message}` });
          return;
        }
        sendProgress(`${products.length}개 상품 분류 완료`, 18);

        sendProgress('상품별 핵심 검색어 추출 중...', 20);
        let searchTermsMap;
        try {
          searchTermsMap = await gemini.extractSearchTerms(products, classifications, String(region || '').toUpperCase());
        } catch (e) {
          console.warn('[AI] 검색어 추출 실패, 계속 진행:', e.message);
          searchTermsMap = {};
        }
        sendProgress('검색어 추출 완료', 28);

        sendProgress('쇼피에서 키워드 수집 중...', 30);
        const allSearchTerms = new Set();
        for (const terms of Object.values(searchTermsMap)) {
          if (Array.isArray(terms)) {
            terms.forEach(function (t) { if (t) allSearchTerms.add(t); });
          }
        }
        const uniqueTerms = Array.from(allSearchTerms);
        const allSuggestions = {};

        for (let i = 0; i < uniqueTerms.length; i++) {
          const term = uniqueTerms[i];
          sendProgress(
            `키워드 수집: "${term}" (${i + 1}/${uniqueTerms.length})`,
            30 + (i / Math.max(uniqueTerms.length, 1)) * 15
          );
          try {
            const suggestions = await ShopeeKeywords.fetchSuggestions(String(region || '').toUpperCase(), term);
            allSuggestions[term] = suggestions;
          } catch (e) {
            allSuggestions[term] = [];
          }
          await new Promise(function (r) { setTimeout(r, 500); });
        }

        const productKeywordsMap = {};
        for (const [idx, terms] of Object.entries(searchTermsMap)) {
          productKeywordsMap[idx] = [];
          if (Array.isArray(terms)) {
            for (const term of terms) {
              const sugs = allSuggestions[term] || [];
              productKeywordsMap[idx].push(...sugs);
            }
          }
          const seen = new Set();
          productKeywordsMap[idx] = productKeywordsMap[idx].filter(function (k) {
            const key = String(k.keyword || '').toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }

        sendProgress('키워드 수집 완료', 48);
        sendProgress('인기/트렌딩 키워드 수집 중...', 49);

        let topKeywords = [];
        let trendingKeywords = [];
        try {
          const [topRes, trendRes] = await Promise.allSettled([
            ShopeeKeywords.fetchTopKeywords(String(region || '').toUpperCase()),
            ShopeeKeywords.fetchTrendingKeywords(String(region || '').toUpperCase())
          ]);
          topKeywords = topRes.status === 'fulfilled' ? topRes.value : [];
          trendingKeywords = trendRes.status === 'fulfilled' ? trendRes.value : [];
        } catch (e) {
          // optional
        }
        sendProgress('모든 키워드 수집 완료', 50);

        const batchSize = 5;
        const allResults = [];
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < products.length; i += batchSize) {
          const batch = products.slice(i, i + batchSize);
          const batchNum = Math.floor(i / batchSize) + 1;
          const totalBatches = Math.ceil(products.length / batchSize);

          sendProgress(
            `AI 최적화 ${batchNum}/${totalBatches} 배치 처리 중...`,
            50 + (i / products.length) * 45,
            `상품 ${i + 1}~${Math.min(i + batchSize, products.length)} / ${products.length}`
          );

          try {
            const batchResults = await gemini.optimizeBatch(
              batch,
              classifications,
              productKeywordsMap,
              String(region || '').toUpperCase()
            );

            if (Array.isArray(batchResults)) {
              for (const result of batchResults) {
                const originalTitle = result.originalTitle || result.original_title || '';
                const optimizedTitle = result.optimizedTitle || result.new_title || originalTitle;
                const description = result.description || result.new_description || '';
                const usedKeywords = result.usedKeywords || result.used_keywords || [];
                allResults.push({
                  ...result,
                  originalTitle,
                  optimizedTitle,
                  description,
                  usedKeywords,
                  original_title: originalTitle,
                  new_title: optimizedTitle,
                  new_description: description,
                  used_keywords: usedKeywords,
                  success: true,
                  product: products.find(p => p._globalIndex === result.index) || null
                });
                successCount++;
              }
            }
          } catch (e) {
            for (const product of batch) {
              const title = product.title || '';
              allResults.push({
                index: product._globalIndex,
                originalTitle: title,
                optimizedTitle: title,
                description: '',
                usedKeywords: [],
                original_title: title,
                new_title: title,
                new_description: '',
                used_keywords: [],
                reasoning: `오류: ${e.message}`,
                success: false,
                product
              });
              failCount++;
            }
          }

          if (i + batchSize < products.length) {
            sendProgress('Gemini API 대기 중...', 50 + (i / products.length) * 45);
            await new Promise(function (r) { setTimeout(r, 4000); });
          }
        }

        sendProgress('✅ AI 최적화 완료!', 100);

        const payload = {
          success: true,
          results: allResults,
          summary: {
            total: products.length,
            success: successCount,
            fail: failCount
          },
          keywords: {
            top: topKeywords,
            trending: trendingKeywords,
            productSpecific: Object.values(productKeywordsMap).flat().length
          },
          classifications
        };

        // compatibility for old UI code that expects data wrapper
        sendResponse({
          ...payload,
          data: {
            results: payload.results,
            summary: payload.summary,
            keywords: payload.keywords,
            classifications: payload.classifications
          }
        });
      } catch (e) {
        console.error('[AI] 전체 프로세스 오류:', e);
        sendResponse({ success: false, error: e.message });
      }
    })();

    return true;
  }

  if (msg.type === 'APPLY_OPTIMIZATIONS') {
    (async function () {
      try {
        const spcData = await findSpcCds();
        if (!spcData) {
          sendResponse({ success: false, error: 'Not logged in' });
          return;
        }
        const results = await ShopeeUpdater.executeBatchUpdate(
          spcData.spc,
          msg.optimizationPlan || [],
          null
        );
        sendResponse({ success: true, data: results });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'RUN_FRESHNESS') {
    (async function () {
      try {
        const spcData = await findSpcCds();
        if (!spcData) {
          sendResponse({ success: false, error: 'Not logged in' });
          return;
        }
        const domain = msg.sellerDomain || spcData.domain;
        const results = await ShopeeUpdater.freshnessRotation(
          spcData.spc,
          msg.products || [],
          { shopId: msg.shopId, region: msg.region, sellerDomain: domain }
        );
        sendResponse({ success: true, data: results });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'RESTORE_BACKUP') {
    (async function () {
      try {
        const backups = await new Promise(function (r) {
          chrome.storage.local.get('productBackups', function (res) {
            r(res.productBackups || {});
          });
        });
        const key = `${msg.shopId}_${msg.productId}`;
        const backup = backups[key];
        if (!backup) {
          sendResponse({ success: false, error: '백업 없음' });
          return;
        }

        const spcData = await findSpcCds();
        if (!spcData) {
          sendResponse({ success: false, error: 'Not logged in' });
          return;
        }

        const updateData = {};
        if (backup.originalTitle) updateData.name = backup.originalTitle;
        if (backup.originalDescription) updateData.description = backup.originalDescription;

        const res = await ShopeeUpdater.updateProduct(
          spcData.spc,
          msg.shopId,
          msg.region,
          msg.productId,
          updateData,
          msg.sellerDomain || spcData.domain
        );
        sendResponse({ success: true, data: res, backup: backup });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  sendResponse({ success: false, error: 'Unknown message type: ' + (msg && msg.type ? msg.type : '') });
  return false;
});

// ══════════════════════════════════════
// 전체 샵 분석
// ══════════════════════════════════════
async function analyzeAllShops() {
  const shops = await ShopeeAPI.getShopList();
  const results = [];

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    const shopId = String(shop.shop_id);
    const region = (shop.region || 'sg').toLowerCase();
    const shopName = shop.name || shop.shop_name || shop.user_name || 'Shop ' + shopId;
    try {
      chrome.runtime.sendMessage({
        type: 'ANALYSIS_PROGRESS',
        message: shopName + ' 분석 중... (' + (i + 1) + '/' + shops.length + ')',
        percent: Math.round((i / shops.length) * 100)
      }).catch(function () { });

      const report = await ShopAnalyzer.analyzeShop(shopId, region, shopName);
      await StorageHelper.saveReport(shopId, report);
      results.push(report);

      await new Promise(function (r) { setTimeout(r, 1000); });
    } catch (e) {
      results.push({ shopName: shopName, error: e && e.message ? e.message : 'Error' });
    }
  }

  return results;
}

// ══════════════════════════════════════
// 주기적 분석 (알람)
// ══════════════════════════════════════
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'auto_analyze') {
    analyzeAllShops().catch(function (e) {
      console.error('Auto analyze failed:', e);
    });
  }
});

chrome.runtime.onInstalled.addListener(function () {
  StorageHelper.loadSettings().then(function (settings) {
    if (settings && settings.autoAnalyzeInterval > 0) {
      chrome.alarms.create('auto_analyze', {
        periodInMinutes: settings.autoAnalyzeInterval * 60
      });
    }
  });
});
