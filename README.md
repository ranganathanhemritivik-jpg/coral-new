# Stumble Coral Backend

Local testing server for the supplied StumbleCoral client. Requires Node.js 24 or newer.

1. Run `npm install` in this folder.
2. Run `npm start`. First start creates a local .env with random keys.
3. Leave it running and use the included StumbleCoral.dll with the game on the same computer.

Server: http://127.0.0.1:8080
Health: http://127.0.0.1:8080/health
Shared JSON: http://127.0.0.1:8080/shared/0.56/NULL
Login: POST /user/login with DeviceId and Version (or deviceId for the custom DLL login).

Player data persists in data/coral.sqlite. Do not delete this file if you want to keep accounts.
The supplied Shared.cs downloads shared JSON with a 10-second timeout and uses the bundled shared data if the request fails.

Verified: server startup, health endpoint, account creation/login and shared JSON. Full game login, matchmaking and matches are not yet verified. This is a local test backend, not a public deployment. Multiplayer requires configuration of a Photon application you control and a publicly reachable authentication endpoint. The inherited authentication and economy routes need review before public hosting.
