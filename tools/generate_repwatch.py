#!/usr/bin/env python3
"""
RepWatch data generator
=======================

Builds a single JSON data file (data/data.json),
using the same official sources that GovTrack.us and the Github unitedstates/congress
scraper project use. No API keys are required.

Sources
-------
1. House roll call votes: clerk.house.gov EVS XML
   (https://clerk.house.gov/evs/<year>/rollNNN.xml)
2. Senate roll call votes: senate.gov Legislative Information System XML
   (https://www.senate.gov/legislative/LIS/roll_call_votes/...)
3. Bill summaries/status: GovInfo bulk Bill Status XML (Library of Congress / GPO)
   (https://www.govinfo.gov/bulkdata/BILLSTATUS/...)
4. Member roster & IDs: unitedstates/congress-legislators
   (legislators-current.yaml)
5. Misconduct records: govtrack/misconduct (misconduct-instances.csv)

Usage
-----
    pip install pyyaml
    python3 tools/generate_repwatch.py                                      # current Congress
    python3 tools/generate_repwatch.py --congress 119                       # a specific Congress
    python3 tools/generate_repwatch.py --limit-votes 50 --limit-bills 40    # quick test

Re-run this any time new votes are cast, then re-upload the app files.
Downloads are cached in tools/cache.
"""

import argparse
import csv
import datetime as dt
import html as htmllib
import io
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required:  pip install pyyaml")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(SCRIPT_DIR, "cache")
OUT_PATH = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "data", "data.json"))

UA = "Python urllib"

# --------------------------------------------------------------------------
# HTTP with caching
# --------------------------------------------------------------------------

def fetch(url, cache_key, use_cache=None, timeout=30):
    """GET a URL, returning (status, body-bytes). Cached on disk."""
    if use_cache is None:
        use_cache = CACHE_USE
    cache_path = os.path.join(CACHE_DIR, cache_key)
    if use_cache and os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
            return 200, f.read()
    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                with open(cache_path, "wb") as f:
                    f.write(body)
                return resp.status, body
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return 404, b""
            last_err = e
        except Exception as e:  # network errors, etc.
            last_err = e
        time.sleep(1.5 * (attempt + 1))
    print(f"    ! giving up on {url}: {last_err}", file=sys.stderr)
    return None, None


def get_text(url, cache_key, use_cache=None):
    status, body = fetch(url, cache_key, use_cache=use_cache)
    if status == 200 and body is not None:
        return body.decode("utf-8", errors="replace")
    return None


def sleep(sec):
    time.sleep(sec)

# --------------------------------------------------------------------------
# Congress arithmetic
# --------------------------------------------------------------------------

def congress_first_year(congress):
    """Year the first session of this Congress begins (119th -> 2025)."""
    return 1989 + 2 * (congress - 101)

def current_congress(today=None):
    today = today or dt.date.today()
    return (today.year - 1989) // 2 + 101

# --------------------------------------------------------------------------
# Member roster
# --------------------------------------------------------------------------

LEGISLATORS_URL = "https://raw.githubusercontent.com/unitedstates/congress-legislators/master/legislators-current.yaml"

