const StorageHelper = {
  async saveReport(shopId, report) {
    if (!shopId || !report) return;
    const key = `report_${shopId}`;
    await chrome.storage.local.set({ [key]: report });

    const histKey = `history_${shopId}`;
    const data = await chrome.storage.local.get(histKey);
    const history = data[histKey] || [];
    history.unshift({
      date: report.analyzedAt || new Date().toISOString(),
      score: report.score || 0,
      totalProducts: report.summary?.totalProducts || 0,
      totalViews: report.summary?.totalViews || 0,
      totalSold: report.summary?.totalSold || 0,
      localizationRate: report.summary?.localizationRate || 0,
      keywordMatchRate: report.summary?.keywordMatchRate || 0,
      issueCount: (report.issues || []).length
    });
    if (history.length > 30) history.length = 30;
    await chrome.storage.local.set({ [histKey]: history });
  },

  async loadReport(shopId) {
    const data = await chrome.storage.local.get(`report_${shopId}`);
    return data[`report_${shopId}`] || null;
  },

  async loadHistory(shopId) {
    const data = await chrome.storage.local.get(`history_${shopId}`);
    return data[`history_${shopId}`] || [];
  },

  async loadAllReports() {
    const all = await chrome.storage.local.get(null);
    const reports = {};
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith('report_')) {
        reports[key.replace('report_', '')] = value;
      }
    }
    return reports;
  },

  async saveSettings(settings) {
    await chrome.storage.local.set({
      optimizer_settings: settings,
      optimizerSettings: settings
    });
  },

  async loadSettings() {
    const data = await chrome.storage.local.get(['optimizer_settings', 'optimizerSettings']);
    const s = data.optimizer_settings || data.optimizerSettings || {};
    return {
      autoAnalyzeInterval: s.autoAnalyzeInterval ?? 24,
      freshnessRotationEnabled: s.freshnessRotationEnabled ?? false,
      productsPerDay: s.productsPerDay ?? 7,
      notificationsEnabled: s.notificationsEnabled ?? true,
      geminiKey: s.geminiKey ?? '',
      geminiModel: s.geminiModel ?? 'gemini-2.0-flash',
      maxTitleLength: s.maxTitleLength ?? 120,
      keywordPosition: s.keywordPosition ?? 'front',
      keepBrand: s.keepBrand ?? 'always',
      approvalRequired: s.approvalRequired ?? true,
      autoBackup: s.autoBackup ?? true,
      ...s
    };
  },

  async get(key) {
    const data = await chrome.storage.local.get(key);
    return data[key];
  },

  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },

  async clear() {
    await chrome.storage.local.clear();
  }
};

export { StorageHelper };
