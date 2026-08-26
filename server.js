// server.js — SPQC (SoloPeruQChallenge)
// Trae ranked stats de cuentas fijas de LAN usando la Riot API.
// El estado "en vivo" (partida completa, 10 jugadores) SOLO se consulta
// desde /api/live, para no golpear el spectator API en cada refresh de la tabla.
// La API key vive solo en el backend.

const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json()); // necesario para leer el body de POST /api/blueshell/record

const RIOT_API_KEY = process.env.RIOT_API_KEY;
if (!RIOT_API_KEY) {
  console.warn('⚠️  No se encontró RIOT_API_KEY en las variables de entorno.');
}

const PLATFORM = 'la1'; // LAN
const CONTINENT = 'americas';

// Carpeta donde se guardan los archivos JSON persistentes (contador de blue
// shells, blue shells pendientes). Por defecto es la carpeta del server, pero
// en Railway (y hostings parecidos) el disco del contenedor es EFÍMERO: si el
// proceso se reinicia o se hace un redeploy, todo lo que no esté en un Volume
// persistente se borra. Por eso este path es configurable con DATA_DIR: se le
// puede apuntar a un Railway Volume montado (ej. DATA_DIR=/data) para que el
// contador sobreviva a los reinicios. Sin esa variable, sigue funcionando
// igual que antes (mismo comportamiento, mismo bug si el hosting resetea el disco).
const DATA_DIR = process.env.DATA_DIR || __dirname;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.error(`No se pudo crear/usar DATA_DIR (${DATA_DIR}):`, err.message);
}

