// discover-accounts.js — lista todas las páginas FB e IG disponibles con el token actual
const TOKEN = process.env.META_TOKEN;
const API   = 'https://graph.facebook.com/v19.0';

async function get(path, params = '') {
  const url = `${API}${path}?access_token=${TOKEN}${params}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`${path}: ${data.error.message} (code ${data.error.code})`);
  return data;
}

async function main() {
  console.log('=== Cuentas accesibles con el token ===\n');

  // 1. Info del usuario/token
  try {
    const me = await get('/me', '&fields=id,name,email');
    console.log(`Usuario: ${me.name} (${me.id})`);
  } catch(e) { console.log('Usuario:', e.message); }

  // 2. Todas las páginas de Facebook administradas
  try {
    const pages = await get('/me/accounts', '&fields=id,name,fan_count,access_token&limit=25');
    console.log(`\n--- Páginas de Facebook (${pages.data?.length || 0}) ---`);
    for (const p of (pages.data || [])) {
      console.log(`  Nombre: ${p.name}`);
      console.log(`  PAGE_ID: ${p.id}`);
      console.log(`  Fans: ${p.fan_count || 0}`);
      console.log(`  ---`);

      // 3. Instagram Business asociado a cada página
      try {
        const ig = await get(`/${p.id}`, '&fields=instagram_business_account');
        if (ig.instagram_business_account?.id) {
          const igId = ig.instagram_business_account.id;
          const igProfile = await get(`/${igId}`, '&fields=username,followers_count,media_count');
          console.log(`  Instagram: @${igProfile.username}`);
          console.log(`  IG_USER_ID: ${igId}`);
          console.log(`  Seguidores: ${igProfile.followers_count}`);
        } else {
          console.log(`  Instagram: No vinculado`);
        }
      } catch(e) { console.log(`  Instagram error: ${e.message}`); }
      console.log('');
    }
  } catch(e) { console.log('Páginas:', e.message); }
}

main().catch(err => { console.error(err); process.exit(1); });
