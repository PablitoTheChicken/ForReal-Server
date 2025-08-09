const express = require('express');
const https = require('https');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// TLS certificates (Let's Encrypt)
const privateKey  = fs.readFileSync('/etc/letsencrypt/live/cahoots.gg/privkey.pem', 'utf8');
const certificate = fs.readFileSync('/etc/letsencrypt/live/cahoots.gg/fullchain.pem', 'utf8');
const credentials = { key: privateKey, cert: certificate };

const API_FOOTBALL_KEY=your_api_football_key_here
const CONTACT_FROM="Cahoots.gg <no-reply@forreal.com>"
const CONTACT_TO="joram@kleiberg.net"

const footballCache = new Map();
const FOOTBALL_CACHE_MS = 5 * 60 * 1000;

app.get('/football/fixtures', async (req, res) => {
  try {
    const { date, leagues, timezone = 'UTC' } = req.query;
    if (!date) {
      return res.status(400).json({ error: "Missing required 'date' (YYYY-MM-DD)" });
    }
    if (!API_FOOTBALL_KEY) {
      return res.status(500).json({ error: 'API_FOOTBALL_KEY not set on server' });
    }

    const leagueIds = (leagues ? String(leagues) : '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const cacheKey = JSON.stringify({ date, leagueIds, timezone });
    const cached = footballCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < FOOTBALL_CACHE_MS) {
      return res.json(cached.payload);
    }

    const url = 'https://v3.football.api-sports.io/fixtures';
    const headers = { 'x-apisports-key': API_FOOTBALL_KEY };

    let responses = [];
    if (leagueIds.length === 0) {
      // All fixtures for the date
      const r = await axios.get(url, { headers, params: { date, timezone } });
      responses = [r.data];
    } else {
      // Fetch per-league and merge
      const requests = leagueIds.map(league =>
        axios.get(url, { headers, params: { date, league, timezone } })
      );
      responses = (await Promise.all(requests)).map(r => r.data);
    }

    // Merge API-Football payloads
    const merged = {
      get: 'fixtures',
      parameters: { date, leagues: leagueIds, timezone },
      errors: [],
      results: responses.reduce((sum, r) => sum + (r.results || 0), 0),
      paging: { current: 1, total: 1 },
      response: responses.flatMap(r => r.response || []),
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
