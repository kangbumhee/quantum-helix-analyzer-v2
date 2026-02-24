// lib/gemini.js — Gemini AI 범용 상품 최적화 엔진
// 하드코딩 카테고리 매핑 완전 제거, AI가 모든 카테고리를 자동 처리

class GeminiOptimizer {
  constructor(apiKey, model) {
    this.apiKey = apiKey;
    this.model = model || 'gemini-2.0-flash';
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    this.maxRetries = 2;
    this.retryDelays = [15000, 30000];
  }

  async _callGemini(prompt, retryCount = 0) {
    try {
      const resp = await fetch(`${this.baseUrl}?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json'
          }
        })
      });

      if (resp.status === 429 || resp.status === 503) {
        if (retryCount < this.maxRetries) {
          const delay = this.retryDelays[retryCount];
          console.warn(`Gemini rate limit, ${delay / 1000}s 후 재시도...`);
          await new Promise(r => setTimeout(r, delay));
          return this._callGemini(prompt, retryCount + 1);
        }
        throw new Error(`Gemini API rate limit (${this.maxRetries}회 재시도 실패)`);
      }

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Gemini API ${resp.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini 응답에 텍스트 없음');

      return this._parseJSON(text);
    } catch (e) {
      if (retryCount < this.maxRetries && e.message.includes('fetch')) {
        const delay = this.retryDelays[retryCount];
        await new Promise(r => setTimeout(r, delay));
        return this._callGemini(prompt, retryCount + 1);
      }
      throw e;
    }
  }

  _parseJSON(text) {
    let cleaned = String(text || '').trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    return JSON.parse(cleaned);
  }

  async classifyProducts(products) {
    const batchSize = 30;
    const allResults = [];

    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);

      const prompt = `You are a product classifier for Shopee e-commerce.

Given these product titles, classify EACH into exactly ONE category and ONE sub-category.

=== CATEGORY LIST ===
electronics: (phone, laptop, earbuds, charger, cable, speaker, camera, smartwatch, tablet, powerbank, keyboard, mouse, monitor, printer, router, usb, adapter, headphone, microphone, webcam, drone, console, game)
fashion: (shirt, dress, pants, jacket, skirt, hoodie, sweater, jeans, shorts, blouse, coat, suit, underwear, socks, scarf, hat, cap, belt, tie, gloves, uniform, swimwear, pajamas, legging, cardigan)
beauty: (lipstick, foundation, mascara, eyeshadow, blush, concealer, primer, serum, moisturizer, cleanser, toner, sunscreen, mask_beauty, cream, lotion, perfume, nail_polish, makeup_brush, puff, eyeliner, lip_tint, powder, skincare_set, essence, sleeping_mask)
home_living: (curtain, pillow_home, blanket, rug, carpet, shelf, lamp, vase, frame, clock_home, organizer, hanger, hook, drawer, mirror, candle, diffuser, decoration, bedsheet, mattress, sofa_cover, cushion_cover, storage_box, laundry_basket, trash_can)
kitchen: (plate, bowl, cup, mug, spoon, fork, chopstick, knife_kitchen, cutting_board, pot, pan, kettle, bottle, tumbler, thermos, lunch_box, bento, container, spatula, ladle, whisk, tray, pitcher, glass, coaster, placemat, apron, oven_mitt, food_wrap, water_bottle, straw)
stationery: (pen, pencil, eraser, ruler, notebook, sticker, tape, marker, highlighter, scissors, glue, stapler, paper, envelope, stamp, memo_pad, file_folder, pencil_case, correction_tape, crayon, color_pencil, brush_pen, washi_tape, label, letter_set, diary, planner, ink, refill, sharpener, clip, pin)
toys_games: (plush_doll, figure, action_figure, puzzle, board_game, card_game, building_blocks, remote_control_toy, doll, toy_car, stuffed_animal, ball, toy_gun, slime, fidget, rubiks_cube, yo_yo, kite, model_kit, toy_set)
bags_wallets: (backpack, handbag, tote_bag, crossbody_bag, shoulder_bag, clutch, wallet, coin_purse, pouch, sling_bag, drawstring_bag, travel_bag, laptop_bag, gym_bag, fanny_pack, card_holder, money_clip, cosmetic_bag, pencil_pouch, string_pouch, makeup_bag)
accessories: (keychain, hair_clip, hair_band, scrunchie, ring, necklace, bracelet, earring, brooch, pin_accessory, watch_strap, phone_case, bag_charm, hair_tie, headband, barrette, choker, anklet, cufflink, tiara, bow, ribbon)
health: (vitamin, supplement, thermometer, blood_pressure, mask_health, bandage, first_aid, essential_oil, inhaler, pain_relief, eye_drop, probiotics)
sports: (yoga_mat, dumbbell, resistance_band, jump_rope, water_bottle_sport, gym_gloves, knee_brace, cycling, running_shoes, swim_goggles, badminton, football, basketball, tennis)
pet: (pet_food, pet_toy, pet_bed, leash, collar, pet_bowl, pet_shampoo, cat_litter, aquarium, bird_cage, pet_carrier, pet_clothes)
baby: (diaper, baby_bottle, pacifier, bib, baby_clothes, stroller, car_seat, baby_toy, teether, baby_food, baby_lotion, baby_wipe)
food: (snack, candy, chocolate, cookie, noodle, rice, sauce, spice, tea, coffee_food, drink, dried_fruit, nut, cereal, honey, jam)
automotive: (car_mount, car_charger, dash_cam, car_cover, car_mat, air_freshener_car, car_wash, led_car, wiper, tire)
digital_goods: (gift_card, software, game_code, subscription, ebook)

=== PRODUCTS ===
${batch.map((p, idx) => `${i + idx}: "${p.title || p.name || ''}"`).join('\n')}

=== RULES ===
1. Return ONLY a JSON array, no other text
2. Every product MUST have exactly one category and one sub from the lists above
3. If uncertain, pick the CLOSEST match — never use "other" if any category fits
4. "other" is only for products that genuinely fit nowhere

=== RESPONSE FORMAT ===
[{"index":${i},"category":"stationery","sub":"pen"},{"index":${i + 1},"category":"kitchen","sub":"tumbler"}]`;

      const result = await this._callGemini(prompt);
      allResults.push(...result);

      if (i + batchSize < products.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    return allResults;
  }

  async extractSearchTerms(products, classifications, region) {
    const lang = this._getLang(region);
    const batchSize = 20;
    const allTerms = {};

    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      const prompt = `You are a Shopee keyword researcher for ${region} market.

For each product, extract 2-3 SHORT search terms that a real ${region} Shopee buyer would type.
Terms MUST be in ${lang} language.
Terms must be generic product-type words, NOT brand names.

=== PRODUCTS ===
${batch.map((p, idx) => {
  const globalIdx = i + idx;
  const cls = classifications.find(c => c.index === globalIdx);
  return `${globalIdx}: "${p.title || p.name || ''}" [category: ${cls?.category}/${cls?.sub}]`;
}).join('\n')}

=== RULES ===
1. Each term should be 1-3 words that buyers actually search
2. Use LOCAL language: ${this._getLanguageExamples(region)}
3. Do NOT include brand names
4. Return ONLY JSON object

=== RESPONSE FORMAT ===
{"${i}":["term1","term2"],"${i + 1}":["term1","term2","term3"]}`;

      const result = await this._callGemini(prompt);
      for (const [key, val] of Object.entries(result)) {
        allTerms[key] = val;
      }

      if (i + batchSize < products.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    return allTerms;
  }

  async optimizeBatch(batch, classifications, keywordsMap, region, onProgress) {
    const lang = this._getLang(region);
    const langName = this._getLangName(region);

    const productEntries = batch.map((product) => {
      const cls = classifications.find(c => c.index === product._globalIndex) || { category: 'other', sub: 'other' };
      const keywords = keywordsMap[product._globalIndex] || [];
      return `
--- PRODUCT ${product._globalIndex} ---
Title: "${product.title || product.name || ''}"
Category: ${cls.category}/${cls.sub}
Shopee Suggested Keywords: ${keywords.length > 0
  ? keywords.map(k => `"${k.keyword}"${k.volume ? ` (${k.volume})` : ''}`).join(', ')
  : 'NONE FOUND'}`;
    }).join('\n');

    const prompt = `You are the #1 Shopee SEO expert for ${region} (${langName}).

=== YOUR TASK ===
Optimize each product's title and description for Shopee ${region} search.

=== PRODUCTS ===${productEntries}

=== TITLE RULES (CRITICAL — violating any = failure) ===
1. Title MUST be in ${langName} (${lang})
2. Title MUST be ≤ 120 characters total
3. Put the MOST important keyword within the FIRST 60 characters
4. KEEP all original info: brand name [BRAND], size, color, capacity, quantity, material
5. ONLY use keywords from "Shopee Suggested Keywords" above
6. If NO keywords were found, just improve the title structure/language
7. Do NOT add keywords that don't match the product
8. Maximum 3 keywords per title, naturally integrated

=== DESCRIPTION RULES ===
1. Write in ${langName} (${lang}), 150-300 words
2. First paragraph: what the product is + primary keyword
3. Include: material, dimensions/capacity, use case, care instructions (if applicable)
4. Include "Made in Korea" or origin if the original title suggests it
5. DO NOT use the same template for every product
6. For ${region} market, mention: ${this._getLocalSellingPoints(region)}

=== RESPONSE FORMAT (JSON array) ===
[{
  "index": 0,
  "originalTitle": "original title here",
  "optimizedTitle": "optimized title in ${lang}",
  "description": "full description in ${lang}",
  "usedKeywords": ["keyword1", "keyword2"],
  "reasoning": "한국어로 왜 이 키워드를 선택했는지 설명"
}]`;

    return this._callGemini(prompt);
  }

  _getLang(region) {
    const map = {
      'SG': 'en', 'MY': 'en', 'PH': 'en',
      'TW': 'zh-TW', 'TH': 'th', 'VN': 'vi',
      'BR': 'pt-BR', 'MX': 'es-MX', 'ID': 'id',
      'CL': 'es-CL', 'CO': 'es-CO', 'PL': 'pl'
    };
    return map[String(region || '').toUpperCase()] || 'en';
  }

  _getLangName(region) {
    const map = {
      'SG': 'English', 'MY': 'English/Malay', 'PH': 'English/Filipino',
      'TW': '繁體中文', 'TH': 'ภาษาไทย', 'VN': 'Tiếng Việt',
      'BR': 'Português', 'MX': 'Español', 'ID': 'Bahasa Indonesia',
      'CL': 'Español', 'CO': 'Español', 'PL': 'Polski'
    };
    return map[String(region || '').toUpperCase()] || 'English';
  }

  _getLanguageExamples(region) {
    const map = {
      'SG': 'e.g., "water bottle", "cute sticker", "gel pen"',
      'MY': 'e.g., "botol air", "beg tangan", "tuala mandi"',
      'PH': 'e.g., "bag for women", "cute notebook", "tumbler"',
      'TW': 'e.g., "保溫杯", "貼紙", "鑰匙圈"',
      'TH': 'e.g., "แก้วเก็บความเย็น", "กระเป๋า", "สติกเกอร์"',
      'VN': 'e.g., "bình giữ nhiệt", "túi xách", "bút gel"',
      'BR': 'e.g., "garrafa térmica", "adesivo", "bolsa feminina"',
      'MX': 'e.g., "botella térmica", "sticker decorativo", "bolsa de mano"',
      'ID': 'e.g., "botol minum", "tas selempang", "stiker lucu"'
    };
    return map[String(region || '').toUpperCase()] || 'use local language terms buyers actually search';
  }

  _getLocalSellingPoints(region) {
    const map = {
      'SG': 'fast delivery, authentic/original, Made in Korea premium',
      'MY': 'penghantaran percuma, harga berpatutan, Ready Stock Malaysia',
      'PH': 'COD available, free shipping, authentic, fast delivery',
      'TW': '台灣現貨, 韓國直送, 免運費, 正品保證',
      'TH': 'ส่งจากไทย, ของแท้, จัดส่งเร็ว, สินค้าพร้อมส่ง',
      'VN': 'hàng chính hãng, giao hàng nhanh, freeship, sẵn hàng',
      'BR': 'frete grátis, pronta entrega, produto importado da Coreia',
      'MX': 'envío gratis, producto importado, disponible, original',
      'ID': 'gratis ongkir, ready stock, original Korea, COD tersedia'
    };
    return map[String(region || '').toUpperCase()] || 'fast shipping, authentic product';
  }
}

if (typeof self !== 'undefined') {
  self.GeminiOptimizer = GeminiOptimizer;
}
if (typeof window !== 'undefined') {
  window.GeminiOptimizer = GeminiOptimizer;
}
if (typeof module !== 'undefined') module.exports = GeminiOptimizer;