def load_roster(congress, today):
    """Return {member_id: member_dict} for everyone serving (or who served)
    any part of the given Congress, plus a govtrack_id -> member_id map.
    People who left mid-Congress are filled in later from the Clerk's list
    (predecessor records) and the vote XMLs."""
    yml = get_text(LEGISLATORS_URL, "legislators/legislators-current.yaml")
    if not yml:
        sys.exit("Could not download legislators-current.yaml")
    people = yaml.safe_load(yml)

    start_year = congress_first_year(congress)
    window_start = dt.date(start_year, 1, 3)
    window_end = dt.date(start_year + 2, 1, 3)

    members = {}
    govtrack_map = {}

    for p in people:
        ids = p.get("id") or {}
        name = p.get("name") or {}
        full = name.get("official_full") or " ".join(
            x for x in (name.get("first"), name.get("last")) if x
        )
        first_term = None
        for t in p.get("terms", []):
            try:
                ts = dt.date.fromisoformat(t["start"])
                te = dt.date.fromisoformat(t["end"]) if t.get("end") else today + dt.timedelta(days=3650)
            except (ValueError, KeyError):
                continue
            # overlaps this Congress?
            if ts < window_end and te > window_start:
                t = dict(t)
                if first_term is None or t["start"] > first_term["start"]:
                    first_term = t
        if first_term is None:
            continue

        chamber = "house" if first_term["type"] == "rep" else "senate"
        mid = ids.get("bioguide") if chamber == "house" else ids.get("lis")
        if not mid or mid in members:
            continue

        end = dt.date.fromisoformat(first_term["end"]) if first_term.get("end") else None
        serving = end is None or end >= today
        m = {
            "id": mid,
            "name": full,
            "chamber": chamber,
            "state": first_term.get("state", ""),
            "party": first_term.get("party", ""),
            "serving": serving,
        }
        if chamber == "house":
            m["district"] = first_term.get("district") or 0
        else:
            m["class"] = first_term.get("class") or 0
        if not serving and end:
            m["left"] = end.strftime("%B %Y")
        members[mid] = m
        if ids.get("govtrack"):
            govtrack_map[str(ids["govtrack"])] = mid
    return members, govtrack_map


def cross_check_house(members, congress, today):
    """Ensure every member on the Clerk of the House's official list is in
    our roster, and build a map of recent predecessors (people who left the
    House during this Congress) so their votes can be attributed by name.

    Returns (added_count, predecessor_map) where predecessor_map maps
    bioguide id -> {name, party, state, vacate_date}."""
    xml_text = get_text("https://clerk.house.gov/xml/lists/MemberData.xml",
                        "clerk/MemberData.xml")
    if not xml_text:
        return 0, {}
    added = 0
    preds = {}
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return 0, {}
    for m in root.findall("./members/member"):
        dist = (m.findtext("statedistrict") or "").strip()
        info = m.find("member-info")
        if info is None:
            continue
        state = dist[:2]
        bg = (info.findtext("bioguideID") or "").strip()
        if bg and bg not in members:
            district = dist[2:] or "00"
            name = " ".join(x for x in (
                info.findtext("firstname"), info.findtext("lastname"), info.findtext("suffix")
            ) if x and x.strip())
            party_code = (info.findtext("party") or "").strip().upper()
            party = {"R": "Republican", "D": "Democrat"}.get(party_code, party_code)
            members[bg] = {
                "id": bg, "name": name, "chamber": "house", "state": state,
                "party": party, "serving": True,
                "district": int(district) if district.isdigit() else 0,
            }
            added += 1
        # predecessor = person who left this seat during the Congress
        pred = m.find("predecessor-info")
        if pred is not None:
            pbg = (pred.findtext("pred-memindex") or "").strip()
            pname = (pred.findtext("pred-official-name") or "").strip()
            pcode = (pred.findtext("pred-party") or "").strip().upper()
            vacate_el = pred.find("pred-vacate-date")
            vacate = (vacate_el.get("date") or "").strip() if vacate_el is not None else ""  # YYYYMMDD
            if pbg and pname:
                preds[pbg] = {
                    "name": pname,
                    "party": {"R": "Republican", "D": "Democrat"}.get(pcode, pcode),
                    "state": state,
                    "vacate_date": vacate,
                }
    return added, preds

# --------------------------------------------------------------------------
# House votes
# --------------------------------------------------------------------------

HOUSE_BILL_TYPES = {
    "H R": "hr", "S": "s", "H RES": "hres", "S RES": "sres",
    "H JOINT RES": "hjres", "H J RES": "hjres",
    "S JOINT RES": "sjres", "S J RES": "sjres",
    "H CON RES": "hconres", "S CON RES": "sconres",
}

def parse_house_legis_num(s):
    s = (s or "").strip()
    if not s or s in ("QUORUM", "MOTION", "JOURNAL", "ADJOURN") or re.match(r"^QUORUM \d+$", s):
        return None
    if s in HOUSE_BILL_TYPES:
        return HOUSE_BILL_TYPES[s], None
    m = re.match(r"^(H R|H RES|S RES|H JOINT RES|H J RES|S JOINT RES|S J RES|H CON RES|S CON RES|S) (\d+)$", s)
    if m:
        return HOUSE_BILL_TYPES[m.group(1)], int(m.group(2))
    return None


