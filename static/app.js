// ================== ESCAPOWANIE HTML (ochrona przed XSS) ==================
function h(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

// ================== STAN GLOBALNY ==================
let products = [];          // ładowane z API
let cart = [];              // klient-side, nie trafia do bazy
let editingId = null;
let pendingImgData = null;
let scannerMode = null;     // 'sell', 'stock', 'modal'
let hwScanBuf = '';         // bufor klawiszy z czytnika HW
let hwScanTs  = 0;          // timestamp ostatniego znaku (ms)
let npValue = '';
let activeCategory = 'Wszystkie';
let activeStockCategory = 'Wszystkie';
let currentUser          = null;
let currentUserFromCache = false;   // true gdy załadowany z IndexedDB offline
let importData           = null;
let isOnline = true;          // aktualny stan połączenia
let probeInterval = null;     // handle setInterval dla sondowania offline
let syncInProgress = false;   // blokada przed równoczesną synchronizacją

// ================== OFFLINE DB (IndexedDB) ==================
const offlineDB = (() => {
  const DB_NAME    = 'sklepik-offline';
  const DB_VERSION = 1;
  let   _db        = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('products'))
          db.createObjectStore('products', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pending_sales'))
          db.createObjectStore('pending_sales', { keyPath: 'localId', autoIncrement: true });
        if (!db.objectStoreNames.contains('user'))
          db.createObjectStore('user', { keyPath: 'id' });
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  function tx(storeName, mode = 'readonly') {
    return _db.transaction(storeName, mode).objectStore(storeName);
  }

  async function saveProducts(arr) {
    await openDB();
    return new Promise((resolve, reject) => {
      const store = tx('products', 'readwrite');
      const clear = store.clear();
      clear.onsuccess = () => {
        let rem = arr.length;
        if (rem === 0) { resolve(); return; }
        arr.forEach(p => {
          const r = store.put(p);
          r.onsuccess = () => { if (--rem === 0) resolve(); };
          r.onerror   = e => reject(e.target.error);
        });
      };
      clear.onerror = e => reject(e.target.error);
    });
  }

  async function getProducts() {
    await openDB();
    return new Promise((resolve, reject) => {
      const r = tx('products').getAll();
      r.onsuccess = e => resolve(e.target.result || []);
      r.onerror   = e => reject(e.target.error);
    });
  }

  async function updateProductStock(productId, delta) {
    await openDB();
    return new Promise((resolve, reject) => {
      const store = tx('products', 'readwrite');
      const get   = store.get(productId);
      get.onsuccess = e => {
        const p = e.target.result;
        if (!p) { resolve(); return; }
        p.stock = Math.max(0, p.stock + delta);
        const put = store.put(p);
        put.onsuccess = () => resolve(p);
        put.onerror   = e2 => reject(e2.target.error);
      };
      get.onerror = e => reject(e.target.error);
    });
  }

  async function addPendingSale(saleData) {
    await openDB();
    return new Promise((resolve, reject) => {
      const r = tx('pending_sales', 'readwrite').add({ ...saleData, ts_local: Date.now() });
      r.onsuccess = e => resolve(e.target.result);
      r.onerror   = e => reject(e.target.error);
    });
  }

  async function getPendingSales() {
    await openDB();
    return new Promise((resolve, reject) => {
      const r = tx('pending_sales').getAll();
      r.onsuccess = e => resolve(e.target.result || []);
      r.onerror   = e => reject(e.target.error);
    });
  }

  async function removePendingSale(localId) {
    await openDB();
    return new Promise((resolve, reject) => {
      const r = tx('pending_sales', 'readwrite').delete(localId);
      r.onsuccess = () => resolve();
      r.onerror   = e => reject(e.target.error);
    });
  }

  async function countPendingSales() {
    await openDB();
    return new Promise((resolve, reject) => {
      const r = tx('pending_sales').count();
      r.onsuccess = e => resolve(e.target.result);
      r.onerror   = e => reject(e.target.error);
    });
  }

  async function saveCurrentUser(userData) {
    await openDB();
    return new Promise((resolve, reject) => {
      const store = tx('user', 'readwrite');
      const clear = store.clear();
      clear.onsuccess = () => {
        if (!userData) { resolve(); return; }
        const r = store.put(userData);
        r.onsuccess = () => resolve();
        r.onerror   = e => reject(e.target.error);
      };
      clear.onerror = e => reject(e.target.error);
    });
  }

  async function getCachedUser() {
    await openDB();
    return new Promise((resolve, reject) => {
      const r = tx('user').getAll();
      r.onsuccess = e => resolve((e.target.result || [])[0] || null);
      r.onerror   = e => reject(e.target.error);
    });
  }

  return { openDB, saveProducts, getProducts, updateProductStock,
           addPendingSale, getPendingSales, removePendingSale, countPendingSales,
           saveCurrentUser, getCachedUser };
})();

// ================== CONNECTIVITY ==================
async function probeConnectivity() {
  const ctrl    = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 3000);
  try {
    await fetch('/api/ping', { method: 'GET', signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timeout);
    return true;
  } catch {
    clearTimeout(timeout);
    return false;
  }
}

function startProbeLoop() {
  if (probeInterval) return;
  probeInterval = setInterval(async () => {
    const ok = await probeConnectivity();
    if (ok && !isOnline) {
      setOnlineState(true);
      syncPendingSales();
    }
  }, 15000);
}

function stopProbeLoop() {
  if (probeInterval) { clearInterval(probeInterval); probeInterval = null; }
}

function setOnlineState(online) {
  isOnline = online;
  updateConnectionBadge();
  const banner = document.getElementById('offlineBanner');
  if (banner) banner.style.display = online ? 'none' : 'block';
  const finBtn = document.querySelector('.btn-finalize');
  if (finBtn) finBtn.classList.toggle('offline-mode', !online);
  if (online) stopProbeLoop(); else startProbeLoop();
}

async function updateConnectionBadge() {
  const badge = document.getElementById('connectionBadge');
  const label = document.getElementById('connectionLabel');
  if (!badge || !label) return;
  const count = await offlineDB.countPendingSales().catch(() => 0);
  const chip  = count > 0 ? ` <span class="pending-chip">${count}</span>` : '';
  if (syncInProgress) {
    badge.className = 'connection-badge syncing';
    label.innerHTML = 'Synchronizuję...' + chip;
  } else if (!isOnline) {
    badge.className = 'connection-badge offline';
    label.innerHTML = 'Offline' + chip;
  } else {
    badge.className = 'connection-badge online';
    label.innerHTML = 'Online' + chip;
  }
}

// ================== API ==================
function loading(on) {
  document.getElementById('loadingBar').classList.toggle('active', on);
}

async function api(method, path, body) {
  const isSilent = path === '/api/ping';
  if (!isSilent) loading(true);

  const ctrl    = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);

  try {
    const opts = {
      method,
      headers: {'Content-Type': 'application/json'},
      credentials: 'same-origin',
      signal: ctrl.signal,
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(path, opts);
    clearTimeout(timeout);

    if (res.status === 401) {
      window.location.href = '/login';
      return null;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Błąd ${res.status}`);
    }

    // Udana odpowiedź = jesteśmy online
    if (!isOnline) setOnlineState(true);

    return res.headers.get('content-type')?.includes('json')
      ? await res.json()
      : null;
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof TypeError || e.name === 'AbortError') {
      if (isOnline) setOnlineState(false);
      const err = new Error('Brak połączenia z serwerem');
      err.isOffline = true;
      throw err;
    }
    throw e;
  } finally {
    if (!isSilent) loading(false);
  }
}

// ================== INIT ==================
async function init() {
  await offlineDB.openDB().catch(e => console.warn('IDB openDB:', e));

  // Sprawdź łączność przed próbą API
  const reachable = await probeConnectivity();
  setOnlineState(reachable);

  // Sprawdź sesję
  try {
    currentUser = await api('GET', '/api/me');
    if (!currentUser) return;
    currentUserFromCache = false;
    // Cachuj tylko minimalne dane — bez is_admin żeby nie dawać fałszywych uprawnień offline
    offlineDB.saveCurrentUser({ id: currentUser.id, username: currentUser.username }).catch(() => {});
  } catch (e) {
    if (e.isOffline) {
      // Brak sieci — spróbuj załadować z cache (bez is_admin — tylko sprzedaż dostępna offline)
      currentUser = await offlineDB.getCachedUser().catch(() => null);
      currentUserFromCache = true;
      if (!currentUser) {
        window.location.href = '/login';
        return;
      }
    } else {
      return;
    }
  }

  document.getElementById('headerUsername').textContent = currentUser.username;

  // Pokaż elementy admina jeśli admin (tylko gdy dane z serwera — nie z cache offline)
  if (currentUser.is_admin && !currentUserFromCache) {
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'flex');
  }

  // Wymuś zmianę hasła jeśli admin/admin lub nowe konto z flagą must_change_password
  if (currentUser.must_change_password) {
    openPasswordModal(true);
  }

  const now = new Date();
  document.getElementById('headerDate').innerHTML =
    now.toLocaleDateString('pl-PL', {weekday:'long'}) + '<br>' +
    now.toLocaleDateString('pl-PL', {day:'numeric', month:'long'});
  document.getElementById('reportDateFrom').value = today();
  document.getElementById('reportDateTo').value   = today();

  await loadProducts();
  renderCategories();
  renderProducts();
  renderQuickAmounts();
  await updateConnectionBadge();

  // Zsynchronizuj oczekujące sprzedaże z poprzedniej sesji offline
  if (isOnline) syncPendingSales();

  initHwScanner();
}

async function loadProducts() {
  if (isOnline) {
    try {
      const data = await api('GET', '/api/products');
      if (data) {
        products = data;
        offlineDB.saveProducts(data).catch(e => console.warn('IDB saveProducts:', e));
      }
    } catch (e) {
      if (e.isOffline) {
        const cached = await offlineDB.getProducts().catch(() => []);
        if (cached.length > 0) {
          products = cached;
          showToast('Załadowano produkty z pamięci podręcznej', 'orange');
        }
      } else {
        throw e;
      }
    }
  } else {
    const cached = await offlineDB.getProducts().catch(() => []);
    products = cached;
  }
}

// ================== PAGES ==================
function goPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  btn.classList.add('active');

  if (name === 'stock') renderStock();
  if (name === 'report') renderReport();
  if (name === 'users') renderUsers();
  if (name === 'sell') { renderCategories(); renderProducts(); }
}

// ================== HELPERS ==================
function today() { return new Date().toISOString().slice(0, 10); }

function fPLN(grosz) {
  return (grosz / 100).toFixed(2).replace('.', ',') + ' zł';
}

function fTime(ts) {
  return new Date(ts).toLocaleTimeString('pl-PL', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
}

// ================== CATEGORIES ==================
function getCategories() {
  const cats = [...new Set(products.map(p => p.category || 'Inne').filter(Boolean))];
  return ['Wszystkie', ...cats];
}

function renderCategories() {
  const el = document.getElementById('catFilter');
  el.innerHTML = '';
  getCategories().forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'cat-chip' + (c === activeCategory ? ' active' : '');
    btn.textContent = c;
    btn.addEventListener('click', () => setCategory(c));
    el.appendChild(btn);
  });
}

function setCategory(cat) {
  activeCategory = cat;
  renderCategories();
  renderProducts();
}

// ================== PRODUCTS GRID ==================
function buildCard(p) {
  const stockLabel = p.stock === 0 ? 'Brak' : p.stock <= 3 ? `Ostatnie ${p.stock}` : `${p.stock} szt.`;
  const pillClass  = p.stock === 0 ? 'empty' : p.stock <= 3 ? 'low' : '';
  const cartItem   = cart.find(c => c.id === p.id);

  const card = document.createElement('div');
  card.className = 'prod-card' + (p.stock === 0 ? ' unavailable' : '') + (cartItem ? ' in-cart' : '');
  if (p.stock > 0) card.addEventListener('click', () => addToCart(p.id));

  const pill = document.createElement('span');
  pill.className = 'stock-pill' + (pillClass ? ' ' + pillClass : '');
  pill.textContent = stockLabel;
  card.appendChild(pill);

  if (cartItem) {
    const badge = document.createElement('span');
    badge.className = 'cart-qty-badge';
    badge.textContent = `🛒 ×${cartItem.qty}`;
    card.appendChild(badge);
  }

  if (p.img) {
    const img = document.createElement('img');
    img.className = 'prod-img';
    img.src = p.img;
    img.alt = p.name;
    card.appendChild(img);
  } else {
    const emoji = document.createElement('span');
    emoji.className = 'prod-emoji';
    emoji.textContent = p.emoji || '🛒';
    card.appendChild(emoji);
  }

  const name = document.createElement('div');
  name.className = 'prod-name';
  name.textContent = p.name;
  card.appendChild(name);

  const price = document.createElement('div');
  price.className = 'prod-price';
  price.textContent = fPLN(p.price);
  card.appendChild(price);

  return card;
}

function renderProducts() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const grid = document.getElementById('productsGrid');

  const list = products.filter(p => {
    const matchSearch = !search || p.name.toLowerCase().includes(search) || (p.barcode && p.barcode.includes(search));
    const matchCat = activeCategory === 'Wszystkie' || (p.category || 'Inne') === activeCategory;
    return matchSearch && matchCat;
  });

  if (list.length === 0) {
    grid.innerHTML = '<div class="no-data">Brak produktów</div>';
    return;
  }

  const inCart    = list.filter(p =>  cart.some(c => c.id === p.id)).sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  const notInCart = list.filter(p => !cart.some(c => c.id === p.id));

  // Grupuj wg kategorii, sortuj alfabetycznie w grupie
  const groupMap = {};
  notInCart.forEach(p => {
    const cat = p.category || 'Inne';
    if (!groupMap[cat]) groupMap[cat] = [];
    groupMap[cat].push(p);
  });
  Object.values(groupMap).forEach(g => g.sort((a, b) => a.name.localeCompare(b.name, 'pl')));
  const sortedCats = Object.keys(groupMap).sort((a, b) => a.localeCompare(b, 'pl'));

  function renderGroup(label, items, isCart = false) {
    const group = document.createElement('div');
    group.className = 'prod-group' + (isCart ? ' prod-group-cart' : '');

    const header = document.createElement('div');
    header.className = 'prod-group-label';
    header.textContent = label;
    group.appendChild(header);

    const groupGrid = document.createElement('div');
    groupGrid.className = 'prod-group-grid';
    items.forEach(p => groupGrid.appendChild(buildCard(p)));
    group.appendChild(groupGrid);

    grid.appendChild(group);
  }

  grid.innerHTML = '';
  if (inCart.length > 0) renderGroup('🛒 W koszyku', inCart, true);
  sortedCats.forEach(cat => renderGroup(cat, groupMap[cat]));
}

// ================== CART ==================
function addToCart(id) {
  const p = products.find(x => x.id === id);
  if (!p || p.stock === 0) return;
  const ex = cart.find(c => c.id === id);
  if (ex) { if (ex.qty < p.stock) ex.qty++; else return; }
  else cart.push({id, qty: 1});
  renderCart();
  showToast(`+ ${p.name}`, 'orange');
}

function changeQty(id, d) {
  const item = cart.find(c => c.id === id);
  if (!item) return;
  item.qty += d;
  if (item.qty <= 0) cart = cart.filter(c => c.id !== id);
  const p = products.find(x => x.id === id);
  if (p && item && item.qty > p.stock) item.qty = p.stock;
  renderCart();
}

function cartTotal() {
  return cart.reduce((s, item) => {
    const p = products.find(x => x.id === item.id);
    return s + (p ? p.price * item.qty : 0);
  }, 0);
}

function renderCart() {
  const el = document.getElementById('cartItems');
  if (cart.length === 0) {
    el.innerHTML = '<div class="cart-empty">Dotknij produkt aby dodać</div>';
    document.getElementById('cartTotal').textContent = '0,00 zł';
    npValue = '';
    updateNumDisplay();
    renderProducts();
    return;
  }
  el.innerHTML = cart.map(item => {
    const p = products.find(x => x.id === item.id);
    if (!p) return '';
    const sub   = p.price * item.qty;
    const thumb = p.img
      ? `<img class="cr-thumb" src="${p.img}" alt="">`
      : `<div class="cr-thumb">${h(p.emoji || '🛒')}</div>`;
    return `<div class="cart-row">
      ${thumb}
      <div class="cr-name">${h(p.name)}</div>
      <div class="qty-ctrl">
        <button class="qty-btn" onclick="changeQty(${p.id}, -1)">−</button>
        <span class="qty-num">${item.qty}</span>
        <button class="qty-btn" onclick="changeQty(${p.id}, +1)">+</button>
      </div>
      <div class="cr-total">${fPLN(sub)}</div>
    </div>`;
  }).join('');
  document.getElementById('cartTotal').textContent = fPLN(cartTotal());
  updateNumDisplay();
  renderProducts();
}

function clearCart() {
  cart = [];
  npValue = '';
  renderCart();
}

// ================== NUMPAD ==================
function renderQuickAmounts() {
  const amts   = [100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const labels = ['1 zł','2 zł','5 zł','10 zł','20 zł','50 zł','100 zł','200 zł'];
  document.getElementById('quickAmounts').innerHTML = amts.map((a, i) =>
    `<button class="qa-btn" onclick="npSet(${a})">${labels[i]}</button>`
  ).join('');
}

function npDigit(d) { if (npValue.length >= 8) return; npValue += d; updateNumDisplay(); }
function npDelete()  { npValue = npValue.slice(0, -1); updateNumDisplay(); }
function npClear()   { npValue = ''; updateNumDisplay(); }
function npSet(g)    { npValue = String(g); updateNumDisplay(); }
function npExact()   { npValue = String(cartTotal()); updateNumDisplay(); }

function updateNumDisplay() {
  const el    = document.getElementById('numDisplay');
  if (!npValue) { el.textContent = '—'; el.className = 'numpad-display'; return; }
  const paid   = parseInt(npValue);
  const total  = cartTotal();
  const change = paid - total;
  if (change >= 0) {
    el.innerHTML = `${fPLN(paid)} &nbsp;→&nbsp; <span style="color:var(--green-dark)">Reszta: ${fPLN(change)}</span>`;
    el.className = 'numpad-display has-change';
  } else {
    el.innerHTML = `${fPLN(paid)} &nbsp;→&nbsp; <span style="color:var(--red)">Brakuje: ${fPLN(Math.abs(change))}</span>`;
    el.className = 'numpad-display';
  }
}

// ================== FINALIZACJA SPRZEDAŻY ==================
async function finalize() {
  if (cart.length === 0) { showToast('❌ Koszyk jest pusty!', 'red'); return; }
  const paid  = parseInt(npValue) || 0;
  const total = cartTotal();
  if (paid > 0 && paid < total) { showToast('❌ Za mało gotówki!', 'red'); return; }

  if (isOnline) {
    try {
      await api('POST', '/api/sales', {
        items: cart.map(item => ({id: item.id, qty: item.qty})),
        paid:  paid || total,
      });
      await loadProducts();
      cart = [];
      npValue = '';
      renderCart();
      renderProducts();
      showToast(`✅ Sprzedano za ${fPLN(total)}`, 'green');
    } catch (e) {
      if (e.isOffline) {
        await saveOfflineSale(cart, paid || total, total);
      } else {
        showToast('❌ ' + e.message, 'red');
      }
    }
  } else {
    await saveOfflineSale(cart, paid || total, total);
  }
}

async function saveOfflineSale(currentCart, paid, total) {
  try {
    await offlineDB.addPendingSale({
      items: currentCart.map(item => ({ id: item.id, qty: item.qty })),
      paid,
    });
  } catch (e) {
    showToast('❌ Błąd zapisu offline: ' + e.message, 'red');
    return;
  }

  for (const item of currentCart) {
    const p = products.find(x => x.id === item.id);
    if (p) {
      p.stock = Math.max(0, p.stock - item.qty);
      offlineDB.updateProductStock(p.id, -item.qty).catch(e => console.warn('IDB stock:', e));
    }
  }

  cart    = [];
  npValue = '';
  renderCart();
  renderProducts();
  updateConnectionBadge();
  showToast(`📴 Sprzedano offline (${fPLN(total)}) — zostanie zsynchronizowane`, 'orange');
}

// ================== SYNCHRONIZACJA OFFLINE ==================
async function syncPendingSales() {
  if (syncInProgress) return;
  const pending = await offlineDB.getPendingSales().catch(() => []);
  if (pending.length === 0) return;

  syncInProgress = true;
  updateConnectionBadge();

  let synced = 0;
  const failed = [];

  for (const sale of pending) {
    try {
      await api('POST', '/api/sales', { items: sale.items, paid: sale.paid });
      await offlineDB.removePendingSale(sale.localId);
      synced++;
    } catch (e) {
      if (e.isOffline) break;   // połączenie znikło — przerwij, zostaw resztę
      failed.push({ sale, reason: e.message });
    }
  }

  if (synced > 0) {
    await loadProducts();
    renderProducts();
    renderCategories();
  }

  syncInProgress = false;
  updateConnectionBadge();

  if (failed.length === 0 && synced > 0) {
    showToast(`✅ Zsynchronizowano ${synced} sprzedaży`, 'green');
  } else if (failed.length > 0) {
    const details = failed.map(f => {
      const t = new Date(f.sale.ts_local).toLocaleTimeString('pl-PL', {hour:'2-digit', minute:'2-digit'});
      return `• ${t}: ${f.reason}`;
    }).join('\n');
    alert(`Nie zsynchronizowano ${failed.length} sprzedaży:\n\n${details}\n\nZostały zachowane w kolejce.`);
    if (synced > 0) showToast(`✅ ${synced} zsynchronizowano, ⚠️ ${failed.length} błąd`, 'orange');
  }
}

// ================== MAGAZYN ==================
function renderStockCategories() {
  const el = document.getElementById('stockCatFilter');
  if (!el) return;
  el.innerHTML = '';
  getCategories().forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'cat-chip' + (c === activeStockCategory ? ' active' : '');
    btn.textContent = c;
    btn.addEventListener('click', () => { activeStockCategory = c; renderStock(); });
    el.appendChild(btn);
  });
}

function renderStock() {
  renderStockCategories();
  const grid = document.getElementById('stockGrid');
  if (products.length === 0) {
    grid.innerHTML = '<div class="no-data">Brak produktów. Kliknij „Dodaj produkt".</div>';
    return;
  }

  const search = (document.getElementById('stockSearchInput')?.value || '').toLowerCase();
  const list = products.filter(p => {
    const matchSearch = !search || p.name.toLowerCase().includes(search) || (p.barcode && p.barcode.includes(search));
    const matchCat = activeStockCategory === 'Wszystkie' || (p.category || 'Inne') === activeStockCategory;
    return matchSearch && matchCat;
  });

  if (list.length === 0) {
    grid.innerHTML = '<div class="no-data">Brak produktów.</div>';
    return;
  }

  function buildStockCard(p) {
    const badge = p.stock === 0
      ? '<span class="badge badge-empty">Brak</span>'
      : p.stock <= 3 ? '<span class="badge badge-low">Mało</span>'
      : '<span class="badge badge-ok">OK</span>';
    const thumb = p.img
      ? `<img class="sc-img" src="${p.img}" alt="">`
      : `<div class="sc-emoji">${h(p.emoji || '🛒')}</div>`;
    return `<div class="stock-card">
      <div class="sc-top">
        ${thumb}
        <div class="sc-info">
          <div class="sc-name">${h(p.name)}</div>
          <div class="sc-price">${fPLN(p.price)}</div>
          ${p.barcode ? `<div class="sc-barcode">📊 ${h(p.barcode)}</div>` : ''}
        </div>
      </div>
      <div class="sc-stock-row">
        <span class="sc-stock-num">${p.stock} szt.</span>
        ${badge}
      </div>
      <div class="sc-actions" style="margin-bottom:8px">
        <input class="sc-restock" type="number" min="1" id="rs_${p.id}" placeholder="ile szt.">
        <button class="sm-btn sm-green" onclick="restock(${p.id})">+Dodaj</button>
      </div>
      <div style="display:flex;gap:6px">
        <button class="sm-btn sm-blue" style="flex:1" onclick="openEditModal(${p.id})">✏️ Edytuj</button>
        <button class="sm-btn sm-red" onclick="delProduct(${p.id})">🗑️</button>
      </div>
    </div>`;
  }

  // Grupuj wg kategorii, sortuj alfabetycznie w grupie
  const groupMap = {};
  list.forEach(p => {
    const cat = p.category || 'Inne';
    if (!groupMap[cat]) groupMap[cat] = [];
    groupMap[cat].push(p);
  });
  Object.values(groupMap).forEach(g => g.sort((a, b) => a.name.localeCompare(b.name, 'pl')));
  const sortedCats = Object.keys(groupMap).sort((a, b) => a.localeCompare(b, 'pl'));

  grid.innerHTML = sortedCats.map(cat => `
    <div class="prod-group">
      <div class="prod-group-label">${h(cat)}</div>
      <div class="stock-grid">${groupMap[cat].map(buildStockCard).join('')}</div>
    </div>
  `).join('');
}

async function restock(id) {
  const input = document.getElementById('rs_' + id);
  const qty   = parseInt(input.value);
  if (!qty || qty <= 0) { showToast('❌ Podaj ilość', 'red'); return; }
  try {
    const updated = await api('POST', `/api/products/${id}/restock`, {qty});
    const p = products.find(x => x.id === id);
    if (p && updated) Object.assign(p, updated);
    input.value = '';
    renderStock();
    renderProducts();
    showToast(`✅ Dodano ${qty} szt. „${updated.name}"`, 'green');
  } catch (e) {
    showToast('❌ ' + e.message, 'red');
  }
}

async function delProduct(id) {
  if (!confirm('Usunąć ten produkt?')) return;
  try {
    await api('DELETE', `/api/products/${id}`);
    products = products.filter(p => p.id !== id);
    renderStock();
    renderProducts();
    renderCategories();
    showToast('🗑️ Produkt usunięty', 'orange');
  } catch (e) {
    showToast('❌ ' + e.message, 'red');
  }
}

// ================== MODAL PRODUKTU ==================
function openAddModal() {
  editingId = null;
  pendingImgData = null;
  document.getElementById('modalTitle').textContent = '➕ Nowy produkt';
  ['fName','fEmoji','fPrice','fStock','fBarcode','fCategory'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('imgPreview').src = '';
  document.getElementById('imgPreviewBox').style.display = 'none';
  document.getElementById('productOverlay').classList.remove('hidden');
}

function openEditModal(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  pendingImgData = p.img || null;
  document.getElementById('modalTitle').textContent = '✏️ Edytuj: ' + p.name;
  document.getElementById('fName').value     = p.name;
  document.getElementById('fEmoji').value    = p.emoji || '';
  document.getElementById('fPrice').value    = (p.price / 100).toFixed(2);
  document.getElementById('fStock').value    = p.stock;
  document.getElementById('fBarcode').value  = p.barcode || '';
  document.getElementById('fCategory').value = p.category || '';
  if (p.img) {
    document.getElementById('imgPreview').src = p.img;
    document.getElementById('imgPreviewBox').style.display = 'block';
  } else {
    document.getElementById('imgPreview').src = '';
    document.getElementById('imgPreviewBox').style.display = 'none';
  }
  document.getElementById('productOverlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('productOverlay').classList.add('hidden');
}

function removeImg() {
  pendingImgData = null;
  document.getElementById('imgPreview').src = '';
  document.getElementById('imgPreviewBox').style.display = 'none';
}

// Resize zdjęcia do max 300px w JS (przed wysłaniem do API) — tani i sprawdzony sposób
function handleImg(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const max    = 300;
      let w = img.width, h = img.height;
      if (w > h) { if (w > max) { h = h * max / w; w = max; } }
      else        { if (h > max) { w = w * max / h; h = max; } }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      pendingImgData = canvas.toDataURL('image/jpeg', 0.85);
      document.getElementById('imgPreview').src = pendingImgData;
      document.getElementById('imgPreviewBox').style.display = 'block';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function saveProduct() {
  const name     = document.getElementById('fName').value.trim();
  const emoji    = document.getElementById('fEmoji').value.trim() || '🛒';
  const priceStr = document.getElementById('fPrice').value.replace(',', '.');
  const price    = Math.round(parseFloat(priceStr) * 100);
  const stock    = parseInt(document.getElementById('fStock').value);
  const barcode  = document.getElementById('fBarcode').value.trim();
  const category = document.getElementById('fCategory').value.trim() || 'Inne';

  if (!name || isNaN(price) || isNaN(stock) || price <= 0 || stock < 0) {
    showToast('❌ Uzupełnij wymagane pola!', 'red'); return;
  }

  const body = {name, emoji, price, stock, barcode, category, img: pendingImgData || ''};
  try {
    if (editingId) {
      const updated = await api('PUT', `/api/products/${editingId}`, body);
      const idx = products.findIndex(x => x.id === editingId);
      if (idx >= 0 && updated) products[idx] = updated;
    } else {
      const created = await api('POST', '/api/products', body);
      if (created) products.push(created);
    }
    closeModal();
    renderStock();
    renderProducts();
    renderCategories();
    showToast(editingId ? '✅ Zaktualizowano' : '✅ Dodano produkt', 'green');
  } catch (e) {
    showToast('❌ ' + e.message, 'red');
  }
}

// ================== UŻYTKOWNICY ==================
async function renderUsers() {
  const data = await api('GET', '/api/users');
  if (!data) return;
  const grid = document.getElementById('usersGrid');
  grid.innerHTML = '';
  data.forEach(u => {
    const card = document.createElement('div');
    card.className = 'user-card';
    card.innerHTML = `
      <div class="user-avatar ${u.is_admin ? 'admin' : 'staff'}">${u.is_admin ? '👑' : '🧑'}</div>
      <div class="user-info">
        <div class="user-name"></div>
        <div class="user-role">${u.is_admin ? 'Administrator' : 'Sprzedawca'}</div>
      </div>
      <div class="user-actions"></div>`;
    card.querySelector('.user-name').textContent = u.username;
    const actions = card.querySelector('.user-actions');
    if (u.id !== currentUser.id) {
      const btn = document.createElement('button');
      btn.className = 'sm-btn sm-red';
      btn.textContent = '🗑️ Usuń';
      btn.addEventListener('click', () => deleteUser(u.id, u.username));
      actions.appendChild(btn);
    } else {
      actions.innerHTML = '<span style="font-size:0.75rem;color:var(--muted)">to Ty</span>';
    }
    grid.appendChild(card);
  });
}

function openUserModal() {
  ['uName','uPass'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('uRole').value = 'staff';
  document.getElementById('userOverlay').classList.remove('hidden');
}

function closeUserModal() {
  document.getElementById('userOverlay').classList.add('hidden');
}

async function saveUser() {
  const username = document.getElementById('uName').value.trim();
  const password = document.getElementById('uPass').value;
  const is_admin = document.getElementById('uRole').value === 'admin';
  if (!username || !password) { showToast('❌ Uzupełnij pola', 'red'); return; }
  try {
    await api('POST', '/api/users', {username, password, is_admin});
    closeUserModal();
    renderUsers();
    showToast(`✅ Konto „${username}" utworzone`, 'green');
  } catch (e) {
    showToast('❌ ' + e.message, 'red');
  }
}

async function deleteUser(id, username) {
  if (!confirm(`Usunąć konto „${username}"?`)) return;
  try {
    await api('DELETE', `/api/users/${id}`);
    renderUsers();
    showToast(`🗑️ Konto usunięte`, 'orange');
  } catch (e) {
    showToast('❌ ' + e.message, 'red');
  }
}

// ================== RAPORT ==================
const REPORT_PAGE_SIZE = 20;
let reportPage     = 1;
let reportAllSales = [];

async function renderReport() {
  const dateFrom = document.getElementById('reportDateFrom').value;
  const dateTo   = document.getElementById('reportDateTo').value;
  let params = '';
  if (dateFrom && dateTo && dateFrom === dateTo) {
    params = `date=${dateFrom}`;
  } else {
    if (dateFrom) params += `date_from=${dateFrom}`;
    if (dateTo)   params += (params ? '&' : '') + `date_to=${dateTo}`;
  }
  let data;
  try {
    data = await api('GET', `/api/sales${params ? '?' + params : ''}`);
  } catch (e) {
    if (e.isOffline) { showToast('📴 Raport niedostępny offline', 'red'); return; }
    showToast('❌ ' + e.message, 'red'); return;
  }
  if (!data) return;

  reportAllSales = data;
  reportPage     = 1;

  const revenue   = reportAllSales.reduce((s, x) => s + x.total, 0);
  const itemCount = reportAllSales.reduce((s, x) => s + x.items.reduce((a, i) => a + i.qty, 0), 0);
  document.getElementById('rRevenue').textContent = fPLN(revenue);
  document.getElementById('rTrans').textContent   = reportAllSales.length;
  document.getElementById('rItems').textContent   = itemCount;

  // Nagłówek wydruku
  if (dateFrom && dateTo && dateFrom === dateTo) {
    const d = new Date(dateFrom + 'T12:00:00');
    document.getElementById('printDateStr').textContent =
      d.toLocaleDateString('pl-PL', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  } else {
    const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString('pl-PL', {day:'numeric', month:'long', year:'numeric'});
    const parts = [];
    if (dateFrom) parts.push(fmt(dateFrom));
    if (dateTo)   parts.push(fmt(dateTo));
    document.getElementById('printDateStr').textContent = parts.join(' – ');
  }

  renderReportPage();
}

function _reportRowHtml(s) {
  const itemsStr = s.items.map(i => `${h(i.emoji || '')} ${h(i.name)} ×${i.qty}`).join(', ');
  const change   = (s.paid || s.total) - s.total;
  return `<tr>
    <td style="white-space:nowrap">${fTime(s.ts)}</td>
    <td>${itemsStr}</td>
    <td>${fPLN(s.paid || s.total)}</td>
    <td>${change > 0 ? fPLN(change) : '—'}</td>
    <td><strong>${fPLN(s.total)}</strong></td>
  </tr>`;
}

function renderReportPage() {
  const tbody = document.getElementById('reportBody');
  if (reportAllSales.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="no-data">Brak sprzedaży w wybranym okresie</td></tr>';
    document.getElementById('reportPagination').innerHTML = '';
    return;
  }
  const start = (reportPage - 1) * REPORT_PAGE_SIZE;
  const slice = reportAllSales.slice(start, start + REPORT_PAGE_SIZE);
  tbody.innerHTML = slice.map(_reportRowHtml).join('');
  renderReportPagination();
}

function renderReportPagination() {
  const totalPages = Math.ceil(reportAllSales.length / REPORT_PAGE_SIZE);
  const el = document.getElementById('reportPagination');
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const range = [];
  const delta = 2;
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= reportPage - delta && i <= reportPage + delta)) {
      range.push(i);
    } else if (range[range.length - 1] !== '…') {
      range.push('…');
    }
  }

  el.innerHTML = [
    `<button onclick="goReportPage(${reportPage - 1})" ${reportPage === 1 ? 'disabled' : ''}>&#8249;</button>`,
    ...range.map(r => r === '…'
      ? `<button disabled>…</button>`
      : `<button class="${r === reportPage ? 'active' : ''}" onclick="goReportPage(${r})">${r}</button>`
    ),
    `<button onclick="goReportPage(${reportPage + 1})" ${reportPage === totalPages ? 'disabled' : ''}>&#8250;</button>`,
  ].join('');
}

function goReportPage(n) {
  const totalPages = Math.ceil(reportAllSales.length / REPORT_PAGE_SIZE);
  if (n < 1 || n > totalPages) return;
  reportPage = n;
  renderReportPage();
  document.getElementById('reportTable').scrollIntoView({behavior: 'smooth', block: 'start'});
}

function doPrint() {
  renderReport().then(() => {
    // Przed drukowaniem: pokaż wszystkie wiersze
    const tbody = document.getElementById('reportBody');
    const saved = tbody.innerHTML;
    tbody.innerHTML = reportAllSales.map(_reportRowHtml).join('');
    window.print();
    tbody.innerHTML = saved;
  });
}

// ================== WYLOGOWANIE ==================
async function doLogout() {
  // Wyczyść cached user z IDB przed wylogowaniem — zapobiega załadowaniu apki ze starą sesją po nowym logowaniu
  await offlineDB.saveCurrentUser(null).catch(() => {});
  window.location.href = '/logout';
}

// ================== ZMIANA HASŁA ==================
function openPasswordModal(forced = false) {
  ['pwOld', 'pwNew', 'pwConfirm'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('passwordForcedInfo').style.display = forced ? 'block' : 'none';
  document.getElementById('passwordModalTitle').textContent   = forced ? '🔑 Ustaw nowe hasło' : '🔑 Zmień hasło';
  document.getElementById('passwordOldField').style.display   = forced ? 'none' : 'block';
  document.getElementById('passwordCancelBtn').style.display  = forced ? 'none' : '';
  document.getElementById('passwordOverlay').classList.remove('hidden');
}

function closePasswordModal() {
  document.getElementById('passwordOverlay').classList.add('hidden');
}

async function changeMyPassword() {
  const pwNew     = document.getElementById('pwNew').value;
  const pwConfirm = document.getElementById('pwConfirm').value;
  const pwOld     = document.getElementById('pwOld').value;

  if (pwNew.length < 6)         { showToast('❌ Hasło musi mieć min. 6 znaków', 'red'); return; }
  if (pwNew !== pwConfirm)      { showToast('❌ Hasła nie są takie same', 'red'); return; }

  const body = { password: pwNew };
  if (document.getElementById('passwordOldField').style.display !== 'none') {
    body.old_password = pwOld;
  }

  try {
    await api('PUT', `/api/users/${currentUser.id}/password`, body);
    closePasswordModal();
    currentUser.must_change_password = false;
    showToast('✅ Hasło zostało zmienione', 'green');
  } catch (e) {
    showToast('❌ ' + e.message, 'red');
  }
}

// ================== BACKUP ==================
function previewImport(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById('importFileName').textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      importData = JSON.parse(e.target.result);
      const pCount = (importData.products || []).length;
      const sCount = (importData.sales    || []).length;
      const date   = importData.exportedAt ? new Date(importData.exportedAt).toLocaleString('pl-PL') : 'nieznana';
      document.getElementById('importPreviewText').innerHTML =
        `<b>📦 Produktów:</b> ${pCount}<br><b>🧾 Transakcji:</b> ${sCount}<br><b>📅 Data backupu:</b> ${h(date)}`;
      document.getElementById('importPreview').style.display = 'block';
      document.getElementById('importBtn').style.display     = 'block';
    } catch {
      showToast('❌ Błędny plik!', 'red');
      importData = null;
    }
  };
  reader.readAsText(file);
}

async function doImport() {
  if (!importData) return;
  const importSales = document.getElementById('importSalesCheck').checked;
  const msg = importSales
    ? `Wczytać backup?\n\n⚠️ Nadpisze produkty ORAZ całą historię transakcji!\n\nNie można cofnąć!`
    : `Wczytać backup?\n\nNadpisze produkty. Historia transakcji zostanie zachowana.\n\nNie można cofnąć!`;
  if (!confirm(msg)) return;
  try {
    const payload = { ...importData, _import_sales: importSales };
    const result  = await api('POST', '/api/import', payload);
    document.getElementById('importPreview').style.display    = 'none';
    document.getElementById('importBtn').style.display        = 'none';
    document.getElementById('importFileName').textContent     = 'Żaden plik nie wybrany';
    document.getElementById('importSalesCheck').checked       = false;
    importData = null;
    await loadProducts();
    renderCategories();
    renderProducts();
    const salesInfo = result.sales_replaced ? ` i ${result.sales} transakcji` : ' (historia zachowana)';
    showToast(`✅ Wczytano ${result.products} produktów${salesInfo}`, 'green');
  } catch (e) {
    showToast('❌ ' + e.message, 'red');
  }
}

// ================== SKANER ==================
function initHwScanner() {
  const INTERVAL = 60; // ms — max odstęp między znakami czytnika HW (człowiek pisze wolniej)
  const MIN_LEN  = 4;  // minimalna długość kodu

  document.addEventListener('keydown', (e) => {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

    const now = Date.now();

    if (e.key === 'Enter') {
      if (hwScanBuf.length >= MIN_LEN) {
        const code = hwScanBuf;
        hwScanBuf = ''; hwScanTs = 0;
        e.preventDefault(); // zapobiega kliknięciu sfokusowanego przycisku przez Enter
        const pageId = document.querySelector('.page.active')?.id;
        const mode = pageId === 'page-sell' ? 'sell' : pageId === 'page-stock' ? 'stock' : null;
        if (mode) { scannerMode = mode; handleScannedCode(code); }
      } else {
        hwScanBuf = '';
      }
      return;
    }

    if (e.key.length === 1) {
      if (hwScanBuf.length > 0 && (now - hwScanTs) > INTERVAL) hwScanBuf = '';
      hwScanBuf += e.key;
      hwScanTs = now;
    }
  });
}

function openScanner(mode) {
  scannerMode = mode;
  const input = document.getElementById('scanInput');
  input.value = '';
  input.click();
}

async function processScanImage(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  document.getElementById('scannerOverlay').classList.remove('hidden');
  document.getElementById('scannerStatus').textContent = 'Szukam kodu kreskowego...';
  try {
    const code = await decodeBarcode(file);
    closeScanner();
    if (code) handleScannedCode(code);
    else showToast('❌ Nie znaleziono kodu — spróbuj ponownie', 'red');
  } catch (e) {
    closeScanner();
    showToast('❌ Błąd skanowania: ' + e.message, 'red');
  }
}

async function decodeBarcode(file) {
  if ('BarcodeDetector' in window) {
    try {
      const detector = new BarcodeDetector({
        formats: ['ean_13','ean_8','code_128','code_39','upc_a','upc_e','qr_code']
      });
      const bitmap  = await createImageBitmap(file);
      const results = await detector.detect(bitmap);
      if (results.length > 0) return results[0].rawValue;
    } catch (e) { console.warn('BarcodeDetector failed:', e); }
  }
  try {
    const img    = await loadImage(file);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx    = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData     = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const codeReader    = new ZXing.MultiFormatReader();
    const lumSource     = new ZXing.RGBLuminanceSource(imageData.data, canvas.width, canvas.height);
    const binaryBitmap  = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lumSource));
    const result        = codeReader.decode(binaryBitmap);
    if (result) return result.getText();
  } catch (e) { console.warn('ZXing failed:', e); }
  return null;
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload  = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = rej;
    img.src = url;
  });
}

