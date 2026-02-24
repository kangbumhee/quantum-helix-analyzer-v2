const ShopeeUpdater = {
  async updateProduct(spcToken, shopId, region, productId, updateData, sellerDomain) {
    const url = `https://${sellerDomain}/api/v3/product/update_product`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `SPC_CDS=${spcToken}`
      },
      credentials: 'include',
      body: JSON.stringify({
        shop_id: shopId,
        item_id: productId,
        ...updateData
      })
    });
    return res.json();
  },

  async executeBatchUpdate(spcToken, plan, onProgress) {
    const settings = await this._getSettings();
    const results = { success: 0, failed: 0, skipped: 0, details: [] };

    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      if (item.skip) {
        results.skipped++;
        results.details.push({ id: item.id, status: 'skipped' });
        continue;
      }

      try {
        if (settings.autoBackup) {
          await this._saveBackup(item.id, item.originalData);
        }

        const payload = {};
        if (item.title) payload.name = item.title;
        if (item.description) payload.description = item.description;

        const store = await chrome.storage.local.get(['sellerDomain', 'region']);
        await this.updateProduct(spcToken, item.shopId, store.region, item.id, payload, store.sellerDomain);

        results.success++;
        results.details.push({ id: item.id, status: 'success' });
      } catch (e) {
        results.failed++;
        results.details.push({ id: item.id, status: 'failed', error: e.message });
      }

      if (onProgress) {
        onProgress({ current: i + 1, total: plan.length, ...results });
      }

      await this._delay(500);
    }

    await this._saveHistory(results);
    return results;
  },

  async freshnessRotation(spcToken, products, shopConfig) {
    const settings = await this._getSettings();
    const limit = shopConfig?.productsPerDay || settings.productsPerDay || 7;
    const intervalDays = shopConfig?.rotationInterval || 7;

    const candidates = products.filter(p => {
      const days = p._daysSinceModify || 999;
      return days > intervalDays;
    }).slice(0, limit);

    const results = { updated: 0, products: [] };

    for (const product of candidates) {
      try {
        const newTitle = this._freshnessTitle(product.name || product.title || '');
        const store = await chrome.storage.local.get(['sellerDomain', 'region']);
        await this.updateProduct(
          spcToken, product.shop_id, store.region,
          product.item_id || product.id,
          { name: newTitle },
          store.sellerDomain
        );
        results.updated++;
        results.products.push({ id: product.item_id || product.id, newTitle });
      } catch (e) {
        console.warn('Freshness rotation failed for', product.item_id, e);
      }
      await this._delay(500);
    }

    await this._recordFreshness(results);
    return results;
  },

  _freshnessTitle(title) {
    const zws = '\u200B';
    if (title.includes(zws)) {
      return title.replace(new RegExp(zws, 'g'), '');
    }
    return title + zws;
  },

  async _getSettings() {
    const data = await chrome.storage.local.get(['optimizer_settings', 'optimizerSettings']);
    return data.optimizer_settings || data.optimizerSettings || {};
  },

  async _saveBackup(productId, originalData) {
    const key = `backup_${productId}`;
    await chrome.storage.local.set({
      [key]: { ...originalData, backedUpAt: new Date().toISOString() }
    });
  },

  async _recordFreshness(results) {
    await chrome.storage.local.set({
      lastFreshnessRun: {
        date: new Date().toISOString(),
        updated: results.updated
      }
    });
  },

  async _saveHistory(results) {
    const data = await chrome.storage.local.get('updateHistory');
    const history = data.updateHistory || [];
    history.unshift({
      date: new Date().toISOString(),
      success: results.success,
      failed: results.failed,
      skipped: results.skipped
    });
    if (history.length > 50) history.length = 50;
    await chrome.storage.local.set({ updateHistory: history });
  },

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
};

export { ShopeeUpdater };
