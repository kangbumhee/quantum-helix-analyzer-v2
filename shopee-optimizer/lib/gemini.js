class GeminiOptimizer {
  constructor(apiKey, model = 'gemini-2.0-flash') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    this.maxRetries = 3;
    this.retryDelays = [15000, 30000, 60000];
  }

  async _callGemini(prompt) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(this.baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
          })
        });

        if (res.status === 429) {
          if (attempt < this.maxRetries) {
            await new Promise(r => setTimeout(r, this.retryDelays[attempt]));
            continue;
          }
          throw new Error('Rate limit exceeded');
        }

        if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);

        const json = await res.json();
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return this._parseJSON(text);
      } catch (e) {
        if (attempt === this.maxRetries) throw e;
        await new Promise(r => setTimeout(r, this.retryDelays[attempt] || 5000));
      }
    }
  }

  _parseJSON(text) {
    let cleaned = text.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    return JSON.parse(cleaned.trim());
  }

  _getLang(region) {
    const map = {
      KR: 'ko', ID: 'id', MY: 'ms', SG: 'en', TH: 'th',
      VN: 'vi', PH: 'en', TW: 'zh-TW', BR: 'pt', MX: 'es', CO: 'es', CL: 'es'
    };
    return map[region] || 'en';
  }

  _getLangName(region) {
    const map = {
      KR: '한국어', ID: 'Bahasa Indonesia', MY: 'Bahasa Melayu', SG: 'English',
      TH: 'ภาษาไทย', VN: 'Tiếng Việt', PH: 'English', TW: '繁體中文',
      BR: 'Português', MX: 'Español', CO: 'Español', CL: 'Español'
    };
    return map[region] || 'English';
  }

  _getLanguageExamples(region) {
    const map = {
      KR: ['여성 원피스', '남성 운동화', '아이폰 케이스'],
      ID: ['dress wanita', 'sepatu pria', 'case hp'],
      MY: ['baju wanita', 'kasut lelaki', 'sarung telefon'],
      TH: ['ชุดเดรสผู้หญิง', 'รองเท้าผู้ชาย', 'เคสโทรศัพท์'],
      VN: ['váy nữ', 'giày nam', 'ốp điện thoại'],
      TW: ['女洋裝', '男運動鞋', '手機殼'],
      BR: ['vestido feminino', 'tênis masculino', 'capa de celular'],
      MX: ['vestido mujer', 'tenis hombre', 'funda celular']
    };
    return map[region] || map['KR'];
  }

  _getLocalSellingPoints(region) {
    const map = {
      KR: '무료배송, 당일발송, 국내정품, 사은품 증정',
      ID: 'gratis ongkir, COD tersedia, garansi resmi',
      MY: 'free shipping, ready stock, warranty included',
      TH: 'ส่งฟรี, ของแท้ 100%, รับประกัน',
      VN: 'miễn phí vận chuyển, hàng chính hãng, bảo hành',
      TW: '免運費, 正品保證, 快速出貨',
      BR: 'frete grátis, produto original, garantia',
      MX: 'envío gratis, producto original, garantía'
    };
    return map[region] || '';
  }

  async classifyProducts(products) {
    const BATCH = 30;
    const categories = [
      'Fashion', 'Electronics', 'Home & Living', 'Beauty', 'Health',
      'Baby & Kids', 'Sports', 'Automotive', 'Food & Beverage', 'Others'
    ];

    for (let i = 0; i < products.length; i += BATCH) {
      const batch = products.slice(i, i + BATCH);
      const items = batch.map((p, idx) => ({
        index: i + idx,
        name: p.name || p.title || '',
        price: p.price || 0
      }));

      const prompt = `Classify each product into one of these categories: ${categories.join(', ')}.
Return JSON array: [{"index": number, "category": "string"}]
Products: ${JSON.stringify(items)}`;

      try {
        const classified = await this._callGemini(prompt);
        for (const c of classified) {
          const product = products[c.index];
          if (product) product._category = c.category;
        }
      } catch (e) {
        console.warn('Classification batch failed', e);
      }

      if (i + BATCH < products.length) await new Promise(r => setTimeout(r, 2000));
    }
    return products;
  }

  async extractSearchTerms(products, region) {
    const BATCH = 20;
    const lang = this._getLang(region);
    const langName = this._getLangName(region);
    const examples = this._getLanguageExamples(region);
    const allTerms = {};

    for (let i = 0; i < products.length; i += BATCH) {
      const batch = products.slice(i, i + BATCH);
      const items = batch.map((p, idx) => ({
        index: i + idx,
        name: p.name || p.title || '',
        category: p._category || 'Others'
      }));

      const prompt = `For each product, suggest 2-3 short search keywords in ${langName} (${lang}).
Examples: ${examples.join(', ')}
Return JSON array: [{"index": number, "keywords": ["kw1", "kw2"]}]
Products: ${JSON.stringify(items)}`;

      try {
        const result = await this._callGemini(prompt);
        for (const r of result) {
          allTerms[r.index] = r.keywords || [];
        }
      } catch (e) {
        console.warn('Search term extraction failed', e);
      }

      if (i + BATCH < products.length) await new Promise(r => setTimeout(r, 2000));
    }
    return allTerms;
  }

  async optimizeBatch(products, region) {
    const langName = this._getLangName(region);
    const sellingPoints = this._getLocalSellingPoints(region);

    const items = products.map(p => ({
      id: p.item_id || p.product_id || p.id,
      currentTitle: p.name || p.title || '',
      category: p._category || 'Others',
      suggestedKeywords: p.suggestedKeywords || [],
      topKeywords: (p.topKeywords || []).slice(0, 5).map(k => typeof k === 'string' ? k : k.keyword || k.name || ''),
      trendingKeywords: (p.trendingKeywords || []).slice(0, 5).map(k => typeof k === 'string' ? k : k.keyword || k.name || '')
    }));

    const prompt = `You are a Shopee product title and description optimizer.
Language: ${langName}
Local selling points: ${sellingPoints}

Rules for titles:
- Max 120 characters
- First 60 chars must contain the main keyword
- Use up to 3 relevant keywords
- Write in ${langName}

Rules for descriptions:
- 150-300 words in ${langName}
- Include product features, benefits, specifications
- Use local selling points naturally

For each product, generate optimized title and description.
Return JSON array: [{"id": number, "optimizedTitle": "string", "optimizedDescription": "string", "usedKeywords": ["kw1","kw2"]}]

Products: ${JSON.stringify(items)}`;

    try {
      return await this._callGemini(prompt);
    } catch (e) {
      console.error('Optimize batch failed', e);
      return [];
    }
  }
}

export { GeminiOptimizer };
