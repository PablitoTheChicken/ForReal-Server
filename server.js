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

    const { visits, playing, upVotes, downVotes } = data;
    const totalVotes = upVotes + downVotes;
    const likeRatio = totalVotes === 0 ? null : upVotes / totalVotes;

    // Fetch the game’s icon
    let iconUrl = null;
    try {
      const iconResp = await axios.get('https://thumbnails.roblox.com/v1/games/icons', {
        params: {
          universeIds: universeId,
          size: '150x150',
          format: 'Png',            // must be case‑sensitive:contentReference[oaicite:2]{index=2}
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
      // use multiget endpoint for rectangular thumbnails:contentReference[oaicite:3]{index=3}
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

    // Respond with game data
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

// Start HTTPS server
const PORT = 443;
https.createServer(credentials, app).listen(PORT, () => {
  console.log(`✅ HTTPS server running at https://cahoots.gg`);
});
