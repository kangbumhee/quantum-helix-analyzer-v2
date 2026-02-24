/*============================================================
  Shop Analyzer Engine
  - 전체 샵 분석 파이프라인
  - 문제 감지 및 점수 산출
  - 리포트 생성
============================================================*/

const ShopAnalyzer = {

  // ══════════════════════════════════════
  // 전체 분석 실행
  // ══════════════════════════════════════
  async analyzeShop(shopId, region, shopName) {
    const report = {
      shopId,
      region: region.toUpperCase(),
      shopName,
      timestamp: Date.now(),
      summary: {},
      products: [],
      issues: [],
      score: 0,
      traffic: {},
      keywords: { popular: [], trending: [] },
      titleAudit: { localizedCount: 0, englishOnlyCount: 0, localizationRate: 0 },
      keywordAudit: { matchedCount: 0, unmatchedCount: 0, matchRate: 0 },
      titleSuggestions: [],
      freshnessStatus: { boosted: 0, pending: 0, expired: 0 }
    };

    try {
      // ── 1. 상품 수집 ──
      await this.updateProgress('상품 목록 수집 중...', 10);
      const products = await ShopeeAPI.getAllProducts(shopId, region);
      report.summary.totalProducts = products.length;

      // ── 2. 성과 데이터 수집 ──
      await this.updateProgress('성과 데이터 수집 중...', 25);
      const perfMap = {};
      for (let i = 0; i < products.length; i += 20) {
        const batch = products.slice(i, i + 20);
        const ids = batch.map(p => p.id);
        try {
          const perf = await ShopeeAPI.getProductPerformance(shopId, region, ids);
          if (perf.data?.performance) {
            Object.assign(perfMap, perf.data.performance);
          }
        } catch (e) { /* skip failed batches */ }
        await new Promise(r => setTimeout(r, 150));
      }

      // ── 3. 키워드 수집 ──
      await this.updateProgress('인기 키워드 수집 중...', 40);
      try {
        const kwRes = await ShopeeAPI.getTopKeywords(shopId, region);
        (kwRes.result || []).forEach(cat => {
          (cat.items || []).forEach(item => {
            report.keywords.popular.push({
              keyword: item.keyword,
              searchCount: item.search_cnt,
              category: cat.l1_cat_name
            });
          });
        });
      } catch (e) { /* skip */ }

      try {
        const trRes = await ShopeeAPI.getTrendingKeywords(shopId, region);
        (trRes.result || []).forEach(cat => {
          (cat.keywords || []).forEach(kw => {
            report.keywords.trending.push({
              keyword: kw.keyword_title,
              riseRate: kw.rise_rate,
              itemCount: kw.item_cnt,
              category: cat.l1_cat_name
            });
          });
        });
      } catch (e) { /* skip */ }

      // ── 4. 트래픽 데이터 ──
      await this.updateProgress('트래픽 데이터 수집 중...', 55);
      const now = new Date();
      const todayTs = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
      const yesterStart = todayTs - 86400;
      const dt = this.formatDate(new Date((todayTs - 86400) * 1000));

      try {
        const traffic = await ShopeeAPI.getTrafficOverview(shopId, region, dt);
        if (traffic.result?.all) {
          report.traffic = traffic.result.all;
        }
      } catch (e) { /* skip */ }

      try {
        const sources = await ShopeeAPI.getTrafficSources(shopId, region, yesterStart, todayTs);
        if (sources.result) {
          report.traffic.sources = sources.result;
        }
      } catch (e) { /* skip */ }

      try {
        const funnel = await ShopeeAPI.getSalesFunnel(shopId, region, yesterStart, todayTs);
        if (funnel.result) {
          report.traffic.funnel = funnel.result;
        }
      } catch (e) { /* skip */ }

      // ── 5. 상품별 분석 ──
      await this.updateProgress('상품별 키워드 분석 중...', 70);
      const liveKws = report.keywords.popular.map(k => k.keyword.toLowerCase());
      const nowTs = Math.floor(Date.now() / 1000);

      products.forEach(p => {
        const perf = perfMap[String(p.id)] || {};
        const analysis = KeywordEngine.analyzeProduct(p, region, liveKws);

        // 성과 데이터 추가
        analysis.l30d_impression = perf.l30d_impression || 0;
        analysis.l30d_sales = perf.l30d_sales || 0;
        analysis.l30d_conversion = perf.l30d_conversion || 0;

        // Freshness 분석
        const daysSinceModify = p.modify_time ? Math.round((nowTs - p.modify_time) / 86400) : 999;
        analysis.daysSinceModify = daysSinceModify;
        if (daysSinceModify <= 3) report.freshnessStatus.pending++;
        else if (daysSinceModify <= 7) report.freshnessStatus.boosted++;
        else report.freshnessStatus.expired++;

        // 제목 최적화 제안
        const suggestion = KeywordEngine.generateTitleSuggestion(analysis, region);
        if (suggestion) {
          report.titleSuggestions.push(suggestion);
        }

        report.products.push(analysis);
      });

      // ── 6. 집계 ──
      await this.updateProgress('분석 결과 집계 중...', 85);

      // 제목 현지화 감사
      const localCount = report.products.filter(p => p.languageMatch).length;
      report.titleAudit = {
        localizedCount: localCount,
        englishOnlyCount: report.products.length - localCount,
        localizationRate: report.products.length > 0 ? Math.round(localCount / report.products.length * 100) : 0
      };

      // 키워드 매칭 감사
      const kwMatched = report.products.filter(p => p.matchedKeywords.length > 0).length;
      report.keywordAudit = {
        matchedCount: kwMatched,
        unmatchedCount: report.products.length - kwMatched,
        matchRate: report.products.length > 0 ? Math.round(kwMatched / report.products.length * 100) : 0
      };

      // 핵심 통계
      report.summary.withViews = report.products.filter(p => p.views > 0).length;
      report.summary.withSales = report.products.filter(p => p.sold > 0).length;
      report.summary.totalViews = report.products.reduce((s, p) => s + p.views, 0);
      report.summary.totalSold = report.products.reduce((s, p) => s + p.sold, 0);
      report.summary.withImpressions = report.products.filter(p => p.l30d_impression > 0).length;

      // ── 7. 문제점 감지 ──
      await this.updateProgress('문제점 분석 중...', 90);
      report.issues = this.detectIssues(report);

      // ── 8. 점수 산출 ──
      report.score = this.calculateScore(report);

      await this.updateProgress('분석 완료!', 100);

    } catch (error) {
      report.error = error.message;
    }

    return report;
  },

  // ══════════════════════════════════════
  // 문제점 감지
  // ══════════════════════════════════════
  detectIssues(report) {
    const issues = [];

    // 1. 제목 현지화 문제
    if (report.titleAudit.localizationRate < 80) {
      issues.push({
        severity: 'CRITICAL',
        type: 'TITLE_LANGUAGE',
        title: '제목 현지화 부족',
        description: `${report.titleAudit.englishOnlyCount}개 상품의 제목이 현지어가 아닙니다 (현지화율: ${report.titleAudit.localizationRate}%)`,
        impact: '현지 검색에서 노출되지 않아 트래픽 손실',
        action: '영어 제목을 현지어 인기 키워드 포함 제목으로 변경'
      });
    }

    // 2. 키워드 미스매칭
    if (report.keywordAudit.matchRate < 30) {
      issues.push({
        severity: 'CRITICAL',
        type: 'KEYWORD_MISMATCH',
        title: '인기 키워드 미포함',
        description: `${report.keywordAudit.unmatchedCount}개 상품에 인기 검색 키워드가 없습니다 (매칭율: ${report.keywordAudit.matchRate}%)`,
        impact: '검색 노출 기회 상실 — 잠재 트래픽 손실',
        action: '각 상품 카테고리에 맞는 인기 키워드를 제목 앞부분에 추가'
      });
    }

    // 3. Freshness Boost 미활용
    if (report.freshnessStatus.expired > report.products.length * 0.7) {
      issues.push({
        severity: 'HIGH',
        type: 'FRESHNESS_EXPIRED',
        title: 'Freshness Boost 만료',
        description: `${report.freshnessStatus.expired}개 상품이 수정 후 7일 이상 경과 (Boost 효과 소멸)`,
        impact: '검색 노출 점수 하락',
        action: '매일 7~10개 상품을 순환 수정하여 항상 Boost 구간 유지'
      });
    }

    // 4. 높은 노출, 낮은 전환
    const highImprLowConv = report.products.filter(p => p.l30d_impression >= 50 && p.l30d_sales === 0);
    if (highImprLowConv.length > 0) {
      issues.push({
        severity: 'HIGH',
        type: 'LOW_CONVERSION',
        title: '노출은 높지만 판매 없음',
        description: `${highImprLowConv.length}개 상품이 50+ 노출이지만 판매 0건`,
        impact: '노출이 있어도 매출로 연결되지 않음 — 곧 노출 하락 예상',
        action: '가격/이미지/제목 개선으로 전환율 향상',
        products: highImprLowConv.map(p => (p.name || '').substring(0, 40))
      });
    }

    // 5. 트래픽 소스 편중
    const searchPct = this.getSearchPercentage(report);
    if (searchPct !== null && searchPct < 20) {
      issues.push({
        severity: 'MEDIUM',
        type: 'LOW_SEARCH_TRAFFIC',
        title: '검색 트래픽 비중 낮음',
        description: `검색을 통한 매출 비중이 ${searchPct.toFixed(1)}%에 불과합니다`,
        impact: '검색 SEO가 작동하지 않음 — 자연 트래픽 부족',
        action: '제목에 인기 키워드 추가 및 상세설명 최적화'
      });
    }

    // 6. 상세설명 부실 (공통 문제)
    issues.push({
      severity: 'MEDIUM',
      type: 'POOR_DESCRIPTION',
      title: '상세설명 최적화 필요',
      description: '대부분의 상품에 상품 고유 설명이 없고 샵 공통 안내문만 있음',
      impact: '검색 관련성 점수 하락 + 구매 전환율 저하',
      action: '상품별 특징/재질/사이즈/사용법을 현지어로 작성하고 키워드 포함'
    });

    // 7. 조회수 대비 판매 없는 상품
    const viewsNoSales = report.products.filter(p => p.views >= 10 && p.sold === 0);
    if (viewsNoSales.length > 0) {
      issues.push({
        severity: 'MEDIUM',
        type: 'VIEWS_NO_SALES',
        title: '조회는 있지만 판매 없음',
        description: `${viewsNoSales.length}개 상품이 10+ 조회이지만 판매 0건`,
        impact: '관심은 있으나 구매로 연결되지 않음',
        action: '가격 경쟁력 확인, 상세 이미지 개선, 할인/프로모션 적용',
        products: viewsNoSales.map(p => `${(p.name || '').substring(0, 35)} (views:${p.views})`)
      });
    }

    return issues;
  },

  // ══════════════════════════════════════
  // 점수 산출 (100점 만점)
  // ══════════════════════════════════════
  calculateScore(report) {
    let score = 100;

    // 제목 현지화 (-30점 max)
    score -= Math.max(0, (100 - report.titleAudit.localizationRate) * 0.3);

    // 키워드 매칭 (-30점 max)
    score -= Math.max(0, (100 - report.keywordAudit.matchRate) * 0.3);

    // Freshness (-15점 max)
    const freshRate = report.products.length > 0
      ? ((report.freshnessStatus.boosted + report.freshnessStatus.pending) / report.products.length * 100)
      : 0;
    score -= Math.max(0, (100 - freshRate) * 0.15);

    // 전환율 문제 (-15점 max)
    const convIssues = report.products.filter(p => p.l30d_impression >= 50 && p.l30d_sales === 0).length;
    score -= Math.min(15, convIssues * 3);

    // 판매 실적 보너스 (+10)
    if (report.summary.totalSold > 10) score = Math.min(100, score + 5);
    if (report.summary.totalSold > 50) score = Math.min(100, score + 5);

    return Math.max(0, Math.round(score));
  },

  // ══════════════════════════════════════
  // 유틸리티
  // ══════════════════════════════════════
  getSearchPercentage(report) {
    if (!report.traffic?.sources?.product_card?.breakdown) return null;
    const search = report.traffic.sources.product_card.breakdown.find(b =>
      b.source && b.source.includes('search')
    );
    return search ? search.sales_ratio * 100 : 0;
  },

  formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  },

  // 진행상황 업데이트 (background → popup 통신)
  async updateProgress(message, percent) {
    chrome.runtime.sendMessage({
      type: 'ANALYSIS_PROGRESS',
      message,
      percent
    }).catch(() => {});
  }
};

if (typeof module !== 'undefined') module.exports = ShopAnalyzer;
