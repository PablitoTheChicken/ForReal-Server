const express = require('express');
const https = require('https');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');

let KEY_OPEN = "aG0ENag5YPGdk-_grYTxb6NZnq0G5P0a0RLQgGTTihNB7vxNhlP3q8pnMD69gen8e7K-BYt6ksT3BlbkFJYqvth2zR3YBm8SH35k77xEkYX968uloOcHzn0dXzj68bf4qPTYCLZrW3om6FsZR4Ng7shC0X4A"
KEY_OPEN = "sk-proj-" + KEY_OPEN
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: KEY_OPEN });

const app = express();
app.use(cors());
app.use(express.json());

// TLS certificates (Let's Encrypt)
const privateKey  = fs.readFileSync('/etc/letsencrypt/live/cahoots.gg/privkey.pem', 'utf8');
const certificate = fs.readFileSync('/etc/letsencrypt/live/cahoots.gg/fullchain.pem', 'utf8');
const credentials = { key: privateKey, cert: certificate };

const API_FOOTBALL_KEY="21bc17ca293394f6a550326464b6cdcc"
const CONTACT_FROM="Cahoots.gg <no-reply@forreal.com>"
const CONTACT_TO="joram@kleiberg.net"

const footballCache = new Map();
const FOOTBALL_CACHE_MS = 5 * 60 * 1000;

async function predictScore({ home, away, season, league, date }) {
  const info = [
    home && `Home: ${home}`,
    away && `Away: ${away}`,
    league && `League: ${league}`,
    season && `Season: ${season}`,
    date && `Date: ${date}`
  ].filter(Boolean).join(' | ');

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini-2024-07-18',
    messages: [
      {
        role: 'system',
        content: 'Predict a football (soccer) full-time score. Use the tool to return ONLY the score; no words. You can be a bit more bold and less risk-averse in your predictions.'
      },
      {
        role: 'user', 
        content: `Context: ${info}`
      }
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'return_score',
        description: 'Return only the predicted full-time score.',
        strict: true, // enforce schema
        parameters: {
          type: 'object',
          properties: {
            score: { type: 'string', pattern: '^[0-9]{1,2}-[0-9]{1,2}$' }
          },
          required: ['score'],
          additionalProperties: false
        }
      }
    }],
    tool_choice: { type: 'function', function: { name: 'return_score' } },
    max_tokens: 10
  });

  // Fix: Access the tool calls from the correct response structure
  const toolCalls = resp.choices?.[0]?.message?.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    console.error('Full response:', JSON.stringify(resp, null, 2));
    throw new Error('No tool calls found in response');
  }
  
  const argumentsString = toolCalls[0].function.arguments;
  console.log('Raw arguments string:', argumentsString);
  
  if (!argumentsString || argumentsString.trim() === '') {
    throw new Error('Empty arguments string from tool call');
  }
  
  let args;
  try {
    args = JSON.parse(argumentsString);
  } catch (parseError) {
    console.error('JSON parse error:', parseError.message);
    console.error('Raw arguments:', argumentsString);
    throw new Error(`Failed to parse tool arguments: ${parseError.message}`);
  }
  
  const score = args?.score || '';
  
  if (!/^[0-9]{1,2}-[0-9]{1,2}$/.test(score)) {
    throw new Error(`Invalid score: ${score}`);
  }
  
  return score;
}

// --- Scores by fixture IDs ---
const scoreCache = new Map();
const SCORE_CACHE_MS = 60 * 1000; // 1 min cache per id

function extractFinalScore(fx) {
  const st = fx?.fixture?.status?.short; // NS, 1H, HT, 2H, ET, FT, AET, PEN...
  const s = fx?.score || {};
  // prefer the "deciding" score first
  if (st === 'PEN' && s.penalty?.home != null) return { ...s.penalty, type: 'PEN' };
  if (st === 'AET' && s.extratime?.home != null) return { ...s.extratime, type: 'AET' };
  if (['FT','AET','PEN'].includes(st) && s.fulltime?.home != null) return { ...s.fulltime, type: 'FT' };
  // fallback to live goals if match not finished
  if (fx?.goals) return { home: fx.goals.home, away: fx.goals.away, type: 'LIVE' };
  return null;
}

async function fetchFixtureById(id) {
  const cached = scoreCache.get(id);
  if (cached && Date.now() - cached.ts < SCORE_CACHE_MS) return cached.fx;

  const url = 'https://v3.football.api-sports.io/fixtures';
  const headers = { 'x-apisports-key': API_FOOTBALL_KEY };
  const { data } = await axios.get(url, { headers, params: { id } });
  const fx = data?.response?.[0];
  if (!fx) throw new Error('Fixture not found');
  scoreCache.set(id, { ts: Date.now(), fx });
  return fx;
}

