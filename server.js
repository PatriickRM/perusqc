// server.js — SPQC (SoloPeruQChallenge)
// Trae ranked stats de cuentas fijas de LAN usando la Riot API.
// El estado "en vivo" (partida completa, 10 jugadores) SOLO se consulta
// desde /api/live, para no golpear el spectator API en cada refresh de la tabla.
// La API key vive solo en el backend.

const express = require('express');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const RIOT_API_KEY = process.env.RIOT_API_KEY;
if (!RIOT_API_KEY) {
  console.warn('⚠️  No se encontró RIOT_API_KEY en las variables de entorno.');
}

const PLATFORM = 'la1'; // LAN
const CONTINENT = 'americas';

// Cuentas del leaderboard. "displayName" es el nombre "humano" que se muestra
// grande en la tarjeta (ej. "Patrick"); gameName/tagLine es el Riot ID real
// que se muestra chiquito debajo. Para agregar un amigo, solo suma un objeto.
const ACCOUNTS = [
  {
    displayName: 'Patrick',
    gameName: 'Dark Mind',
    tagLine: 'MID',
    role: 'MID',
    avatar: 'https://pbs.twimg.com/media/E5bJaYnX0AUZ89v.jpg'
  },
  {
    displayName: 'Orlaman',
    gameName: 'SHELÐON',
    tagLine: 'LAN',
    role: 'TOP',
    avatar: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTuv0_D-ziTirIDN5heYEQHZR-MFszBov_QZUfIeAG6KdJNut9h33iyEqBr&s=10'
  },
  {
    displayName: 'Zoe',
    gameName: 'Minita Carreada',
    tagLine: 'Miau',
    role: 'ADC',
    avatar: 'https://content-historia.nationalgeographic.com.es/medio/2020/11/02/laika_7c3e28af_550x542.jpg'
  },

  {
    displayName: 'Umbra',
    gameName: 'Diegoomee',
    tagLine: '117',
    role: 'TOP',
    avatar: 'https://static.wikia.nocookie.net/disney/images/4/4e/Oscar-Pecezuelos.png/revision/latest/smart/width/250/height/250?cb=20110330181428&path-prefix=es'
  },
  {
    displayName: 'karalej',
    gameName: 'Satenekig',
    tagLine: 'LAN',
    role: 'ADC',
    avatar: 'https://i.blogs.es/5eeb4a/burns/840_560.jpeg'
  },

];

const TIER_VALUE = {
  IRON: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4,
  EMERALD: 5, DIAMOND: 6, MASTER: 7, GRANDMASTER: 8, CHALLENGER: 9,
};
const RANK_VALUE = { IV: 0, III: 1, II: 2, I: 3 };
const NO_DIVISION_TIERS = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

const ROLE_LABEL = {
  TOP: 'TOP',
  JUNGLE: 'JUNGLA',
  MIDDLE: 'MID',
  BOTTOM: 'ADC',
  UTILITY: 'SUPPORT',
};

function eloScore(entry) {
  if (!entry) return -1;
  const tier = TIER_VALUE[entry.tier] ?? 0;
  const rankPart = NO_DIVISION_TIERS.has(entry.tier) ? 0 : (RANK_VALUE[entry.rank] ?? 0);
  return tier * 4000 + rankPart * 1000 + entry.leaguePoints;
}

function opggUrl(gameName, tagLine) {
  return `https://op.gg/es/lol/summoners/lan/${encodeURIComponent(gameName)}-${encodeURIComponent(tagLine)}`;
}

