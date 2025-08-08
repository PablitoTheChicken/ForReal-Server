const express = require('express');
const https = require('https');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const privateKey  = fs.readFileSync('/etc/letsencrypt/live/cahoots.gg/privkey.pem', 'utf8');
const certificate = fs.readFileSync('/etc/letsencrypt/live/cahoots.gg/fullchain.pem', 'utf8');
const credentials = { key: privateKey, cert: certificate };

app.get('/', (req, res) => {
  res.send('Welcome to the Roblox Game API');
});

app.get('/game/:universeId', async (req, res) => {
  const { universeId } = req.params;

  try {
  const response = await axios.get(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
  const data = response.data.data?.[0];

  if (!data) {
    console.error(`Game not found for universeId ${universeId}`);
    return res.status(404).json({ error: 'Game not found or invalid Universe ID' });
  }

  const { visits, playing, upVotes, downVotes } = data;
  const totalVotes = upVotes + downVotes;
  const likeRatio = totalVotes === 0 ? null : upVotes / totalVotes;

  const thumbnailURL = 'https://thumbnails.roblox.com/v1/games/icons';
  const imageURL = 'https://thumbnails.roblox.com/v1/games/thumbnails';

  const [thumbnailResponse, imageResponse] = await Promise.all([
    axios.get(thumbnailURL, {
      params: {
        universeIds: universeId,
        size: '150x150',
        format: 'Png',
        isCircular: false
      }
    }),
    axios.get(imageURL, {
      params: {
        universeIds: universeId,
        size: '768x432',
        format: 'Png',
        isCircular: false
      }
    })
  ]);

  const iconData = thumbnailResponse.data?.data?.[0];
  const thumbData = imageResponse.data?.data?.[0];

  if (!iconData || iconData.state !== "Completed") {
    console.warn(`Icon not found for universeId ${universeId}:`, iconData?.state);
  }

  if (!thumbData || thumbData.state !== "Completed") {
    console.warn(`Thumbnail not found for universeId ${universeId}:`, thumbData?.state);
  }

  const iconUrl = iconData?.imageUrl || null;
  const thumbnailUrl = thumbData?.imageUrl || null;

  res.json({
    visits,
    playing,
    likeRatio,
    iconUrl,
    thumbnailUrl
  });

} catch (error) {
  if (error.response) {
    console.error(`Error fetching Roblox game data:`, error.response.status, error.response.data);
  } else {
    console.error('Error fetching Roblox game data:', error.message);
  }

  res.status(500).json({ error: 'Failed to fetch game details from Roblox API' });
}
});

const PORT = 443;
https.createServer(credentials, app).listen(PORT, () => {
  console.log(`✅ HTTPS server running at https://cahoots.gg`);
});