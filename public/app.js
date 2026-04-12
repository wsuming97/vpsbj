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

    if (currentFilter === 'special') {
      // 在“特价VPS”下按商家分组显示
      const grouped = {};
      filtered.forEach(p => {
        const prov = p.providerName || '其他';
        if (!grouped[prov]) grouped[prov] = [];
        grouped[prov].push(p);
      });

      const sortedProviders = Object.keys(grouped).sort();

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
    if (product.speedtestUrl) {
      speedtest.href = `speedtest.html?id=${encodeURIComponent(product.id)}`;
    } else {
      speedtest.style.display = 'none';
    }

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
