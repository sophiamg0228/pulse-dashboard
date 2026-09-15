// fetch-ads.js — corre en GitHub Actions, genera ads-metrics.json
const TOKEN = process.env.META_ADS_TOKEN;
const API   = 'https://graph.facebook.com/v19.0';

if (!TOKEN) { console.error('META_ADS_TOKEN no configurado'); process.exit(1); }

const AD_CLIENTS = [
  { id: 'novacell',  name: 'Novacell Itagüí',    acct: '1607438714372589', currency: 'COP', benchmark: 900  },
  { id: 'avignon',   name: 'Distrito Avignon',    acct: '1105337453373756', currency: 'COP', benchmark: null },
  { id: 'mizuderma', name: 'Mizu Derma',          acct: '2307524142782312', currency: 'USD', benchmark: null },
];

const FIELDS = 'spend,impressions,reach,clicks,cpc,cpm,actions,cost_per_action_type';

async function fetchInsights(acctId, preset) {
  const url = `${API}/act_${acctId}/insights?fields=${FIELDS}&date_preset=${preset}&level=account&access_token=${TOKEN}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (data.error) { console.warn(`  Insights ${preset}: ${data.error.message}`); return null; }
  return data.data?.[0] || null;
}

function parseInsights(d) {
  if (!d) return null;
  const conv = (d.actions || []).find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d');
  const conversations = conv ? parseInt(conv.value) : 0;
  const spend = parseFloat(d.spend) || 0;
  return {
    spend,
    impressions:        parseInt(d.impressions)  || 0,
    reach:              parseInt(d.reach)         || 0,
    clicks:             parseInt(d.clicks)        || 0,
    cpc:                parseFloat(d.cpc)         || 0,
    cpm:                parseFloat(d.cpm)         || 0,
    conversations,
    cost_per_conversation: conversations > 0 ? Math.round(spend / conversations * 100) / 100 : null,
  };
}

async function fetchCampaigns(acctId) {
  const url = `${API}/act_${acctId}/campaigns?fields=name,status,daily_budget,lifetime_budget&access_token=${TOKEN}`;
  const res  = await fetch(url);
  const data = await res.json();
  return (data.data || []).map(c => ({
    name:   c.name,
    status: c.status,
    daily_budget: c.daily_budget ? Math.round(parseInt(c.daily_budget) / 100) : null,
  }));
}

async function main() {
  const fs = await import('fs');
  const output = { updated: new Date().toISOString(), clients: {} };

  for (const c of AD_CLIENTS) {
    console.log(`\n── ${c.name} ──`);
    const [d30, dAll, campaigns] = await Promise.all([
      fetchInsights(c.acct, 'last_30d'),
      fetchInsights(c.acct, 'maximum'),
      fetchCampaigns(c.acct),
    ]);

    const last_30d     = parseInsights(d30);
    const accumulated  = parseInsights(dAll);

    console.log(`  30d: $${last_30d?.spend} spend | ${last_30d?.conversations} conv | CPC ${last_30d?.cpc}`);
    console.log(`  Total: $${accumulated?.spend} spend | ${accumulated?.conversations} conv`);

    output.clients[c.id] = {
      name: c.name, currency: c.currency, benchmark: c.benchmark,
      last_30d, accumulated, campaigns,
    };
  }

  fs.writeFileSync('ads-metrics.json', JSON.stringify(output, null, 2));
  console.log('\n✓ ads-metrics.json generado');
}

main().catch(err => { console.error(err); process.exit(1); });
