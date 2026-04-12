document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('product-grid');
  const template = document.getElementById('card-template');
  const lastUpdateEl = document.getElementById('last-update');
  const btnRefresh = document.getElementById('btn-refresh');
  const filterTabsContainer = document.getElementById('filter-tabs');
  const searchInput = document.getElementById('search-input');
  
  let currentData = [];
  let currentFilter = 'all';

  // 监听搜索输入
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderCards();
    });
  }

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

  // Render cards based on current data and filter
  function renderCards() {
    grid.innerHTML = '';
    
    // Filter data
    let filtered = currentData;
    
    // Search filter
    if (searchInput && searchInput.value) {
      const qs = searchInput.value.toLowerCase().trim();
      filtered = filtered.filter(p => {
        const title = (p.name || '').toLowerCase();
        const prov = (p.providerName || '').toLowerCase();
        const dcs = (p.datacenters || []).join(' ').toLowerCase();
        const routes = (p.networkRoutes || []).join(' ').toLowerCase();
        const sp = p.specs || {};
        const specsStr = Object.values(sp).join(' ').toLowerCase();
        const price = (p.price || '').toLowerCase();
        
        return title.includes(qs) || prov.includes(qs) || dcs.includes(qs) || 
               routes.includes(qs) || specsStr.includes(qs) || price.includes(qs);
      });
    }

    if (currentFilter === 'special') {
      filtered = filtered.filter(p => p.isSpecialOffer === true);
    } else if (currentFilter !== 'all') {
      filtered = filtered.filter(p => p.provider === currentFilter);
    }
      
    if (filtered.length === 0) {
      grid.innerHTML = '<div class="loading-state">暂无符合条件的商品</div>';
      return;
    }

    if (currentFilter === 'special') {
      // 在“特价VPS”下按商家分组显示
      const grouped = {};
      filtered.forEach(p => {
        const prov = p.providerName || '其他';
        if (!grouped[prov]) grouped[prov] = [];
        grouped[prov].push(p);
      });

      // 商家优先级排序
      const priority = ['DMIT', '搬瓦工', 'CloudCone', 'RackNerd', 'ColoCrossing', 'ZGO Cloud'];
      const sortedProviders = Object.keys(grouped).sort((a, b) => {
        const idxA = priority.indexOf(a);
        const idxB = priority.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });

      sortedProviders.forEach(providerName => {
        // 添加商家分组标题
        const header = document.createElement('div');
        header.className = 'provider-group-header';
        header.innerHTML = `<span class="provider-group-badge">${grouped[providerName].length}</span> ${providerName} 特价专区`;
        grid.appendChild(header);

        // 渲染该商家下的卡片
        grouped[providerName].forEach(product => {
          renderSingleCard(product);
        });
      });
    } else {
      // 其他标签页正常直接显示
      filtered.forEach(product => {
        renderSingleCard(product);
      });
    }
  }

  function renderSingleCard(product) {
    const clone = template.content.cloneNode(true);

    clone.querySelector('.provider-badge').textContent = product.providerName;
    clone.querySelector('.product-name').textContent = product.name;
    clone.querySelector('.product-price').textContent = product.price;

    const endpointSection = clone.querySelector('.test-endpoints');
    const endpointBody = clone.querySelector('.test-endpoints-body');

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
    const hasInlineEndpoints = Array.isArray(product.testEndpoints) && product.testEndpoints.length > 0;
    renderEndpointSection(product, endpointSection, endpointBody);

    if (hasInlineEndpoints) {
      speedtest.style.display = 'none';
    } else if (product.speedtestUrl) {
      speedtest.href = '#';
      speedtest.title = `打开 ${product.providerName} 测速节点`;
      speedtest.textContent = '⚡ 打开测速节点';
      speedtest.addEventListener('click', (e) => {
        e.preventDefault();
        window.open(product.speedtestUrl, '_blank');
      });
    } else {
      speedtest.href = `speedtest.html?id=${encodeURIComponent(product.id)}`;
      speedtest.title = '跳转至内置测速页';
    }

    if (!hasInlineEndpoints && !product.speedtestUrl) {
      endpointSection.hidden = true;
    }

    if (hasInlineEndpoints && !product.speedtestUrl) {
      speedtest.style.display = 'none';
    }

    if (!hasInlineEndpoints && !product.speedtestUrl) {
      speedtest.style.display = 'none';
    }

    speedtest.rel = 'noopener noreferrer';

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

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildGroupedEndpoints(product) {
    if (Array.isArray(product.testEndpoints) && product.testEndpoints.length > 0) {
      const grouped = new Map();
      product.testEndpoints.forEach((endpoint) => {
        const key = endpoint.datacenter || endpoint.label || '默认节点';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(endpoint);
      });
      return Array.from(grouped.entries()).map(([datacenter, endpoints]) => ({ datacenter, endpoints }));
    }

    if (product.speedtestUrl) {
      return [{
        datacenter: (product.datacenters && product.datacenters[0]) || '默认节点',
        endpoints: [{
          label: '测速节点',
          datacenter: (product.datacenters && product.datacenters[0]) || '默认节点',
          route: (product.networkRoutes && product.networkRoutes[0]) || '',
          type: 'url',
          value: product.speedtestUrl,
          note: '兼容模式'
        }]
      }];
    }

    return [];
  }

  function renderEndpointSection(product, endpointSection, endpointBody) {
    const groups = buildGroupedEndpoints(product);
    if (groups.length === 0) {
      endpointSection.hidden = true;
      return;
    }

    endpointSection.hidden = false;
    endpointBody.innerHTML = groups.map((group, groupIndex) => {
      const items = group.endpoints.map((endpoint, endpointIndex) => {
        const route = endpoint.route ? `<span class="endpoint-route">${escapeHtml(endpoint.route)}</span>` : '';
        const note = endpoint.note ? `<span class="endpoint-note">${escapeHtml(endpoint.note)}</span>` : '';
        const value = escapeHtml(endpoint.value);
        const label = escapeHtml(endpoint.label || endpoint.route || endpoint.type || '节点');
        const type = escapeHtml(endpoint.type || 'url');
        return `
          <button
            type="button"
            class="endpoint-chip"
            data-type="${type}"
            data-value="${value}"
            data-label="${label}"
          >
            <span class="endpoint-chip-label">${label}</span>
            ${route}
            <span class="endpoint-chip-value">${value}</span>
            ${note}
          </button>
        `;
      }).join('');

      return `
        <div class="endpoint-group" data-group-index="${groupIndex}">
          <div class="endpoint-group-title">${escapeHtml(group.datacenter)}</div>
          <div class="endpoint-group-items">${items}</div>
        </div>
      `;
    }).join('');

    endpointBody.querySelectorAll('.endpoint-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const type = chip.dataset.type;
        const value = chip.dataset.value;
        const originalText = chip.querySelector('.endpoint-chip-value').textContent;

        if (type === 'ip') {
          try {
            await navigator.clipboard.writeText(value);
            chip.classList.add('copied');
            chip.querySelector('.endpoint-chip-value').textContent = '已复制';
            setTimeout(() => {
              chip.classList.remove('copied');
              chip.querySelector('.endpoint-chip-value').textContent = originalText;
            }, 1500);
          } catch {
            window.prompt('请手动复制测试 IP', value);
          }
          return;
        }

        window.open(value, '_blank');
      });
    });
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

  // Fetch data from backend
  async function fetchData() {
    try {
      btnRefresh.textContent = '刷新中...';
      btnRefresh.disabled = true;
      
      // Fetch providers list 
      const provRes = await fetch('/api/vps/providers');
      const provJson = await provRes.json();
      if (provJson.success) {
        renderFilters(provJson.data);
      }

      // Fetch stock data
      const res = await fetch('/api/vps/stock');
      const json = await res.json();
      
      if (json.success) {
        currentData = json.data;
        // Sort by priority initially
        currentData.sort((a,b) => (a.priority === 'high' ? -1 : 1));
        
        lastUpdateEl.textContent = `最后更新于: ${formatTime(json.lastScrapeTime)}`;
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

  // Initialization
  fetchData();
  
  // Timer for auto-refresh every 2 mins
  setInterval(fetchData, 120 * 1000);
  
  // Manual refresh
  btnRefresh.addEventListener('click', fetchData);
});
