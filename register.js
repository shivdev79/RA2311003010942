'use strict';

/**
 * One-time registration script.
 * 1. Copy .env.example → .env and fill in your details
 * 2. Run:  node register.js
 * 3. Copy the printed CLIENT_ID and CLIENT_SECRET into your .env
 */

require('dotenv').config();
const axios = require('axios');

const API_BASE = process.env.API_BASE_URL || 'http://20.207.122.201/evaluation-service';

async function main() {
  const { EMAIL, NAME, MOBILE_NO, GITHUB_USERNAME, ROLL_NO, ACCESS_CODE } = process.env;

  const missing = Object.entries({ EMAIL, NAME, MOBILE_NO, GITHUB_USERNAME, ROLL_NO, ACCESS_CODE })
    .filter(([, v]) => !v).map(([k]) => k);

  if (missing.length) {
    console.error('Missing env vars:', missing.join(', '));
    console.error('Fill in .env first, then re-run: node register.js');
    process.exit(1);
  }

  console.log('Registering as:', { EMAIL, NAME, ROLL_NO, GITHUB_USERNAME });

  const { data } = await axios.post(`${API_BASE}/register`, {
    email:          EMAIL,
    name:           NAME,
    mobileNo:       MOBILE_NO,
    githubUsername: GITHUB_USERNAME,
    rollNo:         ROLL_NO,
    accessCode:     ACCESS_CODE,
  });

  console.log('\n=== REGISTRATION SUCCESSFUL — save these immediately ===');
  console.log('clientID     :', data.clientID);
  console.log('clientSecret :', data.clientSecret);
  console.log('\nAdd to your .env:');
  console.log(`CLIENT_ID=${data.clientID}`);
  console.log(`CLIENT_SECRET=${data.clientSecret}`);
}

main().catch(err => {
  console.error('Registration failed:', err.response?.data || err.message);
  process.exit(1);
});