async function riotFetch(url) {
  const res = await fetch(url, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
  if (res.status === 404) return null; // ej: sin partida en vivo, sin partidas ranked
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Riot API ${res.status} en ${url}: ${text}`);
  }
  return res.json();
}

// ---------- Caché simple en memoria (evita golpear la Riot API en cada refresh) ----------
const CACHE_TTL_MS = 80_000;
let leaderboardCache = { at: 0, data: null };

// Caché aparte, más corto, solo para el estado en vivo — así si varias
// personas tienen live.html abierto al mismo tiempo no se duplican las
// llamadas al spectator API en cada poll de 15s del frontend.
const LIVE_CACHE_TTL_MS = 12_000;
let liveCache = { at: 0, data: null };

// ---------- Ranked stats: SIN spectator API. Esto es lo único que usa /api/leaderboard ----------
async function loadPlayer(account) {
  const { displayName, gameName, tagLine, avatar, role } = account;
  const riotId = `${gameName}#${tagLine}`;
  try {
    const acc = await riotFetch(
      `https://${CONTINENT}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );
    if (!acc) throw new Error('Cuenta no encontrada');

    const summoner = await riotFetch(
      `https://${PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${acc.puuid}`
    );
    if (!summoner) throw new Error('Summoner no encontrado (revisa que la cuenta exista en LAN)');

    // league-v4 by-puuid: el estándar actual (el "id" encriptado se está deprecando)
    const entries = await riotFetch(
      `https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${acc.puuid}`
    );
    const ranked = (entries || []).find(e => e.queueType === 'RANKED_SOLO_5x5') || null;

    return {
      riotId,
      puuid: acc.puuid, // se guarda para que /api/live pueda consultar el spectator API sin repetir el lookup de cuenta
      displayName: displayName || gameName,
      gameName,
      tagLine,
      role,
      profileIconId: summoner.profileIconId,
      tier: ranked?.tier || 'UNRANKED',
      rank: ranked?.rank || '',
      leaguePoints: ranked?.leaguePoints || 0,
      wins: ranked?.wins || 0,
      losses: ranked?.losses || 0,
      winrate: ranked ? Math.round((ranked.wins / (ranked.wins + ranked.losses)) * 100) : null,
      score: eloScore(ranked),
      opgg: opggUrl(gameName, tagLine),
      avatar: avatar || null,
    };
  } catch (err) {
    return {
      riotId,
      puuid: null,
      displayName: displayName || gameName,
      gameName,
      tagLine,
      role: null,
      error: err.message,
      opgg: opggUrl(gameName, tagLine),
      score: -1,
    };
  }
}

async function buildLeaderboard() {
  const results = await Promise.all(ACCOUNTS.map(loadPlayer));
  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return results;
}

async function getLeaderboard() {
  const now = Date.now();
  if (leaderboardCache.data && now - leaderboardCache.at < CACHE_TTL_MS) {
    return { data: leaderboardCache.data, cached: true };
  }
  const leaderboard = await buildLeaderboard();
  leaderboardCache = { at: now, data: leaderboard };
  return { data: leaderboard, cached: false };
}

app.get('/api/leaderboard', async (_req, res) => {
  try {
    const { data, cached } = await getLeaderboard();
    res.json({ platform: PLATFORM, leaderboard: data, cached });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Estado en vivo: SOLO se consulta acá, cuando alguien pide /api/live ----------
async function loadLiveStatus(player) {
  if (!player.puuid) return { inGame: false };

  const liveGame = await riotFetch(
    `https://${PLATFORM}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${player.puuid}`
  );
  if (!liveGame) return { inGame: false };

  const me = (liveGame.participants || []).find(p => p.puuid === player.puuid);
  const bans = (liveGame.bannedChampions || [])
    .filter(b => b.championId > 0)
    .sort((a, b) => a.pickTurn - b.pickTurn)
    .map(b => ({ championId: b.championId, teamId: b.teamId, pickTurn: b.pickTurn }));

  // Participantes completos (10) para poder mostrar la partida entera en /en-vivo.
  // riotId viene directo del endpoint spectator-v5; si Riot no lo manda para algún
  // participante, el cliente cae de vuelta a "Invocador".
  const participants = (liveGame.participants || []).map(p => ({
    riotId: p.riotId || null,
    championId: p.championId,
    teamId: p.teamId,
    spell1Id: p.spell1Id,
    spell2Id: p.spell2Id,
  }));

  return {
    inGame: true,
    gameId: liveGame.gameId,
    gameStartMs: Date.now() - (liveGame.gameLength * 1000),
    gameLengthSeconds: liveGame.gameLength,
    queueId: liveGame.gameQueueConfigId,
    championId: me?.championId ?? null,
    teamId: me?.teamId ?? null,
    bans,
    participants,
  };
}

async function buildLiveMatches() {
  // Reusa el caché del leaderboard solo para el puuid/nombre de cada cuenta
  // (no dispara el spectator API); si no hay caché vigente, lo arma sin consultar Riot de más.
  const { data: leaderboard } = await getLeaderboard();
  const players = leaderboard.filter(p => !p.error && p.puuid);

  const liveResults = await Promise.all(players.map(async p => ({ p, live: await loadLiveStatus(p) })));

  // Agrupa a los jugadores rastreados por partida (gameId), para mostrar cada
  // partida en vivo una sola vez con sus 10 participantes, aunque haya dos
  // amigos en la misma partida.
  const byGame = new Map();
  liveResults.forEach(({ p, live }, idx) => {
    if (!live.inGame) return;
    const rankIndex = leaderboard.indexOf(p);
    const gameId = live.gameId;
    if (!byGame.has(gameId)) {
      byGame.set(gameId, {
        gameId,
        queueId: live.queueId,
        gameStartMs: live.gameStartMs,
        bans: live.bans,
        participants: live.participants,
        tracked: [],
      });
    }
    byGame.get(gameId).tracked.push({
      riotId: p.riotId,
      displayName: p.displayName,
      rank: rankIndex + 1,
      teamId: live.teamId,
      championId: live.championId,
    });
  });

  return Array.from(byGame.values());
}

app.get('/api/live', async (_req, res) => {
  try {
    const now = Date.now();
    if (liveCache.data && now - liveCache.at < LIVE_CACHE_TTL_MS) {
      return res.json({ matches: liveCache.data, cached: true });
    }
    const matches = await buildLiveMatches();
    liveCache = { at: now, data: matches };
    res.json({ matches, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SPQC corriendo en http://localhost:${PORT}`));