const express = require('express');
const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

const app = express();
app.use(express.json());

// Enable CORS for all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Azure Key Vault setup
const keyVaultName = "my-vault123";
const secretName = "firm-private-key";
const vaultUrl = `https://${keyVaultName}.vault.azure.net`;

const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);

// Simple endpoint to get private key
app.post('/get-key', async (req, res) => {
  try {
    const secret = await client.getSecret(secretName);
    let privateKey = secret.value;
    
    if (!privateKey.startsWith('0x')) {
      privateKey = '0x' + privateKey;
    }
    
    res.json({ 
      success: true, 
      privateKey: privateKey 
    });
    
  } catch (error) {
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.listen(3002, () => {
  console.log('🚀 Key server running on port 3002');
});