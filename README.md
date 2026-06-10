# SK Bukit Kallam OTI1 Tahun 1-3 Dashboard

Vercel version of the student academic focus dashboard.

## Environment Variables

Set these in Vercel:

- `SPREADSHEET_ID` = `1Qq0WnlqWQ2wcUcQOOOBVS5Yeu291BoTOqxJ4TZM2GgM`
- `GOOGLE_API_KEY` = Google Cloud API key with Google Sheets API enabled

The app reads Google Sheets formatting, so the API key is required to detect red `BIL` cells.

## Class Filter

This version only reads class tabs for Tahun 1, Tahun 2, and Tahun 3. Tabs for Tahun 4, Tahun 5, and Tahun 6 are ignored.

## Data Rule

Only students with a red background on the `BIL` cell are treated as `Murid Fokus`.
Blank TP cells stay blank. No TP auto-fill.

Subject-specific focus lists only show red-`BIL` students when that subject's OTI1 mark is below 50 or TP is 1-2.
Use `Overall` to show every red-`BIL` student.

This version analyses Tahun 1-3 only and reads OTI1/TP from BM E:F, Sains O:P, M3 Y:Z, and BI AI:AJ.
