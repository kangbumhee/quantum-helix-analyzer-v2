// lib/updater.js — Shopee API를 통한 상품 수정 엔진
const ShopeeUpdater = {
  async updateProduct(spcToken, shopId, region, productId, updateData, sellerDomain) {
    const domain = sellerDomain || "seller.shopee.kr";
    const url = `https://${domain}/api/v3/product/update_product_info?SPC_CDS=${spcToken}&SPC_CDS_VER=2&cnsc_shop_id=${shopId}&cbsc_shop_region=${region}`;
    const payload = { id: productId, ...updateData };

    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return response.json();
  },

  async executeBatchUpdate(spcToken, optimizationPlan, onProgress) {
    const plan = optimizationPlan || [];
    const results = { total: plan.length, success: 0, failed: 0, skipped: 0, details: [] };

    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];

      if (!item.approved) {
        results.skipped++;
        results.details.push({ ...item, status: "skipped" });
        if (onProgress) onProgress(i + 1, results.total, { ...item, status: "skipped" });
        continue;
      }

      try {
        if (i > 0) await this._delay(500);

        const settings = await this._getSettings();
        if (settings.autoBackup) {
          await this._saveBackup(item);
        }

        const updateData = {};
        if (item.newTitle) updateData.name = item.newTitle;
        if (item.newDescription) updateData.description = item.newDescription;

        const res = await this.updateProduct(
          spcToken, item.shopId, item.region, item.productId, updateData, item.sellerDomain
        );

        const ok = (res.code === 0 || res.message === "success" || !res.error);
        if (ok) {
          results.success++;
          results.details.push({ ...item, status: "success", response: res });
          await this._recordFreshness(item.productId, item.shopId);
        } else {
          results.failed++;
          results.details.push({ ...item, status: "failed", error: res.message || JSON.stringify(res) });
        }
      } catch (e) {
        results.failed++;
        results.details.push({ ...item, status: "error", error: e.message });
      }
      if (onProgress) onProgress(i + 1, results.total, results.details[results.details.length - 1]);
    }

    await this._saveHistory(results);
    return results;
  },

  async _getSettings() {
    return new Promise((r) => chrome.storage.local.get("optimizerSettings", (res) => r(res.optimizerSettings || {})));
  },

  async _saveBackup(item) {
    return new Promise((r) => {
      chrome.storage.local.get("productBackups", (res) => {
        const backups = res.productBackups || {};
        const key = `${item.shopId}_${item.productId}`;
        backups[key] = {
          originalTitle: item.originalTitle || item.productName,
          originalDescription: item.originalDescription || "",
          timestamp: Date.now()
        };
        chrome.storage.local.set({ productBackups: backups }, r);
      });
    });
  },

  async _recordFreshness(productId, shopId) {
    return new Promise((r) => {
      chrome.storage.local.get("freshnessHistory", (res) => {
        const h = res.freshnessHistory || {};
        if (!h[shopId]) h[shopId] = {};
        h[shopId][productId] = Date.now();
        chrome.storage.local.set({ freshnessHistory: h }, r);
      });
    });
  },

  async _saveHistory(results) {
    return new Promise((r) => {
      chrome.storage.local.get("updateHistory", (res) => {
        const history = res.updateHistory || [];
        history.unshift({
          timestamp: Date.now(),
          summary: {
            total: results.total,
            success: results.success,
            failed: results.failed,
            skipped: results.skipped
          }
        });
        if (history.length > 100) history.length = 100;
        chrome.storage.local.set({ updateHistory: history }, r);
      });
    });
  },

  async freshnessRotation(spcToken, products, shopConfig) {
    const settings = await this._getSettings();
    const limit = parseInt(settings.dailyFreshness, 10) || 7;
    const intervalDays = parseInt(settings.freshnessInterval, 10) || 7;
    const INTERVAL = intervalDays * 24 * 60 * 60 * 1000;

    const history = await new Promise((r) => {
      chrome.storage.local.get("freshnessHistory", (res) => r((res.freshnessHistory || {})[shopConfig.shopId] || {}));
    });

    const now = Date.now();
    const needsRefresh = (products || [])
      .map((p) => ({ ...p, lastUpdate: history[p.id] || 0 }))
      .filter((p) => (now - p.lastUpdate) > INTERVAL)
      .sort((a, b) => (b.statistics?.sold_count || 0) - (a.statistics?.sold_count || 0) || a.lastUpdate - b.lastUpdate);

    const toUpdate = needsRefresh.slice(0, limit);
    const results = [];

    for (const product of toUpdate) {
      await this._delay(500);
      const title = product.name || "";
      const refreshed = this._freshnessTitle(title);

      try {
        const res = await this.updateProduct(spcToken, shopConfig.shopId, shopConfig.region, product.id, { name: refreshed }, shopConfig.sellerDomain);
        const ok = (res.code === 0 || !res.error);
        results.push({ productId: product.id, name: title, status: ok ? "success" : "failed", newTitle: refreshed });
        if (ok) await this._recordFreshness(product.id, shopConfig.shopId);
      } catch (e) {
        results.push({ productId: product.id, name: title, status: "error", error: e.message });
      }
    }
    return { updated: results.filter((r) => r.status === "success").length, total: toUpdate.length, details: results };
  },

  _freshnessTitle(title) {
    if (title.endsWith(" ")) return title.trimEnd();
    if (title.includes("] ")) return title.replace("] ", "]");
    if (title.includes("]") && !title.includes("] ")) return title.replace("]", "] ");
    if (title.endsWith("\u200B")) return title.slice(0, -1);
    return title + "\u200B";
  },

  _delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
};

if (typeof window !== "undefined") window.ShopeeUpdater = ShopeeUpdater;