function handleScannedCode(code) {
  if (scannerMode === 'sell') {
    const p = products.find(x => x.barcode === code);
    if (p) {
      if (p.stock > 0) { addToCart(p.id); showToast(`✅ ${p.name} dodano!`, 'green'); }
      else showToast('❌ Brak w magazynie!', 'red');
    } else showToast('❓ Nieznany kod: ' + code, 'red');
  } else if (scannerMode === 'stock') {
    const p = products.find(x => x.barcode === code);
    if (p) { openEditModal(p.id); showToast(`📦 ${p.name}`, 'orange'); }
    else {
      openAddModal();
      document.getElementById('fBarcode').value = code;
      showToast('Nowy produkt — uzupełniam dane...', 'orange');
      lookupBarcode(code);
    }
  } else if (scannerMode === 'modal') {
    document.getElementById('fBarcode').value = code;
    showToast('✅ Kod wpisany: ' + code, 'green');
    lookupBarcode(code);
  }
}

function closeScanner() {
  document.getElementById('scannerOverlay').classList.add('hidden');
}

// ================== LOOKUP KODU KRESKOWEGO (Open Food Facts) ==================
async function lookupBarcode(code) {
  const statusEl = document.getElementById('barcodeLookupStatus');
  if (!statusEl) return;
  statusEl.style.display = 'block';
  statusEl.textContent = '🔍 Szukam w bazie produktów...';
  try {
    const r = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}?fields=product_name,product_name_pl,image_front_url,categories_tags`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await r.json();
    if (data.status !== 1 || !data.product) {
      statusEl.textContent = 'ℹ️ Nie znaleziono w bazie — uzupełnij ręcznie';
      return;
    }
    const p = data.product;
    const name = p.product_name_pl || p.product_name || '';
    const nameEl = document.getElementById('fName');
    if (name && nameEl && !nameEl.value.trim()) {
      nameEl.value = name;
    }
    // Kategoria — wybierz polski tag jeśli dostępny
    const catEl = document.getElementById('fCategory');
    if (catEl && !catEl.value.trim() && Array.isArray(p.categories_tags)) {
      const plTag = p.categories_tags.find(t => t.startsWith('pl:'));
      if (plTag) {
        catEl.value = plTag.replace('pl:', '').replace(/-/g, ' ');
        catEl.value = catEl.value.charAt(0).toUpperCase() + catEl.value.slice(1);
      }
    }
    // Zdjęcie — pobierz, zmniejsz do 300px i ustaw jako pendingImgData
    if (p.image_front_url && !pendingImgData) {
      try {
        const imgResp = await fetch(p.image_front_url);
        const blob = await imgResp.blob();
        const blobUrl = URL.createObjectURL(blob);
        await new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const max = 300;
            let w = img.width, h = img.height;
            if (w > h) { if (w > max) { h = h * max / w; w = max; } }
            else        { if (h > max) { w = w * max / h; h = max; } }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            pendingImgData = canvas.toDataURL('image/jpeg', 0.85);
            document.getElementById('imgPreview').src = pendingImgData;
            document.getElementById('imgPreviewBox').style.display = 'block';
            URL.revokeObjectURL(blobUrl);
            res();
          };
          img.onerror = rej;
          img.src = blobUrl;
        });
      } catch (_) { /* brak zdjęcia — nic się nie dzieje */ }
    }
    statusEl.textContent = '✅ Dane uzupełnione z Open Food Facts';
    statusEl.style.color = 'var(--success, #2e7d32)';
  } catch (e) {
    statusEl.textContent = 'ℹ️ Nie znaleziono w bazie — uzupełnij ręcznie';
  }
}

// ================== TOAST ==================
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast ' + type + ' show';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ================== EVENT LISTENERS ==================
document.getElementById('productOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('productOverlay')) closeModal();
});
document.getElementById('userOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('userOverlay')) closeUserModal();
});

window.addEventListener('online', async () => {
  const ok = await probeConnectivity();
  if (ok) { setOnlineState(true); syncPendingSales(); }
});
window.addEventListener('offline', () => setOnlineState(false));

// ================== START ==================
document.addEventListener('DOMContentLoaded', init);

// ================== SERVICE WORKER (PWA) ==================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => {
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              showToast('Dostępna aktualizacja aplikacji — odśwież stronę', 'orange');
            }
          });
        });
      })
      .catch(err => console.warn('SW rejestracja nieudana:', err));
  });
}
