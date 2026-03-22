const TORN_API = 'https://api.torn.com';

// Items relevant to Happy Jump
const ITEM_IDS = {
  xanax: 206,
  ecstasy: 197,
  edvd: 389,
};

const form = document.getElementById('api-form');
const input = document.getElementById('api-key');
const btn = document.getElementById('submit-btn');
const resultsEl = document.getElementById('results');
const loadingEl = document.getElementById('loading');
const toastEl = document.getElementById('toast');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = input.value.trim();
  if (!key) return showToast('Please enter an API key.', 'error');

  btn.disabled = true;
  resultsEl.classList.add('hidden');
  loadingEl.classList.remove('hidden');
  toastEl.classList.add('hidden');

  try {
    // Fetch user data and market data in parallel
    const [userData, marketData] = await Promise.all([
      fetchTorn(key, 'user', '', 'basic,profile,personalstats,crimes,battlestats'),
      fetchMarketPrices(key),
    ]);

    loadingEl.classList.add('hidden');

    if (userData.error) {
      throw new Error(`Torn API error ${userData.error.code}: ${userData.error.error}`);
    }

    renderResults(userData, marketData);
    showToast('Data loaded successfully!', 'success');
  } catch (err) {
    loadingEl.classList.add('hidden');
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

async function fetchTorn(key, section, id, selections) {
  const idPart = id ? `/${id}` : '';
  const url = `${TORN_API}/${section}${idPart}?selections=${selections}&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from Torn API`);
  return res.json();
}

async function fetchMarketPrices(key) {
  // Fetch item market data for our 3 drug items
  const prices = {};
  try {
    // Use torn section to get item details (market values)
    const itemIds = Object.values(ITEM_IDS).join(',');
    const data = await fetchTorn(key, 'torn', '', 'items');
    if (data.error) return { error: data.error };

    for (const [name, id] of Object.entries(ITEM_IDS)) {
      const item = data.items?.[id];
      if (item) {
        prices[name] = {
          name: item.name,
          market_value: item.market_value,
          image: item.image,
        };
      }
    }
  } catch (err) {
    return { error: err.message };
  }
  return prices;
}

function renderResults(user, market) {
  resultsEl.innerHTML = '';
  resultsEl.classList.remove('hidden');

  // 1. Player identity card
  resultsEl.appendChild(renderPlayerCard(user));

  // 2. Profile details
  resultsEl.appendChild(renderProfileCard(user));

  // 3. Battle stats (if available)
  if (user.strength !== undefined) {
    resultsEl.appendChild(renderBattleStatsCard(user));
  }

  // 4. Personal stats (if available)
  if (user.personalstats) {
    resultsEl.appendChild(renderPersonalStatsCard(user.personalstats));
  }

  // 5. Crime stats (if available)
  if (user.criminalrecord) {
    resultsEl.appendChild(renderCrimesCard(user.criminalrecord));
  }

  // 6. Market prices for Happy Jump items
  if (market && !market.error) {
    resultsEl.appendChild(renderMarketCard(market));
  }

  // 7. Happy Jump pricing calculation
  if (market && !market.error) {
    resultsEl.appendChild(renderHappyJumpCard(market));
  }

  // 8. Raw JSON
  resultsEl.appendChild(renderRawCard('Raw User JSON', user));
}

function renderPlayerCard(u) {
  const card = makeCard('Player');
  const body = card.querySelector('.card-body');

  const statusColor = u.status?.color || 'green';

  body.innerHTML = `
    <div class="player-header">
      <div>
        <div class="player-name">${esc(u.name)} <span style="color:#888">[${u.player_id}]</span></div>
        <div class="player-meta">
          <span>Level ${u.level}</span>
          <span>${esc(u.gender || '')}</span>
          <span>Age: ${u.age ? u.age.toLocaleString() + ' days' : 'N/A'}</span>
        </div>
        <div style="margin-top:0.5rem">
          Status: <span class="status-badge ${statusColor}">${esc(u.status?.description || 'Unknown')}</span>
        </div>
      </div>
    </div>
  `;
  return card;
}

function renderProfileCard(u) {
  const rows = [
    ['Faction', u.faction ? `${esc(u.faction.faction_name)} [${u.faction.faction_id}]` : 'None'],
    ['Job', u.job?.company_name || u.job?.job || 'None'],
    ['Life', u.life ? `${u.life.current} / ${u.life.maximum}` : 'N/A'],
    ['Last Action', u.last_action?.relative || 'N/A'],
    ['Signup', u.signup || 'N/A'],
    ['Awards', u.awards?.toLocaleString() ?? 'N/A'],
    ['Karma', u.karma?.toLocaleString() ?? 'N/A'],
    ['Forum Posts', u.forum_posts?.toLocaleString() ?? 'N/A'],
    ['Friends', u.friends?.toLocaleString() ?? 'N/A'],
    ['Enemies', u.enemies?.toLocaleString() ?? 'N/A'],
    ['Donator', u.donator === 1 ? 'Yes' : u.donator === 0 ? 'No' : 'N/A'],
    ['Married', u.married?.spouse_name ? `${esc(u.married.spouse_name)} [${u.married.spouse_id}]` : 'No'],
    ['Property', u.property || 'N/A'],
    ['Revivable', u.revivable === 1 ? 'Yes' : u.revivable === 0 ? 'No' : 'N/A'],
  ];
  return makeTableCard('Profile Details', rows);
}

