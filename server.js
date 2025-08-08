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

// Root route
app.get('/', (req, res) => {
  res.send('Welcome to the Roblox Game API');
});

// Main game info endpoint
app.get('/game/:universeId', async (req, res) => {
  const { universeId } = req.params;

  try {
    // Fetch core game data
    const response = await axios.get(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
    const data = response.data.data?.[0];

    if (!data) {
      return res.status(404).json({ error: 'Game not found or invalid Universe ID' });
    }

    const { visits, playing } = data;

    // Fetch vote counts for like ratio:contentReference[oaicite:1]{index=1}
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

    // Fetch the game’s icon (unchanged)
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

    // Fetch the game’s thumbnail (unchanged)
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

    res.json({
      visits,
      playing,
      likeRatio,
      iconUrl,
      thumbnailUrl
    });
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
