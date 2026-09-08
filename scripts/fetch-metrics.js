// fetch-metrics.js — corre en GitHub Actions cada hora
// Lee métricas de Instagram/Facebook y genera metrics.json
// El token META_TOKEN vive en GitHub Secrets, nunca en el código

const IG_ID   = '17841404458720963';
const PAGE_ID = '1141201932642316';
const TOKEN   = process.env.META_TOKEN;
const API     = 'https://graph.facebook.com/v19.0';

if (!TOKEN) { console.error('META_TOKEN no configurado'); process.exit(1); }

function dateStr(d) { return new Date(d).toISOString().slice(0, 10); }

async function get(path, params = '') {
  const url = `${API}${path}?access_token=${TOKEN}${params}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`Meta API ${path}: ${data.error.message}`);
  return data;
}

// Genera rangos mensuales desde Ene 2026 hasta hoy
function getMonthRanges() {
  const months = [];
  const now = new Date();
  for (let m = 1; m <= now.getMonth() + 1; m++) {
    const since = `2026-${String(m).padStart(2, '0')}-01`;
    const nextStart = m < 12
      ? `2026-${String(m + 1).padStart(2, '0')}-01`
      : '2027-01-01';
    // Mes completado → hasta el día 1 del siguiente; mes actual → hasta mañana
    const until = m <= now.getMonth()
      ? nextStart
      : dateStr(Date.now() + 86400000);
    months.push({ id: since.slice(0, 7), since, until });
  }
  return months;
}

async function fetchIGTotals(since, until) {
  try {
    // Sin metric_type=total_value: devuelve serie diaria → sumamos nosotros
    const data = await get(`/${IG_ID}/insights`,
      `&metric=views,total_interactions,accounts_engaged,profile_views&period=day&since=${since}&until=${until}`);
    const m = {};
    (data.data || []).forEach(d => {
      if (d.values) m[d.name] = d.values.reduce((s, v) => s + (v.value || 0), 0);
    });
    return {
      views:            m.views || 0,
      interactions:     m.total_interactions || 0,
      accounts_engaged: m.accounts_engaged || 0,
      profile_views:    m.profile_views || 0,
    };
  } catch (e) {
    console.warn(`  IG totals ${since}: ${e.message}`);
    return { views: 0, interactions: 0, accounts_engaged: 0, profile_views: 0 };
  }
}

async function fetchFBTotals(since, until) {
  try {
    const data = await get(`/${PAGE_ID}/insights`,
      `&metric=page_impressions,page_post_engagements,page_reach&period=day&since=${since}&until=${until}`);
    const m = {};
    (data.data || []).forEach(d => {
      if (d.values) m[d.name] = d.values.reduce((s, v) => s + (v.value || 0), 0);
    });
    return {
      impressions: m.page_impressions || 0,
      engagements: m.page_post_engagements || 0,
      reach:       m.page_reach || 0,
    };
  } catch (e) {
    console.warn(`  FB totals ${since}: ${e.message}`);
    return { impressions: 0, engagements: 0, reach: 0 };
  }
}

async function main() {
  const since30 = dateStr(Date.now() - 30 * 864e5);
  const until   = dateStr(Date.now());

  console.log(`Fetching metrics ${since30} → ${until}`);

  // ── IG actual ────────────────────────────────────────
  const [profile, totals, reach, media] = await Promise.all([
    get(`/${IG_ID}`, '&fields=followers_count,media_count,username'),
    get(`/${IG_ID}/insights`, `&metric=views,accounts_engaged,total_interactions,profile_views&metric_type=total_value&period=day&since=${since30}&until=${until}`),
    get(`/${IG_ID}/insights`, `&metric=reach&period=days_28`),
    get(`/${IG_ID}/media`, '&fields=id,caption,media_type,like_count,comments_count,timestamp&limit=20'),
  ]);

  const im = {};
  (totals.data || []).forEach(d => { im[d.name] = d.total_value?.value || 0; });

  let reach28 = 0;
  if (reach.data?.[0]?.values?.length) {
    const vals = reach.data[0].values;
    reach28 = vals[vals.length - 1]?.value || 0;
  }

  const top_posts = (media.data || [])
    .map(p => ({
      caption: ((p.caption || '').split('\n')[0]).replace(/#\S+/g, '').trim().slice(0, 80),
      type: { VIDEO: 'Video', IMAGE: 'Imagen', CAROUSEL_ALBUM: 'Carrusel' }[p.media_type] || 'Post',
      likes: p.like_count || 0,
      comments: p.comments_count || 0,
      total_interactions: (p.like_count || 0) + (p.comments_count || 0),
      timestamp: p.timestamp,
    }))
    .sort((a, b) => b.total_interactions - a.total_interactions)
    .slice(0, 6);

  // ── FB actual ────────────────────────────────────────
  let fb_fans = 0;
  let fb30 = { impressions: 0, engagements: 0, reach: 0 };
  try {
    const [fbPage, fbIns] = await Promise.all([
      get(`/${PAGE_ID}`, '&fields=fan_count'),
      fetchFBTotals(since30, until),
    ]);
    fb_fans = fbPage.fan_count || 0;
    fb30 = fbIns;
  } catch (e) {
    console.warn('FB actual:', e.message);
  }

  // ── Datos mensuales (Ene 2026 → hoy) ─────────────────
  const monthRanges = getMonthRanges();
  const ig_monthly = {};
  const fb_monthly = {};

  for (const m of monthRanges) {
    process.stdout.write(`  ${m.id} ...`);
    const [igM, fbM] = await Promise.all([
      fetchIGTotals(m.since, m.until),
      fetchFBTotals(m.since, m.until),
    ]);
    ig_monthly[m.id] = igM;
    fb_monthly[m.id] = fbM;
    console.log(' ✓');
  }

  const output = {
    updated: new Date().toISOString(),
    client: 'odontoclave',
    ig: {
      username:             profile.username,
      followers:            profile.followers_count || 0,
      media_count:          profile.media_count || 0,
      views_30d:            im.views || 0,
      reach_28d:            reach28,
      interactions_30d:     im.total_interactions || 0,
      accounts_engaged_30d: im.accounts_engaged || 0,
      profile_views_30d:    im.profile_views || 0,
      top_posts,
      monthly:              ig_monthly,
    },
    fb: {
      fans:             fb_fans,
      impressions_30d:  fb30.impressions,
      reach_30d:        fb30.reach,
      engagements_30d:  fb30.engagements,
      monthly:          fb_monthly,
    },
  };

  const fs = await import('fs');
  fs.writeFileSync('metrics.json', JSON.stringify(output, null, 2));
  console.log('\n✓ metrics.json generado');
  console.log(`  IG seguidores: ${output.ig.followers}`);
  console.log(`  IG views 30d:  ${output.ig.views_30d}`);
  console.log(`  FB fans:       ${output.fb.fans}`);
  console.log(`  Meses:         ${monthRanges.map(m => m.id).join(', ')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
