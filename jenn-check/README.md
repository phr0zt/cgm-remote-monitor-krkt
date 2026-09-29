# Jenn's check

Private page: five big buttons (Basaglar, Apidra, Food, Other insulin, Note) that write to Nightscout,
plus today's checklist and log read back from Nightscout, so anything logged in xDrip shows up too.

## Run on Railway
1. Deploy Nightscout (MongoDB + `nightscout/cgm-remote-monitor`) and note its URL and API_SECRET.
2. Deploy this folder as a service (Dockerfile included). Set the variables from `.env.example`.
3. Open the service URL, log in with APP_USER / APP_PASS. Add it to Jenn's home screen.

## xDrip settings (Jenn's phone)
Settings > Cloud Upload > Nightscout Sync (REST-API): enable, Base URL
`https://<API_SECRET>@<nightscout-host>/api/v1/`, and tick "Upload treatments".

## Checklist
Edit `CHECKLIST` at the top of `server.js` to change what counts as done for the day.
