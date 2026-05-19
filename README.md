# SK Bukit Kallam Student Focus Dashboard

Vercel version of the student academic focus dashboard.

## Environment Variables

Set these in Vercel:

- `SPREADSHEET_ID` = `1JoHXzqWluZywnwTVDQXANNn-vSWHLfWHaBhNsNtLvjQ`
- `GOOGLE_API_KEY` = Google Cloud API key with Google Sheets API enabled

The app reads Google Sheets formatting, so the API key is required to detect red `BIL` cells.

## Data Rule

Only students with a red background on the `BIL` cell are treated as `Murid Fokus`.
Blank TP cells stay blank. No TP auto-fill.