function renderBattleStatsCard(u) {
  const fmt = (v) => v !== undefined ? Number(v).toLocaleString() : 'Hidden';
  const rows = [
    ['Strength', fmt(u.strength)],
    ['Speed', fmt(u.speed)],
    ['Dexterity', fmt(u.dexterity)],
    ['Defense', fmt(u.defense)],
    ['Total', fmt((u.strength || 0) + (u.speed || 0) + (u.dexterity || 0) + (u.defense || 0))],
  ];
  return makeTableCard('Battle Stats', rows);
}

function renderPersonalStatsCard(ps) {
  // Pick the most interesting personal stats
  const pick = [
    ['Attacks Won', ps.attackswon],
    ['Attacks Lost', ps.attackslost],
    ['Defends Won', ps.defendswon],
    ['Defends Lost', ps.defendslost],
    ['Xanax Used', ps.xantaken],
    ['Ecstasy Used', ps.exttaken],
    ['Energy Drinks Used', ps.energydrinkused],
    ['Overdoses', ps.overdosed],
    ['Times Hospitalized', ps.hospitalized],
    ['Drugs Used', ps.drugsused],
    ['Items Bought Abroad', ps.itemsboughtabroad],
    ['Revives', ps.revives],
    ['Networth', ps.networth ? '$' + Number(ps.networth).toLocaleString() : 'N/A'],
    ['Bounties Placed', ps.bountiesplaced],
    ['Bounties Collected', ps.bountiescollected],
  ];

  const rows = pick
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([label, v]) => [label, typeof v === 'number' ? v.toLocaleString() : v]);

  return makeTableCard('Personal Stats (selected)', rows);
}

function renderCrimesCard(cr) {
  const rows = Object.entries(cr)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => [k.replace(/_/g, ' '), v.toLocaleString()]);
  return makeTableCard('Criminal Record', rows);
}

function renderMarketCard(market) {
  const rows = Object.entries(market).map(([key, item]) => [
    item.name,
    '$' + Number(item.market_value).toLocaleString(),
  ]);
  return makeTableCard('Market Prices (Happy Jump Items)', rows);
}

function renderHappyJumpCard(market) {
  const xanPrice = market.xanax?.market_value || 850000;
  const edvdPrice = market.edvd?.market_value || 4000000;
  const ecsPrice = market.ecstasy?.market_value || 70000;

  const rehab = 1000000;
  const margin = 0.15;
  const xanOd = 0.03;
  const ecsOd = 0.05;

  const packageCost = 4 * xanPrice + 5 * edvdPrice + ecsPrice;
  const xanPayout = 4 * xanPrice + rehab;
  const ecsPayout = packageCost + rehab;
  const pXanOd = 1 - Math.pow(1 - xanOd, 4);
  const pEcsOd = Math.pow(1 - xanOd, 4) * ecsOd;
  const expectedLiability = pXanOd * xanPayout + pEcsOd * ecsPayout;
  const trueCost = packageCost + expectedLiability;
  const suggestedPrice = trueCost / (1 - margin);
  const profit = suggestedPrice - trueCost;

  const $ = (v) => '$' + Math.round(v).toLocaleString();
  const pct = (v) => (v * 100).toFixed(2) + '%';

  const rows = [
    ['Package Cost', $(packageCost)],
    ['— 4x Xanax', $(4 * xanPrice)],
    ['— 5x EDVD', $(5 * edvdPrice)],
    ['— 1x Ecstasy', $(ecsPrice)],
    ['', ''],
    ['P(Xanax OD)', pct(pXanOd)],
    ['P(Ecstasy OD)', pct(pEcsOd)],
    ['Xanax Payout', $(xanPayout)],
    ['Ecstasy Payout', $(ecsPayout)],
    ['Expected Liability', $(expectedLiability)],
    ['', ''],
    ['True Cost', $(trueCost)],
    ['Suggested Price (15% margin)', $(suggestedPrice)],
    ['Profit Per Package', $(profit)],
  ];

  return makeTableCard('Happy Jump Pricing (calculated from live prices)', rows);
}

function renderRawCard(title, data) {
  const card = makeCard(title, true); // collapsed by default
  const body = card.querySelector('.card-body');
  body.innerHTML = `<div class="raw-json">${esc(JSON.stringify(data, null, 2))}</div>`;
  return card;
}

// --- Helpers ---

function makeCard(title, collapsed = false) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-header">
      <span>${esc(title)}</span>
      <span class="toggle">${collapsed ? '▸ show' : '▾ hide'}</span>
    </div>
    <div class="card-body ${collapsed ? 'collapsed' : ''}"></div>
  `;
  const header = card.querySelector('.card-header');
  const body = card.querySelector('.card-body');
  const toggle = card.querySelector('.toggle');
  header.addEventListener('click', () => {
    body.classList.toggle('collapsed');
    toggle.textContent = body.classList.contains('collapsed') ? '▸ show' : '▾ hide';
  });
  return card;
}

function makeTableCard(title, rows, collapsed = false) {
  const card = makeCard(title, collapsed);
  const body = card.querySelector('.card-body');
  const rowsHtml = rows
    .map(([label, value]) => {
      if (!label && !value) return '<tr><td colspan="2" style="padding:0.2rem"></td></tr>';
      return `<tr><td class="label">${esc(label)}</td><td class="value">${value}</td></tr>`;
    })
    .join('');
  body.innerHTML = `<table class="data-table">${rowsHtml}</table>`;
  return card;
}

function showToast(msg, type = 'error') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
}

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str ?? '';
  return el.innerHTML;
}
