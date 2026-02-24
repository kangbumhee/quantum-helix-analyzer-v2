import { ShopeeAPI } from './api.js';
import { KeywordEngine } from './keywords.js';

const ShopAnalyzer = {
  async analyzeShop(shopId, region, shopName) {
    const report = {
      shopId, region, shopName,
      analyzedAt: new Date().toISOString(),
      summary: {},
      products: [],
      issues: [],
      score: 0,
      traffic: {},
      keywords: { popular: [], trending: [] },
      titleAudit: { localizationRate: 0 },
      keywordAudit: { matchRate: 0 },
      titleSuggestions: [],
      freshness: { pending: 0, boosted: 0, expired: 0 }
    };

    try {
      await ShopeeAPI.init();

      this._progress(shopId, 5, '상품 목록 수집 중...');
      const products = await ShopeeAPI.getAllProducts(shopId);

      this._progress(shopId, 15, '성능 데이터 수집 중...');
      const batchSize = 20;
      for (let i = 0; i < products.length; i += batchSize) {
        const batch = products.slice(i, i + batchSize);
        await Promise.all(batch.map(async (p) => {
          try {
            const perf = await ShopeeAPI.getProductPerformance(shopId, p.item_id || p.id);
            p._perf = perf?.data || {};
          } catch { p._perf = {}; }
        }));
        await new Promise(r => setTimeout(r, 300));
      }

      this._progress(shopId, 35, '키워드 수집 중...');
      let popularKeywords = [], trendingKeywords = [];
      try {
        const topRes = await ShopeeAPI.getTopKeywords(shopId);
        popularKeywords = topRes?.data?.keywords || topRes?.data?.list || [];
      } catch {}
      try {
        const trendRes = await ShopeeAPI.getTrendingKeywords(shopId);
        trendingKeywords = trendRes?.data?.keywords || trendRes?.data?.list || [];
      } catch {}
      report.keywords = { popular: popularKeywords, trending: trendingKeywords };

      this._progress(shopId, 50, '트래픽 데이터 수집 중...');
      try {
        report.traffic.overview = (await ShopeeAPI.getTrafficOverview(shopId))?.data || {};
        report.traffic.sources = (await ShopeeAPI.getTrafficSources(shopId))?.data || {};
        report.traffic.funnel = (await ShopeeAPI.getSalesFunnel(shopId))?.data || {};
      } catch {}

      this._progress(shopId, 65, '상품 분석 중...');
      let localizedCount = 0, matchHit = 0;
      let totalViews = 0, totalSold = 0, totalImpressions = 0;

      for (const p of products) {
        const analysis = KeywordEngine.analyzeProduct(p, popularKeywords, trendingKeywords);
        const perf = p._perf || {};
        const views = perf.page_view || perf.views || 0;
        const sold = perf.sold || perf.sales || 0;
        const impressions = perf.impression || perf.impressions || 0;
        const lastModify = p.update_time || p.modified_time || 0;
        const daysSinceModify = lastModify ? Math.floor((Date.now() / 1000 - lastModify) / 86400) : 999;

        let freshnessStatus = 'expired';
        if (daysSinceModify <= 3) freshnessStatus = 'pending';
        else if (daysSinceModify <= 7) freshnessStatus = 'boosted';
        report.freshness[freshnessStatus]++;

        if (analysis.isLocalized) localizedCount++;
        if (analysis.keywordMatchCount > 0) matchHit++;
        totalViews += views;
        totalSold += sold;
        totalImpressions += impressions;

        const suggestion = KeywordEngine.generateTitleSuggestion(p, analysis, popularKeywords);

        report.products.push({
          ...p,
          _analysis: analysis,
          _views: views,
          _sold: sold,
          _impressions: impressions,
          _daysSinceModify: daysSinceModify,
          _freshnessStatus: freshnessStatus,
          _suggestion: suggestion
        });

        if (suggestion && suggestion.addedKeywords.length > 0) {
          report.titleSuggestions.push(suggestion);
        }
      }

      const totalProducts = products.length || 1;
      report.titleAudit.localizationRate = localizedCount / totalProducts;
      report.keywordAudit.matchRate = products.length > 0 ? matchHit / totalProducts : 0;
      report.summary = {
        totalProducts: products.length,
        totalViews,
        totalSold,
        totalImpressions,
        localizationRate: report.titleAudit.localizationRate,
        keywordMatchRate: report.keywordAudit.matchRate
      };

      report.issues = this._detectIssues(report);
      report.score = this._calcScore(report);

      this._progress(shopId, 100, '분석 완료');
    } catch (err) {
      console.error('[Analyzer]', err);
      report.issues.push({ level: 'critical', message: `분석 오류: ${err.message}` });
    }

    return report;
  },

  _detectIssues(report) {
    const issues = [];
    const s = report.summary;

    if (s.localizationRate < 0.8)
      issues.push({ level: 'critical', message: `제목 현지화율 ${Math.round(s.localizationRate * 100)}% (80% 미만)` });

    if (s.keywordMatchRate < 0.3)
      issues.push({ level: 'critical', message: `키워드 매칭률 ${Math.round(s.keywordMatchRate * 100)}% (30% 미만)` });

    const expiredRate = report.freshness.expired / (s.totalProducts || 1);
    if (expiredRate > 0.7)
      issues.push({ level: 'high', message: `Freshness 만료 상품 ${Math.round(expiredRate * 100)}% (70% 초과)` });

    const zeroSalesHighImpr = report.products.filter(p => p._impressions >= 50 && p._sold === 0);
    if (zeroSalesHighImpr.length > 0)
      issues.push({ level: 'high', message: `노출 50+ 판매 0건 상품 ${zeroSalesHighImpr.length}개` });

    const searchPct = this._getSearchPercentage(report.traffic);
    if (searchPct < 20)
      issues.push({ level: 'medium', message: `검색 트래픽 비율 ${searchPct}% (20% 미만)` });

    const zeroSalesViews = report.products.filter(p => p._views >= 10 && p._sold === 0);
    if (zeroSalesViews.length > 0)
      issues.push({ level: 'medium', message: `조회 10+ 판매 0건 상품 ${zeroSalesViews.length}개` });

    return issues;
  },

  _getSearchPercentage(traffic) {
    try {
      const sources = traffic?.sources?.sources || traffic?.sources?.list || [];
      const search = sources.find(s => s.type === 'search' || s.name === 'search');
      return search ? Math.round(search.percentage || search.ratio * 100 || 0) : 0;
    } catch { return 0; }
  },

  _calcScore(report) {
    let score = 100;
    const s = report.summary;

    score -= Math.max(0, (0.8 - s.localizationRate) * 50);
    score -= Math.max(0, (0.5 - s.keywordMatchRate) * 30);

    const expiredRate = report.freshness.expired / (s.totalProducts || 1);
    score -= Math.max(0, expiredRate * 20);

    const conversionIssues = report.products.filter(p => p._views >= 10 && p._sold === 0).length;
    score -= Math.min(15, conversionIssues * 0.5);

    if (s.totalSold > 10) score += 3;
    if (s.totalSold > 50) score += 2;

    return Math.max(0, Math.min(100, Math.round(score)));
  },

  _progress(shopId, pct, text) {
    try {
      chrome.runtime.sendMessage({
        type: 'ANALYSIS_PROGRESS',
        shopId, percentage: pct, text
      }).catch(() => {});
    } catch {}
  },

  formatDate(ts) {
    if (!ts) return '-';
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
};

export { ShopAnalyzer };