def classify_kind(question):
    q = (question or "").strip()
    if q in ("Call of the House", "Call by States") or q.startswith("Call by States"):
        return "quorum"
    if "Election of the Speaker" in q:
        return "leadership"
    if re.match(r"^On (Overriding the Veto|Presidential Veto|Objections of the President)", q):
        return "passage"
    if re.match(r"^On Passage", q) or re.search(r"Conference Report", q) \
       or re.search(r"Concur(ing| in) in the Senate Amendment", q, re.I) \
       or re.search(r"Suspend (the )?Rules and (Agree|Concur|Pass)", q, re.I) \
       or re.match(r"^On (Agreeing to )?the (Joint |Concurrent )?Resolution", q):
        return "passage"
    if re.search(r"(On (Agreeing to )?the (En Bloc )?Amendments?|Amendment \d+ to)", q, re.I):
        return "amendment"
    if "Cloture" in q:
        return "cloture"
    if re.match(r"^On the Nomination", q):
        return "nomination"
    if re.search(r"Motion to Recommit", q, re.I):
        return "recommit"
    if "Guilty or Not Guilty" in q:
        return "conviction"
    if re.search(r"Resolution of Ratification", q, re.I):
        return "treaty"
    return "procedural"


def parse_house_vote(body, year, sleep_s):
    """Parse one House roll XML -> vote dict (or None)."""
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return None
    if root.tag != "rollcall-vote":
        return None
    md = root.find("vote-metadata")
    if md is None:
        return None

    def txt(tag):
        el = md.find(tag)
        return (el.text or "").strip() if el is not None and el.text else ""

    num = int(txt("rollcall-num") or 0)
    question = txt("vote-question")
    # The Clerk's plain description of what was voted on. Kept as a last
    # resort for the app: when the question is uninformative (e.g. a bare
    # "On Passage" on a joint resolution).
    desc = txt("vote-desc")
    date_s = txt("action-date")  # e.g. 4-Jun-2025
    try:
        date = dt.datetime.strptime(date_s, "%d-%b-%Y").date()
    except ValueError:
        date = dt.date(year, 1, 1)
    kind = classify_kind(question)
    bill_ref = parse_house_legis_num(txt("legis-num"))
    amend_el = md.find("amendment-num")
    amendment = None
    if amend_el is not None and (amend_el.text or "").strip().isdigit():
        amendment = {
            "number": int(amend_el.text.strip()),
            "author": (md.findtext("amendment-author") or "").strip() or None,
        }

    vote = {
        "id": f"{date.isoformat()}-h{num}",
        "chamber": "house",
        "number": num,
        "date": date.isoformat(),
        "question": question,
        "desc": desc,
        "kind": kind,
        "result": txt("vote-result"),
        "bill": {"type": bill_ref[0], "number": bill_ref[1]} if bill_ref else None,
        "amendment": amendment,
        "yea": [],
        "nay": [],
    }

    # Speaker / call-of-house votes record candidate names instead of Aye/No.
    if kind in ("leadership",):
        return vote, {}

    yeas, nays = [], []
    member_info = {}
    for rec in root.findall("./vote-data/recorded-vote"):
        leg = rec.find("legislator")
        cast = (rec.findtext("vote") or "").strip()
        if leg is None:
            continue
        mid = (leg.get("name-id") or "").strip()
        if not mid:
            continue
        lastname = (leg.get("sort-field") or leg.get("unaccented-name") or "").strip()
        party = (leg.get("party") or "").strip()
        state = (leg.get("state") or "").strip()
        if lastname:
            member_info[mid] = {"name": lastname, "state": state,
                                "party": {"R": "Republican", "D": "Democrat"}.get(party, party)}
        if cast in ("Aye", "Yea"):
            yeas.append(mid)
        elif cast in ("No", "Nay"):
            nays.append(mid)
        # "Not Voting" is intentionally dropped to keep the file small.
    vote["yea"] = yeas
    vote["nay"] = nays
    return vote, member_info


