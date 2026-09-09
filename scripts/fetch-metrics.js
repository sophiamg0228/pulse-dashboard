// fetch-metrics.js — corre en GitHub Actions cada hora
const CLIENTS = [
  { id: 'odontoclave', name: 'Odontoclave',       ig: '17841404458720963', page: '1141201932642316' },
  { id: 'ridasa',      name: 'Ridasa Constructora', ig: '17841436372592900', page: '381801831681673'  },
];

const TOKEN = process.env.META_TOKEN;
const API   = 'https://graph.facebook.com/v19.0';

if (!TOKEN) { console.error('META_TOKEN no configurado'); process.exit(1); }

function dateStr(d) { return new Date(d).toISOString().slice(0, 10); }

async function get(path, params = '', customToken = TOKEN) {
  const url = `${API}${path}?access_token=${customToken}${params}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`Meta API ${path}: ${data.error.message}`);
  return data;
}

async function fetchIGTotals(igId, since, until, followers) {
  try {
    const data = await get(`/${igId}/insights`,
      `&metric=views,total_interactions,accounts_engaged,profile_views&metric_type=total_value&period=day&since=${since}&until=${until}`);
    const m = {};
    (data.data || []).forEach(d => { m[d.name] = d.total_value?.value || 0; });
    return { views: m.views||0, interactions: m.total_interactions||0, accounts_engaged: m.accounts_engaged||0, profile_views: m.profile_views||0, followers };
  } catch (e) {
    console.warn(`  IG totals ${since}: ${e.message}`);
    return { views: 0, interactions: 0, accounts_engaged: 0, profile_views: 0, followers };
  }
}

async function fetchFBTotals(pageId, since, until, pageToken) {
  const NPE_METRICS = 'page_impressions_unique,page_engaged_users,page_views_total';
  const OLD_METRICS = 'page_impressions,page_post_engagements,page_reach';
  for (const metrics of [NPE_METRICS, OLD_METRICS]) {
    try {
      const data = await get(`/${pageId}/insights`,
        `&metric=${metrics}&period=day&since=${since}&until=${until}`, pageToken);
      if (!data.data?.length) continue;
      const m = {};
      (data.data || []).forEach(d => {
        if (d.values) m[d.name] = d.values.reduce((s, v) => s + (v.value || 0), 0);
      });
      return {
        impressions: m.page_impressions || m.page_views_total || 0,
        engagements: m.page_post_engagements || m.page_engaged_users || 0,
        reach:       m.page_reach || m.page_impressions_unique || 0,
      };
    } catch (e) {
      console.warn(`  FB totals ${since} (${metrics.split(',')[0]}...): ${e.message}`);
    }
  }
  return { impressions: 0, engagements: 0, reach: 0 };
}

async function fetchClientMetrics(client, since30, until, tomorrow, existingData) {
  console.log(`\n── ${client.name} ──`);
  const { ig: IG_ID, page: PAGE_ID } = client;

  const [profile, totals, reach, media] = await Promise.all([
    get(`/${IG_ID}`, '&fields=followers_count,media_count,username'),
    get(`/${IG_ID}/insights`, `&metric=views,accounts_engaged,total_interactions,profile_views&metric_type=total_value&period=day&since=${since30}&until=${until}`),
    get(`/${IG_ID}/insights`, `&metric=reach&period=days_28`),
    get(`/${IG_ID}/media`,    '&fields=id,caption,media_type,like_count,comments_count,timestamp&limit=20'),
  ]);

  const im = {};
  (totals.data || []).forEach(d => { im[d.name] = d.total_value?.value || 0; });

  let reach28 = 0;
  if (reach.data?.[0]?.values?.length) {
    const vals = reach.data[0].values;
    reach28 = vals[vals.length - 1]?.value || 0;
  }

  const followers = profile.followers_count || 0;

  const top_posts = (media.data || [])
    .map(p => ({
      caption: ((p.caption || '').split('\n')[0]).replace(/#\S+/g, '').trim().slice(0, 80),
      type: { VIDEO:'Video', IMAGE:'Imagen', CAROUSEL_ALBUM:'Carrusel' }[p.media_type] || 'Post',
      likes: p.like_count || 0, comments: p.comments_count || 0,
      total_interactions: (p.like_count||0) + (p.comments_count||0),
      timestamp: p.timestamp,
    }))
    .sort((a, b) => b.total_interactions - a.total_interactions)
    .slice(0, 6);

  // FB page token
  let pageToken = TOKEN;
  let fb_fans = 0;
  try {
    const pageData = await get(`/${PAGE_ID}`, '&fields=access_token,fan_count');
    if (pageData.access_token) pageToken = pageData.access_token;
    fb_fans = pageData.fan_count || 0;
    console.log(`  IG: @${profile.username} | ${followers} seg | Views 30d: ${im.views||0}`);
    console.log(`  FB fans: ${fb_fans} | page token: ${pageToken !== TOKEN ? 'OK' : 'user token'}`);
  } catch (e) { console.warn('  FB page token:', e.message); }

  const fb30 = await fetchFBTotals(PAGE_ID, since30, until, pageToken);

  // Monthly data — preserve existing + update recent
  let igMonthly = existingData?.ig?.monthly || {};
  let fbMonthly = existingData?.fb?.monthly || {};

  const currentMonthKey   = until.slice(0, 7);
  const currentMonthStart = `${currentMonthKey}-01`;

  const [igCurrent, fbCurrent] = await Promise.all([
    fetchIGTotals(IG_ID, currentMonthStart, tomorrow, followers),
    fetchFBTotals(PAGE_ID, currentMonthStart, tomorrow, pageToken),
  ]);
  igMonthly[currentMonthKey] = igCurrent;
  fbMonthly[currentMonthKey] = fbCurrent;

  const prevDate = new Date(currentMonthStart);
  prevDate.setMonth(prevDate.getMonth() - 1);
  const prevMonthKey   = `${prevDate.getFullYear()}-${String(prevDate.getMonth()+1).padStart(2,'0')}`;
  const prevMonthStart = `${prevMonthKey}-01`;
  const fetchSince     = prevMonthStart >= since30 ? prevMonthStart : since30;

  const [igPrev, fbPrev] = await Promise.all([
    fetchIGTotals(IG_ID, fetchSince, currentMonthStart, followers),
    fetchFBTotals(PAGE_ID, fetchSince, currentMonthStart, pageToken),
  ]);
  const prevExisting = igMonthly[prevMonthKey];
  if (!prevExisting || igPrev.views > (prevExisting.views || 0)) {
    igMonthly[prevMonthKey] = igPrev;
    fbMonthly[prevMonthKey] = fbPrev;
  }

  console.log(`  Meses IG con datos: ${Object.entries(igMonthly).filter(([,v])=>v.views>0).map(([k])=>k).join(', ') || 'ninguno'}`);

  return {
    ig: {
      username: profile.username, followers, media_count: profile.media_count||0,
      views_30d: im.views||0, reach_28d: reach28,
      interactions_30d: im.total_interactions||0,
      accounts_engaged_30d: im.accounts_engaged||0,
      profile_views_30d: im.profile_views||0,
      top_posts, monthly: igMonthly,
    },
    fb: {
      fans: fb_fans, impressions_30d: fb30.impressions,
      reach_30d: fb30.reach, engagements_30d: fb30.engagements,
      monthly: fbMonthly,
    },
  };
}

async function main() {
  const fs = await import('fs');
  const since30  = dateStr(Date.now() - 30 * 864e5);
  const until    = dateStr(Date.now());
  const tomorrow = dateStr(Date.now() + 864e5);

  // Load existing metrics to preserve monthly history
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync('metrics.json', 'utf8')); } catch {}

  const output = { updated: new Date().toISOString(), clients: {} };

  for (const client of CLIENTS) {
    try {
      output.clients[client.id] = {
        name:   client.name,
        ...(await fetchClientMetrics(client, since30, until, tomorrow, existing.clients?.[client.id])),
      };
    } catch(e) {
      console.error(`  ERROR ${client.name}:`, e.message);
    }
  }

  fs.writeFileSync('metrics.json', JSON.stringify(output, null, 2));
  console.log('\n✓ metrics.json generado');
}

main().catch(err => { console.error(err); process.exit(1); });
