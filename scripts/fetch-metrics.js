// fetch-metrics.js — corre en GitHub Actions cada hora
const IG_ID   = '17841404458720963';
const PAGE_ID = '1141201932642316';
const TOKEN   = process.env.META_TOKEN;
const API     = 'https://graph.facebook.com/v19.0';

if (!TOKEN) { console.error('META_TOKEN no configurado'); process.exit(1); }

function dateStr(d) { return new Date(d).toISOString().slice(0, 10); }

async function get(path, params = '', customToken = TOKEN) {
  const url = `${API}${path}?access_token=${customToken}${params}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`Meta API ${path}: ${data.error.message}`);
  return data;
}

// Métricas IG para un período — siempre con total_value (única forma que funciona)
async function fetchIGTotals(since, until, followers) {
  try {
    const data = await get(`/${IG_ID}/insights`,
      `&metric=views,total_interactions,accounts_engaged,profile_views&metric_type=total_value&period=day&since=${since}&until=${until}`);
    const m = {};
    (data.data || []).forEach(d => { m[d.name] = d.total_value?.value || 0; });
    return {
      views:            m.views || 0,
      interactions:     m.total_interactions || 0,
      accounts_engaged: m.accounts_engaged || 0,
      profile_views:    m.profile_views || 0,
      followers,  // snapshot del momento actual
    };
  } catch (e) {
    console.warn(`  IG totals ${since}: ${e.message}`);
    return { views: 0, interactions: 0, accounts_engaged: 0, profile_views: 0, followers };
  }
}

// Métricas FB para un período — usa page token
async function fetchFBTotals(since, until, pageToken) {
  try {
    const data = await get(`/${PAGE_ID}/insights`,
      `&metric=page_impressions,page_post_engagements,page_reach&period=day&since=${since}&until=${until}`,
      pageToken);
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
  const fs = await import('fs');
  const since30 = dateStr(Date.now() - 30 * 864e5);
  const until    = dateStr(Date.now());
  const tomorrow = dateStr(Date.now() + 864e5);

  console.log(`Fetching metrics ${since30} → ${until}`);

  // ── Perfil IG ─────────────────────────────────────────
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

  const followers = profile.followers_count || 0;

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

  // ── Page token de FB (para insights de página) ────────
  let pageToken = TOKEN;
  let fb_fans = 0;
  try {
    const pageData = await get(`/${PAGE_ID}`, '&fields=access_token,fan_count');
    if (pageData.access_token) pageToken = pageData.access_token;
    fb_fans = pageData.fan_count || 0;
    console.log(`  FB fans: ${fb_fans}, page token: ${pageToken !== TOKEN ? 'OK' : 'usando user token'}`);
  } catch (e) {
    console.warn('  FB page token:', e.message);
  }

  // ── FB actual 30d ─────────────────────────────────────
  const fb30 = await fetchFBTotals(since30, until, pageToken);

  // ── Datos mensuales (preservar existentes + actualizar disponibles) ──
  // La API solo devuelve datos de los últimos 30 días con total_value.
  // Guardamos: mes actual + lo que quede del mes anterior dentro de los 30 días.
  // Los meses guardados de runs anteriores se preservan.
  let existingIGMonthly = {};
  let existingFBMonthly = {};
  try {
    const prev = JSON.parse(fs.readFileSync('metrics.json', 'utf8'));
    existingIGMonthly = prev.ig?.monthly || {};
    existingFBMonthly = prev.fb?.monthly || {};
  } catch {}

  const currentMonthKey = until.slice(0, 7);              // "2026-09"
  const currentMonthStart = `${currentMonthKey}-01`;       // "2026-09-01"

  // Mes actual: desde el 1ro hasta hoy
  console.log(`  Mes actual ${currentMonthKey}...`);
  const [igCurrent, fbCurrent] = await Promise.all([
    fetchIGTotals(currentMonthStart, tomorrow, followers),
    fetchFBTotals(currentMonthStart, tomorrow, pageToken),
  ]);
  existingIGMonthly[currentMonthKey] = igCurrent;
  existingFBMonthly[currentMonthKey] = fbCurrent;

  // Mes anterior: solo si su inicio está dentro de los 30 días o desde los 30d hacia su fin
  const prevDate = new Date(currentMonthStart);
  prevDate.setMonth(prevDate.getMonth() - 1);
  const prevMonthKey   = `${prevDate.getFullYear()}-${String(prevDate.getMonth()+1).padStart(2,'0')}`;
  const prevMonthStart = `${prevMonthKey}-01`;
  // Traer desde max(inicio del mes anterior, hace 30 días) hasta el inicio del mes actual
  const fetchSince = prevMonthStart >= since30 ? prevMonthStart : since30;

  console.log(`  Mes anterior ${prevMonthKey} (desde ${fetchSince})...`);
  const [igPrev, fbPrev] = await Promise.all([
    fetchIGTotals(fetchSince, currentMonthStart, followers),
    fetchFBTotals(fetchSince, currentMonthStart, pageToken),
  ]);
  // Solo sobreescribir si tenemos más datos que antes
  const prevExisting = existingIGMonthly[prevMonthKey];
  if (!prevExisting || igPrev.views > (prevExisting.views || 0)) {
    existingIGMonthly[prevMonthKey] = igPrev;
    existingFBMonthly[prevMonthKey] = fbPrev;
    console.log(`    IG views: ${igPrev.views}, FB impressions: ${fbPrev.impressions}`);
  } else {
    console.log(`    Preservando datos anteriores (${prevExisting.views} views)`);
  }

  const output = {
    updated: new Date().toISOString(),
    client: 'odontoclave',
    ig: {
      username:             profile.username,
      followers,
      media_count:          profile.media_count || 0,
      views_30d:            im.views || 0,
      reach_28d:            reach28,
      interactions_30d:     im.total_interactions || 0,
      accounts_engaged_30d: im.accounts_engaged || 0,
      profile_views_30d:    im.profile_views || 0,
      top_posts,
      monthly:              existingIGMonthly,
    },
    fb: {
      fans:            fb_fans,
      impressions_30d: fb30.impressions,
      reach_30d:       fb30.reach,
      engagements_30d: fb30.engagements,
      monthly:         existingFBMonthly,
    },
  };

  fs.writeFileSync('metrics.json', JSON.stringify(output, null, 2));
  console.log('\n✓ metrics.json generado');
  console.log(`  IG seguidores: ${followers} | Views 30d: ${im.views || 0}`);
  console.log(`  FB fans: ${fb_fans} | Impressions 30d: ${fb30.impressions}`);
  console.log(`  Meses con datos IG: ${Object.entries(existingIGMonthly).filter(([,v])=>v.views>0).map(([k])=>k).join(', ') || 'ninguno aún'}`);
}

main().catch(err => { console.error(err); process.exit(1); });