def fetch_house_votes(year, congress, limit=None, sleep_s=0.12):
    votes = []
    member_info = {}
    n = 1
    skipped_in_a_row = 0
    while n <= 1500:
        url = f"https://clerk.house.gov/evs/{year}/roll{n:03d}.xml"
        text = get_text(url, f"clerk/evs/{year}/roll{n:03d}.xml")
        n += 1
        if text is None:  # network failure: keep trying next (maybe transient)
            skipped_in_a_row += 1
            if skipped_in_a_row > 5:
                break
            sleep(1.0)
            continue
        if b"roll-call-vote-not-available" in text.encode():
            # vacated / not yet posted: skip this number
            skipped_in_a_row += 1
            if skipped_in_a_row > 5:
                print(f"    house {year}: stopping after {skipped_in_a_row} missing in a row (at roll {n})")
                break
            continue
        parsed = parse_house_vote(text.encode(), year, sleep_s)
        if parsed is None:
            skipped_in_a_row += 1
            if skipped_in_a_row > 5:
                break
            continue
        vote, info = parsed
        if vote["number"] != n - 1:
            print(f"    ! house {year}: expected roll {n-1}, got {vote['number']} (gap in numbering)")
            skipped_in_a_row += 1
            if skipped_in_a_row > 3:
                break
            continue
        skipped_in_a_row = 0
        votes.append(vote)
        member_info.update(info)
        if limit and len(votes) >= limit:
            break
        sleep(sleep_s)
    return votes, member_info

# --------------------------------------------------------------------------
# Senate votes
# --------------------------------------------------------------------------

SENATE_BILL_TYPES = {
    "H.R.": "hr", "S.": "s", "H.Res.": "hres", "S.Res.": "sres",
    "H.J.Res.": "hjres", "S.J.Res.": "sjres",
    "H.Con.Res.": "hconres", "S.Con.Res.": "sconres",
}

def parse_senate_vote(body, congress, session_num, sleep_s):
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return None
    if root.tag != "roll_call_vote":
        return None

    def txt(path):
        return (root.findtext(path) or "").strip()

    try:
        date = dt.datetime.strptime(re.sub(r"\s+", " ", txt("vote_date")), "%B %d, %Y, %I:%M %p").date()
    except ValueError:
        try:
            date = dt.datetime.strptime(re.sub(r"\s+", " ", txt("vote_date")), "%B %d, %Y").date()
        except ValueError:
            return None

    num = int(txt("vote_number") or 0)
    question = txt("vote_question_text") or txt("question")
    title = txt("vote_title")
    # For cloture votes the 'title' field is the useful one (see congress project).
    if "Cloture" in question and title:
        question, title = title, question
    vote = {
        "id": f"{date.isoformat()}-s{num}",
        "chamber": "senate",
        "number": num,
        "date": date.isoformat(),
        "question": (question + (" " + title if title and "Cloture" not in question else "")).strip(),
        "title": title or "",
        "kind": classify_kind(question),
        "result": txt("vote_result_text") or txt("vote_result"),
        "bill": None,
        "amendment": None,
        "yea": [],
        "nay": [],
    }

    doc_type = (root.findtext("document/document_type") or "").strip()
    doc_num = (root.findtext("document/document_number") or "").strip()
    if doc_type in SENATE_BILL_TYPES and doc_num.isdigit():
        vote["bill"] = {"type": SENATE_BILL_TYPES[doc_type], "number": int(doc_num)}
    elif doc_type == "PN":
        vote["kind"] = "nomination"
    elif vote["kind"] == "amendment" and vote["bill"] is None:
        # Amendment votes carry the parent bill in the question text,
        # e.g. "On the Amendment S.Amdt. 14 to S.Amdt. 8 to S. 5 ..." —
        # the parent bill is the last plain bill reference.
        refs = re.findall(r"(S\.?Con\.?Res\.|H\.?Con\.?Res\.|H\.?R\.|S)\.?\s*(\d+)", question)
        refs = [(t, n) for t, n in refs if not (doc_num and n == doc_num)]
        if refs:
            t, n = refs[-1]
            if "Con" in t:
                btype = "hconres" if t.startswith("H") else "sconres"
            else:
                btype = "hr" if t.startswith("H") else "s"
            vote["bill"] = {"type": btype, "number": int(n)}

    amend_num = (root.findtext("amendment/amendment_number") or "").strip()
    m = re.match(r"^S\.?Amdt\.? (\d+)", amend_num)
    if m:
        vote["amendment"] = {"number": int(m.group(1)),
                             "author": (root.findtext("amendment/amendment_purpose") or "").strip() or None}

    yeas, nays = [], []
    member_info = {}
    for member in root.findall("./members/member"):
        cast = (member.findtext("vote_cast") or "").strip()
        mid = (member.findtext("lis_member_id") or "").strip()
        if not mid:
            continue
        mf = (member.findtext("member_full") or "").strip()
        st = (member.findtext("state") or "").strip()
        pt = (member.findtext("party") or "").strip()
        if mf:
            member_info[mid] = {"name": mf, "state": st, "party": pt}
        if cast in ("Yea", "Aye"):
            yeas.append(mid)
        elif cast in ("Nay", "No"):
            nays.append(mid)
    vote["yea"] = yeas
    vote["nay"] = nays
    return vote, member_info


