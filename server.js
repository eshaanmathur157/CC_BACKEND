const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Path to credentials file (in the SERVER folder)
const CREDENTIALS_PATH = path.join(__dirname, 'gen-lang-client-0487226181-f8b8cd61d3d9.json');

// Check if credentials exist on startup
const credentialsExist = fs.existsSync(CREDENTIALS_PATH);
console.log(`Credentials file: ${credentialsExist ? 'FOUND' : 'NOT FOUND'} at ${CREDENTIALS_PATH}`);

app.post('/api/estimate-carbon', async (req, res) => {
  try {
    const { coordinates, options } = req.body;
    
    if (!credentialsExist) {
      return res.status(500).json({ 
        error: 'Google Earth Engine credentials not found',
        details: 'Please add the service account JSON file to the SERVER folder'
      });
    }
    
    // Use the correct absolute path to credentials
    const { main } = require('./ForestCarbonEstimation.js');
    const result = await main(CREDENTIALS_PATH, coordinates, options);
    res.json(result);
    
  } catch (error) {
    console.error('Carbon estimation error:', error.message);
    
    // Check for specific error types
    if (error.message.includes('invalid_grant') || error.message.includes('Invalid JWT')) {
      return res.status(401).json({ 
        error: 'Google Earth Engine authentication failed',
        details: 'The service account credentials have expired or been revoked. Please generate new credentials from Google Cloud Console.',
        originalError: error.message
      });
    }
    
    if (error.message.includes('not found')) {
      return res.status(404).json({ 
        error: 'Credentials file not found',
        details: error.message
      });
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    credentialsFound: credentialsExist,
    credentialsPath: CREDENTIALS_PATH
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Google Earth Engine credentials: ${credentialsExist ? '✅ Found' : '❌ Not found'}`);
});