async function resolveScores(ids) {
  const tasks = ids.map(async (id) => {
    try {
      const fx = await fetchFixtureById(id);
      const finalScore = extractFinalScore(fx);
      return [String(id), {
        id: fx?.fixture?.id,
        date: fx?.fixture?.date,
        timezone: fx?.fixture?.timezone,
        status: fx?.fixture?.status,                  // { long, short, elapsed }
        league: fx?.league,                           // { id, name, country, season, round }
        teams: fx?.teams,                             // { home:{name,winner}, away:{...} }
        goals: fx?.goals,                             // { home, away } (running total)
        score: fx?.score,                             // { halftime, fulltime, extratime, penalty }
        finalScore,                                   // normalized: {home, away, type}
        isFinished: ['FT','AET','PEN'].includes(fx?.fixture?.status?.short)
      }];
    } catch (e) {
      return [String(id), { error: e.message }];
    }
  });
  const entries = await Promise.all(tasks);
  return Object.fromEntries(entries);
}

// GET /football/scores?ids=123,456,789
app.get('/football/scores', async (req, res) => {
  try {
    if (!API_FOOTBALL_KEY) return res.status(500).json({ error: 'API_FOOTBALL_KEY not set' });
    const ids = String(req.query.ids || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return res.status(400).json({ error: "Provide 'ids' query, e.g. ?ids=123,456" });

    const response = await resolveScores(ids);
    res.json({ results: ids.length, response });
  } catch (err) {
    console.error('scores GET error:', err.message);
    res.status(500).json({ error: 'Failed to fetch scores', details: err.message });
  }
});

// POST /football/scores  { "ids": [123,456] }
app.post('/football/scores', async (req, res) => {
  try {
    if (!API_FOOTBALL_KEY) return res.status(500).json({ error: 'API_FOOTBALL_KEY not set' });
    const bodyIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = bodyIds.map(String).map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return res.status(400).json({ error: "Body must include { ids: [ ... ] }" });

    const response = await resolveScores(ids);
    res.json({ results: ids.length, response });
  } catch (err) {
    console.error('scores POST error:', err.message);
    res.status(500).json({ error: 'Failed to fetch scores', details: err.message });
  }
});

app.get('/football/fixtures', async (req, res) => {
  try {
    const { date, leagues, timezone = 'UTC', season, withPrediction } = req.query;
    if (!date) {
      return res.status(400).json({ error: "Missing required 'date' (YYYY-MM-DD)" });
    }
    if (!API_FOOTBALL_KEY) {
      return res.status(500).json({ error: 'API_FOOTBALL_KEY not set on server' });
    }

    // Parse filters (we will NOT send these to the API; we filter locally)
    const leagueIds = (leagues ? String(leagues) : '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const seasonNumber = season ? Number(season) : null;

    // Cache key includes filters since we return filtered results
    const cacheKey = JSON.stringify({ date, leagueIds, season: seasonNumber, timezone });
    const cached = footballCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < FOOTBALL_CACHE_MS) {
      return res.json(cached.payload);
    }

    const url = 'https://v3.football.api-sports.io/fixtures';
    const headers = { 'x-apisports-key': API_FOOTBALL_KEY };

    // IMPORTANT: Only use date (+ timezone) with the external API (free plan friendly)
    const apiResp = await axios.get(url, { headers, params: { date, timezone } });
    const apiPayload = apiResp.data || {};
    const rawFixtures = Array.isArray(apiPayload.response) ? apiPayload.response : [];

    // Manual filtering by league + season (if provided)
    const filtered = rawFixtures.filter(item => {
      const itemLeagueId = item?.league?.id;
      const itemSeason = item?.league?.season;

      const leagueOk = leagueIds.length === 0
        ? true
        : leagueIds.includes(String(itemLeagueId));

      const seasonOk = seasonNumber == null
        ? true
        : itemSeason === seasonNumber;

      return leagueOk && seasonOk;
    });

let predictedMap = new Map();

if (withPrediction === 'true') {
  const jobs = filtered.map(async fx => {
    const home = fx?.teams?.home?.name;
    const away = fx?.teams?.away?.name;
    if (!home || !away) return;
    try {
      const key = `${home} vs ${away}`;
      const score = await predictScore({
        home, away,
        season: fx?.league?.season,
        league: fx?.league?.name || fx?.league?.id,
        date: fx?.fixture?.date
      });
      predictedMap.set(key, score);
    } catch (e) {
      console.warn('Prediction failed for fixture:', home, away, e.message);
    }
  });
  await Promise.allSettled(jobs);
}

    const responseWithPredictions = filtered.map(fx => {
  const home = fx?.teams?.home?.name;
  const away = fx?.teams?.away?.name;
  const key = `${home} vs ${away}`;
  return {
    ...fx,
    gptPredictedScore: predictedMap.get(key) || null
  };
});

    // Build merged payload (same shape as API-Football)
const merged = {
  get: 'fixtures',
  parameters: { date, leagues: leagueIds, season: seasonNumber, timezone, withPrediction },
  errors: apiPayload.errors || [],
  results: (withPrediction === 'true') ? responseWithPredictions.length : filtered.length,
  paging: { current: 1, total: 1 },
  response: (withPrediction === 'true') ? responseWithPredictions : filtered,
};

    footballCache.set(cacheKey, { ts: Date.now(), payload: merged });
    res.json(merged);
  } catch (err) {
    console.error('API-Football error:', err.response?.status, err.response?.data || err.message);
    const status = err.response?.status || 500;
    res.status(status).json({
      error: 'Failed to fetch fixtures',
      details: err.response?.data ?? err.message,
    });
  }
});

// Root route
app.get('/', (req, res) => {
  res.send('Welcome to the Roblox Game API');
});

const gameCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in ms

app.get('/game/:universeId', async (req, res) => {
  const { universeId } = req.params;

  // Check cache first
  const cached = gameCache.get(universeId);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return res.json(cached.data);
  }

  try {
    // Fetch core game data
    const response = await axios.get(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
    const data = response.data.data?.[0];

    if (!data) {
      return res.status(404).json({ error: 'Game not found or invalid Universe ID' });
    }

    const { visits, playing, name } = data;

    // Fetch vote counts
    let upVotes = 0;
    let downVotes = 0;
    try {
      const votesResp = await axios.get(`https://games.roblox.com/v1/games/${universeId}/votes`);
      const votesData = votesResp.data;
      upVotes = votesData?.upVotes ?? 0;
      downVotes = votesData?.downVotes ?? 0;
    } catch (voteErr) {
      console.warn(`Votes request failed for universeId ${universeId}:`, voteErr.message);
    }
    const totalVotes = upVotes + downVotes;
    const likeRatio = totalVotes > 0 ? upVotes / totalVotes : 0;

    // Fetch the game’s icon
    let iconUrl = null;
    try {
      const iconResp = await axios.get('https://thumbnails.roblox.com/v1/games/icons', {
        params: {
          universeIds: universeId,
          size: '150x150',
          format: 'Png',
          returnPolicy: 'PlaceHolder',
          isCircular: false
        }
      });
      const iconData = iconResp.data.data?.[0];
      if (iconData?.state === 'Completed') {
        iconUrl = iconData.imageUrl;
      }
    } catch (err) {
      console.warn(`Icon request failed for universeId ${universeId}:`, err.message);
    }

    // Fetch the game’s thumbnail
    let thumbnailUrl = null;
    try {
      const thumbResp = await axios.get('https://thumbnails.roblox.com/v1/games/multiget/thumbnails', {
        params: {
          universeIds: universeId,
          size: '768x432',
          format: 'Png',
          returnPolicy: 'PlaceHolder',
          isCircular: false
        }
      });
      const thumbEntry = thumbResp.data.data?.[0];
      const firstThumb = thumbEntry?.thumbnails?.[0];
      if (firstThumb?.state === 'Completed') {
        thumbnailUrl = firstThumb.imageUrl;
      }
    } catch (err) {
      console.warn(`Thumbnail request failed for universeId ${universeId}:`, err.message);
    }

    const result = {
      name,
      visits,
      playing,
      likeRatio,
      iconUrl,
      thumbnailUrl
    };

    // Save to cache
    gameCache.set(universeId, { data: result, timestamp: Date.now() });

    res.json(result);
  } catch (error) {
    if (error.response) {
      console.error('Error fetching Roblox game data:', error.response.status, error.response.data);
    } else {
      console.error('Error fetching Roblox game data:', error.message);
    }
    res.status(500).json({ error: 'Failed to fetch game details from Roblox API' });
  }
});

app.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    // 1. Fetch user details (username, displayName):contentReference[oaicite:2]{index=2}.
    const userResp = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
    const { name, displayName, id } = userResp.data;

    // 2. Fetch avatar headshot image:contentReference[oaicite:3]{index=3}.
    let avatarUrl = null;
    try {
      const headshotResp = await axios.get('https://thumbnails.roblox.com/v1/users/avatar-headshot', {
        params: {
          userIds: userId,
          size: '150x150',
          format: 'Png',
          isCircular: false
        }
      });
      const thumbData = headshotResp.data.data?.[0];
      if (thumbData?.state === 'Completed') {
        avatarUrl = thumbData.imageUrl;
      }
    } catch (thumbErr) {
      console.warn(`Avatar request failed for userId ${userId}:`, thumbErr.message);
    }

    // Return user profile information
    res.json({
      userId: id,
      username: name,
      displayName,
      avatarUrl
    });
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.status(404).json({ error: 'User not found or invalid user ID' });
    }
    console.error('Error fetching Roblox user data:', error.message);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Start HTTPS server
const PORT = 443;
https.createServer(credentials, app).listen(PORT, () => {
  console.log(`✅ HTTPS server running at https://cahoots.gg`);
});
