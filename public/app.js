document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('product-grid');
  const template = document.getElementById('card-template');
  const lastUpdateEl = document.getElementById('last-update');
  const btnRefresh = document.getElementById('btn-refresh');
  const filterTabsContainer = document.getElementById('filter-tabs');
  
  let currentData = [];
  let currentFilter = 'all';

  // Format date safely
  function formatTime(isoString) {
    if (!isoString) return '未曾检测';
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute:'2-digit', second:'2-digit' });
    } catch {
      return isoString;
    }
  }

  function parsePriceNumber(priceText) {
    if (!priceText) return null;
    const match = String(priceText).replace(/,/g, '').match(/\$(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) : null;
  }

  function formatDiscount(basePrice, currentPrice) {
    if (!basePrice || !currentPrice || currentPrice <= 0 || currentPrice >= basePrice) return null;
    const discount = ((basePrice - currentPrice) / basePrice) * 100;
    return `-${discount.toFixed(2)}%`;
  }

  function buildBillingCyclesHtml(product) {
    const cycles = product.billingCycles;
    if (!cycles || typeof cycles !== 'object') return '';

    const cycleMeta = [
      ['semiAnnually', '半年缴'],
      ['annually', '年缴'],
      ['biennially', '两年缴'],
      ['triennially', '三年缴']
    ];

    const basePrice = parsePriceNumber(cycles.semiAnnually || product.price);
    const items = cycleMeta
      .filter(([key]) => cycles[key])
      .map(([key, label]) => {
        const currentPrice = parsePriceNumber(cycles[key]);
        const discount = formatDiscount(basePrice, currentPrice);
        const isBase = key === 'semiAnnually';
        return `
          <div class="billing-cycle-item${isBase ? ' is-base' : ''}">
            <span class="billing-cycle-label">${label}</span>
            <span class="billing-cycle-price">${cycles[key]}</span>
            ${discount ? `<span class="billing-cycle-discount">${discount}</span>` : ''}
          </div>
        `;
      });

    if (items.length === 0) return '';

    return `
      <div class="billing-cycles-header">缴费年限价格</div>
      <div class="billing-cycles-grid">${items.join('')}</div>
    `;
  }

  // Render cards based on current data and filter
  function renderCards() {
    grid.innerHTML = '';
    
    // Filter data
    let filtered = currentData;
    if (currentFilter === 'special') {
      filtered = currentData.filter(p => p.isSpecialOffer === true);
    } else if (currentFilter !== 'all') {
      filtered = currentData.filter(p => p.provider === currentFilter);
    }
      
    if (filtered.length === 0) {
      grid.innerHTML = '<div class="loading-state">暂无符合条件的商品</div>';
      return;
    }

    let cardIndex = 0;

    if (currentFilter === 'special') {
      // 在“特价VPS”下按商家分组显示
      const grouped = {};
      filtered.forEach(p => {
        const prov = p.providerName || '其他';
        if (!grouped[prov]) grouped[prov] = [];
        grouped[prov].push(p);
      });

      // 对特价区商家进行过滤与排位：仅展示高优商家，或将杂牌沉底
      const priority = ['DMIT', '搬瓦工', 'RackNerd', 'GreenCloud', 'ColoCrossing', 'ZGO Cloud'];
      const sortedProviders = Object.keys(grouped).sort((a, b) => {
        const idxA = priority.indexOf(a);
        const idxB = priority.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });

      // 在特价区首部增加一个商家快捷电梯导航（仅在特价区显示），替代全局搜索框
      const jumpNav = document.createElement('div');
      jumpNav.className = 'special-jump-nav';
      jumpNav.style.cssText = 'grid-column: 1 / -1; display:flex; gap:10px; flex-wrap:wrap; margin-bottom: 20px;';
      
      const navTitle = document.createElement('span');
      navTitle.textContent = '🧭 快速直达:';
      navTitle.style.cssText = 'font-weight:bold; color:var(--text-muted); line-height:30px;';
      jumpNav.appendChild(navTitle);

      sortedProviders.forEach(providerName => {
        const btn = document.createElement('button');
        btn.className = 'tab-btn';
        btn.style.cssText = 'padding: 4px 12px; font-size: 0.85rem; border-radius: 6px;';
        btn.textContent = `${providerName} (${grouped[providerName].length})`;
        btn.onclick = () => {
          document.getElementById('provider-' + providerName).scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
        jumpNav.appendChild(btn);
      });
      grid.appendChild(jumpNav);

      sortedProviders.forEach(providerName => {
        // 添加商家分组标题
        const header = document.createElement('div');
        header.className = 'provider-group-header';
        header.id = 'provider-' + providerName;
        header.innerHTML = `<span class="provider-group-badge">${grouped[providerName].length}</span> ${providerName} 特价专区`;
        grid.appendChild(header);

        // 按活动名称正则提取二级分组
        const eventGrouped = {};
        grouped[providerName].forEach(p => {
          // 匹配任何全角或半角括号里的内容
          const match = p.name.match(/[(（]([^)）]+)[)）]/g);
          let eventName = '常规特惠';
          if (match && match.length > 0) {
            eventName = match[match.length - 1].replace(/[()（）]/g, '').trim();
          }
          if (!eventGrouped[eventName]) eventGrouped[eventName] = [];
          eventGrouped[eventName].push(p);
        });

        // 排序：有明确活动的排前，"常规特惠" 沉底
        const eventNames = Object.keys(eventGrouped).sort((a,b) => {
          if (a === '常规特惠') return 1;
          if (b === '常规特惠') return -1;
          return a.localeCompare(b);
        });

        eventNames.forEach(evt => {
          // 渲染二级分类标题（如果全是常规特惠，则不渲染以保持简洁）
          if (eventNames.length > 1 || evt !== '常规特惠') {
            const subHeader = document.createElement('div');
            subHeader.className = 'event-group-subheader';
            subHeader.style.cssText = 'grid-column: 1 / -1; font-size: 0.95rem; font-weight: 600; color: var(--text-muted); margin-top: 12px; margin-bottom: -4px; padding-left: 8px; border-left: 3px solid var(--acc-blue); display: flex; align-items: center; gap: 8px; line-height: 1.2;';
            subHeader.innerHTML = `🏷️ ${evt} <span style="font-size:0.8rem; font-weight:normal; opacity:0.8;">(${eventGrouped[evt].length})</span>`;
            grid.appendChild(subHeader);
          }
          
          // 渲染卡片
          eventGrouped[evt].forEach(product => {
            renderSingleCard(product, cardIndex++);
          });
        });
      });
    } else {
      // 其他标签页正常直接显示
      filtered.forEach(product => {
        renderSingleCard(product, cardIndex++);
      });
    }
  }

  function renderSingleCard(product, index = 0) {
    const clone = template.content.cloneNode(true);

    // 给卡片根节点打上 data-product-id，供增量更新定位
    const firstElement = clone.firstElementChild;
    if (firstElement) {
      firstElement.dataset.productId = product.id;
      // 每张卡片延迟递增 50ms (最大 500ms 封顶，加快体感渲染)
      const delay = Math.min(index * 50, 500);
      firstElement.style.animationDelay = `${delay}ms`;
    }

    clone.querySelector('.provider-badge').textContent = product.providerName;
    clone.querySelector('.product-name').textContent = product.name;
    clone.querySelector('.product-price').textContent = product.price;

    const billingCyclesBox = clone.querySelector('.billing-cycles');
    const billingCyclesHtml = buildBillingCyclesHtml(product);
    if (billingCyclesHtml) {
      billingCyclesBox.hidden = false;
      billingCyclesBox.innerHTML = billingCyclesHtml;
    } else {
      billingCyclesBox.hidden = true;
      billingCyclesBox.innerHTML = '';
    }

    // Handle specs block
    clone.querySelector('.dc-val').textContent = (product.datacenters || []).join(', ');
    
    // Fallback in case specs object is missing
    const sp = product.specs || {};
    clone.querySelector('.cpu-val').textContent = `${sp.cpu || '?'} / ${sp.ram || '?'}`;
    clone.querySelector('.disk-val').textContent = sp.disk || '?';
    clone.querySelector('.bw-val').textContent = `${sp.bandwidth || '?'} / ${sp.port || '?'}`;
    
    // Render tags below title
    const routingTagsBox = clone.querySelector('.routing-tags');
    const allTags = product.networkRoutes || [];
    routingTagsBox.innerHTML = allTags.map(tag => {
      let cssClass = 'tag-normal';
      if (tag.includes('CN2 GIA') || tag.includes('9929') || tag.includes('CMIN2')) cssClass = 'tag-premium';
      if (tag.includes('优化') || tag.includes('软银')) cssClass = 'tag-optimized';
      return `<span class="pill-tag ${cssClass}">${tag}</span>`;
    }).join('');

    const statusContainer = clone.querySelector('.stock-status');
    const buyBtn = clone.querySelector('.btn-buy');
    
    // Setup stock status UI
    if (product.inStock === true) {
      statusContainer.innerHTML = `<span class="status-badge in-stock">✅ 有货</span>`;
      buyBtn.classList.add('active');
      buyBtn.href = product.affUrl || product.checkUrl;
      buyBtn.textContent = '🛒 立即购买';
      buyBtn.style.pointerEvents = 'auto';
    } else if (product.inStock === null) {
      statusContainer.innerHTML = `<span class="status-badge checking">⏳ 检测中</span>`;
      buyBtn.classList.remove('active');
      buyBtn.textContent = '检测中...';
      buyBtn.href = '#';
      buyBtn.style.pointerEvents = 'none';
    } else {
      const errorMsg = product.statusMessage && product.statusMessage.startsWith('Error') ? '探测异常' : '缺货状态';
      statusContainer.innerHTML = `<span class="status-badge oos">❌ ${errorMsg}</span>`;
      buyBtn.classList.remove('active');
      buyBtn.textContent = '暂时缺货';
      buyBtn.href = '#';
      buyBtn.style.pointerEvents = 'none';
    }
    
    // Setup tools
    const speedtest = clone.querySelector('.test-link');
    speedtest.href = `speedtest.html?id=${encodeURIComponent(product.id)}`;
    speedtest.title = '打开站内测速页';

    // 显示优惠码提示
    if (product.promoCode) {
      const promoEl = document.createElement('div');
      promoEl.className = 'promo-code-tip';
      promoEl.innerHTML = `🎫 优惠码：<code class="promo-code" title="点击复制">${product.promoCode}</code>`;
      promoEl.querySelector('.promo-code').addEventListener('click', (e) => {
        navigator.clipboard.writeText(product.promoCode).then(() => {
          e.target.textContent = '已复制 ✓';
          setTimeout(() => { e.target.textContent = product.promoCode; }, 1500);
        });
      });
      buyBtn.parentNode.insertBefore(promoEl, buyBtn.nextSibling);
    }
    
    grid.appendChild(clone);
  }

  // Render filter tabs
  function renderFilters(providers) {
    // Keep 'all' tab if it exists
    const allTab = `<button class="tab-btn ${currentFilter === 'all' ? 'active' : ''}" data-provider="all">全部</button>`;
    const specialTab = `<button class="tab-btn special-offer-tab ${currentFilter === 'special' ? 'active' : ''}" data-provider="special">🔥 特价VPS</button>`;
    
    let tabsHtml = allTab + specialTab;
    providers.forEach(p => {
      const isActive = currentFilter === p.id ? 'active' : '';
      tabsHtml += `<button class="tab-btn ${isActive}" data-provider="${p.id}">${p.name}</button>`;
    });
    
    filterTabsContainer.innerHTML = tabsHtml;
    
    // Add event listeners to tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        currentFilter = e.target.getAttribute('data-provider');
        
        // Update styling
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        
        renderCards();
      });
    });
  }

  // ── 增量更新：只更新单张卡片的库存状态，不重绘整个列表 ──
  function patchCardStock(product) {
    // 找到已经渲染在 DOM 里的对应卡片
    const card = grid.querySelector(`[data-product-id="${product.id}"]`);
    if (!card) return; // 该产品不在当前视图里（被筛选掉了），忽略

    const statusContainer = card.querySelector('.stock-status');
    const buyBtn = card.querySelector('.btn-buy');
    if (!statusContainer || !buyBtn) return;

    if (product.inStock === true) {
      statusContainer.innerHTML = `<span class="status-badge in-stock">✅ 有货</span>`;
      buyBtn.classList.add('active');
      buyBtn.href = product.affUrl || product.checkUrl;
      buyBtn.textContent = '🛒 立即购买';
      buyBtn.style.pointerEvents = 'auto';
      // 补货瞬间短暂高亮
      card.style.transition = 'box-shadow 0.3s ease';
      card.style.boxShadow = '0 0 0 2px var(--acc-green, #22c55e)';
      setTimeout(() => { card.style.boxShadow = ''; }, 3000);
    } else if (product.inStock === null) {
      statusContainer.innerHTML = `<span class="status-badge checking">⏳ 检测中</span>`;
      buyBtn.classList.remove('active');
      buyBtn.textContent = '检测中...';
      buyBtn.href = '#';
      buyBtn.style.pointerEvents = 'none';
    } else {
      const errorMsg = product.statusMessage?.startsWith('Error') ? '探测异常' : '缺货状态';
      statusContainer.innerHTML = `<span class="status-badge oos">❌ ${errorMsg}</span>`;
      buyBtn.classList.remove('active');
      buyBtn.textContent = '暂时缺货';
      buyBtn.href = '#';
      buyBtn.style.pointerEvents = 'none';
    }

    // 同步内存数据
    const idx = currentData.findIndex(p => p.id === product.id);
    if (idx !== -1) {
      currentData[idx] = { ...currentData[idx], ...product };
    }
  }

  // ── Fetch data from backend（全量拉取，用于初始化和手动刷新） ──
  async function fetchData() {
    try {
      btnRefresh.textContent = '刷新中...';
      btnRefresh.disabled = true;

      const [provRes, res] = await Promise.all([
        fetch('/api/vps/providers'),
        fetch('/api/vps/stock'),
      ]);
      const [provJson, json] = await Promise.all([provRes.json(), res.json()]);

      if (provJson.success) renderFilters(provJson.data);

      if (json.success) {
        currentData = json.data;
        currentData.sort((a,b) => (a.priority === 'high' ? -1 : 1));
        lastUpdateEl.textContent = `最后更新: ${formatTime(new Date().toISOString())}`;
        renderCards();
      } else {
        throw new Error(json.error || 'Server error');
      }
    } catch (e) {
      grid.innerHTML = `<div class="loading-state">获取状态失败，请稍后刷新重试: ${e.message}</div>`;
    } finally {
      btnRefresh.textContent = '立即刷新';
      btnRefresh.disabled = false;
    }
  }

  // ── SSE 实时推送：零延迟接收库存变化 ──
  let sseRetryTimer = null;

  function connectSSE() {
    if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
    const es = new EventSource('/api/sse');

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);

        if (msg.type === 'ping') return; // 保活帧，忽略

        if (msg.type === 'init') {
          // 初始快照：用 SSE 返回的数据替代 fetch 初始化
          currentData = msg.data.filter(p => !p.isHidden);
          currentData.sort((a,b) => (a.priority === 'high' ? -1 : 1));

          // 同时刷新 provider tabs（显示全部商家，不限有货）
          const providerMap = {};
          currentData.forEach(p => {
            providerMap[p.provider] = p.providerName;
          });
          renderFilters(Object.entries(providerMap).map(([id, name]) => ({ id, name })));

          renderCards();
          lastUpdateEl.textContent = `已连接实时推送`;

        } else if (msg.type === 'stock_update') {
          // 增量更新：只更新这一张卡片
          patchCardStock(msg.product);
          lastUpdateEl.textContent = `实时: ${formatTime(new Date().toISOString())}`;

        } else if (msg.type === 'cycle_done') {
          lastUpdateEl.textContent = `上次扫描: ${formatTime(msg.ts)} (${msg.checked}/${msg.total})`;
        }
      } catch (_) {}
    };

    es.onerror = () => {
      es.close();
      // SSE 断开后 5 秒重连，重连后 init 事件会自动刷新数据，不需要额外 fetchData
      sseRetryTimer = setTimeout(connectSSE, 5000);
    };
  }

  // ── Initialization ──
  connectSSE(); // 优先走 SSE 实时通道

  // SSE 超时兜底：连接建立 3 秒后如果仍无数据，回退到普通 fetch
  setTimeout(() => {
    if (currentData.length === 0) fetchData();
  }, 3000);

  // 2 分钟兜底轮询（防止 SSE 数据由于网络断开导致不更新）
  setInterval(() => {
    fetchData(); // 强制每2分钟刷新一次，保持和UI文案一致
  }, 2 * 60 * 1000);

  // Manual refresh（始终走全量拉取，用于用户主动刷新）
  btnRefresh.addEventListener('click', fetchData);
});
