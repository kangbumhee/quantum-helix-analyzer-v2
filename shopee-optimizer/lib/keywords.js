// lib/keywords.js — 쇼피 키워드 수집 엔진
// 전체 인기 키워드 + 상품별 맞춤 키워드 (자동완성 API) + 트렌딩

function isKeywordMatchNormalized(title, keyword) {
  if (!title || !keyword) return false;
  const titleLower = String(title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const kwLower = String(keyword).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (titleLower.includes(kwLower)) return true;

  const kwWords = kwLower.split(/[\s\-\/]+/).filter(w => w.length >= 2);
  if (kwWords.length === 0) return false;
  if (kwWords.length === 1) return titleLower.includes(kwWords[0]);
  const matchedWords = kwWords.filter(w => titleLower.includes(w));
  return matchedWords.length >= Math.ceil(kwWords.length * 0.5);
}

class ShopeeKeywords {
  static DOMAINS = {
    SG: 'https://shopee.sg',
    MY: 'https://shopee.com.my',
    PH: 'https://shopee.ph',
    TW: 'https://shopee.tw',
    TH: 'https://shopee.co.th',
    VN: 'https://shopee.vn',
    BR: 'https://shopee.com.br',
    MX: 'https://shopee.com.mx',
    ID: 'https://shopee.co.id',
    CL: 'https://shopee.cl',
    CO: 'https://shopee.com.co',
    PL: 'https://shopee.pl'
  };

  static LANGUAGES = {
    SG: 'en', MY: 'ms', PH: 'en', TW: 'zh-Hant',
    TH: 'th', VN: 'vi', BR: 'pt', MX: 'es',
    ID: 'id', CL: 'es', CO: 'es', PL: 'pl'
  };

  static async _fetch(url, region, options = {}) {
    const key = String(region || '').toUpperCase();
    const domain = this.DOMAINS[key] || this.DOMAINS.SG;
    const lang = this.LANGUAGES[key] || 'en';
    const headers = {
      'x-api-source': 'pc',
      'x-shopee-language': lang,
      'x-requested-with': 'XMLHttpRequest',
      referer: domain,
      accept: 'application/json',
      ...(options.headers || {})
    };
    const fetchOptions = {
      method: options.method || 'GET',
      headers,
      credentials: 'include',
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    };
    const resp = await fetch(url, fetchOptions);
    if (!resp.ok) throw new Error(`Shopee API ${resp.status}: ${url}`);
    return resp.json();
  }

  static _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  static async fetchTopKeywords(region, limit = 20) {
    const key = String(region || '').toUpperCase();
    const domain = this.DOMAINS[key];
    if (!domain) return [];
    const results = [];
    const seen = new Set();
    const seeds = ['', 'a', 'b', 'c', 's', 't'];

    for (const seed of seeds) {
      try {
        const url = `${domain}/api/v4/search/search_hint?keyword=${encodeURIComponent(seed)}`;
        const data = await this._fetch(url, key);
        const hints = data?.data?.hints || data?.data?.keywords || data?.data?.keyword_items || data?.data?.items || data?.hints || [];

        for (const hint of hints) {
          const text = hint?.text || hint?.keyword || hint?.display_text || hint?.hint || (typeof hint === 'string' ? hint : null);
          if (!text || !text.trim()) continue;
          const k = text.trim().toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          results.push({
            keyword: text.trim(),
            volume: hint?.count || hint?.search_volume || 0,
            source: 'top_hint'
          });
        }

        await this._delay(300);
      } catch (e) {
        // continue to next seed
      }

      if (results.length >= limit) break;
    }

    if (results.length === 0) {
      console.warn(`[Keywords] fetchTopKeywords: ${key}에서 0개 반환. 쿠키 상태와 API 응답 구조를 확인하세요.`);
    } else {
      console.log(`[Keywords] fetchTopKeywords: ${key}에서 ${results.length}개 수집`);
    }
    return results.slice(0, limit);
  }

  static async fetchSuggestions(region, searchTerm) {
    const key = String(region || '').toUpperCase();
    const domain = this.DOMAINS[key];
    if (!domain || !searchTerm) return [];

    try {
      const encoded = encodeURIComponent(String(searchTerm).trim());
      const url = `${domain}/api/v4/search/search_suggestion?keyword=${encoded}`;
      const data = await this._fetch(url, key);
      const suggestions = [];
      const rawList = data?.data?.suggestions || data?.data?.keywords || data?.suggestions || data?.data?.items || [];
      for (const item of rawList) {
        const text = item?.text || item?.keyword || item?.hint || (typeof item === 'string' ? item : null);
        if (text && text.trim()) {
          suggestions.push({
            keyword: text.trim(),
            source: 'autocomplete',
            baseTerm: searchTerm
          });
        }
      }
      return suggestions;
    } catch (e) {
      console.warn(`fetchSuggestions failed for "${searchTerm}" (${key}):`, e.message);
      return [];
    }
  }

  static async fetchProductKeywords(region, searchTerms, onProgress) {
    const allKeywords = [];
    const seen = new Set();

    for (let i = 0; i < (searchTerms || []).length; i++) {
      const term = searchTerms[i];
      if (!term || term.length < 2) continue;
      if (onProgress) onProgress(`키워드 수집: "${term}" (${i + 1}/${searchTerms.length})`);
      const suggestions = await this.fetchSuggestions(region, term);

      for (const s of suggestions) {
        const k = String(s.keyword || '').toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        allKeywords.push(s);
      }

      await this._delay(500);
    }

    return allKeywords;
  }

  static async getKeywordSearchCount(region, keyword) {
    const key = String(region || '').toUpperCase();
    const domain = this.DOMAINS[key];
    if (!domain || !keyword) return 0;

    try {
      const encoded = encodeURIComponent(String(keyword).trim());
      const url = `${domain}/api/v4/search/search_items?keyword=${encoded}&by=relevancy&limit=1&newest=0&order=desc`;
      const data = await this._fetch(url, key);
      return data?.data?.total_count || data?.total_count || 0;
    } catch (e) {
      return 0;
    }
  }

  static async batchGetSearchCounts(region, keywords, onProgress) {
    const results = [];
    for (let i = 0; i < (keywords || []).length; i++) {
      if (onProgress && i % 5 === 0) onProgress(`검색량 조회: ${i + 1}/${keywords.length}`);
      const kw = keywords[i];
      const count = await this.getKeywordSearchCount(region, kw.keyword);
      results.push({ ...kw, volume: count });
      await this._delay(300);
    }
    results.sort((a, b) => (b.volume || 0) - (a.volume || 0));
    return results;
  }

  static async fetchTrendingKeywords(region) {
    const key = String(region || '').toUpperCase();
    const domain = this.DOMAINS[key];
    if (!domain) return [];
    const results = [];
    const seen = new Set();
    const hintSeeds = ['', 'a', 'b', 'c', 'm', 's', 't', 'p', 'k'];
    const localSeeds = {
      TW: ['手', '包', '杯', '衣'],
      TH: ['ก', 'ข', 'ค', 'ม', 'ส'],
      VN: ['á', 'b', 'c', 't', 'đ'],
      BR: ['a', 'b', 'c', 'g', 'r'],
      ID: ['a', 'b', 'c', 't', 's'],
      MY: ['a', 'b', 'c', 's', 't'],
      MX: ['a', 'b', 'c', 'g', 'r'],
      PH: ['a', 'b', 'c', 's', 'p'],
      SG: ['a', 'b', 'c', 's', 'w']
    };
    const seeds = Array.from(new Set([...hintSeeds, ...(localSeeds[key] || [])]));

    for (const seed of seeds) {
      try {
        const hintUrl = `${domain}/api/v4/search/search_hint?keyword=${encodeURIComponent(seed)}`;
        const hintData = await this._fetch(hintUrl, key);
        const hints = hintData?.data?.hints || hintData?.data?.keywords || hintData?.data?.items || hintData?.hints || [];

        for (const hint of hints) {
          const text = hint?.text || hint?.keyword || hint?.hint || hint?.display_text || (typeof hint === 'string' ? hint : null);
          if (!text || !text.trim()) continue;
          const k = text.trim().toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          results.push({
            keyword: text.trim(),
            volume: hint?.count || hint?.search_volume || 0,
            source: 'trending_hint'
          });
        }

        await this._delay(300);
      } catch (e) {
        // continue to next seed
      }

      if (results.length >= 30) break;
    }

    if (results.length < 10) {
      try {
        const sugUrl = `${domain}/api/v4/search/search_suggestion?keyword=`;
        const sugData = await this._fetch(sugUrl, key);
        const suggestions = sugData?.data?.suggestions || sugData?.data?.keywords || sugData?.data?.items || sugData?.suggestions || [];

        for (const item of suggestions) {
          const text = item?.text || item?.keyword || item?.hint || (typeof item === 'string' ? item : null);
          if (!text || !text.trim()) continue;
          const k = text.trim().toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          results.push({
            keyword: text.trim(),
            volume: item?.count || item?.search_volume || 0,
            source: 'trending_suggestion'
          });
        }
      } catch (e) {
        console.warn(`fetchTrendingKeywords suggestion fallback failed (${key}):`, e.message);
      }
    }

    if (results.length === 0) {
      try {
        const debugUrl = `${domain}/api/v4/search/search_hint?keyword=a`;
        const raw = await this._fetch(debugUrl, key);
        console.log(`[Keywords DEBUG] ${key} search_hint raw response:`, JSON.stringify(raw).slice(0, 1000));
      } catch (e) {
        console.warn(`[Keywords DEBUG] ${key} search_hint debug failed:`, e.message);
      }

      try {
        const debugUrl2 = `${domain}/api/v4/search/search_suggestion?keyword=a`;
        const raw2 = await this._fetch(debugUrl2, key);
        console.log(`[Keywords DEBUG] ${key} search_suggestion raw response:`, JSON.stringify(raw2).slice(0, 1000));
      } catch (e) {
        console.warn(`[Keywords DEBUG] ${key} search_suggestion debug failed:`, e.message);
      }

      console.warn(`[Keywords] ${key}: 트렌딩 키워드 0개 — 위 DEBUG 로그에서 실제 응답 구조를 확인하세요`);
    }

    return results;
  }

  static async fetchAllKeywords(region, searchTerms = [], onProgress) {
    const result = { top: [], trending: [], productSpecific: [], all: [] };
    if (onProgress) onProgress('인기/트렌딩 키워드 수집 중...');

    const [topResult, trendingResult] = await Promise.allSettled([
      this.fetchTopKeywords(region),
      this.fetchTrendingKeywords(region)
    ]);
    result.top = topResult.status === 'fulfilled' ? topResult.value : [];
    result.trending = trendingResult.status === 'fulfilled' ? trendingResult.value : [];

    if (searchTerms.length > 0) {
      if (onProgress) onProgress('상품별 맞춤 키워드 수집 중...');
      result.productSpecific = await this.fetchProductKeywords(region, searchTerms, onProgress);
    }

    const seen = new Set();
    const merged = [];
    for (const list of [result.productSpecific, result.top, result.trending]) {
      for (const kw of list) {
        const key = String(kw.keyword || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(kw);
      }
    }
    result.all = merged;
    return result;
  }

  // Compatibility: existing background/dashboard expect this shape
  static async fetchKeywords(spcToken, shopId, region, sellerDomain) {
    const domain = sellerDomain || 'seller.shopee.kr';
    const topKeywords = [];
    const trendingKeywords = [];
    try {
      const base = `https://${domain}/api/mydata/krsc/shop/v2/seller-coach/top-keyword/overview/?SPC_CDS=${spcToken}&SPC_CDS_VER=2&cnsc_shop_id=${shopId}&cbsc_shop_region=${region}`;
      const res = await fetch(base, { credentials: 'include' });
      const data = await res.json();
      const categories = data.result || data.data?.result || [];
      categories.forEach((cat) => {
        const categoryName = cat.category_name || cat.name || '';
        const items = cat.items || cat.keywords || [];
        items.forEach((item) => {
          const keyword = item.keyword || item.name || '';
          if (!keyword) return;
          topKeywords.push({
            keyword,
            search_volume: item.search_volume || item.search_count || item.search_cnt || 0,
            category: categoryName
          });
          if (item.growth && item.growth > 1.5) {
            trendingKeywords.push({
              keyword,
              growth: typeof item.growth === 'number' ? Number(item.growth.toFixed(1)) : item.growth,
              category: categoryName
            });
          }
        });
      });
    } catch (e) {
      console.warn('fetchKeywords top-keyword API failed:', e.message);
    }

    try {
      const trendUrl = `https://${domain}/api/mydata/krsc/shop/v2/seller-coach/trending-keyword/overview/?SPC_CDS=${spcToken}&SPC_CDS_VER=2&cnsc_shop_id=${shopId}&cbsc_shop_region=${region}`;
      const trendRes = await fetch(trendUrl, { credentials: 'include' });
      const trendData = await trendRes.json();
      const trendCategories = trendData.result || trendData.data?.result || [];
      trendCategories.forEach((cat) => {
        const categoryName = cat.category_name || cat.name || '';
        const items = cat.items || cat.keywords || [];
        items.forEach((item) => {
          const keyword = item.keyword || item.name || '';
          const growth = item.growth || item.trend_ratio || item.increase_ratio || 0;
          if (!keyword || growth <= 1) return;
          trendingKeywords.push({
            keyword,
            growth: typeof growth === 'number' ? Number(growth.toFixed(1)) : growth,
            category: categoryName
          });
        });
      });
    } catch (e) {
      console.log('트렌딩 키워드 별도 API 없음, 기존 데이터 사용');
    }

    const dedup = {};
    for (const kw of trendingKeywords) {
      const key = String(kw.keyword || '').toLowerCase();
      if (!key) continue;
      if (!dedup[key] || Number(kw.growth || 0) > Number(dedup[key].growth || 0)) {
        dedup[key] = kw;
      }
    }
    const uniqueTrending = Object.values(dedup);

    topKeywords.sort((a, b) => (b.search_volume || 0) - (a.search_volume || 0));
    uniqueTrending.sort((a, b) => (b.growth || 0) - (a.growth || 0));
    return { topKeywords, trendingKeywords: uniqueTrending };
  }

  static analyzeMatching(products, topKeywords) {
    const kwList = (topKeywords || []).map(k => (k.keyword || '').toLowerCase());
    return (products || []).map((p) => {
      const title = (p.name || '').toLowerCase();
      const matched = (topKeywords || []).filter(k => isKeywordMatchNormalized(title, k.keyword || ''));
      const missed = (topKeywords || []).filter(k => !isKeywordMatchNormalized(title, k.keyword || ''));
      return {
        productId: p.id,
        productName: p.name,
        matchedKeywords: matched,
        missedKeywords: missed.slice(0, 5),
        matchRate: kwList.length > 0 ? ((matched.length / Math.min(kwList.length, 10)) * 100).toFixed(1) : 0,
        sold_count: p.statistics?.sold_count || 0,
        view_count: p.statistics?.view_count || 0
      };
    });
  }
}

const KeywordEngine = {
  detectLanguage(text) {
    const value = text || '';
    const langs = [];
    if (/[가-힣]/.test(value)) langs.push('ko');
    if (/[\u4e00-\u9fff]/.test(value)) langs.push('zh');
    if (/[\u0e00-\u0e7f]/.test(value)) langs.push('th');
    if (/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i.test(value)) langs.push('vi');
    if (/[çãõáàâêéíóôú]/i.test(value)) langs.push('pt');
    if (langs.length === 0) langs.push('en');
    return langs;
  },
  analyzeProduct(product, region, liveKeywords = []) {
    const name = product.name || '';
    const titleLangs = this.detectLanguage(name);
    const nameLower = name.toLowerCase();
    const normalized = (liveKeywords || []).map((k) => (typeof k === 'string' ? k : k.keyword || '')).filter(Boolean);
    const matchedKeywords = normalized.filter((kw) => isKeywordMatchNormalized(nameLower, kw));
    const missingKeywords = normalized.filter((kw) => !isKeywordMatchNormalized(nameLower, kw)).slice(0, 10);
    const expectedLang = { vn: 'vi', tw: 'zh', th: 'th', br: 'pt', sg: 'en', my: 'en', ph: 'en', id: 'id', mx: 'es' };
    const langMatch = region === 'sg' ? titleLangs.includes('en') : titleLangs.includes(expectedLang[region] || 'en');
    return {
      productId: product.id,
      name,
      category: 'dynamic',
      titleLanguages: titleLangs,
      languageMatch: langMatch,
      matchedKeywords,
      missingKeywords,
      liveMatchedKeywords: matchedKeywords,
      suggestedKeywords: normalized.slice(0, 10),
      estimatedSearches: '?',
      views: product.statistics?.view_count || 0,
      sold: product.statistics?.sold_count || 0,
      likes: product.statistics?.liked_count || 0,
      modifyTime: product.modify_time || 0,
      createTime: product.create_time || 0
    };
  },
  generateTitleSuggestion(analysis) {
    if (!analysis || !analysis.missingKeywords || analysis.missingKeywords.length === 0) return null;
    const topKeywords = analysis.missingKeywords.slice(0, 3);
    const brandMatch = (analysis.name || '').match(/^\[([^\]]+)\]/);
    const brand = brandMatch ? brandMatch[1] : '';
    const originalCore = (analysis.name || '').replace(/^\[[^\]]+\]\s*/, '').substring(0, 30);
    const suggestion = brand ? `[${brand}] ${topKeywords.join(' ')} ${originalCore}` : `${topKeywords.join(' ')} ${originalCore}`;
    return {
      current: analysis.name,
      suggested: suggestion,
      addedKeywords: topKeywords,
      estimatedSearchVolume: analysis.estimatedSearches || '?',
      priority: analysis.sold > 0 ? 'HIGH' : analysis.views > 0 ? 'MEDIUM' : 'LOW'
    };
  }
};

if (typeof self !== 'undefined') {
  self.ShopeeKeywords = ShopeeKeywords;
  self.KeywordEngine = KeywordEngine;
}
if (typeof window !== 'undefined') {
  window.ShopeeKeywords = ShopeeKeywords;
  window.KeywordEngine = KeywordEngine;
}
if (typeof module !== 'undefined') {
  module.exports = { ShopeeKeywords, KeywordEngine };
}