def fetch_senate_votes(congress, session_year, limit=None, sleep_s=0.1):
    session_num = session_year - congress_first_year(congress) + 1
    menu_url = f"https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_{congress}_{session_num}.xml"
    menu = get_text(menu_url, f"senate/menu_{congress}_{session_num}.xml")
    if not menu:
        print(f"    senate {congress}.{session_num}: no vote menu (session may not have started)")
        return []
    try:
        root = ET.fromstring(menu.encode())
    except ET.ParseError:
        return []
    nums = []
    for v in root.findall(".//vote"):
        n = v.findtext("vote_number")
        if n and n.strip().isdigit():
            nums.append(int(n.strip()))
    votes = []
    member_info = {}
    for num in sorted(nums):
        if limit and len(votes) >= limit:
            break
        url = (f"https://www.senate.gov/legislative/LIS/roll_call_votes/"
               f"vote{congress}{session_num}/vote_{congress}_{session_num}_{num:05d}.xml")
        text = get_text(url, f"senate/{congress}_{session_num}_{num:05d}.xml")
        if not text:
            continue
        parsed = parse_senate_vote(text.encode(), congress, session_num, sleep_s)
        if parsed:
            vote, info = parsed
            votes.append(vote)
            member_info.update(info)
        sleep(sleep_s)
    return votes, member_info

# --------------------------------------------------------------------------
# Bill summaries (GovInfo BILLSTATUS)
# --------------------------------------------------------------------------

BILLS_WITH_STATUS = {"hr", "s", "hres", "sres", "hjres", "sjres", "hconres", "sconres"}

POLICY_ISSUES = {
    "Agriculture and Food": "Food & Farming",
    "Economics and Public Finance": "Taxes & Spending",
    "Education": "Education",
    "Energy": "Energy",
    "Environmental Protection": "Environment",
    "Government Operations and Politics": "Government & Elections",
    "Health": "Health Care",
    "Housing and Community Development": "Housing",
    "International Affairs and National Security": "Foreign Affairs & Defense",
    "Labor and Employment": "Jobs & Labor",
    "Law": "Crime & Courts",
    "Science and Technology": "Science & Technology",
    "Transportation": "Transportation",
    "Veterans and Military Affairs": "Veterans",
}