// Cuentas del leaderboard. "displayName" es el nombre "humano" que se muestra
// grande en la tarjeta (ej. "Patrick"); gameName/tagLine es el Riot ID real
// que se muestra chiquito debajo. Para agregar un amigo, solo suma un objeto.
const ACCOUNTS = [
  {
    displayName: 'Patrick',
    gameName: 'Dark Mind',
    tagLine: 'MID',
    role: 'MID',
    avatar: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQFvBjWAI6NVRI_7iKHWrttrBhppgGPJUnJvsGzSrJUVM9yU4R1TXRy-Tc&s=10'
  },
  {
    displayName: 'Orlaman',
    gameName: 'Ragnarok Now',
    tagLine: 'Peru',
    role: 'TOP',
    avatar: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQU4Q2-MWltchUuo1HPo4t3M17mEFs2jAujHUb8lmamDQ&s=10'
  },
  {
    displayName: 'Zoe',
    gameName: 'Minita Carreada',
    tagLine: 'Miau',
    role: 'SUPPORT',
    avatar: 'https://i.pinimg.com/1200x/9e/af/51/9eaf51fa4495cdd616e618ec47c357b5.jpg'
  },

  {
    displayName: 'karalej',
    gameName: 'Satenekig',
    tagLine: 'LAN',
    role: 'ADC',
    avatar: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSC4EqaMl6HamaF_kJO6x5SBZH1gDOBMT57K5PZxFt8wg&s=10'
  },
  {
    displayName: 'Junior',
    gameName: 'Ey Jude',
    tagLine: '1959',
    role: 'MID',
    avatar: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSFwobB5dPWnbhQtJ5iIQIvPjLV35ZOrq4ZzAo7aCDR6g&s=10'
  },
  {
    displayName: 'Defcon',
    gameName: 'Dragonヤギ',
    tagLine: 'デフコン',
    role: 'JUNGLA',
    avatar: 'https://cdn.readawrite.com/publicassets/14691481/images/8243705298_IMG_4695.jpeg'
  },
  {
    displayName: 'JazzEvans',
    gameName: 'JazzParalelado',
    tagLine: '78911',
    role: 'JUNGLA',
    avatar: 'https://static.wikia.nocookie.net/rickandmorty/images/e/ee/Morty501.png/revision/latest/thumbnail/width/360/height/450?cb=20210827150137'
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

async function riotFetch(url, attempt = 1) {
  const res = await fetch(url, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
  if (res.status === 404) return null; // ej: sin partida en vivo, sin partidas ranked
  if (res.status === 429 && attempt <= 3) {
    // Rate limit: antes esto tiraba error y la cuenta se quedaba sin
    // snapshot ese ciclo (silencioso), rompiendo el tracking de LP para esa
    // cuenta justo en ese momento. Ahora se reintenta respetando Retry-After
    // (o un backoff corto si Riot no lo manda) antes de rendirse de verdad.
    const retryAfterHeader = res.headers.get('retry-after');
    const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : attempt * 800;
    await sleep(Math.max(waitMs, 300));
    return riotFetch(url, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Riot API ${res.status} en ${url}: ${text}`);
  }
  return res.json();
}

// ---------- Caché simple en memoria (evita golpear la Riot API en cada refresh) ----------
const CACHE_TTL_MS = 80_000;
let leaderboardCache = { at: 0, data: null };
let leaderboardBuildPromise = null; // evita reconstrucciones simultáneas del leaderboard

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
  // Antes las 7 cuentas arrancaban exactamente al mismo instante, lo que
  // manda 7 llamadas de golpe a cada uno de los 3 endpoints (account,
  // summoner, league) casi en simultáneo — fácil de pasarse del límite de
  // ráfaga por segundo de la API key. Con este escalonado de 150ms entre
  // cuenta y cuenta, siguen resolviéndose en paralelo pero más repartidas.
  const results = await Promise.all(
    ACCOUNTS.map((account, i) => sleep(i * 150).then(() => loadPlayer(account)))
  );
  results.forEach(recordLpSnapshot); // guarda LP/tier/rank de este momento para poder medir ganancias/pérdidas después
  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return results;
}

async function getLeaderboard() {
  const now = Date.now();
  if (leaderboardCache.data && now - leaderboardCache.at < CACHE_TTL_MS) {
    return { data: leaderboardCache.data, cached: true };
  }
  // Si ya hay una construcción en curso (ej. dos endpoints pidiéndolo casi al
  // mismo tiempo justo cuando el caché venció), esperamos esa misma promesa
  // en vez de disparar otro build en paralelo — eso es lo que duplicaba las
  // llamadas a Riot y disparaba los 429.
  if (leaderboardBuildPromise) {
    const data = await leaderboardBuildPromise;
    return { data, cached: false };
  }
  leaderboardBuildPromise = buildLeaderboard();
  try {
    const leaderboard = await leaderboardBuildPromise;
    leaderboardCache = { at: Date.now(), data: leaderboard };
    return { data: leaderboard, cached: false };
  } finally {
    leaderboardBuildPromise = null;
  }
}

app.get('/api/leaderboard', async (_req, res) => {
  try {
    const { data, cached } = await getLeaderboard();
    res.json({ platform: PLATFORM, leaderboard: data, cached });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const RANK_CACHE_TTL_MS = 15 * 60 * 1000;
const rankCache = new Map(); // puuid -> { tier, rank, leaguePoints, at }

async function getRankForPuuid(puuid) {
  const cached = rankCache.get(puuid);
  if (cached && Date.now() - cached.at < RANK_CACHE_TTL_MS) return cached;

  let result = { tier: 'UNRANKED', rank: '', leaguePoints: 0 };
  try {
    const entries = await riotFetch(
      `https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`
    );
    const ranked = (entries || []).find(e => e.queueType === 'RANKED_SOLO_5x5');
    if (ranked) {
      result = { tier: ranked.tier, rank: ranked.rank, leaguePoints: ranked.leaguePoints };
    }
  } catch (err) {
    // si falla, se cachea igual como UNRANKED para no reintentar en cada refresh
  }

  const entry = { ...result, at: Date.now() };
  rankCache.set(puuid, entry);
  return entry;
}
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

  const participants = (liveGame.participants || []).map(p => ({
    puuid: p.puuid,
    riotId: p.riotId || null,
    championId: p.championId,
    teamId: p.teamId,
    spell1Id: p.spell1Id,
    spell2Id: p.spell2Id,
  }));

  // Trae el elo de los 10 participantes (con caché por puuid, así que en
  // partidas repetidas o refrescos seguidos casi no pega a la Riot API).
  await Promise.all(participants.map(async p => {
    const rank = await getRankForPuuid(p.puuid);
    p.tier = rank.tier;
    p.division = rank.rank;
    p.leaguePoints = rank.leaguePoints;
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
      // Elo ya viene incluido en el objeto de leaderboard cacheado (p), así que
      // mostrarlo acá no cuesta ninguna llamada extra a la Riot API.
      tier: p.tier,
      division: p.rank,
      leaguePoints: p.leaguePoints,
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

// ---------- Historial de partidas (match-v5) ----------
// Es la parte más "cara" en llamadas a la Riot API (1 para la lista de IDs +
// 1 por cada partida), así que se cachea fuerte (10 min) y se arma en serie
// con una pausa chiquita entre llamadas para no pisar los rate limits del
// API key. Vive en su propio endpoint/caché, separado del leaderboard y del
// live, para no hacerlos más lentos ni más pesados en llamadas a Riot.
const MATCH_HISTORY_COUNT = 5;
const MATCH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
let matchHistoryCache = { at: 0, data: null };
let matchHistoryBuildPromise = null; // mismo lock que el leaderboard: evita duplicar el fetch más caro (match-v5) si dos endpoints lo piden a la vez

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractParticipant(match, puuid) {
  const info = match.info;
  const p = (info.participants || []).find(x => x.puuid === puuid);
  if (!p) return null;
  return {
    matchId: match.metadata.matchId,
    win: p.win,
    championId: p.championId,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
    queueId: info.queueId,
    gameCreation: info.gameCreation,
    gameDurationSeconds: info.gameDuration,
  };
}

async function loadPlayerMatchHistory(player) {
  if (!player.puuid) return { matches: [], error: 'Sin puuid' };
  try {
    const ids = await riotFetch(
      `https://${CONTINENT}.api.riotgames.com/lol/match/v5/matches/by-puuid/${player.puuid}/ids?start=0&count=${MATCH_HISTORY_COUNT}`
    );
    if (!ids || !ids.length) return { matches: [] };

    const matches = [];
    for (const id of ids) {
      const match = await riotFetch(`https://${CONTINENT}.api.riotgames.com/lol/match/v5/matches/${id}`);
      await sleep(60); // pequeño respiro entre llamadas, para no pisar el rate limit
      if (!match) continue;
      const parsed = extractParticipant(match, player.puuid);
      if (parsed) matches.push(parsed);
    }
    return { matches };
  } catch (err) {
    return { matches: [], error: err.message };
  }
}

async function buildMatchHistory() {
  // Reusa el leaderboard cacheado (puuid + avatar), no dispara llamadas extra.
  const { data: leaderboard } = await getLeaderboard();
  const players = leaderboard.filter(p => !p.error && p.puuid);

  const result = [];
  for (const p of players) {
    const { matches, error } = await loadPlayerMatchHistory(p);
    result.push({ displayName: p.displayName, avatar: p.avatar, matches, error });
    await sleep(60);
  }
  return result;
}

async function getMatchHistory() {
  const now = Date.now();
  if (matchHistoryCache.data && now - matchHistoryCache.at < MATCH_CACHE_TTL_MS) {
    return { data: matchHistoryCache.data, cached: true };
  }
  if (matchHistoryBuildPromise) {
    const data = await matchHistoryBuildPromise;
    return { data, cached: false };
  }
  matchHistoryBuildPromise = buildMatchHistory();
  try {
    const players = await matchHistoryBuildPromise;
    matchHistoryCache = { at: Date.now(), data: players };
    return { data: players, cached: false };
  } finally {
    matchHistoryBuildPromise = null;
  }
}

app.get('/api/matches', async (_req, res) => {
  try {
    const { data: players, cached } = await getMatchHistory();
    res.json({ players, cached });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ---------- Tracking de LP: promedios de ganancia/pérdida + Aegis of Valor ----------
// La Riot API no expone un flag de "esta partida tuvo Aegis" (doble LP por
// autofill + victoria, ver patch 26.15). Así que lo inferimos: cada vez que
// se arma el leaderboard guardamos un snapshot {leaguePoints, tier, rank} por
// cuenta, y cuando aparece una partida ranked nueva en el historial,
// comparamos el snapshot de justo antes vs el de justo después. Si el tier/
// rank no cambiaron entremedio (o sea, no hubo promoción/descenso que
// resetee el contador de LP), la diferencia es la ganancia/pérdida real de
// esa partida. Si en una victoria esa ganancia es bastante más alta que el
// promedio reciente de la cuenta, la marcamos como Aegis.
const LP_LOG_FILE = path.join(DATA_DIR, 'lp-log.json');
const LP_STATS_FILE = path.join(DATA_DIR, 'lp-stats.json');
const LP_LOG_MAX_PER_PLAYER = 300; // suficiente para cubrir varios días de refrescos cada ~80s
const LP_STATS_SAMPLE_SIZE = 15; // cuántas ganancias/pérdidas "normales" recientes se usan para el promedio
const AEGIS_THRESHOLD_MULT = 1.6; // ganancia >= 1.6x el promedio propio => se cuenta como Aegis
const AEGIS_FALLBACK_BASELINE = 18; // baseline por defecto mientras no hay suficiente historial propio
const RANKED_SOLO_QUEUE_ID = 420;
const LP_MATCH_GIVEUP_MS = 30 * 60 * 1000; // si en 30 min no aparece el snapshot "después", se descarta esa partida

function loadJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function saveJsonFile(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (err) { console.error(`No se pudo guardar ${file}:`, err.message); }
}

// lpLog: { [puuid]: [{ at, leaguePoints, tier, rank }, ...] } ordenado por tiempo ascendente
let lpLog = loadJsonFile(LP_LOG_FILE, {});
// lpStats: { [displayName]: { gains:[...], losses:[...], aegisCount, seenMatchIds:[...] } }
let lpStats = loadJsonFile(LP_STATS_FILE, {});

function emptyLpStatsEntry() {
  return { gains: [], losses: [], aegisCount: 0, seenMatchIds: [] };
}

function recordLpSnapshot(player) {
  if (!player.puuid || player.error) return; // cuenta rota o sin ranked: nada que trackear
  const list = lpLog[player.puuid] || (lpLog[player.puuid] = []);
  list.push({ at: Date.now(), leaguePoints: player.leaguePoints, tier: player.tier, rank: player.rank });
  if (list.length > LP_LOG_MAX_PER_PLAYER) list.splice(0, list.length - LP_LOG_MAX_PER_PLAYER);
  saveJsonFile(LP_LOG_FILE, lpLog);
}

// Snapshots ordenados ascendente por tiempo (así se van guardando). Dos
// búsquedas independientes: la de "antes" se ancla al INICIO de la partida
// (gameCreation) y la de "después" se ancla al FINAL (gameCreation + duración).
// Antes esto estaba mal: se buscaban ambas con la misma referencia (el final),
// lo que hacía que "antes" casi siempre cayera en un snapshot tomado A MITAD
// de la partida (no antes de que arrancara), y esa partida quedaba descartada
// siempre — para todas las cuentas, no solo para partidas nuevas.
function findSnapshotBefore(puuid, ts) {
  const list = lpLog[puuid] || [];
  let result = null;
  for (const snap of list) {
    if (snap.at <= ts) result = snap; // se va quedando con el último <= ts
    else break;
  }
  return result;
}
function findSnapshotAfter(puuid, ts) {
  const list = lpLog[puuid] || [];
  for (const snap of list) {
    if (snap.at >= ts) return snap; // el primero >= ts
  }
  return null;
}

// Recorre las partidas ranked nuevas de un jugador y actualiza sus stats de
// LP (gains/losses/aegisCount). Se llama con las mismas `matches` que ya
// trae /api/matches (win, matchId, queueId, gameCreation, gameDurationSeconds).
function processLpStats(displayName, matches) {
  const entry = lpStats[displayName] || (lpStats[displayName] = emptyLpStatsEntry());
  let changed = false;

  for (const m of matches) {
    if (m.queueId !== RANKED_SOLO_QUEUE_ID) continue; // Aegis solo aplica a ranked solo/duo
    if (entry.seenMatchIds.includes(m.matchId)) continue;

    const gameEndMs = m.gameCreation + m.gameDurationSeconds * 1000;
    // Necesitamos el puuid para buscar snapshots; lo resolvemos desde ACCOUNTS vía displayName más abajo (ver processAllLpStats)
    const puuid = entry._puuid;
    const beforeGame = findSnapshotBefore(puuid, m.gameCreation); // última foto ANTES de que arrancara
    const after = findSnapshotAfter(puuid, gameEndMs); // primera foto DESPUÉS de que terminó

    if (beforeGame && after && beforeGame.tier === after.tier && beforeGame.rank === after.rank) {
      const delta = after.leaguePoints - beforeGame.leaguePoints;
      if (m.win) {
        const baseline = entry.gains.length ? entry.gains.reduce((a, b) => a + b, 0) / entry.gains.length : AEGIS_FALLBACK_BASELINE;
        if (delta > 0 && delta >= baseline * AEGIS_THRESHOLD_MULT) {
          entry.aegisCount += 1;
        } else if (delta > 0) {
          entry.gains.push(delta);
          if (entry.gains.length > LP_STATS_SAMPLE_SIZE) entry.gains.shift();
        }
      } else if (delta < 0) {
        entry.losses.push(Math.abs(delta));
        if (entry.losses.length > LP_STATS_SAMPLE_SIZE) entry.losses.shift();
      }
      entry.seenMatchIds.push(m.matchId);
      changed = true;
    } else if (Date.now() - gameEndMs > LP_MATCH_GIVEUP_MS) {
      // Nunca va a aparecer un snapshot limpio para esta partida (o hubo
      // promo/descenso entremedio); la descartamos para no reintentar por siempre.
      entry.seenMatchIds.push(m.matchId);
      changed = true;
    }
    // si no, se deja sin marcar: se reintenta la próxima vez que se llame esta función
  }

  if (entry.seenMatchIds.length > 500) entry.seenMatchIds.splice(0, entry.seenMatchIds.length - 500);
  return changed;
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function lpStatsSummary(displayName) {
  const entry = lpStats[displayName];
  if (!entry) return { avgGain: null, avgLoss: null, aegisCount: 0 };
  return { avgGain: avg(entry.gains), avgLoss: avg(entry.losses), aegisCount: entry.aegisCount };
}

// Se llama después de armar /api/matches (que ya tiene puuid + matches por
// jugador), así que reutiliza esa data sin pegarle de nuevo a la Riot API.
function processAllLpStats(matchHistoryPlayers, leaderboard) {
  let changed = false;
  for (const mp of matchHistoryPlayers) {
    const player = leaderboard.find(p => p.displayName === mp.displayName);
    if (!player || !player.puuid) continue;
    const entry = lpStats[mp.displayName] || (lpStats[mp.displayName] = emptyLpStatsEntry());
    entry._puuid = player.puuid; // no se persiste como stat en sí, solo se usa en memoria para el lookup de snapshots
    if (processLpStats(mp.displayName, mp.matches)) changed = true;
  }
  if (changed) saveJsonFile(LP_STATS_FILE, lpStats);
}

app.get('/api/lp-stats', async (_req, res) => {
  try {
    const { data: leaderboard } = await getLeaderboard();
    const { data: players } = await getMatchHistory();

    processAllLpStats(players, leaderboard);

    const stats = {};
    ACCOUNTS.forEach(a => { stats[a.displayName] = lpStatsSummary(a.displayName); });
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Carga manual de Aegis "viejos" (partidas de antes de tener el tracker
// automático corriendo, o cualquier caso donde el detector no lo haya
// pescado). Solo suma/resta al contador, requiere estar logueado y cada
// cuenta únicamente puede tocar su propio contador. `delta` normalmente es
// 1 (o -1 si te equivocaste al cargar uno).
app.post('/api/aegis/adjust', requireAuth, (req, res) => {
  const rawDelta = req.body?.delta;
  const delta = Number.isInteger(rawDelta) ? rawDelta : 1;
  if (delta === 0) return res.status(400).json({ error: 'delta no puede ser 0' });

  const entry = lpStats[req.displayName] || (lpStats[req.displayName] = emptyLpStatsEntry());
  entry.aegisCount = Math.max(0, entry.aegisCount + delta);
  saveJsonFile(LP_STATS_FILE, lpStats);
  res.json({ ok: true, displayName: req.displayName, aegisCount: entry.aegisCount });
});

// Reset de una sola vez: durante el desarrollo del tracker de LP hubo un par
// de bugs (ver historial de cambios) que hicieron que varias partidas quedaran
// marcadas como "ya vistas, no reintentar" (seenMatchIds) sin haberse podido
// medir de verdad. Ese registro queda guardado para siempre y bloquea que se
// vuelvan a intentar aunque el código ya esté arreglado. Este endpoint borra
// todo lo acumulado (gains, losses, aegisCount, seenMatchIds de TODAS las
// cuentas) para arrancar de cero una vez que el sistema ya funciona bien.
// Después de usarlo, no hace falta llamarlo de nuevo — es solo para
// descontaminar los datos viejos.
app.post('/api/lp-stats/reset', requireAuth, (_req, res) => {
  lpStats = {};
  saveJsonFile(LP_STATS_FILE, lpStats);
  res.json({ ok: true, message: 'lp-stats reseteado, arranca de cero' });
});

// ---------- Contador de Blue Shell ----------
// Guarda cuántas veces le tocó cada castigo a cada jugador. Se persiste en un
// archivo JSON junto al server para que sobreviva a reinicios del proceso.
// Nota: si el hosting hace un redeploy con filesystem limpio (algunos free tiers
// de Railway lo hacen), este archivo se resetea. Si eso pasa seguido, lo ideal
// es mover esto a una tablita en una base de datos real más adelante.
const BLUESHELL_KEYS = ['AUTOFILL', 'SIN_FLASH', 'RANDOM_CHAMP', 'SIN_BOTAS'];
const BLUESHELL_FILE = path.join(DATA_DIR, 'blueshell-counts.json');

function emptyBlueshellEntry() {
  const byPrize = {};
  BLUESHELL_KEYS.forEach(k => { byPrize[k] = 0; });
  return { total: 0, byPrize };
}

function loadBlueshellCounts() {
  try {
    const data = JSON.parse(fs.readFileSync(BLUESHELL_FILE, 'utf8'));
    console.log(`✅ Contador de blue shells cargado desde ${BLUESHELL_FILE} (${Object.keys(data).length} jugadores).`);
    return data;
  } catch (err) {
    console.warn(`⚠️  No se pudo leer ${BLUESHELL_FILE} (${err.code || err.message}). Arrancando el contador en 0. Si esto pasa seguido y no es la primera vez que corre el server, revisa si DATA_DIR está apuntando a un disco persistente.`);
    return {};
  }
}

function saveBlueshellCounts(counts) {
  try {
    fs.writeFileSync(BLUESHELL_FILE, JSON.stringify(counts, null, 2));
  } catch (err) {
    console.error('No se pudo guardar blueshell-counts.json:', err.message);
  }
}

let blueshellCounts = loadBlueshellCounts();

app.get('/api/blueshell/counts', (_req, res) => {
  res.json({ counts: blueshellCounts });
});

app.post('/api/blueshell/record', (req, res) => {
  const { displayName, prizeKey } = req.body || {};

  if (typeof displayName !== 'string' || !displayName.trim()) {
    return res.status(400).json({ error: 'Falta displayName' });
  }
  if (!BLUESHELL_KEYS.includes(prizeKey)) {
    return res.status(400).json({ error: 'prizeKey inválido' });
  }

  if (!blueshellCounts[displayName]) {
    blueshellCounts[displayName] = emptyBlueshellEntry();
  }
  const entry = blueshellCounts[displayName];
  entry.total += 1;
  entry.byPrize[prizeKey] = (entry.byPrize[prizeKey] || 0) + 1;
  entry.lastAt = Date.now();

  saveBlueshellCounts(blueshellCounts);
  res.json({ ok: true, entry });
});

// Solo anota qué campeón le tocó en el último "Campeón aleatorio" — no suma
// al conteo (eso ya lo hizo /api/blueshell/record cuando cayó ese premio).
app.post('/api/blueshell/champion', (req, res) => {
  const { displayName, championName } = req.body || {};

  if (typeof displayName !== 'string' || !displayName.trim()) {
    return res.status(400).json({ error: 'Falta displayName' });
  }
  if (typeof championName !== 'string' || !championName.trim()) {
    return res.status(400).json({ error: 'Falta championName' });
  }

  if (!blueshellCounts[displayName]) {
    blueshellCounts[displayName] = emptyBlueshellEntry();
  }
  blueshellCounts[displayName].lastChampion = championName;
  saveBlueshellCounts(blueshellCounts);
  res.json({ ok: true, entry: blueshellCounts[displayName] });
});

// ---------- Login simple ----------
// No es un sistema de seguridad de verdad, es solo para saber "quién es quién"
// al tirar una blue shell. Usuario y contraseña son el nombre del jugador en
// minúsculas y sin espacios/tildes (ej. displayName "Defcon" -> user: defcon,
// pass: defcon). Se genera automáticamente desde ACCOUNTS, así que si agregas
// un amigo nuevo ahí arriba, ya tiene su login sin tocar nada más acá.
function normalizeUsername(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca tildes
    .replace(/[^a-z0-9]/g, ''); // saca espacios/símbolos
}

const USERS = ACCOUNTS.map(a => {
  const u = normalizeUsername(a.displayName);
  return { username: u, password: u, displayName: a.displayName };
});

// token -> { displayName, createdAt }. Vive en memoria: si el server se
// reinicia, todos quedan deslogueados y tienen que volver a entrar (no pasa
// nada, el login es instantáneo).
const sessions = new Map();

function getToken(req) {
  return req.headers['x-spqc-token'] || (req.body && req.body.token) || req.query.token || null;
}

function requireAuth(req, res, next) {
  const token = getToken(req);
  const session = token && sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Tenés que iniciar sesión primero' });
  req.displayName = session.displayName;
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'Falta usuario o contraseña' });
  }
  const u = normalizeUsername(username);
  const user = USERS.find(x => x.username === u);
  if (!user || user.password !== normalizeUsername(password)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  const token = crypto.randomUUID();
  sessions.set(token, { displayName: user.displayName, createdAt: Date.now() });
  res.json({ ok: true, token, displayName: user.displayName });
});

app.post('/api/logout', (req, res) => {
  const token = getToken(req);
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const token = getToken(req);
  const session = token && sessions.get(token);
  if (!session) return res.status(401).json({ error: 'No autenticado' });
  res.json({ ok: true, displayName: session.displayName });
});

// ---------- Inventario de Blue Shells ----------
// Cada cuenta puede "conseguir" blue shells (hasta un máximo) y las gasta al
// tirárselas a un rival. Así se corta el poder tirar ruletas ilimitadas: si
// no tenés stock, no podés tirar.
const MAX_BLUESHELL_STOCK = 3;
const INVENTORY_FILE = path.join(DATA_DIR, 'blueshell-inventory.json');

function loadInventory() {
  try {
    return JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveInventory(inv) {
  try {
    fs.writeFileSync(INVENTORY_FILE, JSON.stringify(inv, null, 2));
  } catch (err) {
    console.error('No se pudo guardar blueshell-inventory.json:', err.message);
  }
}

let blueshellInventory = loadInventory();

function getStock(displayName) {
  return blueshellInventory[displayName] || 0;
}

app.get('/api/blueshell/inventory', (_req, res) => {
  // Devuelve el stock de TODOS los jugadores (incluso los que nunca
  // consiguieron ninguna, en 0), así el front puede pintar la lista completa.
  const full = {};
  ACCOUNTS.forEach(a => { full[a.displayName] = getStock(a.displayName); });
  res.json({ inventory: full, max: MAX_BLUESHELL_STOCK });
});

app.post('/api/blueshell/inventory/add', requireAuth, (req, res) => {
  const current = getStock(req.displayName);
  if (current >= MAX_BLUESHELL_STOCK) {
    return res.status(400).json({ error: `Ya tenés el máximo de ${MAX_BLUESHELL_STOCK} blue shells` });
  }
  blueshellInventory[req.displayName] = current + 1;
  saveInventory(blueshellInventory);
  res.json({ ok: true, inventory: blueshellInventory[req.displayName] });
});

// ---------- Blue Shells pendientes ----------
// Cola simple de "fulano le tiró una blue shell a mengano". Cualquier cuenta
// logueada puede tirarle una a otra (si tiene stock), la víctima (logueada)
// es la única que puede marcarla como hecha, y ahí desaparece de la lista.
const PENDING_FILE = path.join(DATA_DIR, 'blueshell-pending.json');

function loadPending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function savePending(list) {
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2));
  } catch (err) {
    console.error('No se pudo guardar blueshell-pending.json:', err.message);
  }
}

let pendingBlueshells = loadPending();

app.get('/api/blueshell/pending', (_req, res) => {
  res.json({ pending: pendingBlueshells });
});

app.post('/api/blueshell/throw', requireAuth, (req, res) => {
  const { to, prizeKey, prizeLabel, reversed, reversedFrom } = req.body || {};
  const target = ACCOUNTS.find(a => a.displayName === to);
  if (!target) return res.status(400).json({ error: 'Rival inválido' });
  // Si tocó "Reverse" en la ruleta, el castigo se le da la vuelta al que
  // tiró la blue shell, así que en ese caso sí se permite que "to" sea
  // el mismo que tira (req.displayName). Fuera de ese caso, se mantiene
  // la regla de no poder tirarse una a uno mismo.
  if (target.displayName === req.displayName && !reversed) {
    return res.status(400).json({ error: 'No te podés tirar una blue shell a vos mismo' });
  }

  const stock = getStock(req.displayName);
  if (stock <= 0) {
    return res.status(400).json({ error: 'No te quedan blue shells. Conseguí una arriba antes de tirar 🐢' });
  }
  blueshellInventory[req.displayName] = stock - 1;
  saveInventory(blueshellInventory);

  const entry = {
    id: crypto.randomUUID(),
    from: req.displayName,
    to: target.displayName,
    prizeKey: prizeKey || null,
    prizeLabel: prizeLabel || null,
    champion: null,
    reversedFrom: reversed ? (reversedFrom || null) : null,
    createdAt: Date.now(),
  };
  pendingBlueshells.push(entry);
  savePending(pendingBlueshells);
  res.json({ ok: true, pending: pendingBlueshells, id: entry.id, inventory: blueshellInventory[req.displayName] });
});

// Se llama después del sorteo de campeón (solo aplica al premio "Campeón
// aleatorio"), para completar el dato en la blue shell pendiente que ya se
// había creado al girar la ruleta.
app.post('/api/blueshell/pending/:id/champion', requireAuth, (req, res) => {
  const { championName } = req.body || {};
  const entry = pendingBlueshells.find(p => p.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Esa blue shell pendiente ya no existe' });
  if (entry.from !== req.displayName) {
    return res.status(403).json({ error: 'Solo quien tiró la blue shell puede definir el campeón' });
  }
  if (typeof championName === 'string' && championName.trim()) {
    entry.champion = championName.trim();
    savePending(pendingBlueshells);
  }
  res.json({ ok: true, pending: pendingBlueshells });
});

app.post('/api/blueshell/pending/:id/complete', requireAuth, (req, res) => {
  const entry = pendingBlueshells.find(p => p.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Esa blue shell pendiente ya no existe' });
  if (entry.to !== req.displayName) {
    return res.status(403).json({ error: 'Solo la víctima puede marcar esta blue shell como hecha' });
  }

  pendingBlueshells = pendingBlueshells.filter(p => p.id !== entry.id);
  savePending(pendingBlueshells);
  res.json({ ok: true, pending: pendingBlueshells });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SPQC corriendo en http://localhost:${PORT}`));

// ---------- Poller de LP en segundo plano ----------
// El tracking de Aegis/promedios de LP necesita un snapshot de ANTES y otro
// de DESPUÉS de cada partida. Si esos snapshots solo se tomaran cuando
// alguien carga la página, cualquier partida jugada mientras nadie está
// mirando la web (de noche, entre semana, etc.) queda sin registrar.
// Este poller llama a getLeaderboard() cada BACKGROUND_POLL_MS, así los
// snapshots se siguen tomando aunque no haya visitas — mismo caché de
// siempre, solo que ahora se refresca solo en vez de esperar tráfico.
const BACKGROUND_POLL_MS = 90_000; // un poco más que el TTL del caché (80s), para no pisarlo
setInterval(() => {
  getLeaderboard().catch(err => console.error('Poller de LP en segundo plano falló:', err.message));
}, BACKGROUND_POLL_MS);