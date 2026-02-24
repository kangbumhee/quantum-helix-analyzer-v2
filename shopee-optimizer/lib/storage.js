/*============================================================
  Chrome Storage Helper
  - 분석 결과 저장/로드
  - 스냅샷 히스토리 관리
============================================================*/

const StorageHelper = {

  // ── 분석 결과 저장 ──
  async saveReport(shopId, report) {
    const key = `report_${shopId}`;
    const historyKey = `history_${shopId}`;

    // 최신 리포트 저장
    await chrome.storage.local.set({ [key]: report });

    // 히스토리에 요약 추가 (최대 30일)
    const history = await this.get(historyKey) || [];
    history.push({
      date: new Date().toISOString(),
      score: report.score || 0,
      totalProducts: report.summary?.totalProducts || 0,
      totalViews: report.summary?.totalViews || 0,
      totalSold: report.summary?.totalSold || 0,
      localizationRate: report.titleAudit?.localizationRate || 0,
      keywordMatchRate: report.keywordAudit?.matchRate || 0,
      issueCount: report.issues?.length || 0
    });

    // 30일 초과분 제거
    while (history.length > 30) history.shift();
    await chrome.storage.local.set({ [historyKey]: history });
  },

  // ── 분석 결과 로드 ──
  async loadReport(shopId) {
    return this.get(`report_${shopId}`);
  },

  // ── 히스토리 로드 ──
  async loadHistory(shopId) {
    return this.get(`history_${shopId}`) || [];
  },

  // ── 모든 샵 리포트 로드 ──
  async loadAllReports() {
    const all = await chrome.storage.local.get(null);
    const reports = {};
    Object.keys(all).forEach(key => {
      if (key.startsWith('report_')) {
        reports[key.replace('report_', '')] = all[key];
      }
    });
    return reports;
  },

  // ── 설정 저장/로드 ──
  async saveSettings(settings) {
    await chrome.storage.local.set({
      optimizer_settings: settings,
      optimizerSettings: settings
    });
  },

  async loadSettings() {
    const result = await chrome.storage.local.get(['optimizer_settings', 'optimizerSettings']);
    return result.optimizer_settings || result.optimizerSettings || {
      autoAnalyzeInterval: 24, // hours
      freshnessRotationEnabled: false,
      productsPerDay: 7,
      notificationsEnabled: true
    };
  },

  // ── 유틸리티 ──
  async get(key) {
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  },

  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },

  async clear() {
    await chrome.storage.local.clear();
  }
};

if (typeof module !== 'undefined') module.exports = StorageHelper;