KEYWORD_ISSUES = [
    ("Guns & Firearms", r"\bguns?\b|firearms?|assault weapon|second amendment|ammunition|background check"),
    ("Health Care", r"medicare|medicaid|health ?care|health insurance|hospitals?|food stamps|nutrition|mental health|cdc\b|fda\b|pandemic|epidemic|vaccin"),
    ("Environment", r"climate|carbon|emissions?|environmental|\bepa\b|clean water|wildlife|land management|biodiversity"),
    ("Taxes & Spending", r"\btax(es|ation)?\b|\bir\b|budget|appropriat|stimulus|deficit|debt ceiling"),
    ("Foreign Affairs & Defense", r"defense|national security|armed forces|military|\bnato\b|sanction|treaty|foreign"),
    ("Immigration", r"immigration|immigrant|border|asylum|\bvisas?\b|daca|refugee"),
    ("Jobs & Labor", r"minimum wage|labor\b|workers'?|union|social security|unemployment"),
    ("Government & Elections", r"election|voting|redistrict|census|ethics|congressional|post office"),
    ("Transportation", r"transit|highway|rail\b|aviation|airline|trucking|port of"),
    ("Food & Farming", r"\bfarm|agriculture|\bcrops?\b|food security|drought|\busda\b|ranch"),
    ("Education", r"school|education|student loan|teachers?"),
    ("Energy", r"energy|\boil\b|\bnatural gas\b|solar|\bwind\b|electric|nuclear|pipelines?"),
    ("Housing", r"housing|mortgage|\brent|affordable home"),
    ("Crime & Courts", r"crime|felony|prison|incarcerat|police|drug|murder"),
    ("Veterans", r"veterans?"),
]
KW_RE = [(label, re.compile(rx, re.I)) for label, rx in KEYWORD_ISSUES]


