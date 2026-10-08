# RepWatch

A simple way to see how the members of Congress have
voted in plain language. Also includes public records of misconduct and
ethics investigations against them.

RepWatch is a small static PWA website (HTML + CSS + JS).
All the data lives in a single JSON file that is generated in bulk from official sources and
re-uploaded whenever it needs to be refreshed.

It is deliberately focused on **what happened** (the votes and the records),
rather than "party-line" scores. You look at the votes and decide for yourself.

The site is currently deployed via GitHub Pages at: http://adeem.co/RepWatch/

## Usage

1. **Find your representatives.** Tap "Find a Representative", pick your
   state, and tap **Save** on your U.S. Senators and House
   Representative for your district. (You can save anyone, from any state.)
   Saved representatives are kept in your browser on your local device.
2. **Look at their records.** Tap a saved representative to see:
   - **Conduct & ethics records** from the public misconduct database
     (allegations, investigations, censures, resignations, and outcomes).
     These are *allegations and records* - they do not prove wrongdoing.
   - **How they have voted**, grouped by issue (Health Care, Guns &
     Firearms, Taxes & Spending, Environment, etc.) Each vote shows:
     - what was voted on, in plain language (using the Library of Congress’
       own bill summaries as titles can be misleading),
     - a green **Voted FOR** or red **Voted AGAINST** badge,
     - overall vote counts,
     - the date, and a link to the bill on `Congress.gov`.
   Routine roll calls (quorum calls, nominations, pure procedure) are hidden
   by default. Choose "Show all votes" to see them.
3. **Compare.** On the Compare page, pick up to three saved representatives
   and an issue, and see side by side how each of them voted on every bill.

### About the data

- **Votes**: every roll call of the current Congress from the Clerk of the
  House (`clerk.house.gov`) and the Senate’s official Legislative Information
  System (`senate.gov`).
- **Bill summaries**: from the Government Publishing Office’s bulk Bill
  Status data (`govinfo.gov`), which carries the Congressional Research
  Service’s plain-language summaries.
- **Conduct records**: from the open
  [govtrack/misconduct](https://github.com/govtrack/misconduct) database.
- **People**: the
  [unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators)
  roster, cross-checked against the Clerk of the House’s official member
  list (which also supplies names of people who left office mid-Congress).


## Regenerating / periodic refresh

Run this to gather fresh votes. It takes a few minutes and is free, with no API keys required.

```bash
# one time: install the dependency
pip install pyyaml

# generate data/data.json for the current Congress
python3 tools/generate_repwatch.py
```

Useful options:

```bash
python3 tools/generate_repwatch.py --congress 119                       # a specific Congress
python3 tools/generate_repwatch.py --limit-votes 50 --limit-bills 40    # quick test
python3 tools/generate_repwatch.py --no-cache                           # ignore cached downloads
```

The script:

1. Downloads the member roster (congress-legislators YAML + the Clerk’s
   official House member list).
2. Walks the Clerk of the House’s EVS endpoint
   (`https://clerk.house.gov/evs/<year>/rollNNN.xml`) to collect every House
   roll call, and the Senate’s official roll-call XMLs for every Senate roll
   call.
3. For every bill voted on, downloads its status record from `govinfo.gov`
   BILLSTATUS (title, plain-language summary, subjects, issue area, link).
4. Downloads the misconduct CSV and keeps entries about people serving (or
   who have served) in this Congress.
5. Writes everything out to `data/data.json` (~5 MB).

Downloads are cached in `tools/cache/`, so an interrupted run resumes where
it left off, and re-runs only fetch what is new. (Delete `tools/cache/` to
force a complete re-download.)


### Data availability

The service worker (`sw.js`) uses a **network-first** strategy for
`data/data.json`. When a visitor has internet access, the app fetches the JSON
from the web (getting the latest re-upload) and refreshes the local cache.
When offline, it serves the last cached copy.


## Privacy

The app makes no network requests except for fetching
its own files. Saved representatives live in your own browser’s `localStorage`
and never leave your device.
