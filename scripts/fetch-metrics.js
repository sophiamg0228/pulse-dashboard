const IG_ID   = '17841404458720963';
const PAGE_ID = '1141201932642316';
const TOKEN   = process.env.META_TOKEN;
const API     = 'https://graph.facebook.com/v19.0';

if (!TOKEN) { console.error('META_TOKEN no configurado'); process.exit(1); }

function sinceDate(daysAgo) {
  return new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);
}

async function get(path, params = '') {
  const url = `${API}${path}?access_token=${TOKEN}${params}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`Meta API: ${data.error.message}`);
  return data;
}

async function main() {
  const since30 = sinceDate(30);
  const until   = new Date().toISOString().slice(0, 10);

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

  const output = {
    updated: new Date().toISOString(),
    client: 'odontoclave',
    ig: {
      username: profile.username,
      followers: profile.followers_count || 0,
      media_count: profile.media_count || 0,
      views_30d: im.views || 0,
      reach_28d: reach28,
      interactions_30d: im.total_interactions || 0,
      accounts_engaged_30d: im.accounts_engaged || 0,
      profile_views_30d: im.profile_views || 0,
      top_posts,
    },
  };

  const fs = await import('fs');
  fs.writeFileSync('metrics.json', JSON.stringify(output, null, 2));
  console.log('✓ metrics.json generado:', JSON.stringify({
    followers: output.ig.followers,
    views_30d: output.ig.views_30d,
    reach_28d: output.ig.reach_28d,
  }));
}

main().catch(err => { console.error(err); process.exit(1); });