def clean_html(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = htmllib.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def pick_issue(bill_type, number, title, summary):
    # policy area is set on the bill dict by the caller when available
    text = f"{title} {summary}"
    hits = [label for label, rx in KW_RE if rx.search(text)]
    return hits[:1][0] if hits else None


def fetch_bill_status(congress, btype, number, sleep_s=0.12):
    url = (f"https://www.govinfo.gov/bulkdata/BILLSTATUS/{congress}/{btype}/"
           f"BILLSTATUS-{congress}{btype}{number}.xml")
    text = get_text(url, f"govinfo/{congress}/{btype}{number}.xml")
    if not text:
        return None
    try:
        root = ET.fromstring(text.encode())
    except ET.ParseError:
        return None
    bill = root.find("bill")
    if bill is None:
        return None

    title = (bill.findtext("title") or "").strip()
    # latest short summary
    summary = ""
    summaries = bill.findall("summaries/summary")
    if summaries:
        def sd(sm):
            return (sm.findtext("actionDate") or "").strip()
        summaries.sort(key=sd, reverse=True)
        summary = clean_html(summaries[0].findtext("text"))
    # GovInfo summaries usually begin with the bill's own title; drop that
    # repetition (the title is shown separately by the app).
    if title and summary:
        t2 = re.sub(r"\s+", " ", title).strip()
        if summary.lower().startswith(t2.lower()):
            summary = summary[len(t2):].lstrip(". \t")
    # subjects
    subjects = [ (i.findtext("name") or "").strip()
                 for i in bill.findall("subjects/legislativeSubjects/item") ]
    subjects = [s for s in subjects if s][:8]
    policy = (bill.findtext("policyArea/name") or "").strip()
    issue = POLICY_ISSUES.get(policy)
    if not issue:
        issue = pick_issue(btype, number, title, summary)
    if not issue:
        issue = "Other"
    latest = ""
    la = bill.find("latestAction")
    if la is not None:
        latest = " ".join(x for x in [(la.findtext("actionDate") or "").strip(),
                                      (la.findtext("text") or "").strip()] if x)
    return {
        "title": title,
        "summary": summary[:2200],
        "issue": issue,
        "subjects": subjects,
        "url": (bill.findtext("legislationUrl") or "").strip(),
        "latest_action": latest[:500],
    }

# --------------------------------------------------------------------------
# Misconduct
# --------------------------------------------------------------------------

MISCONDUCT_URL = "https://raw.githubusercontent.com/govtrack/misconduct/master/misconduct-instances.csv"
CONSEQ_COLS = ["censure", "confirmation", "contempt", "conviction", "exclusion",
               "expulsion", "fined", "plea", "reprimand", "resignation", "settlement"]
TAG_COLS = ["corruption", "crime", "elections", "ethics", "resolved",
            "sexual-harassment-abuse", "unresolved"]


def strip_md(s):
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s or "")
    s = re.sub(r"\*\*([^*]+)\*\*", r"\1", s)
    s = re.sub(r"\*([^*]+)\*", r"\1", s)
    s = htmllib.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def load_misconduct(govtrack_map, congress, today):
    csv_text = get_text(MISCONDUCT_URL, "misconduct/misconduct-instances.csv")
    if not csv_text:
        print("    ! could not download misconduct CSV; skipping misconduct data")
        return []
    start_year = congress_first_year(congress)
    window_start = dt.date(start_year, 1, 3).isoformat()
    entries = []
    rows = list(csv.DictReader(io.StringIO(csv_text)))
    for r in rows:
        person = (r.get("person") or "").strip()
        mid = govtrack_map.get(person)
        if not mid:
            continue
        first = (r.get("first_date") or "").strip()
        last = (r.get("last_date") or "").strip()
        # relevant if the case is still open, or it ended during this Congress
        if (last != "" and last < window_start) or first > today.isoformat():
            continue
        tags = [c for c in TAG_COLS if (r.get(c) or "").strip().upper() == "X"]
        if not tags:
            tags = []
        consequences = [c.capitalize() for c in CONSEQ_COLS if (r.get(c) or "").strip().upper() == "X"]
        entries.append({
            "member_id": mid,
            "allegation": strip_md(r.get("allegation")),
            "text": strip_md(r.get("text"))[:1600],
            "first_date": first,
            "last_date": last,
            "tags": tags,
            "consequences": consequences,
            "source": "https://www.govtrack.us/misconduct",
        })
    entries.sort(key=lambda e: e["first_date"], reverse=True)
    return entries

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Generate RepWatch data.json")
    ap.add_argument("--congress", type=int, default=None,
                    help="Congress number (default: current)")
    ap.add_argument("--outdir", default=OUT_PATH, help="Output path for data.json")
    ap.add_argument("--limit-votes", type=int, default=None, help="Max votes per chamber (testing)")
    ap.add_argument("--limit-bills", type=int, default=None, help="Max bill-status fetches (testing)")
    ap.add_argument("--no-cache", action="store_true", help="Ignore the download cache")
    ap.add_argument("--sleep", type=float, default=None, help="Override delay between requests (s)")
    args = ap.parse_args()

    global CACHE_USE
    CACHE_USE = not args.no_cache
    sleep_s = args.sleep
    today = dt.date.today()
    congress = args.congress or current_congress(today)
    first_year = congress_first_year(congress)
    sessions = [first_year] + ([first_year + 1] if first_year + 1 <= today.year else [])

    print(f"RepWatch data generator")
    print(f"  Congress: {congress}th (sessions: {', '.join(str(s) for s in sessions)})")
    print(f"  Output:   {args.outdir}")
    print()

    # 1. Roster -------------------------------------------------------------
    print("[1/5] Member roster (congress-legislators + House Clerk list)...")
    members, govtrack_map = load_roster(congress, today)
    added, predecessor_map = cross_check_house(members, congress, today)
    if added:
        print(f"    (+{added} House members from the Clerk's official list)")
    n_house = sum(1 for m in members.values() if m["chamber"] == "house")
    n_senate = len(members) - n_house
    print(f"    {len(members)} members ({n_house} House, {n_senate} Senate)")

    # 2. Votes --------------------------------------------------------------
    votes = []
    print("[2/5] House roll call votes (clerk.house.gov)...")
    house_member_info = {}
    for year in sessions:
        v, info = fetch_house_votes(year, congress, limit=args.limit_votes,
                                    sleep_s=0.12 if sleep_s is None else sleep_s)
        print(f"    {year}: {len(v)} votes")
        votes.extend(v)
        house_member_info.update(info)
    print("[3/5] Senate roll call votes (senate.gov)...")
    senate_member_info = {}
    for year in sessions:
        v, info = fetch_senate_votes(congress, year, limit=args.limit_votes,
                                     sleep_s=0.1 if sleep_s is None else sleep_s)
        print(f"    {year}: {len(v)} votes")
        votes.extend(v)
        senate_member_info.update(info)
    print(f"    total votes: {len(votes)}")

    # Fallback members for voter IDs not in the roster (brand-new seats etc.)
    known = set(members.keys())
    fallback = 0
    for v in votes:
        for opt in (v["yea"], v["nay"]):
            for mid in opt:
                if mid not in known:
                    known.add(mid)
                    members[mid] = {
                        "id": mid, "name": mid,
                        "chamber": v["chamber"], "state": "?",
                        "party": "", "serving": True,
                        **({"district": 0} if v["chamber"] == "house" else {"class": 0}),
                    }
                    fallback += 1
    if fallback:
        print(f"    ! {fallback} voter IDs were not in the roster; filling in what we can")

    # Fill in placeholder members.
    # House: prefer the Clerk's predecessor records (full official names for
    # people who left office during the Congress); otherwise use what the
    # vote XMLs say (last name, party, state).
    for mid, m in list(members.items()):
        if m["name"] != m["id"] and m.get("state") != "?":
            continue
        if m["chamber"] == "house":
            pred = predecessor_map.get(mid)
            if pred:
                vacate = pred.pop("vacate_date", "")  # YYYYMMDD
                m.update(pred)
                m["serving"] = False
                if len(vacate) >= 8:
                    m["left"] = dt.date.fromisoformat(f"{vacate[:4]}-{vacate[4:6]}-{vacate[6:8]}").strftime("%B %Y")
            else:
                info = house_member_info.get(mid)
                if info:
                    m.update({"state": info["state"], "party": info["party"],
                              "name": info["name"]})
        else:
            info = senate_member_info.get(mid)
            if info:
                m.update({"name": info["name"], "state": info["state"],
                          "party": info["party"]})
    still_blank = sum(1 for m in members.values() if m["name"] == m["id"] or m.get("state") == "?")
    if still_blank:
        print(f"    ! {still_blank} members could not be identified by name; they will show by ID only")

    # 4. Bill summaries -----------------------------------------------------
    bills_needed = set()
    for v in votes:
        if v["bill"] and v["bill"]["type"] in BILLS_WITH_STATUS:
            bills_needed.add((v["bill"]["type"], v["bill"]["number"]))
    print(f"[4/5] Bill summaries/status (GovInfo BILLSTATUS) for {len(bills_needed)} bills...")
    bills = {}
    missing = 0
    fetched = 0
    for btype, number in sorted(bills_needed):
        if args.limit_bills and fetched >= args.limit_bills:
            break
        info = fetch_bill_status(congress, btype, number,
                                 sleep_s=0.12 if sleep_s is None else sleep_s)
        fetched += 1
        if info is None:
            missing += 1
            continue
        bills[f"{btype}{number}"] = info
        if fetched % 25 == 0:
            print(f"    {fetched}/{len(bills_needed)} done")
    print(f"    {len(bills)} bills with status, {missing} missing status files")

    # 4. Misconduct ---------------------------------------------------------
    print("[5/5] Misconduct records (govtrack/misconduct)...")
    misconduct = load_misconduct(govtrack_map, congress, today)
    print(f"    {len(misconduct)} entries for current members")

    # 5. Assemble -----------------------------------------------------------
    issues = sorted({b["issue"] for b in bills.values()} | {"Other"})
    data = {
        "meta": {
            "congress": congress,
            "generated": today.isoformat(),
            "sessions": [f"{congress}.{y}" for y in sessions],
            "counts": {
                "members": len(members), "votes": len(votes),
                "bills": len(bills), "misconduct": len(misconduct),
            },
            "sources": [
                "clerk.house.gov (House roll call votes)",
                "senate.gov (Senate roll call votes)",
                "govinfo.gov BILLSTATUS (bill summaries, Library of Congress)",
                "unitedstates/congress-legislators (member roster)",
                "govtrack/misconduct (conduct records)",
            ],
        },
        "members": sorted(members.values(), key=lambda m: (m["chamber"], m["state"], m["name"])),
        "votes": sorted(votes, key=lambda v: (v["date"], v["chamber"], v["number"])),
        "bills": bills,
        "misconduct": misconduct,
        "issues": {i: i for i in issues},
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.outdir)), exist_ok=True)
    with open(args.outdir, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
    size = os.path.getsize(args.outdir)
    print()
    print(f"Wrote {args.outdir}  ({size/1024/1024:.2f} MB)")
    print(f"  {len(members)} members, {len(votes)} votes, {len(bills)} bills, {len(misconduct)} misconduct entries")
    print("Done. Re-upload the app (or just the data/ folder) whenever you regenerate.")

# cache flag used by get_text default
CACHE_USE = True

if __name__ == "__main__":
    main()
